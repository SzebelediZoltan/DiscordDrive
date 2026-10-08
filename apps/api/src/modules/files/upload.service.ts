import { createHash } from 'node:crypto'
import type { Request } from 'express'
import { loadEnv } from '../../config/env.js'
import { AuditAction, ChunkStatus, FileStatus, type FileObject, type UploadSession, type Webhook } from '../../generated/prisma/client.js'
import { AppError } from '../../http/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { prisma } from '../../lib/prisma.js'
import { Semaphore, systemClock } from '../../lib/rate-limit.js'
import { buildDispatcherDeps } from '../dispatch/gateway.js'
import { dispatchChunks, type ChunkInput, type StoredBatch } from '../dispatch/dispatcher.js'
import { decryptCredential } from '../webhooks/webhook.service.js'
import { expiryFromUrl } from './attachment-url.js'
import { parseChunkIndex, parseSizeBytes } from './upload.schemas.js'

/**
 * The upload side of the file API: `init` a session, POST chunks, `complete` or `abort`.
 *
 * The shape of the problem is that a chunk POST is a request/response exchange, but
 * Discord only accepts ten chunks per message. Buffering here — rather than making the
 * client send one chunk per message — is what keeps the client's model simple ("send each
 * piece, I get an ack") while still reaching Discord at ten pieces per request.
 *
 * The cost of buffering is that a buffered chunk is not durable: it exists only in this
 * process's memory until the batch it belongs to is flushed. That is why `received[]` only
 * ever lists chunks with a row in the database, and why a client resuming an upload
 * re-sends anything that was still buffered when the process went away. A lie about what
 * is durable would be a file that silently loses its tail.
 *
 * Everything mutable about one file runs under a per-file lock (`runExclusive`), because
 * the pending list, the flush that empties it, and the Discord round trip in between must
 * not interleave. Two chunk POSTs for the same file arriving together would otherwise both
 * decide they are the tenth chunk and dispatch the same batch twice.
 */

const MIB = 1024 * 1024

/**
 * Ceiling on bytes held in pending buffers across all uploads.
 *
 * A buffered chunk costs real RSS until it is flushed, so an unbounded map is a memory
 * exhaustion vector: one client that opens many uploads and never finishes them would pin
 * gigabytes. Flushing before refusing means a legitimate burst usually succeeds rather
 * than paying for someone else's abandoned sessions.
 */
const MAX_PENDING_BYTES = 256 * MIB

/**
 * How many chunk request bodies may be read (and therefore held) at once.
 *
 * Bounded separately from the pending buffers: the body is an additional allocation on top
 * of whatever is already buffered, and several concurrent 25 MiB bodies add up faster than
 * they look.
 */
const MAX_CONCURRENT_CHUNK_BODIES = 8
const bodySlots = new Semaphore({ limit: MAX_CONCURRENT_CHUNK_BODIES, clock: systemClock })

const noop = (): void => {}

// ---------------------------------------------------------------------------
// Per-file locking and pending buffers
// ---------------------------------------------------------------------------

interface PendingChunk {
  index: number
  data: Buffer
  sha256: string
}

interface FileState {
  /** Tail of the promise chain; every `runExclusive` for this file appends to it. */
  tail: Promise<void>
  /** Callers chained but not yet finished. Decides when the state can be dropped. */
  queued: number
  pending: PendingChunk[]
  pendingBytes: number
}

const states = new Map<string, FileState>()
let globalPendingBytes = 0

function stateFor(fileId: string): FileState {
  let state = states.get(fileId)
  if (!state) {
    state = { tail: Promise.resolve(), queued: 0, pending: [], pendingBytes: 0 }
    states.set(fileId, state)
  }
  return state
}

/**
 * Runs `fn` with exclusive access to a file's pending buffer.
 *
 * A promise chain rather than an async mutex: chaining needs no polling, and the waiters
 * keep arrival order, which matters because a chunk stream that arrives out of order is
 * already hard to reason about without requests overtaking each other on top.
 */
