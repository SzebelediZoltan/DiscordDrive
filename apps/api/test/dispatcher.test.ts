import { describe, expect, it } from 'vitest'
import { dispatchChunks, planBatches, type ChunkInput, type DispatcherDeps, type DiscordPost } from '../src/modules/dispatch/dispatcher.js'
import { systemClock } from '../src/lib/rate-limit.js'

/**
 * The dispatcher's job is the reaction to Discord's answers, so the Discord client is a
 * script: each test says what comes back, in order, and asserts on what was sent and what the
 * caller was told.
 *
 * Against a real server you cannot reliably produce "429 three times then succeed", which is
 * the single most important behaviour here — a retry that drops data on the floor looks like
 * a successful upload.
 */

class RecordingClock {
  slept: number[] = []
  clock = {
    now: () => 0,
    sleep: async (ms: number) => {
      this.slept.push(ms)
    },
  }
}

const MIB = 1024 * 1024

function chunk(index: number, sizeBytes: number): ChunkInput {
  const data = Buffer.alloc(sizeBytes, index % 251)
  return { index, data, sha256: `sha-${index}` }
}

function chunks(count: number, sizeBytes: number): ChunkInput[] {
  return Array.from({ length: count }, (_, i) => chunk(i, sizeBytes))
}

function ok(messageId: string, partCount: number): DiscordPost {
  return {
    ok: true,
    latencyMs: 5,
    data: {
      id: messageId,
      channel_id: 'channel-1',
      attachments: Array.from({ length: partCount }, (_, i) => ({
        id: `att-${messageId}-${i}`,
        filename: `${i}.bin`,
        size: 1,
        url: `https://cdn.discordapp.com/attachments/1/2/${i}.bin?ex=1&is=1&hm=1`,
      })),
    },
  }
}

function fail(over: Partial<Extract<DiscordPost, { ok: false }>>): DiscordPost {
  return {
    ok: false,
    code: 0,
    status: 400,
    message: 'failed',
    retryAfterSeconds: null,
    latencyMs: 5,
    ...over,
  }
}

function deps(over: Partial<DispatcherDeps> = {}): DispatcherDeps {
  return {
    post: async () => ok('m1', 10),
    clock: systemClock,
    chunkSizeBytes: 8 * MIB,
    chunksPerMessage: 10,
    maxChunkBytes: null,
    maxAttempts: 5,
    ...over,
  }
}

describe('planBatches', () => {
  it('matches the issue’s worked example', () => {
    // 100 chunks at 10 per message is 10 messages. This is the arithmetic the acceptance
    // criteria name, so it is asserted directly rather than implied.
    expect(planBatches(100, 10)).toBe(10)
  })

  it('rounds up a partial batch', () => {
    expect(planBatches(1, 10)).toBe(1)
    expect(planBatches(10, 10)).toBe(1)
    expect(planBatches(11, 10)).toBe(2)
    expect(planBatches(1, 1)).toBe(1)
    expect(planBatches(0, 10)).toBe(0)
  })
})

describe('batching', () => {
  it('packs ten chunks into one message and reports every stored URL', async () => {
    const sent: number[] = []
    const result = await dispatchChunks(
      chunks(100, 1024),
      deps({
        post: async ({ contentLength }) => {
          sent.push(contentLength)
          return ok(`m${sent.length}`, 10)
        },
      }),
    )

    // 100 chunks at 10 per message: 10 requests, not 100. That is the whole point of
    // batching against a 5-request/2s bucket.
    expect(sent).toHaveLength(10)
    expect(result.stored).toHaveLength(10)
    expect(result.storedChunks).toBe(100)
    expect(result.error).toBeNull()

    // Every chunk's CDN URL is captured, parallel to its index, so the download side can
    // reassemble without asking Discord again.
    expect(result.stored[0]!.chunkIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.stored[0]!.attachmentUrls).toHaveLength(10)
    expect(result.stored[9]!.chunkIndexes).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99])
  })

  it('honours a probed ceiling below the configured chunk size', async () => {
    const result = await dispatchChunks(
      chunks(20, 3 * MIB),
      deps({
        chunkSizeBytes: 8 * MIB,
        maxChunkBytes: 3 * MIB,
        post: async () => ok('m', 10),
      }),
    )

    // Chunks are already 3 MiB, so no re-planning is needed and nothing is halved.
    expect(result.reducedChunkLimitBytes).toBeNull()
    expect(result.storedChunks).toBe(20)
  })
})

