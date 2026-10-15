import type { Clock } from '../../lib/rate-limit.js'
import type { AttachmentPart } from './multipart.js'

/**
 * The dispatcher turns a list of chunks into Discord messages, one bounded batch at a time.
 *
 * It owns the four things that decide whether a large upload survives contact with Discord:
 * how much goes in one request, how fast requests start, what happens on a 429, and what
 * happens when the attachment ceiling turns out to be lower than assumed.
 *
 * It deliberately knows nothing about HTTP. The Discord client is injected, so the retry and
 * halving logic is testable by handing it scripted outcomes — including outcomes that are
 * impractical to produce reliably against a real server.
 */

/**
 * The shape of a Discord message, as far as the dispatcher cares. Deliberately a subset of
 * Discord's response: requiring callers to match the full object would tie this module to
 * fields it never reads.
 */
export interface DiscordMessageResponse {
  id: string
  channel_id: string
  attachments: Array<{ id?: string; filename: string; size: number; url: string }>
}

export interface DiscordPostOk {
  ok: true
  data: DiscordMessageResponse
  latencyMs: number
}

export interface DiscordPostFail {
  ok: false
  code: number
  status: number
  message: string
  retryAfterSeconds: number | null
  latencyMs: number
}

export type DiscordPost = DiscordPostOk | DiscordPostFail

/**
 * One chunk as the dispatcher sees it: bytes already in memory, because they were hashed
 * before sending and the hash must match what Discord stores.
 */
export interface ChunkInput {
  index: number
  data: Buffer
  sha256: string
}

export interface DispatcherDeps {
  post: (input: {
    body: NodeJS.ReadableStream
    contentLength: number
    contentType: string
  }) => Promise<DiscordPost>
  clock: Clock
  /** Configured chunk size, in bytes. The probed per-webhook limit may reduce it. */
  chunkSizeBytes: number
  /** Attachments per message. Discord's documented maximum is 10. */
  chunksPerMessage: number
  /** Probed per-webhook attachment ceiling, or null when not yet known. */
  maxChunkBytes: number | null
  maxAttempts: number
  /** Called after every successful message, so the caller can persist it. */
  onBatchStored?: (info: StoredBatch) => Promise<void> | void
  /** Called when a ceiling halving means the remaining chunks need re-planning. */
  onChunkLimitChanged?: (newLimitBytes: number) => Promise<void> | void
}

export interface StoredBatch {
  messageId: string
  channelId: string
  chunkIndexes: number[]
  bytes: number
  /** Signed CDN URLs, parallel to `chunkIndexes`. */
  attachmentUrls: string[]
  attempts: number
}

export interface DispatchResult {
  stored: StoredBatch[]
  /** Chunks accepted before the run gave up. */
  storedChunks: number
  failedChunkIndex: number | null
  error: { code: string; message: string; status: number } | null
  /** Set when the webhook's real ceiling is below the configured chunk size. */
  reducedChunkLimitBytes: number | null
}

export interface DispatchOptions {
  /** Stops after this many chunks, for tests that only need part of a run. */
  limitChunks?: number
  /** Injected randomness for backoff jitter. */
  random?: () => number
}

/** Discord's size-related error codes. Any of these means "this chunk was too big". */
const SIZE_CODES = new Set([40005, 50013, 50045])

/**
 * How many messages a chunk list needs once chunk size is known.
 *
 * Exported because the upload API in #7 needs the same arithmetic to tell a client how many
 * messages to expect, and two implementations of that formula would eventually disagree.
 */
export function planBatches(totalChunks: number, chunksPerMessage: number): number {
  return Math.ceil(totalChunks / chunksPerMessage)
}