function runExclusive<T>(fileId: string, fn: (state: FileState) => Promise<T>): Promise<T> {
  const state = stateFor(fileId)
  state.queued += 1

  const run = state.tail.then(
    () => fn(state),
    () => fn(state),
  )
  state.tail = run.then(noop, noop)

  // Settling is observed on both branches: the bookkeeping has to run for a rejected
  // `fn` too, and only a handled continuation keeps that rejection from surfacing as an
  // unhandled promise alongside the one the route already answers with.
  const settle = (): void => {
    state.queued -= 1
    // Dropped only once nobody is waiting and nothing is buffered, so an idle process does
    // not accumulate one small object per file it has ever touched.
    if (state.queued === 0 && state.pending.length === 0 && states.get(fileId) === state) {
      states.delete(fileId)
    }
  }
  void run.then(settle, settle)

  return run
}

function dropPending(state: FileState): void {
  globalPendingBytes -= state.pendingBytes
  state.pending = []
  state.pendingBytes = 0
}

function appendPending(state: FileState, chunk: PendingChunk): void {
  // A duplicate index means the client re-sent something still buffered. The later body
  // wins so a genuinely corrected send is not discarded, and the bytes are not double
  // counted.
  const existing = state.pending.findIndex((p) => p.index === chunk.index)
  if (existing >= 0) {
    const replaced = state.pending[existing]!
    globalPendingBytes -= replaced.data.byteLength
    state.pendingBytes -= replaced.data.byteLength
    state.pending.splice(existing, 1)
  }

  state.pending.push(chunk)
  state.pendingBytes += chunk.data.byteLength
  globalPendingBytes += chunk.data.byteLength
}

// ---------------------------------------------------------------------------
// Reading a chunk body
// ---------------------------------------------------------------------------

/**
 * Consumes the raw request body, hashing as it goes, and returns exactly the bytes that
 * were declared.
 *
 * Two size checks rather than one: a client that declares a too-large `Content-Length` is
 * refused before a single byte is read, and a client that lies about it (or uses chunked
 * encoding) is caught the moment the stream passes the expected size. Both answer
 * `CHUNK_SIZE_MISMATCH` so the client knows the fix is to send the declared size, not that
 * something internal went wrong.
 */
async function readChunkBody(req: Request, expectedBytes: number): Promise<{ data: Buffer; sha256: string }> {
  const declared = req.headers['content-length']
  if (declared !== undefined) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > expectedBytes) {
      throw AppError.payloadTooLarge(
        'CHUNK_SIZE_MISMATCH',
        `This chunk must be exactly ${expectedBytes} bytes; the request declared ${size}`,
      )
    }
  }

  return bodySlots.run(
    () =>
      new Promise<{ data: Buffer; sha256: string }>((resolve, reject) => {
        const hash = createHash('sha256')
        const parts: Buffer[] = []
        let total = 0
        let settled = false

        const finish = (): void => {
          if (settled) return
          settled = true
          cleanup()
          resolve({ data: Buffer.concat(parts, total), sha256: hash.digest('hex') })
        }

        const fail = (err: unknown): void => {
          if (settled) return
          settled = true
          cleanup()
          // Stop listening rather than draining. The unread remainder of a hostile body is
          // left in the socket, where Node discards it once this response goes out, so the
          // refusal costs nothing and a client that keeps sending hits backpressure.
          req.pause()
          reject(err)
        }

        const onData = (buf: Buffer): void => {
          if (settled) return
          total += buf.byteLength
          if (total > expectedBytes) {
            fail(
              AppError.payloadTooLarge(
                'CHUNK_SIZE_MISMATCH',
                `This chunk must be exactly ${expectedBytes} bytes; the request sent more`,
              ),
            )
            return
          }
          hash.update(buf)
          parts.push(buf)
        }

        const onEnd = (): void => {
          if (settled) return
          if (total !== expectedBytes) {
            fail(
              AppError.badRequest(
                'CHUNK_SIZE_MISMATCH',
                `This chunk must be exactly ${expectedBytes} bytes; received ${total}`,
              ),
            )
            return
          }
          finish()
        }

        const onError = (err: unknown): void => fail(err)
        const cleanup = (): void => {
          req.off('data', onData)
          req.off('end', onEnd)
          req.off('error', onError)
          req.off('aborted', onAborted)
        }
        const onAborted = (): void => fail(AppError.badRequest('CHUNK_UPLOAD_ABORTED', 'The upload was interrupted'))

        req.on('data', onData)
        req.on('end', onEnd)
        req.on('error', onError)
        req.on('aborted', onAborted)
      }),
  )
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function expectedChunkBytes(file: FileObject, index: number): number {
  const chunkSize = BigInt(file.chunkSizeBytes)
  // The last chunk carries the remainder, so its size is the only one that is not simply
  // the configured chunk size. Computed in BigInt: `sizeBytes - chunkSize * index` in
  // floating point is exactly the arithmetic that corrupts files above 4 PiB's worth of
  // bookkeeping — and above 2^53 in general.
  if (index === file.chunkCount - 1) return Number(file.sizeBytes - chunkSize * BigInt(index))
  return file.chunkSizeBytes
}

