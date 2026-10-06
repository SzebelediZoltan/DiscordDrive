import { createHash } from 'node:crypto'
import type { Response } from 'express'
import { AuditAction, ChunkStatus, type FileObject } from '../../generated/prisma/client.js'
import { logger } from '../../config/logger.js'
import { AppError } from '../../http/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { prisma } from '../../lib/prisma.js'
import { fetchAttachment } from '../webhooks/discord.client.js'
import { refreshBatch } from './link-refresh.service.js'

/**
 * The read side of the file API: metadata with link health, byte-level download, and
 * integrity verification.
 *
 * Downloads never touch the disk or accumulate the file in memory. Each chunk's CDN body
 * is streamed out as it arrives and the client is told the size up front, so a 1 GB file
 * costs roughly one chunk's worth of RAM in this process. That streaming promise is why
 * the pre-flight below matters: once headers have been written there is no way to emit a
 * clean JSON error, so every chunk whose link is already known to be expired is re-armed
 * (or found unrecoverable) *before* the first byte is sent.
 *
 * Verification re-reads every chunk and compares its hash to the one recorded at upload,
 * then stores the whole-file SHA-256 once the concatenation checks out — that digest is
 * what later serves as the download's `ETag`.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadOwnedFile(userId: string, fileId: string): Promise<FileObject> {
  const file = await prisma.fileObject.findFirst({ where: { id: fileId, userId } })
  // DELETED is soft-deleted metadata; to the API it is simply gone, and the caller should
  // not learn that a restored file might exist from a different code path.
  if (!file || file.status === 'DELETED') throw AppError.notFound('File not found')
  return file
}

interface DownloadChunk {
  id: string
  index: number
  sizeBytes: bigint
  sha256: string | null
  cdnUrl: string | null
  urlExpiresAt: Date | null
  status: ChunkStatus
  batchId: string | null
}

async function chunksInOrder(fileId: string): Promise<DownloadChunk[]> {
  return prisma.chunk.findMany({
    where: { fileId, status: { in: [ChunkStatus.STORED, ChunkStatus.EXPIRED] } },
    orderBy: { index: 'asc' },
  })
}

/** Whether a link is unusable *right now*, from data we already hold (no network). */
function isDeadNow(chunk: DownloadChunk, now: number): boolean {
  return (
    chunk.status === ChunkStatus.EXPIRED ||
    chunk.cdnUrl === null ||
    chunk.urlExpiresAt === null ||
    chunk.urlExpiresAt.getTime() <= now
  )
}

/**
 * Which batches back a file, and whether each has a bot token that could refresh its links.
 *
 * Loaded for every batch, not only the dead ones: the mid-stream fallback needs to know a
 * token exists when a link 404s unexpectedly, and that information is a cheap DB read it
 * would be worse to skip.
 */
async function botTokenByBatch(fileId: string): Promise<Map<string, boolean>> {
  const batches = await prisma.chunkBatch.findMany({
    where: { chunks: { some: { fileId } } },
    select: { id: true, webhook: { select: { botTokenEnc: true } } },
  })
  return new Map(batches.map((b) => [b.id, b.webhook.botTokenEnc !== null]))
}

/**
 * Re-arms every chunk whose link is already known expired, one bot read per owning batch.
 * Returns the chunk list with the refreshed rows (re-read from the database) substituted
 * in, so a caller holding a stale snapshot does not stream a dead URL.
 */
async function rearmChunks(fileId: string, chunks: DownloadChunk[]): Promise<DownloadChunk[]> {
  const now = Date.now()
  const dead = chunks.filter((chunk) => isDeadNow(chunk, now))
  if (dead.length === 0) return chunks

  const batchIds = [...new Set(dead.map((c) => c.batchId).filter((id): id is string => id !== null))]
  for (const batchId of batchIds) await refreshBatch(batchId)

  const ids = new Set(dead.map((c) => c.id))
  const fresh = await prisma.chunk.findMany({ where: { id: { in: [...ids] } } })
  const byId = new Map(fresh.map((c) => [c.id, c]))
  return chunks.map((c) => (ids.has(c.id) && byId.get(c.id) ? byId.get(c.id)! : c))
}

