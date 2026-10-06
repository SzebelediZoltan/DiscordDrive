import { describe, expect, it } from 'vitest'
import { dispatchChunks, planBatches, type ChunkInput, type DispatcherDeps } from '../src/modules/dispatch/dispatcher.js'

/**
 * The memory bound is an acceptance criterion, so it is measured rather than asserted by
 * inspection.
 *
 * Chunks are generated lazily, one batch at a time, exactly as the upload API will do — the
 * generator holds only the current batch, so a 1 GB file never materialises. What is
 * asserted is that the process's heap grows with the *batch*, not with the *file*, and that
 * the peak stays under the compose memory limit even though the file does not exist in
 * memory at any point.
 *
 * Buffer allocation is charged to external/array-buffer memory rather than the V8 heap, so
 * RSS is sampled instead. Sampling is the honest measurement here: it is what the container
 * limit actually applies to.
 */

const MIB = 1024 * 1024
// Mirrors the api service's mem_limit in docker-compose.yml.
const COMPOSE_MEM_LIMIT_MIB = Number(process.env.COMPOSE_MEM_LIMIT_MIB ?? 1024)

/**
 * Yields `count` chunks of `sizeBytes`, holding at most `batchSize` at a time.
 *
 * This is the streaming shape: the caller keeps a small window alive and lets the rest be
 * garbage collected, which is how the upload endpoint avoids buffering a whole file.
 */
async function* streamChunks(count: number, sizeBytes: number, batchSize: number): AsyncGenerator<ChunkInput[]> {
  for (let offset = 0; offset < count; offset += batchSize) {
    const batch: ChunkInput[] = []
    for (let i = offset; i < Math.min(offset + batchSize, count); i += 1) {
      batch.push({ index: i, data: Buffer.alloc(sizeBytes, i % 256), sha256: `sha-${i}` })
    }
    yield batch
    // Yield to the event loop so the sampler can observe the peak, and so the previous
    // batch is collectable before the next is allocated.
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function rssMib(): number {
  return process.memoryUsage.rss() / MIB
}

/** Peak RSS while `fn` runs, sampled on a timer, plus the RSS it started from. */
async function withPeakRss<T>(fn: () => Promise<T>): Promise<{ result: T; peakMib: number; baselineMib: number }> {
  const baselineMib = rssMib()
  let peak = baselineMib
  const timer = setInterval(() => {
    peak = Math.max(peak, rssMib())
  }, 5)
  timer.unref()

  try {
    const result = await fn()
    return { result, peakMib: Math.max(peak, rssMib()), baselineMib }
  } finally {
    clearInterval(timer)
  }
}

/** A sink that accepts the batches and counts them without retaining anything. */
function sinkingDeps(bytesPerMessage: number): DispatcherDeps {
  return {
    post: async () => ({
      ok: true,
      latencyMs: 1,
      data: {
        id: 'msg',
        channel_id: 'chan',
        attachments: Array.from({ length: bytesPerMessage / (8 * MIB) }, () => ({ filename: 'x.bin', size: 8 * MIB, url: 'https://cdn/x' })),
      },
    }),
    clock: { now: () => Date.now(), sleep: async () => {} },
    chunkSizeBytes: 8 * MIB,
    chunksPerMessage: 10,
    maxChunkBytes: 25 * MIB,
    maxAttempts: 5,
  }
}

describe('memory behaviour under a simulated 1 GB upload', () => {
  it('keeps peak RSS under the compose limit while streaming 1 GB', async () => {
    const chunkSize = 8 * MIB
    const totalChunks = (1024 * MIB) / chunkSize // 128

    const { peakMib } = await withPeakRss(async () => {
      let messages = 0

      for await (const batch of streamChunks(totalChunks, chunkSize, 10)) {
        const result = await dispatchChunks(batch, sinkingDeps(chunkSize * batch.length))
        expect(result.error).toBeNull()
        messages += result.stored.length
      }

      // 128 chunks at 10 per message: 13 messages. Matches the issue's worked example.
      expect(messages).toBe(13)
    })

    // The hard requirement: the container survives the upload. The compose mem_limit is what
    // actually kills a misbehaving process, so this is the assertion that has teeth.
    expect(peakMib).toBeLessThan(COMPOSE_MEM_LIMIT_MIB)
  }, 120_000)

  it('plateaus rather than scaling with file size', async () => {
    // The property that matters, and the one a whole-file buffer would fail: peak memory
    // must not track the number of bytes uploaded. RSS is not expected to return to
    // baseline — Node's allocator retains freed buffers — but it must stop growing.
    const run = async (totalChunks: number) =>
      withPeakRss(async () => {
        for await (const batch of streamChunks(totalChunks, 8 * MIB, 10)) {
          await dispatchChunks(batch, sinkingDeps(8 * MIB * batch.length))
        }
      })

    // 1 GB, then 3 GB. The second run is three times the traffic.
    const oneGb = await run(128)
    const threeGb = await run(384)

    // Well under the limit for both.
    expect(threeGb.peakMib).toBeLessThan(COMPOSE_MEM_LIMIT_MIB)

    // RSS is cumulative inside one process — the allocator keeps freed buffers between
    // runs — so absolute peaks inflate run two with run one's leftover. Measuring the
    // growth *during* each run isolates the streaming cost, which is the property under
    // test: three times the data must not cost three times the memory. A generous 25%
    // allowance catches a whole-file buffering implementation while keeping the
    // assertion immune to allocator nondeterminism.
    const oneGbGrowth = oneGb.peakMib - oneGb.baselineMib
    const threeGbGrowth = threeGb.peakMib - threeGb.baselineMib
    expect(threeGbGrowth).toBeLessThan(oneGbGrowth * 1.25)
  }, 180_000)

  it('sends 100 chunks as 10 messages of 10', async () => {
    // The acceptance criterion stated directly: 10 chunks per message, so 100 chunks is
    // 10 messages rather than 100 requests.
    expect(planBatches(100, 10)).toBe(10)

    let messages = 0
    let chunksStored = 0
    for await (const batch of streamChunks(100, MIB, 10)) {
      const result = await dispatchChunks(batch, sinkingDeps(10 * MIB))
      messages += result.stored.length
      chunksStored += result.storedChunks
    }

    expect(chunksStored).toBe(100)
    expect(messages).toBe(10)
  }, 60_000)

  it('does not accumulate across many uploads', async () => {
    // A per-upload leak would only show up on a long-lived server, which is exactly the
    // deployment this app has.
    const measure = async () => {
      for await (const batch of streamChunks(10, 8 * MIB, 10)) {
        await dispatchChunks(batch, sinkingDeps(8 * MIB * batch.length))
      }
      return rssMib()
    }

    await measure() // warm up: the first run pays for lazily-initialised structures
    const before = rssMib()
    for (let i = 0; i < 5; i += 1) await measure()
    const after = rssMib()

    // Five more 80 MiB uploads — 400 MiB of traffic — must not cost anything like 400 MiB of
    // resident memory.
    expect(after - before).toBeLessThan(128)
  }, 180_000)
})