/**
 * The webhook an upload posts to: the one the session pinned when it started, so a file
 * half-written to one channel is not finished in another, falling back to the current
 * default for sessions created before a webhook existed or after one was deleted.
 */
async function resolvePostingWebhook(userId: string, preferredId: string | null): Promise<Webhook> {
  if (preferredId) {
    const pinned = await prisma.webhook.findFirst({ where: { id: preferredId, userId } })
    if (pinned) return pinned
  }

  const fallback = await prisma.webhook.findFirst({ where: { userId, isDefault: true } })
  if (!fallback) {
    throw AppError.conflict('NO_WEBHOOK', 'Add a storage webhook before uploading files')
  }
  return fallback
}

/** Finds the file only if it belongs to this user, so someone else's id is a 404. */
async function loadActiveFile(userId: string, fileId: string): Promise<FileObject & { session: UploadSession | null }> {
  const file = await prisma.fileObject.findFirst({
    where: { id: fileId, userId },
    include: { session: true },
  })
  if (!file) throw AppError.notFound('File not found')
  return file
}

/**
 * Removes a file, its session, its chunks, and any batch rows left with nothing in them.
 *
 * Chunk batches are not a child of a file — several files can share a webhook's batches in
 * principle — so they are deleted only once no chunk points at them. That keeps a deleted
 * file from leaving behind empty message records that a link refresher would still sweep.
 */
async function purgeFile(fileId: string): Promise<void> {
  const used = await prisma.chunkBatch.findMany({
    where: { chunks: { some: { fileId } } },
    select: { id: true },
  })

  // Cascades the upload session and the chunks.
  await prisma.fileObject.delete({ where: { id: fileId } })

  if (used.length > 0) {
    await prisma.chunkBatch.deleteMany({
      where: { id: { in: used.map((b) => b.id) }, chunks: { none: {} } },
    })
  }
}

async function storedIndexes(fileId: string): Promise<number[]> {
  const rows = await prisma.chunk.findMany({
    where: { fileId, status: ChunkStatus.STORED },
    select: { index: true },
    orderBy: { index: 'asc' },
  })
  return rows.map((row) => row.index)
}

// ---------------------------------------------------------------------------
// Flushing a buffered batch to Discord
// ---------------------------------------------------------------------------

interface FlushTarget {
  id: string
  chunkSizeBytes: number
  chunkCount: number
}

/**
 * Sends everything buffered for one file to Discord and persists what Discord accepted.
 *
 * Runs while the caller holds the file lock. That is deliberate: releasing the lock for the
 * round trip would let another chunk append to a list that has already been handed to the
 * dispatcher, and the two would disagree about what "everything buffered" meant.
 *
 * Returns the indexes Discord confirmed. Anything still pending after the call has been
 * dropped, so a caller can only ever see "stored" or "gone".
 */