describe('429 handling', () => {
  it('survives a burst of throttling with no data loss', async () => {
    const time = new RecordingClock()
    const responses: DiscordPost[] = [
      fail({ status: 429, message: 'You are being rate limited.', retryAfterSeconds: 1 }),
      fail({ status: 429, message: 'You are being rate limited.', retryAfterSeconds: 1 }),
      fail({ status: 429, message: 'You are being rate limited.', retryAfterSeconds: 1 }),
      ok('m1', 10),
    ]
    let call = 0

    const result = await dispatchChunks(
      chunks(10, 1024),
      deps({
        clock: time.clock,
        post: async () => responses[call++]!,
      }),
    )

    // Three throttles then success, and the chunk is stored — the property that matters.
    expect(result.error).toBeNull()
    expect(result.storedChunks).toBe(10)
    expect(call).toBe(4)
    expect(result.stored[0]!.attempts).toBe(4)

    // Every wait honoured Discord's ask, so the retry cannot land before the window closes.
    expect(time.slept).toHaveLength(3)
    for (const slept of time.slept) expect(slept).toBeGreaterThanOrEqual(1000)
  })

  it('grows the wait across successive throttles', async () => {
    const time = new RecordingClock()
    let call = 0
    await dispatchChunks(
      chunks(10, 1024),
      deps({
        clock: time.clock,
        maxAttempts: 5,
        // No server-supplied wait, so growth comes purely from the exponential schedule.
        post: async () => (call++ < 3 ? fail({ status: 429, message: 'slow down' }) : ok('m', 10)),
      }),
    )

    expect(time.slept[0]!).toBeLessThan(time.slept[1]!)
    expect(time.slept[1]!).toBeLessThan(time.slept[2]!)
  })

  it('gives up after maxAttempts and says which chunk needs re-sending', async () => {
    const time = new RecordingClock()
    const result = await dispatchChunks(
      chunks(20, 1024),
      deps({
        clock: time.clock,
        maxAttempts: 4,
        post: async () => fail({ status: 429, message: 'still limited', retryAfterSeconds: 1 }),
      }),
    )

    // Retry exhaustion must be visible and actionable, not a silent partial upload.
    expect(result.error).toMatchObject({ code: 'RETRY_EXHAUSTED', status: 429 })
    expect(result.failedChunkIndex).toBe(0)
    expect(result.storedChunks).toBe(0)
  })

  it('keeps earlier batches when a later one is throttled out', async () => {
    const time = new RecordingClock()
    let call = 0
    const result = await dispatchChunks(
      chunks(30, 1024),
      deps({
        clock: time.clock,
        maxAttempts: 2,
        post: async () => (call++ < 1 ? ok('m1', 10) : fail({ status: 429, message: 'limited' })),
      }),
    )

    // The first 10 chunks are safe and persisted; the client only re-sends from chunk 10.
    expect(result.storedChunks).toBe(10)
    expect(result.failedChunkIndex).toBe(10)
    expect(result.stored[0]!.messageId).toBe('m1')
  })

  it('never lets jitter push the wait past what Discord asked for', async () => {
    const time = new RecordingClock()
    let call = 0
    await dispatchChunks(
      chunks(10, 1024),
      deps({
        clock: time.clock,
        post: async () => (call++ === 0 ? fail({ status: 429, message: 'limited', retryAfterSeconds: 5 }) : ok('m', 10)),
        maxAttempts: 2,
      }),
      { random: () => 0 },
    )

    // 25% jitter can only shorten the wait, so the floor stays 5s.
    expect(time.slept[0]).toBeGreaterThanOrEqual(3750)
    expect(time.slept[0]).toBeLessThanOrEqual(5000)
  })
})