/** Marks a set of chunks EXPIRED and records that the links are dead, once per wake. */
async function markChunksExpired(
  file: FileObject,
  chunkIds: string[],
  indexes: number[],
): Promise<void> {
  const updated = await prisma.chunk.updateMany({
    where: { id: { in: chunkIds }, status: { not: ChunkStatus.EXPIRED } },
    data: { status: ChunkStatus.EXPIRED },
  })
  await prisma.fileObject.update({ where: { id: file.id }, data: { linkHealthyAt: null } })
  if (updated.count > 0) {
    await recordAudit({
      action: AuditAction.LINK_EXPIRED,
      targetUserId: file.userId,
      meta: { fileId: file.id, chunks: updated.count, indexes: indexes.join(',') },
    })
  }
}

/**
 * Fetches a chunk's bytes, retrying once through a batch refresh when Discord answers with
 * a 403/404 (the signature has expired early or a token is stale). The retry happens
 * because the stored `urlExpiresAt` is only as good as the clock that signed it.
 */
async function fetchChunkBody(
  chunk: DownloadChunk,
  canRefresh: boolean,
): Promise<{ ok: boolean; body: ReadableStream<Uint8Array> | null; message: string }> {
  const first = await fetchAttachment(chunk.cdnUrl ?? '')
  if (first.ok) return { ok: true, body: first.response?.body ?? null, message: '' }

  if (canRefresh && chunk.batchId !== null) {
    await refreshBatch(chunk.batchId)
    const fresh = await prisma.chunk.findUnique({
      where: { id: chunk.id },
      select: { cdnUrl: true, status: true, urlExpiresAt: true },
    })
    if (fresh?.cdnUrl && fresh.status !== ChunkStatus.FAILED && fresh.cdnUrl !== chunk.cdnUrl) {
      const second = await fetchAttachment(fresh.cdnUrl)
      if (second.ok) return { ok: true, body: second.response?.body ?? null, message: '' }
    }
    return { ok: false, body: null, message: 'The storage link could not be refreshed, even after re-reading it from Discord.' }
  }

  return { ok: false, body: null, message: first.message }
}

/** Writes a buffer honouring socket backpressure, so a slow client cannot pin all of RAM. */
function writeWithBackpressure(res: Response, buf: Buffer): Promise<void> {
  if (res.write(buf)) return Promise.resolve()
  return new Promise((resolve) => void res.once('drain', () => resolve()))
}

/**
 * RFC 5987 `Content-Disposition`. The fallback `filename` is plain ASCII (illegal bytes
 * and quotes replaced), and `filename*` carries the real bytes percent-encoded, which is
 * the form browsers prefer for non-ASCII names.
 */
function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/'/g, '%27')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

// ---------------------------------------------------------------------------
// Metadata with link health
// ---------------------------------------------------------------------------

export interface FileMetadata {
  id: string
  name: string
  originalName: string
  sizeBytes: string
  mimeType: string
  status: string
  sha256: string | null
  folderId: string | null
  chunkSizeBytes: number
  chunkCount: number
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  deletedAt: Date | null
  /** Whether every stored link is currently usable and none is about to expire silently. */
  linkHealthy: boolean
  /** The earliest CDN link expiry across the file's chunks, or null when unknown. */
  linkExpiresAt: string | null
  /** When a bot last refreshed this file's links, or null if never. */
  linkRefreshedAt: string | null
  /** Whether the backing webhook carries a bot token, i.e. refresh is even possible. */
  botRefreshEnabled: boolean
}