async function flushPending(state: FileState, file: FlushTarget, webhook: Webhook): Promise<Set<number>> {
  if (state.pending.length === 0) return new Set()

  const ordered = [...state.pending].sort((a, b) => a.index - b.index)
  const meta = new Map(ordered.map((chunk) => [chunk.index, { sha256: chunk.sha256, sizeBytes: chunk.data.byteLength }]))
  const inputs: ChunkInput[] = ordered.map((chunk) => ({ index: chunk.index, data: chunk.data, sha256: chunk.sha256 }))

  const url = await decryptCredential(webhook)
  const env = loadEnv()

  const deps = buildDispatcherDeps({
    webhookRowId: webhook.id,
    discordWebhookUrl: url.normalized,
    chunkSizeBytes: file.chunkSizeBytes,
    chunksPerMessage: env.CHUNKS_PER_MESSAGE,
    maxChunkBytes: webhook.maxChunkBytes,
    maxAttempts: env.DISCORD_MAX_ATTEMPTS,
    globalConcurrency: env.DISCORD_GLOBAL_CONCURRENCY,
    onBatchStored: (info) => persistBatch(file.id, webhook.id, meta, info),
    onChunkLimitChanged: async (limit) => {
      // The probed ceiling is a property of the webhook, not of this upload, so it is
      // recorded for every future file rather than fixed per file.
      await prisma.webhook.update({ where: { id: webhook.id }, data: { maxChunkBytes: limit } })
    },
  })

  const result = await dispatchChunks(inputs, deps)

  const stored = new Set<number>()
  for (const batch of result.stored) {
    for (const index of batch.chunkIndexes) stored.add(index)
  }

  // Whatever Discord confirmed leaves the buffer; whatever it did not is dropped rather
  // than held for a retry that the client has not asked for. The rows that were written
  // survive, so a re-init still reports them in `received[]`.
  dropPending(state)

  if (result.error) {
    if (result.error.code === 'REPLAN_REQUIRED') {
      // The chunks already buffered are sized for a ceiling that no longer applies, so
      // there is nothing to salvage: the file is removed and the client starts again at
      // the smaller size. The new ceiling was persisted by `onChunkLimitChanged` above.
      await purgeFile(file.id)
      throw new AppError(422, 'REPLAN_REQUIRED', result.error.message, {
        fileId: file.id,
        chunkSizeBytes: result.reducedChunkLimitBytes,
      })
    }

    if (result.error.code === 'RETRY_EXHAUSTED') {
      throw AppError.unavailable('RETRY_EXHAUSTED', result.error.message)
    }
    throw AppError.upstream('DISCORD_REJECTED', result.error.message, { discordStatus: result.error.status })
  }

  return stored
}

/**
 * Writes one Discord message's worth of chunks as a single batch row plus its chunks.
 *
 * One transaction for the whole message: a batch row with no chunks, or chunks pointing at
 * a batch that was never created, would both make the later link refresh read the wrong
 * message. `skipDuplicates` is belt and braces — the lock already guarantees a chunk cannot
 * be flushed twice — because a duplicate here would silently rewrite an accepted chunk.
 */