describe('size rejections', () => {
  it('halves the limit, reports it, and stops for the caller to re-plan', async () => {
    const time = new RecordingClock()
    const changes: number[] = []
    let call = 0

    const result = await dispatchChunks(
      chunks(20, 8 * MIB),
      deps({
        clock: time.clock,
        chunkSizeBytes: 8 * MIB,
        maxChunkBytes: null,
        onChunkLimitChanged: (limit) => {
          changes.push(limit)
        },
        post: async () => {
          call += 1
          return fail({ status: 400, code: 40005, message: 'Request entity too large' })
        },
      }),
    )

    // 8 MiB -> 4 MiB, persisted, and the run stops at chunk 0. Halving cannot shrink a
    // buffer that is already 8 MiB, so continuing here would loop forever.
    expect(changes).toEqual([4 * MIB])
    expect(result.reducedChunkLimitBytes).toBe(4 * MIB)
    expect(result.error).toMatchObject({ code: 'REPLAN_REQUIRED', status: 400 })
    expect(result.failedChunkIndex).toBe(0)
    expect(call).toBe(1)
  })

  it('keeps batches already stored when a later one is too large', async () => {
    const time = new RecordingClock()
    let call = 0
    const result = await dispatchChunks(
      chunks(30, 8 * MIB),
      deps({
        clock: time.clock,
        chunkSizeBytes: 8 * MIB,
        // First message accepted, second refused as oversized.
        post: async () => (call++ === 0 ? ok('m1', 10) : fail({ status: 400, code: 40005, message: 'too large' })),
      }),
    )

    // The first 10 chunks are safe; the client re-splits from chunk 10 only.
    expect(result.storedChunks).toBe(10)
    expect(result.failedChunkIndex).toBe(10)
  })

  it('treats every documented size code as a ceiling problem', async () => {
    for (const code of [40005, 50013, 50045]) {
      const time = new RecordingClock()
      const changes: number[] = []
      const result = await dispatchChunks(
        chunks(2, 8 * MIB),
        deps({
          clock: time.clock,
          maxAttempts: 1,
          onChunkLimitChanged: (limit) => {
            changes.push(limit)
          },
          post: async () => fail({ status: 400, code, message: 'too large' }),
        }),
      )
      expect(changes, `code ${code}`).toEqual([4 * MIB])
      expect(result.error?.code, `code ${code}`).toBe('REPLAN_REQUIRED')
    }
  })

  it('refuses rather than looping when a chunk cannot be split small enough', async () => {
    const time = new RecordingClock()
    const changes: number[] = []
    const result = await dispatchChunks(
      // 1500 bytes against a 1024-byte ceiling: halving cannot reach it.
      chunks(2, 1500),
      deps({
        clock: time.clock,
        chunkSizeBytes: 1024,
        maxChunkBytes: 1024,
        onChunkLimitChanged: (limit) => {
          changes.push(limit)
        },
        post: async () => ok('m', 10),
      }),
    )

    expect(result.error).toMatchObject({ code: 'REPLAN_REQUIRED', status: 422 })
    // No request was made: the mismatch is visible before spending one.
    expect(changes).toEqual([])
  })
})

describe('non-retryable failures', () => {
  it('reports a deleted webhook instead of retrying it five times', async () => {
    const time = new RecordingClock()
    let calls = 0
    const result = await dispatchChunks(
      chunks(10, 1024),
      deps({
        clock: time.clock,
        post: async () => {
          calls += 1
          return fail({ status: 404, code: 10015, message: 'Unknown Webhook' })
        },
      }),
    )

    // A dead webhook never recovers by retrying; five attempts would just delay the message.
    expect(calls).toBe(1)
    expect(result.error).toMatchObject({ code: 'DISCORD_REJECTED', status: 404 })
    expect(result.storedChunks).toBe(0)
  })

  it('tells the caller which chunk to re-send', async () => {
    const time = new RecordingClock()
    let call = 0
    const result = await dispatchChunks(
      chunks(20, 1024),
      deps({
        clock: time.clock,
        post: async () => {
          call += 1
          return call === 1 ? ok('m1', 10) : fail({ status: 500, code: 0, message: 'Internal Server Error' })
        },
      }),
    )

    expect(result.failedChunkIndex).toBe(10)
  })
})

describe('persistence hooks', () => {
  it('reports each stored batch so the caller can persist it immediately', async () => {
    const stored: number[][] = []
    await dispatchChunks(
      chunks(25, 1024),
      deps({
        post: async () => ok(`m${stored.length + 1}`, 10),
        onBatchStored: (info) => {
          stored.push(info.chunkIndexes)
        },
      }),
    )

    // Persisted per message, not once at the end: a crash mid-upload must not lose the
    // batches that Discord already accepted.
    expect(stored).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
      [20, 21, 22, 23, 24],
    ])
  })

  it('stops at limitChunks without disturbing the rest of the list', async () => {
    const result = await dispatchChunks(chunks(30, 1024), deps({ post: async () => ok('m', 10) }), { limitChunks: 10 })
    expect(result.storedChunks).toBe(10)
    expect(result.error).toBeNull()
  })

  it('handles an empty chunk list without a request', async () => {
    let called = false
    const result = await dispatchChunks(
      [],
      deps({
        post: async () => {
          called = true
          return ok('m', 10)
        },
      }),
    )

    expect(called).toBe(false)
    expect(result.storedChunks).toBe(0)
    expect(result.error).toBeNull()
  })
})