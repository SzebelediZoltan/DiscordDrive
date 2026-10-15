/**
 * Timing primitives for talking to Discord politely.
 *
 * Everything here exists because Discord rate-limits per webhook, not per account: roughly
 * 5 webhook POSTs per 2 seconds, and posting over that earns a 429 with a wait time that has
 * to be honoured exactly. Getting this wrong is not a soft failure — it is a silently
 * truncated upload, or a ban.
 *
 * These are deliberately free of I/O and of Discord-specific vocabulary, so they can be
 * tested deterministically against an injected clock rather than by sleeping.
 */

/** Injectable clock and timer, so tests can advance time without waiting for it. */
export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      // setTimeout with a negative delay fires immediately, which is what we want for a
      // zero wait rather than an error.
      setTimeout(resolve, Math.max(0, ms))
    }),
}

export interface TokenBucketOptions {
  /** Sustained rate, in tokens (requests) per second. */
  ratePerSecond: number
  /** Burst allowance. Discord's bucket holds a small number of immediate requests. */
  capacity: number
  clock: Clock
}

/**
 * A token bucket: allows `capacity` requests back to back, then refills at
 * `ratePerSecond`, and queues callers otherwise.
 *
 * Used to smooth requests to a single webhook. The alternative — a fixed sleep between
 * requests — either wastes the burst allowance Discord grants, or exceeds it after the first
 * few requests and eats 429s.
 *
 * Fairness: waiters are served in arrival order. Out-of-order service would let a late
 * arrival jump the queue repeatedly and starve an earlier upload, which for a user watching
 * a progress bar looks like a hang.
 */
export class TokenBucket {
  private readonly ratePerSecond: number
  private readonly capacity: number
  private readonly clock: Clock

  private tokens: number
  private lastRefill: number
  /** Callers waiting for a token, in arrival order. */
  private waiters: Array<() => void> = []
  /** True while the drain loop is running, so it is started at most once. */
  private draining = false

  constructor(options: TokenBucketOptions) {
    if (options.ratePerSecond <= 0) throw new Error('ratePerSecond must be positive')
    if (options.capacity <= 0) throw new Error('capacity must be positive')

    this.ratePerSecond = options.ratePerSecond
    this.capacity = options.capacity
    this.clock = options.clock
    this.tokens = options.capacity
    this.lastRefill = options.clock.now()
  }

  /** Takes a token if one is free right now, otherwise returns 0. Does not queue. */
  tryAcquire(): number {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return 0
    }
    const missing = 1 - this.tokens
    return Math.ceil((missing / this.ratePerSecond) * 1000)
  }

  /**
   * Waits until a token is available, then consumes it.
   *
   * Resolves only after the token has actually been taken, so queued callers never wake
   * together and race for the same token.
   */
  async acquire(): Promise<void> {
    if (this.tryAcquire() === 0) return

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
      this.startDraining()
    })
  }

  /**
   * Serves waiters from the front, one at a time, sleeping through the injected clock
   * between them.
   *
   * A single drain loop rather than one timer per waiter: the ordering guarantee is what
   * makes fairness provable, and every waiter sleeping independently would let a later
   * arrival overtake an earlier one whenever their computed delays happened to differ.
   */
  /** Credits the tokens earned since the last call, up to capacity. */
  private refill(): void {
    const now = this.clock.now()
    const elapsed = now - this.lastRefill
    if (elapsed <= 0) return

    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.ratePerSecond)
    this.lastRefill = now
  }

  private startDraining(): void {
    if (this.draining) return
    this.draining = true
    void this.drain()
  }

  private async drain(): Promise<void> {
    try {
      while (this.waiters.length > 0) {
        const wait = this.tryAcquire()
        // A token was free: serve the head and continue immediately.
        if (wait === 0) {
          this.waiters.shift()?.()
          continue
        }

        await this.clock.sleep(wait)

        // Re-acquire rather than decrementing directly. Sleeping does not refill the bucket
        // on its own, so taking a token here without a refill hands out a token that was
        // never earned — and lets two waiters be served inside one interval, which is the
        // rate-limit violation this whole class exists to prevent.
        if (this.tryAcquire() === 0) this.waiters.shift()?.()
      }
    } finally {
      // Cleared before returning so a waiter enqueued during the final await still starts
      // a drain rather than waiting on a loop that has already exited.
      this.draining = false
    }
  }

  /** Number of callers currently waiting. Used by tests and by the health endpoint. */
  get queued(): number {
    return this.waiters.length
  }
}

export interface SemaphoreOptions {
  limit: number
  clock: Clock
}

/**
 * A counting semaphore bounding concurrent work.
 *
 * Distinct from the bucket: this caps how many requests are *in flight*, where the bucket
 * paces how often they *start*. Both are needed — pacing alone still allows N concurrent
 * bodies in memory, and a concurrency cap alone still bursts.
 */
export class Semaphore {
  private readonly limit: number
  private inFlight = 0
  private waiters: Array<() => void> = []

  constructor(options: SemaphoreOptions) {
    if (options.limit < 1) throw new Error('limit must be at least 1')
    this.limit = options.limit
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.limit) {
      this.inFlight += 1
      return
    }
    // Queued rather than rejected: the caller asked to upload, not to be told to come back.
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.inFlight += 1
  }

  private release(): void {
    this.inFlight -= 1
    this.waiters.shift()?.()
  }

  get active(): number {
    return this.inFlight
  }

  get waiting(): number {
    return this.waiters.length
  }
}

export interface BackoffOptions {
  /** First retry's delay, before growth. */
  baseMs: number
  /** Ceiling for a single wait. */
  maxMs: number
  /** 0 to 1. Fraction of the delay that may be randomised, to spread out retries. */
  jitter: number
  /** Injectable for tests. Must return a value in [0, 1). */
  random?: () => number
}

/**
 * Exponential backoff with full jitter.
 *
 * Discord asks for a specific wait via `retry_after`. That wait is a floor, not a
 * replacement: it says when the current window frees up, and several requests may be queued
 * behind it. So the computed delay is `max(askedFor, exponential)`, then jittered.
 *
 * Jitter matters more than usual here because every client in the world is throttled by the
 * same bucket at the same time. Without it, every retry lands simultaneously and re-creates
 * the burst that caused the 429.
 */
export function backoffDelay(
  attempt: number,
  askedForMs: number | null,
  options: BackoffOptions,
): number {
  const { baseMs, maxMs, jitter, random = Math.random } = options

  // attempt is 1-based: the first retry has not grown yet.
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1))

  // A non-finite ask is discarded rather than allowed through `Math.max`, which propagates
  // NaN: a garbage header would otherwise produce a NaN delay and either never retry or
  // retry instantly, depending on how it reached the timer.
  const asked = askedForMs !== null && Number.isFinite(askedForMs) && askedForMs > 0 ? askedForMs : 0

  // Discord's ask is a floor, not a suggestion: its window is still closed until then.
  const base = Math.max(asked, exponential)
  if (jitter <= 0) return base

  // Jitter only ever *adds* delay, up to `jitter * base`. Subtracting instead would let a
  // retry land before the window Discord said was closed, turning a handled 429 straight back
  // into a 429 — and spreading retries is what jitter is for anyway, which longer waits do
  // just as well as shorter ones.
  return Math.round(base + random() * base * jitter)
}