export async function dispatchChunks(
  chunks: ChunkInput[],
  deps: DispatcherDeps,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const { random = Math.random } = options
  const clock = deps.clock
  const maxAttempts = Math.max(1, deps.maxAttempts)

  // The probed ceiling wins over configuration. A user who probed 3 MiB cannot have 8 MiB
  // chunks sent to their webhook, and Discord would reject them one at a time.
  let chunkLimit = deps.maxChunkBytes ?? deps.chunkSizeBytes
  let reduced: number | null = null

  const stored: StoredBatch[] = []
  let storedChunks = 0
  const limit = options.limitChunks ?? chunks.length

  for (let offset = 0; offset < limit; ) {
    const batch = chunks.slice(offset, offset + deps.chunksPerMessage)

    // A chunk already larger than the ceiling cannot be sent, and lowering the ceiling
    // cannot fix it: the chunk is a fixed buffer. Only the caller can re-split it, so this
    // reports rather than looping — a lower limit is published, and the run stops.
    if (batch[0]!.data.byteLength > chunkLimit) {
      const next = Math.max(1024, Math.floor(chunkLimit / 2))
      if (next < chunkLimit) {
        chunkLimit = next
        reduced = next
        await deps.onChunkLimitChanged?.(next)
      }
      return {
        stored,
        storedChunks,
        failedChunkIndex: batch[0]!.index,
        error: {
          code: 'REPLAN_REQUIRED',
          message: `This webhook accepts at most ${Math.floor(next / (1024 * 1024))} MiB per file part. The remaining chunks will be re-split and sent.`,
          status: 422,
        },
        reducedChunkLimitBytes: next,
      }
    }

    const parts: AttachmentPart[] = batch.map((chunk) => ({
      filename: `${String(chunk.index).padStart(5, '0')}.bin`,
      contentType: 'application/octet-stream',
      data: chunk.data,
    }))

    let attempt = 0
    let outcome: DiscordPost | null = null

    while (attempt < maxAttempts) {
      attempt += 1

      const { buildChunkMessage } = await import('./multipart.js')
      const built = buildChunkMessage({
        parts,
        filenamePrefix: 'chunk',
        // Distinct per attempt: a retried body must not reuse a boundary that a partially
        // consumed earlier attempt may still be sitting inside.
        boundarySeed: offset + attempt,
      })

      outcome = await deps.post({
        body: built.body,
        contentLength: built.contentLength,
        contentType: `multipart/form-data; boundary=${built.boundary}`,
      })

      if (outcome.ok) break

      const asFailure = outcome

      if (SIZE_CODES.has(asFailure.code) || asFailure.status === 413) {
        // The ceiling is lower than assumed. Halve it, persist, and re-plan: retrying the
        // same oversized body would only be rejected again, so this is a change of plan
        // rather than another attempt.
        // Halve, publish, and stop. The chunks in hand are already the wrong size, so
        // retrying the same body at a lower limit would only be rejected again; the caller
        // re-splits the remainder and resumes from `failedChunkIndex`.
        const next = Math.max(1024, Math.floor(chunkLimit / 2))
        chunkLimit = next
        reduced = next
        await deps.onChunkLimitChanged?.(next)
        return {
          stored,
          storedChunks,
          failedChunkIndex: batch[0]!.index,
          error: { code: 'REPLAN_REQUIRED', message: asFailure.message, status: asFailure.status },
          reducedChunkLimitBytes: next,
        }
      }

      if (asFailure.status === 429) {
        // Out of attempts on a retryable status. Distinct from a rejection: the client
        // should come back later rather than treat the webhook as broken.
        if (attempt < maxAttempts) {
          const { backoffDelay } = await import('../../lib/rate-limit.js')
          const delay = backoffDelay(attempt, asFailure.retryAfterSeconds ? asFailure.retryAfterSeconds * 1000 : null, {
            baseMs: 500,
            maxMs: 30_000,
            jitter: 0.25,
            random,
          })
          await clock.sleep(delay)
          continue
        }
        return {
          stored,
          storedChunks,
          failedChunkIndex: batch[0]!.index,
          error: { code: 'RETRY_EXHAUSTED', message: asFailure.message, status: asFailure.status },
          reducedChunkLimitBytes: reduced,
        }
      }

      // Anything else — a deleted webhook, an auth failure, a network drop — is not worth
      // retrying here. The client re-sends the chunk from its own File handle.
      return {
        stored,
        storedChunks,
        failedChunkIndex: batch[0]!.index,
        error: { code: 'DISCORD_REJECTED', message: asFailure.message, status: asFailure.status },
        reducedChunkLimitBytes: reduced,
      }
    }

    if (outcome === null) {
      continue
    }

    if (!outcome.ok) {
      return {
        stored,
        storedChunks,
        failedChunkIndex: batch[0]!.index,
        error: {
          code: outcome.status === 429 ? 'RETRY_EXHAUSTED' : 'DISCORD_REJECTED',
          message: outcome.message,
          status: outcome.status,
        },
        reducedChunkLimitBytes: reduced,
      }
    }

    const record: StoredBatch = {
      messageId: outcome.data.id,
      channelId: outcome.data.channel_id,
      chunkIndexes: batch.map((c) => c.index),
      bytes: batch.reduce((sum, c) => sum + c.data.byteLength, 0),
      attachmentUrls: outcome.data.attachments.map((a) => a.url),
      attempts: attempt,
    }
    stored.push(record)
    await deps.onBatchStored?.(record)

    storedChunks += batch.length
    offset += batch.length
  }

  return { stored, storedChunks, failedChunkIndex: null, error: null, reducedChunkLimitBytes: reduced }
}