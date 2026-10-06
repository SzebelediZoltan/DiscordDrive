import { Semaphore, TokenBucket, systemClock } from '../../lib/rate-limit.js'
import { loadEnv } from '../../config/env.js'
import { discordFetch } from '../webhooks/discord.client.js'
import type { DispatcherDeps, DiscordMessageResponse, DiscordPost, StoredBatch } from './dispatcher.js'

/**
 * The bridge between the dispatcher and a live webhook: pacing, concurrency, and the HTTP
 * call itself.
 *
 * Discord budgets webhook POSTs per webhook — about 5 per 2 seconds — so the limiter is
 * keyed by webhook rather than global. Two uploads through different webhooks should not
 * queue behind each other, and one runaway upload should not consume another's budget.
 *
 * Both limits apply, in this order, because they fail differently. The semaphore bounds how
 * many bodies exist at once; the bucket bounds how often requests start. Pacing without a
 * concurrency cap still allows N simultaneous bodies, and a cap without pacing still
 * bursts into 429s.
 */

/**
 * Discord's documented webhook budget: 5 requests per 2 seconds. Stated as burst and window
 * rather than as a rate, because the burst is what the token bucket models — a flat 2.5/s
 * would refuse the first 5 requests that Discord would have accepted.
 */
const WEBHOOK_BURST = 5
const WEBHOOK_WINDOW_MS = 2000

interface Limiter {
  bucket: TokenBucket
  semaphore: Semaphore
}

const limiters = new Map<string, Limiter>()
let globalSemaphore: Semaphore | null = null

/**
 * Bounds the limiter registry.
 *
 * Webhooks are identified by cuid, so a long-running process would otherwise accumulate one
 * entry per webhook ever used. Clearing wholesale is acceptable because a limiter is cheap
 * to rebuild and the bucket refills from the clock anyway.
 */
const MAX_LIMITERS = 512

function limiterFor(webhookId: string): Limiter {
  const existing = limiters.get(webhookId)
  if (existing) return existing

  if (limiters.size >= MAX_LIMITERS) limiters.clear()

  const created: Limiter = {
    bucket: new TokenBucket({
      ratePerSecond: (WEBHOOK_BURST * 1000) / WEBHOOK_WINDOW_MS,
      capacity: WEBHOOK_BURST,
      clock: systemClock,
    }),
    semaphore: new Semaphore({ limit: loadEnv().DISCORD_CONCURRENCY, clock: systemClock }),
  }
  limiters.set(webhookId, created)
  return created
}

/** Drops all pacing state. Tests use it so one case cannot inherit another's queue. */
export function resetGateway(): void {
  limiters.clear()
  globalSemaphore = null
}

export interface DispatcherDepsConfig {
  webhookRowId: string
  discordWebhookUrl: string
  chunkSizeBytes: number
  chunksPerMessage: number
  maxChunkBytes: number | null
  maxAttempts: number
  globalConcurrency: number
  onBatchStored?: DispatcherDeps['onBatchStored']
  onChunkLimitChanged?: DispatcherDeps['onChunkLimitChanged']
}

export function buildDispatcherDeps(config: DispatcherDepsConfig): DispatcherDeps {
  const limiter = limiterFor(config.webhookRowId)
  globalSemaphore ??= new Semaphore({ limit: config.globalConcurrency, clock: systemClock })

  return {
    clock: systemClock,
    chunkSizeBytes: config.chunkSizeBytes,
    chunksPerMessage: config.chunksPerMessage,
    maxChunkBytes: config.maxChunkBytes,
    maxAttempts: config.maxAttempts,
    onBatchStored: config.onBatchStored,
    onChunkLimitChanged: config.onChunkLimitChanged,
    post: async (input): Promise<DiscordPost> =>
      // Global first, then per-webhook: acquiring in the other order lets a request hold a
      // per-webhook slot while waiting for a global one, which is how nested semaphores
      // deadlock.
      globalSemaphore!.run(() =>
        limiter.semaphore.run(async () => {
          await limiter.bucket.acquire()
          return discordFetch<DiscordMessageResponse>(config.discordWebhookUrl, {
            method: 'POST',
            headers: {
              'content-type': input.contentType,
              'content-length': String(input.contentLength),
            },
            body: input.body as unknown as RequestInit['body'],
            // Node's fetch requires an explicit duplex mode when the body is a stream; it
            // is not part of the DOM RequestInit type.
            duplex: 'half',
            timeoutMs: 120_000,
          } as RequestInit & { timeoutMs?: number; duplex?: string })
        }),
      ),
  }
}

export type { StoredBatch }
