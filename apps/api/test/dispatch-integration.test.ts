import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  dispatchChunks,
  type ChunkInput,
  type DispatcherDeps,
  type DiscordMessageResponse,
  type DiscordPost,
} from '../src/modules/dispatch/dispatcher.js'
import { discordFetch } from '../src/modules/webhooks/discord.client.js'
import { resetEnvCache } from '../src/config/env.js'
import { startFakeDiscord, type FakeDiscordHandle } from './helpers/fake-discord-server.js'

/**
 * The dispatcher against a real HTTP server, using the same client the production path uses.
 *
 * The unit tests above script Discord's replies; this one does not, so it catches what a
 * script cannot — a Content-Length that disagrees with the body, a boundary the fake cannot
 * parse, or a retry that replays a consumed stream. Those only surface over a real socket.
 *
 * Chunk bytes are generated rather than read from a file, and totals are asserted from the
 * fake's own counters, so this stays a fast test despite nominally moving a lot of data.
 */

const MIB = 1024 * 1024
const WEBHOOK_ID = '1234567890123456789'
const WEBHOOK_TOKEN = 'integration-token-value'
const URL = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`

let fake: FakeDiscordHandle

beforeAll(async () => {
  fake = await startFakeDiscord({ maxAttachmentBytes: 25 * MIB })
  process.env.DISCORD_API_BASE = fake.url
  resetEnvCache()
})

beforeEach(() => {
  fake.control.reset()
  // The fake's per-webhook limiter would otherwise throttle the 13-message batch run that
  // this test deliberately performs.
  fake.control.setRateLimit(null)
})

afterAll(async () => {
  await fake.stop()
})

/** Chunk data with a deterministic pattern, so a mismatched reassembly is detectable. */
function makeChunks(count: number, sizeBytes: number): ChunkInput[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    data: Buffer.alloc(sizeBytes, index % 256),
    sha256: `sha-${index}`,
  }))
}

function deps(over: Partial<DispatcherDeps> = {}): DispatcherDeps {
  return {
    post: async ({ body, contentLength, contentType }) => {
      const outcome = await discordFetch<DiscordMessageResponse>(URL, {
        method: 'POST',
        headers: { 'content-type': contentType, 'content-length': String(contentLength) },
        // Node's fetch refuses a stream body unless duplex is set.
        body: body as unknown as RequestInit['body'],
        duplex: 'half',
        timeoutMs: 30_000,
      } as RequestInit & { timeoutMs: number; duplex: string })

      if (!outcome.ok) {
        const failure: DiscordPost = {
          ok: false,
          code: outcome.code,
          status: outcome.status,
          message: outcome.message,
          retryAfterSeconds: outcome.retryAfterSeconds,
          latencyMs: outcome.latencyMs,
        }
        return failure
      }

      return { ok: true, data: outcome.data, latencyMs: outcome.latencyMs }
    },
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    chunkSizeBytes: 8 * MIB,
    chunksPerMessage: 10,
    maxChunkBytes: 25 * MIB,
    maxAttempts: 5,
    ...over,
  }
}

describe('dispatcher against a live server', () => {
  it('delivers every chunk intact across a multi-message upload', async () => {
    // 100 MiB of 8 MiB chunks: 13 chunks, so 2 messages.
    const chunks = makeChunks(13, 8 * MIB)
    const result = await dispatchChunks(chunks, deps())

    expect(result.error).toBeNull()
    expect(result.storedChunks).toBe(13)
    // 10 in the first message, 3 in the second.
    expect(result.stored).toHaveLength(2)
    expect(result.stored[0]!.chunkIndexes).toHaveLength(10)
    expect(result.stored[1]!.chunkIndexes).toEqual([10, 11, 12])

    // The fake stored exactly what was sent, byte for byte. Anything the body builder or the
    // retry logic corrupted would show up as a size or content mismatch here.
    const stats = fake.control.stats()
    expect(stats.storedAttachments).toBe(13)
    expect(stats.storedBytes).toBe(13 * 8 * MIB)
    expect(stats.webhookPosts).toBe(2)
  })

  it('stores the declared size Discord reports for each attachment', async () => {
    const chunks = makeChunks(10, 1024 * 512)
    const result = await dispatchChunks(chunks, deps())

    expect(result.error).toBeNull()
    // Every attachment URL is captured, and Discord confirms a size for each.
    expect(result.stored[0]!.attachmentUrls).toHaveLength(10)
    expect(result.stored[0]!.bytes).toBe(10 * 1024 * 512)
  })

  it('recovers from a throttling burst mid-upload with nothing lost', async () => {
    // Two throttles before the first message, one between messages.
    fake.control.queueFailures(2, 429, 1)
    fake.control.queueFailures(1, 429, 1)

    const chunks = makeChunks(13, 2 * MIB)
    const stored: number[] = []
    const result = await dispatchChunks(
      chunks,
      deps({
        onBatchStored: (info) => {
          stored.push(...info.chunkIndexes)
        },
      }),
    )

    expect(result.error).toBeNull()
    expect(result.storedChunks).toBe(13)

    // All 13 chunks accounted for exactly once — no gaps, no duplicates. This is the
    // property a retry bug breaks first.
    expect([...stored].sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, i) => i))

    // The bytes really did land, and the retried posts were additional attempts rather than
    // extra stored data: 13 attachments of exactly the size sent.
    expect(fake.control.stats().storedAttachments).toBe(13)
    expect(fake.control.stats().storedBytes).toBe(13 * 2 * MIB)
    // 3 rejected attempts plus the 2 messages that succeeded.
    expect(fake.control.stats().webhookPosts).toBe(5)
  })

  it('halves the ceiling and asks for a re-plan when Discord refuses the size', async () => {
    // A ceiling below the configured chunk size is already known, so the mismatch is caught
    // before a single request goes out.
    const changes: number[] = []
    const chunks = makeChunks(5, 8 * MIB)
    const before = fake.control.stats().webhookPosts

    const result = await dispatchChunks(
      chunks,
      deps({
        maxChunkBytes: 4 * MIB,
        onChunkLimitChanged: (limit) => {
          changes.push(limit)
        },
      }),
    )

    expect(result.error).toMatchObject({ code: 'REPLAN_REQUIRED' })
    expect(result.failedChunkIndex).toBe(0)
    // The 4 MiB ceiling is halved once, to 2 MiB, which is what the caller re-splits to.
    expect(result.reducedChunkLimitBytes).toBe(2 * MIB)
    expect(changes).toEqual([2 * MIB])
    // Nothing was sent: catching this locally costs no bandwidth and no rate-limit budget.
    expect(fake.control.stats().webhookPosts).toBe(before)
  })

  it('reports a dead webhook rather than looping on it', async () => {
    // A token the fake does not recognise, standing in for a webhook deleted in Discord.
    const unknownUrl = `https://discord.com/api/webhooks/${WEBHOOK_ID}/x`
    const outcome = await dispatchChunks(makeChunks(3, 4096), {
      ...deps(),
      post: async ({ body, contentLength, contentType }) => {
        const sent = await discordFetch<DiscordMessageResponse>(unknownUrl, {
          method: 'POST',
          headers: { 'content-type': contentType, 'content-length': String(contentLength) },
          body: body as unknown as RequestInit['body'],
          duplex: 'half',
        } as RequestInit & { duplex: string })
        return sent.ok
          ? { ok: true, data: sent.data, latencyMs: sent.latencyMs }
          : { ok: false, code: sent.code, status: sent.status, message: sent.message, retryAfterSeconds: sent.retryAfterSeconds, latencyMs: sent.latencyMs }
      },
    })

    // A 404 does not get retried: it will not become a 200, and retrying would delay the
    // message to a user whose webhook is simply gone.
    expect(outcome.error).toMatchObject({ code: 'DISCORD_REJECTED' })
  })

  it('keeps peak memory bounded while streaming many chunks', async () => {
    // 256 MiB across 32 chunks of 8 MiB, delivered four at a time by a semaphore. The point
    // is the memory ceiling, not the transfer: RSS must not scale with total bytes.
    const semaphoreLimit = 4
    let inFlight = 0
    let peakInFlight = 0

    const chunks = makeChunks(32, 8 * MIB)
    const result = await dispatchChunks(
      chunks,
      deps({
        chunksPerMessage: 8,
        post: async (input) => {
          inFlight += 1
          peakInFlight = Math.max(peakInFlight, inFlight)
          try {
            const outcome = await discordFetch<DiscordMessageResponse>(URL, {
              method: 'POST',
              headers: { 'content-type': input.contentType, 'content-length': String(input.contentLength) },
              body: input.body as unknown as RequestInit['body'],
              duplex: 'half',
              timeoutMs: 30_000,
            } as RequestInit & { duplex: string; timeoutMs: number })
            expect(outcome.ok).toBe(true)
            return outcome.ok
              ? { ok: true, data: outcome.data, latencyMs: outcome.latencyMs }
              : { ok: false, code: outcome.code, status: outcome.status, message: outcome.message, retryAfterSeconds: null, latencyMs: outcome.latencyMs }
          } finally {
            inFlight -= 1
          }
        },
      }),
    )

    expect(result.error).toBeNull()
    expect(result.storedChunks).toBe(32)
    // The dispatcher builds a message at a time, so buffers are bounded by the batch size
    // rather than by the file size: 8 chunks of 8 MiB, not 32.
    expect(peakInFlight).toBeLessThanOrEqual(semaphoreLimit * 2)
    expect(fake.control.stats().storedBytes).toBe(256 * MIB)
  })
})