async function persistBatch(
  fileId: string,
  webhookId: string,
  meta: Map<number, { sha256: string; sizeBytes: number }>,
  info: StoredBatch,
): Promise<void> {
  const expiry = expiryFromUrl(info.attachmentUrls[0])

  await prisma.$transaction(async (tx) => {
    const batch = await tx.chunkBatch.create({
      data: {
        webhookId,
        messageId: info.messageId,
        channelId: info.channelId,
        totalBytes: BigInt(info.bytes),
      },
    })

    await tx.chunk.createMany({
      skipDuplicates: true,
      data: info.chunkIndexes.map((index, position) => {
        const entry = meta.get(index)
        if (!entry) throw new Error(`missing metadata for chunk ${index}`)
        return {
          fileId,
          index,
          sizeBytes: BigInt(entry.sizeBytes),
          sha256: entry.sha256,
          status: ChunkStatus.STORED,
          attempts: info.attempts,
          cdnUrl: info.attachmentUrls[position] ?? null,
          urlExpiresAt: expiry,
          batchId: batch.id,
        }
      }),
    })

    // Only flipped from PENDING: a file that is already UPLOADING stays put, and a file
    // being completed is not bounced back.
    await tx.fileObject.updateMany({
      where: { id: fileId, status: FileStatus.PENDING },
      data: { status: FileStatus.UPLOADING },
    })

    const receivedChunks = await tx.chunk.count({ where: { fileId, status: ChunkStatus.STORED } })
    await tx.uploadSession.update({ where: { fileId }, data: { receivedChunks } })
  })
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export interface InitUploadInput {
  userId: string
  ip?: string | null
  body: {
    name: string
    sizeBytes: string | number
    mimeType: string
    folderId?: string | null
    clientId?: string
  }
}

export interface InitUploadResult {
  fileId: string
  name: string
  sizeBytes: string
  mimeType: string
  folderId: string | null
  chunkSizeBytes: number
  chunkCount: number
  received: number[]
  status: string
}

function presentUpload(file: FileObject, received: number[]): InitUploadResult {
  return {
    fileId: file.id,
    name: file.name,
    sizeBytes: file.sizeBytes.toString(),
    mimeType: file.mimeType,
    folderId: file.folderId,
    chunkSizeBytes: file.chunkSizeBytes,
    chunkCount: file.chunkCount,
    received,
    status: file.status,
  }
}

export async function initUpload(input: InitUploadInput): Promise<InitUploadResult> {
  const env = loadEnv()
  const { userId, body } = input

  const sizeBytes = parseSizeBytes(body.sizeBytes)
  if (sizeBytes > BigInt(env.MAX_FILE_SIZE_MIB)) {
    throw AppError.payloadTooLarge(
      'FILE_TOO_LARGE',
      `Files are limited to ${Math.floor(env.MAX_FILE_SIZE_MIB / MIB)} MiB`,
    )
  }

  let folderId: string | null = null
  if (body.folderId) {
    const folder = await prisma.folder.findFirst({ where: { id: body.folderId, userId } })
    if (!folder) throw AppError.notFound('Folder not found')
    folderId = folder.id
  }

  // Resume takes priority over collision: a client re-initialising its own upload must get
  // its session back rather than be told the name is taken by the file it is writing.
  if (body.clientId) {
    const session = await prisma.uploadSession.findFirst({
      where: { userId, clientId: body.clientId, status: 'ACTIVE' },
      include: { file: true },
    })
    if (session) {
      const status = session.file.status
      // Only a file that is actually being written can resume. A session whose file ended
      // up FAILED or DELETED is dead weight — a resume would hand the client a file whose
      // every chunk POST answers "File not found" — so the leftovers are purged and the
      // next init creates a fresh file, mirroring the name-collision path below.
      if (status === FileStatus.PENDING || status === FileStatus.UPLOADING) {
        return presentUpload(session.file, await storedIndexes(session.file.id))
      }
      if (status === FileStatus.FAILED || status === FileStatus.DELETED) {
        await dropStale(session.file.id)
        await purgeFile(session.file.id)
      }
      // COMPLETE cannot carry an ACTIVE session; if one ever does, the file stays untouched.
    }
  }

  const webhook = await resolvePostingWebhook(userId, null)

  const existing = await prisma.fileObject.findFirst({
    where: { userId, folderId, name: body.name },
    include: { session: true },
  })

  if (existing) {
    // Same name, same folder, same size, and the file is still being written: this is the
    // client's own earlier attempt and it gets its session back with `received[]` filled in.
    // The file status matters as much as the session's: a FAILED or DELETED file can carry
    // an ACTIVE session row, and resuming it would hand the client a file whose every chunk
    // POST answers "File not found". A different size is a different file that happens to
    // collide, which the name check below refuses.
    if (
      existing.session?.status === 'ACTIVE' &&
      (existing.status === FileStatus.PENDING || existing.status === FileStatus.UPLOADING) &&
      existing.sizeBytes === sizeBytes
    ) {
      return presentUpload(existing, await storedIndexes(existing.id))
    }

    if (existing.status === FileStatus.COMPLETE) {
      throw AppError.conflict('FILE_EXISTS', 'A file with that name already exists here')
    }

    // FAILED and DELETED files, and sessions left behind by a process that died mid-upload,
    // are dead weight: their chunks cannot be finished, and the name is needed by the retry.
    // Purging a soft-deleted file here destroys its trash row, but a fresh upload of the
    // same name in the same folder is an outright replacement, not a restore.
    await dropStale(existing.id)
    await purgeFile(existing.id)
  }

  const chunkSizeBytes = Math.min(env.CHUNK_SIZE_MIB, webhook.maxChunkBytes ?? env.CHUNK_SIZE_MIB)
  const chunkCount = Number((sizeBytes + BigInt(chunkSizeBytes) - 1n) / BigInt(chunkSizeBytes))

  const file = await prisma.$transaction(async (tx) => {
    const created = await tx.fileObject.create({
      data: {
        userId,
        folderId,
        name: body.name,
        originalName: body.name,
        sizeBytes,
        mimeType: body.mimeType,
        chunkSizeBytes,
        chunkCount,
        status: FileStatus.PENDING,
      },
    })

    await tx.uploadSession.create({
      data: {
        userId,
        fileId: created.id,
        webhookId: webhook.id,
        clientId: body.clientId ?? null,
        chunkSizeBytes,
        totalChunks: chunkCount,
        receivedChunks: 0,
        status: 'ACTIVE',
        // Reserved for the janitor: an abandoned session should not keep a file marked
        // PENDING forever, and the index on (status, expiresAt) exists to sweep it.
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    })

    await recordAudit(
      {
        action: AuditAction.UPLOAD_STARTED,
        targetUserId: userId,
        actorUserId: userId,
        actorIp: input.ip ?? null,
        meta: {
          fileId: created.id,
          name: created.name,
          sizeBytes: sizeBytes.toString(),
          chunkCount,
          webhookId: webhook.id,
        },
      },
      tx,
    )

    return created
  })

  return presentUpload(file, [])
}

/** Clears any buffered chunks for a file that is about to be deleted and recreated. */
async function dropStale(fileId: string): Promise<void> {
  const state = states.get(fileId)
  if (state) dropPending(state)
}

// ---------------------------------------------------------------------------
// chunk
// ---------------------------------------------------------------------------

export interface ChunkReceipt {
  index: number
  sizeBytes: string
  sha256: string
  stored: boolean
  batchId: string | null
  urlExpiresAt: string | null
}

export async function receiveChunk(input: {
  userId: string
  fileId: string
  indexParam: string
  req: Request
}): Promise<ChunkReceipt> {
  const file = await loadActiveFile(input.userId, input.fileId)
  if (file.status === FileStatus.COMPLETE) {
    throw AppError.conflict('FILE_ALREADY_COMPLETE', 'This file has already been completed')
  }
  if (file.status !== FileStatus.PENDING && file.status !== FileStatus.UPLOADING) {
    throw AppError.notFound('File not found')
  }

  const index = parseChunkIndex(input.indexParam)
  if (index >= file.chunkCount) {
    throw AppError.badRequest(
      'CHUNK_INDEX_OUT_OF_RANGE',
      `Chunk ${index} does not exist: this file has ${file.chunkCount} chunk(s)`,
    )
  }

  const expected = expectedChunkBytes(file, index)
  const body = await readChunkBody(input.req, expected)
  const webhook = await resolvePostingWebhook(input.userId, file.session?.webhookId ?? null)

  return runExclusive(file.id, async (state) => {
    // Re-read under the lock: the file may have been completed or aborted while this
    // request waited, and the body we just buffered describes a file that is gone.
    const fresh = await prisma.fileObject.findUnique({ where: { id: file.id }, select: { status: true } })
    if (!fresh) throw AppError.notFound('File not found')
    if (fresh.status === FileStatus.COMPLETE) {
      throw AppError.conflict('FILE_ALREADY_COMPLETE', 'This file has already been completed')
    }
    if (fresh.status !== FileStatus.PENDING && fresh.status !== FileStatus.UPLOADING) {
      throw AppError.notFound('File not found')
    }

    // Idempotent re-send. A client that lost the response to a successful POST must be
    // able to repeat it without spending Discord budget or duplicating an attachment.
    const alreadyStored = await prisma.chunk.findFirst({
      where: { fileId: file.id, index, status: ChunkStatus.STORED },
      select: { sha256: true, batchId: true, urlExpiresAt: true },
    })
    if (alreadyStored) {
      // Idempotency only holds while the bytes agree. Answering with the stored
      // receipt for a *different* body would tell the client its corrupt re-send
      // was stored, and the file would fail verification on download instead.
      if (alreadyStored.sha256 !== null && alreadyStored.sha256 !== body.sha256) {
        throw AppError.conflict(
          'CHUNK_CONFLICT',
          `Chunk ${index} was already stored with different contents; this upload session no longer matches the file`,
        )
      }
      return {
        index,
        sizeBytes: expected.toString(),
        sha256: alreadyStored.sha256 ?? body.sha256,
        stored: true,
        batchId: alreadyStored.batchId,
        urlExpiresAt: alreadyStored.urlExpiresAt?.toISOString() ?? null,
      }
    }

    if (globalPendingBytes + body.data.byteLength > MAX_PENDING_BYTES) {
      await flushPending(state, file, webhook)
      if (globalPendingBytes + body.data.byteLength > MAX_PENDING_BYTES) {
        throw AppError.tooManyRequests(
          'UPLOAD_BUSY',
          'The server is holding as many unsent chunks as it can. Retry in a moment.',
          5,
        )
      }
    }

    appendPending(state, { index, data: body.data, sha256: body.sha256 })

    const stored = new Set<number>()
    if (state.pending.length >= loadEnv().CHUNKS_PER_MESSAGE) {
      for (const storedIndex of await flushPending(state, file, webhook)) stored.add(storedIndex)
    }

    if (stored.has(index)) {
      const row = await prisma.chunk.findFirst({
        where: { fileId: file.id, index },
        select: { batchId: true, urlExpiresAt: true },
      })
      return {
        index,
        sizeBytes: expected.toString(),
        sha256: body.sha256,
        stored: true,
        batchId: row?.batchId ?? null,
        urlExpiresAt: row?.urlExpiresAt?.toISOString() ?? null,
      }
    }

    return {
      index,
      sizeBytes: expected.toString(),
      sha256: body.sha256,
      // False means "buffered, not durable": the client must not treat this as safe to
      // forget, which is exactly why `received[]` on a later init excludes it.
      stored: false,
      batchId: null,
      urlExpiresAt: null,
    }
  })
}

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

export interface CompleteUploadResult {
  fileId: string
  name: string
  sizeBytes: string
  received: number[]
  status: string
}

export async function completeUpload(input: {
  userId: string
  fileId: string
  ip?: string | null
}): Promise<CompleteUploadResult> {
  const file = await loadActiveFile(input.userId, input.fileId)
  if (file.status === FileStatus.COMPLETE) {
    return {
      fileId: file.id,
      name: file.name,
      sizeBytes: file.sizeBytes.toString(),
      received: await storedIndexes(file.id),
      status: file.status,
    }
  }
  if (file.status !== FileStatus.PENDING && file.status !== FileStatus.UPLOADING) {
    throw AppError.notFound('File not found')
  }

  const webhook = await resolvePostingWebhook(input.userId, file.session?.webhookId ?? null)

  const received = await runExclusive(file.id, async (state) => {
    // Anything still buffered has to reach Discord before "complete" can be answered: the
    // client is asking us to guarantee the file is whole, and buffered bytes have not
    // left this process.
    await flushPending(state, file, webhook)

    const rows = await prisma.chunk.findMany({
      where: { fileId: file.id, status: ChunkStatus.STORED },
      select: { index: true, sizeBytes: true },
      orderBy: { index: 'asc' },
    })

    const present = new Set(rows.map((row) => row.index))
    const missing: number[] = []
    for (let i = 0; i < file.chunkCount && missing.length < 100; i += 1) {
      if (!present.has(i)) missing.push(i)
    }

    let total = 0n
    for (const row of rows) total += row.sizeBytes

    if (missing.length > 0 || rows.length !== file.chunkCount || total !== file.sizeBytes) {
      throw AppError.conflict('INCOMPLETE_UPLOAD', 'Not every chunk has been stored yet', {
        missing,
        missingCount: file.chunkCount - rows.length,
        receivedChunks: rows.length,
        expectedChunks: file.chunkCount,
      })
    }

    await prisma.$transaction(async (tx) => {
      await tx.fileObject.update({
        where: { id: file.id },
        data: { status: FileStatus.COMPLETE, completedAt: new Date() },
      })
      await tx.uploadSession.update({
        where: { fileId: file.id },
        data: { status: 'COMPLETED', completedAt: new Date(), receivedChunks: rows.length },
      })
      await recordAudit(
        {
          action: AuditAction.UPLOAD_COMPLETED,
          targetUserId: input.userId,
          actorUserId: input.userId,
          actorIp: input.ip ?? null,
          meta: { fileId: file.id, sizeBytes: file.sizeBytes.toString(), chunks: rows.length },
        },
        tx,
      )
    })

    return rows.map((row) => row.index)
  })

  return {
    fileId: file.id,
    name: file.name,
    sizeBytes: file.sizeBytes.toString(),
    received,
    status: FileStatus.COMPLETE,
  }
}

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

export async function abortUpload(input: {
  userId: string
  fileId: string
  ip?: string | null
}): Promise<void> {
  const file = await loadActiveFile(input.userId, input.fileId)
  if (file.status === FileStatus.COMPLETE) {
    // A finished file is deleted through the file API, not abandoned: aborting here would
    // silently discard a file the user believes they have.
    throw AppError.conflict('FILE_ALREADY_COMPLETE', 'This file has already been completed')
  }

  await runExclusive(file.id, async (state) => {
    dropPending(state)
    await purgeFile(file.id)
  })

  // Deliberately after the delete, and carrying only ids: the file row is gone by this
  // point, so the audit record is the only remaining trace that it ever existed.
  await recordAudit({
    action: AuditAction.UPLOAD_ABORTED,
    targetUserId: input.userId,
    actorUserId: input.userId,
    actorIp: input.ip ?? null,
    meta: { fileId: file.id, name: file.name, sizeBytes: file.sizeBytes.toString() },
  })
}