export async function presentFileMetadata(input: {
  userId: string
  fileId: string
}): Promise<FileMetadata> {
  const file = await loadOwnedFile(input.userId, input.fileId)

  const [chunks, batches] = await Promise.all([
    prisma.chunk.findMany({
      where: { fileId: file.id, status: { in: [ChunkStatus.STORED, ChunkStatus.EXPIRED] } },
      select: { urlExpiresAt: true, status: true },
    }),
    prisma.chunkBatch.findMany({
      where: { chunks: { some: { fileId: file.id } } },
      select: { webhookId: true, refreshedAt: true },
    }),
  ])

  const [anyWithBot, bot] = await Promise.all([
    prisma.webhook.count({
      where: { id: { in: batches.map((b) => b.webhookId) }, botTokenEnc: { not: null } },
    }),
    // Fewer row reads than a webhook include above would leak nothing extra.
    (async () => {
      const expiries = chunks.map((c) => c.urlExpiresAt?.getTime() ?? null).filter((t): t is number => t !== null)
      const refreshed = batches.map((b) => b.refreshedAt?.getTime() ?? null).filter((t): t is number => t !== null)
      return {
        linkExpiresAt: expiries.length > 0 ? new Date(Math.min(...expiries)) : null,
        linkRefreshedAt: refreshed.length > 0 ? new Date(Math.max(...refreshed)) : null,
      }
    })(),
  ])

  const now = Date.now()
  const linkHealthy =
    file.status === 'COMPLETE' &&
    chunks.length > 0 &&
    chunks.every(
      (c) => c.status === ChunkStatus.STORED && c.urlExpiresAt !== null && c.urlExpiresAt.getTime() > now,
    )

  return {
    id: file.id,
    name: file.name,
    originalName: file.originalName,
    sizeBytes: file.sizeBytes.toString(),
    mimeType: file.mimeType,
    status: file.status,
    sha256: file.sha256,
    folderId: file.folderId,
    chunkSizeBytes: file.chunkSizeBytes,
    chunkCount: file.chunkCount,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    completedAt: file.completedAt,
    deletedAt: file.deletedAt,
    linkHealthy,
    linkExpiresAt: bot.linkExpiresAt?.toISOString() ?? null,
    linkRefreshedAt: bot.linkRefreshedAt?.toISOString() ?? null,
    botRefreshEnabled: anyWithBot > 0,
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(input: {
  userId: string
  fileId: string
  res: Response
}): Promise<void> {
  const file = await loadOwnedFile(input.userId, input.fileId)
  if (file.status !== 'COMPLETE') {
    throw AppError.conflict('INCOMPLETE_UPLOAD', 'This file has not finished uploading yet')
  }

  const chunkRows = await chunksInOrder(file.id)
  if (chunkRows.length !== file.chunkCount) {
    throw AppError.conflict('INCOMPLETE_UPLOAD', 'This file is missing chunks that were never stored')
  }

  const hasToken = await botTokenByBatch(file.id)
  const chunks = await rearmChunks(file.id, chunkRows)

  // The first byte has not been written yet, so a fatal answer here is still a clean JSON
  // error instead of a truncated download. This is what "re-upload required" means.
  const now = Date.now()
  const stillDead = chunks.filter((c) => isDeadNow(c, now))
  if (stillDead.length > 0) {
    await markChunksExpired(
      file,
      stillDead.map((c) => c.id),
      stillDead.map((c) => c.index),
    )
    throw AppError.gone(
      'LINK_EXPIRED',
      'This file\'s storage links have expired and could not be refreshed. Add a bot token to its webhook, then try again — or re-upload the file.',
      {
        expiredChunks: stillDead.map((c) => c.index),
        botRefreshEnabled: [...hasToken.values()].some(Boolean),
      },
    )
  }

  input.res.status(200)
  input.res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')
  input.res.setHeader('Content-Length', file.sizeBytes.toString())
  input.res.setHeader('Content-Disposition', contentDisposition(file.name))
  input.res.setHeader('Cache-Control', 'private, no-store')
  if (file.sha256) input.res.setHeader('ETag', `"${file.sha256}"`)
  input.res.flushHeaders()

  try {
    let sent = 0n
    for (const chunk of chunks) {
      const canRefresh = chunk.batchId !== null && (hasToken.get(chunk.batchId) ?? false)
      const outcome = await fetchChunkBody(chunk, canRefresh)
      if (!outcome.ok || outcome.body === null) {
        throw new Error(outcome.message || 'could not read this chunk from Discord')
      }

      let read = 0n
      for await (const piece of outcome.body) {
        const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece)
        read += BigInt(buf.byteLength)
        await writeWithBackpressure(input.res, buf)
      }
      if (read !== chunk.sizeBytes) {
        throw new Error(`chunk ${chunk.index} delivered ${read} of ${chunk.sizeBytes} bytes; aborting to keep Content-Length honest`)
      }
      sent += read
    }

    if (sent !== file.sizeBytes) {
      throw new Error(`download delivered ${sent} of ${file.sizeBytes} bytes; aborting to keep Content-Length honest`)
    }
    input.res.end()
  } catch (err) {
    // Headers are sent, so an error response is no longer possible; the only honest move
    // is to cut the stream short, which the browser notices because Content-Length and the
    // bytes it actually received disagree. Never rethrow into the error handler, which
    // would try to write JSON onto a response that has already started.
    logger.error({ err, fileId: file.id, userId: input.userId }, 'download aborted mid-stream')
    if (!input.res.writableEnded) input.res.destroy(err instanceof Error ? err : new Error(String(err)))
  }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export interface ChunkVerifyResult {
  index: number
  ok: boolean
  expectedSha256: string | null
  actualSha256: string
  expectedSizeBytes: string
  actualSizeBytes: string
  error: string | null
}

export interface VerifyFileResult {
  ok: boolean
  sha256: string
  chunks: ChunkVerifyResult[]
  totalExpectedBytes: string
  totalReadBytes: string
}

/**
 * Re-reads every chunk and compares size and SHA-256 to what the upload recorded, then
 * stores the whole-file digest. This is the only path that asserts a file is byte-for-byte
 * the original: the download path streams without hashing, because a client that wants the
 * bytes does not want to pay for a verification pass they did not ask for.
 */
export async function verifyFile(input: {
  userId: string
  fileId: string
}): Promise<VerifyFileResult> {
  const file = await loadOwnedFile(input.userId, input.fileId)
  if (file.status !== 'COMPLETE') {
    throw AppError.conflict('INCOMPLETE_UPLOAD', 'This file has not finished uploading yet')
  }

  const chunkRows = await chunksInOrder(file.id)
  if (chunkRows.length !== file.chunkCount) {
    throw AppError.conflict('INCOMPLETE_UPLOAD', 'This file is missing chunks that were never stored')
  }

  const hasToken = await botTokenByBatch(file.id)
  const chunks = await rearmChunks(file.id, chunkRows)

  const wholeHash = createHash('sha256')
  let totalRead = 0n
  let ok = true
  const results: ChunkVerifyResult[] = []

  for (const chunk of chunks) {
    const canRefresh = chunk.batchId !== null && (hasToken.get(chunk.batchId) ?? false)
    const outcome = await fetchChunkBody(chunk, canRefresh)
    if (!outcome.ok || outcome.body === null) {
      results.push({
        index: chunk.index,
        ok: false,
        expectedSha256: null,
        actualSha256: '',
        expectedSizeBytes: chunk.sizeBytes.toString(),
        actualSizeBytes: '0',
        error: outcome.message || 'could not read this chunk from Discord',
      })
      ok = false
      continue
    }

    const chunkHash = createHash('sha256')
    let read = 0n
    for await (const piece of outcome.body) {
      const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece)
      chunkHash.update(buf)
      wholeHash.update(buf)
      read += BigInt(buf.byteLength)
    }

    const actualSha256 = chunkHash.digest('hex')
    const sizeOk = read === chunk.sizeBytes
    const hashOk = chunk.sha256 === null || chunk.sha256 === actualSha256
    if (!sizeOk || !hashOk) ok = false
    totalRead += read

    results.push({
      index: chunk.index,
      ok: sizeOk && hashOk,
      expectedSha256: chunk.sha256,
      actualSha256,
      expectedSizeBytes: chunk.sizeBytes.toString(),
      actualSizeBytes: read.toString(),
      error: sizeOk ? (hashOk ? null : 'Contents do not match the SHA-256 recorded at upload') : 'Size does not match what the upload recorded',
    })
  }

  const sha256 = wholeHash.digest('hex')
  const sizeMatches = totalRead === file.sizeBytes
  const allOk = ok && sizeMatches

  if (allOk) {
    // The whole-file digest is the answer to "was this file uploaded intact", and it is the
    // strongest ETag the download route can offer afterwards.
    await prisma.fileObject.update({
      where: { id: file.id },
      data: { sha256, linkHealthyAt: new Date() },
    })
    await recordAudit({
      action: AuditAction.FILE_VERIFIED,
      targetUserId: file.userId,
      meta: { fileId: file.id, sizeBytes: file.sizeBytes.toString(), sha256 },
    })
  }

  return {
    ok: allOk,
    sha256,
    chunks: results,
    totalExpectedBytes: file.sizeBytes.toString(),
    totalReadBytes: totalRead.toString(),
  }
}