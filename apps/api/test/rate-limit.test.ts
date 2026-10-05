import { describe, expect, it, vi } from 'vitest'
import { backoffDelay, Semaphore, TokenBucket, type Clock } from '../src/lib/rate-limit.js'

/**
 * Timing behaviour is tested against a fake clock, never with real sleeps.
 *
 * A test that actually waits 400 ms to prove a token bucket paces correctly is both slow and
 * flaky — it passes on a fast machine and fails on a loaded one. Here the clock only moves
 * when a test says so, so the assertions are exact.
 */

class FakeClock implements Clock {
  private current: number
  /** Pending sleeps, resolved when time advances past them. */
  private sleepers: Array<{ at: number; resolve: () => void }> = []

  constructor(start = 1_000_000) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepers.push({ at: this.current + Math.max(0, ms), resolve })
      this.drain()
    })
  }

  /** Moves time forward, firing any sleeps that come due. */
  advance(ms: number): void {
    this.current += ms
    this.drain()
  }

  private drain(): void {
    // Repeat: resolving one sleeper may synchronously queue another that is already due.
    for (;;) {
      const due = this.sleepers.filter((s) => s.at <= this.current)
      if (due.length === 0) return
      for (const sleeper of due) {
        this.sleepers.splice(this.sleepers.indexOf(sleeper), 1)
        sleeper.resolve()
      }
    }
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('TokenBucket', () => {
  it('allows a burst up to capacity with no waiting', async () => {
    const clock = new FakeClock()
    const bucket = new TokenBucket({ ratePerSecond: 2.5, capacity: 5, clock })

    for (let i = 0; i < 5; i += 1) {
      // 5 per 2s is 2.5/s.
      expect(bucket.tryAcquire()).toBe(0)
    }
  })

  it('reports the wait needed once the burst is spent', () => {
    const clock = new FakeClock()
    const bucket = new TokenBucket({ ratePerSecond: 2.5, capacity: 5, clock })

    for (let i = 0; i < 5; i += 1) bucket.tryAcquire()

    // 2.5 tokens/sec means one token every 400ms.
    expect(bucket.tryAcquire()).toBe(400)
  })

  it('refills over time and never past capacity', async () => {
    const clock = new FakeClock()
    const bucket = new TokenBucket({ ratePerSecond: 2.5, capacity: 5, clock })
    for (let i = 0; i < 5; i += 1) bucket.tryAcquire()

    clock.advance(400)
    expect(bucket.tryAcquire()).toBe(0)
    expect(bucket.tryAcquire()).toBe(400)

    // Idle for a long time: capped at capacity, so a burst cannot exceed Discord's limit
    // just because the server sat idle.
    clock.advance(60_000)
    for (let i = 0; i < 5; i += 1) expect(bucket.tryAcquire()).toBe(0)
    expect(bucket.tryAcquire()).toBe(400)
  })

  it('paces queued acquire() calls without exceeding the rate', async () => {
    const clock = new FakeClock()
    const bucket = new TokenBucket({ ratePerSecond: 2.5, capacity: 2, clock })

    const stamps: number[] = []
    const take = () =>
      bucket.acquire().then(() => {
        stamps.push(clock.now())
      })

    const all = Promise.all([take(), take(), take(), take(), take()])

    // Nothing is waiting yet: the burst is free.
    await flush()
    expect(stamps).toHaveLength(2)

    // Let the clock run far enough that every remaining waiter is served.
    for (let i = 0; i < 20 && stamps.length < 5; i += 1) {
      clock.advance(400)
      await flush()
    }
    await all

    expect(stamps).toHaveLength(5)

    // The burst allowance is spent free — that is the point of a capacity above 1 — so
    // spacing only applies once the bucket is empty.
    expect(stamps[1]! - stamps[0]!).toBe(0)

    // Everything after the burst is paced: at 2.5 tokens/sec, 400ms apart.
    for (let i = 2; i < stamps.length; i += 1) {
      expect(stamps[i]! - stamps[i - 1]!).toBeGreaterThanOrEqual(400)
    }
  })

  it('serves waiters in arrival order so none starves', async () => {
    const clock = new FakeClock()
    const bucket = new TokenBucket({ ratePerSecond: 1, capacity: 1, clock })
    bucket.tryAcquire()

    const order: number[] = []
    const waiters = [1, 2, 3, 4].map((id) =>
      bucket.acquire().then(() => {
        order.push(id)
      }),
    )

    for (let i = 0; i < 10; i += 1) {
      clock.advance(1000)
      await flush()
    }
    await Promise.all(waiters)

    expect(order).toEqual([1, 2, 3, 4])
  })

  it('rejects a nonsensical configuration rather than dividing by zero later', () => {
    const clock = new FakeClock()
    expect(() => new TokenBucket({ ratePerSecond: 0, capacity: 1, clock })).toThrow()
    expect(() => new TokenBucket({ ratePerSecond: 1, capacity: 0, clock })).toThrow()
  })
})

describe('Semaphore', () => {
  it('never exceeds its limit', async () => {
    const clock = new FakeClock()
    const sem = new Semaphore({ limit: 3, clock })
    let active = 0
    let peak = 0

    await Promise.all(
      Array.from({ length: 20 }, () =>
        sem.run(async () => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((resolve) => setImmediate(resolve))
          active -= 1
        }),
      ),
    )

    expect(peak).toBe(3)
    expect(sem.active).toBe(0)
  })

  it('releases the slot when the body throws', async () => {
    const clock = new FakeClock()
    const sem = new Semaphore({ limit: 1, clock })

    await expect(
      sem.run(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // A leaked slot here would deadlock every later upload, so this is worth asserting.
    expect(sem.active).toBe(0)
    await expect(sem.run(async () => 'recovered')).resolves.toBe('recovered')
  })

  it('queues rather than rejecting when full', async () => {
    const clock = new FakeClock()
    const sem = new Semaphore({ limit: 1, clock })
    let secondStarted = false

    const first = sem.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    const second = sem.run(async () => {
      secondStarted = true
    })

    await flush()
    expect(secondStarted).toBe(false)

    await Promise.all([first, second])
    expect(secondStarted).toBe(true)
  })
})

describe('backoffDelay', () => {
  const options = { baseMs: 500, maxMs: 30_000, jitter: 0, random: () => 0.5 }

  it('grows exponentially from the first retry', () => {
    expect(backoffDelay(1, null, { ...options })).toBe(500)
    expect(backoffDelay(2, null, { ...options })).toBe(1000)
    expect(backoffDelay(3, null, { ...options })).toBe(2000)
    expect(backoffDelay(4, null, { ...options })).toBe(4000)
  })

  it('is capped so a long outage cannot stall an upload indefinitely', () => {
    expect(backoffDelay(20, null, { ...options })).toBe(30_000)
    expect(backoffDelay(50, null, { ...options })).toBe(30_000)
  })

  it('waits at least as long as Discord asked, even when the exponential is smaller', () => {
    // Discord said 3 seconds. Growing from 500ms would retry into a limit still closed.
    expect(backoffDelay(1, 3000, { ...options })).toBe(3000)
    // And an even larger ask wins over the exponential.
    expect(backoffDelay(3, 60_000, { ...options })).toBe(60_000)
  })

  it('never waits less than what Discord asked, even at maximum jitter', () => {
    const asked = 5000
    // random() returns 0: the shortest wait jitter can produce. Even so it must not undercut
    // the server, or the retry lands inside a window that is still closed.
    const delay = backoffDelay(1, asked, { baseMs: 500, maxMs: 30_000, jitter: 0.5, random: () => 0 })
    expect(delay).toBe(asked)
  })

  it('keeps jittered delays inside their bounds across many draws', () => {
    const base = 1000
    const jitter = 0.3
    // Attempt 3 on a 500ms base is 2000ms, which is what gets jittered here.
    const delays = Array.from({ length: 500 }, () =>
      backoffDelay(1, base, { baseMs: base, maxMs: 30_000, jitter, random: Math.random }),
    )

    for (const delay of delays) {
      // Jitter spreads retries by waiting longer, never by waiting less than committed.
      expect(delay).toBeGreaterThanOrEqual(base)
      expect(delay).toBeLessThanOrEqual(base * (1 + jitter))
    }

    // Jitter that never varied would defeat the purpose, so the spread must be real.
    expect(new Set(delays).size).toBeGreaterThan(50)
  })

  it('adds jitter on top of the exponential too', () => {
    const delays = Array.from({ length: 200 }, () =>
      backoffDelay(3, null, { baseMs: 500, maxMs: 30_000, jitter: 0.25, random: Math.random }),
    )
    // Attempt 3 is 2000ms before jitter.
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(2000)
      expect(delay).toBeLessThanOrEqual(2500)
    }
  })

  it('spreads a burst of retries that would otherwise be identical', () => {
    const fixed = Array.from({ length: 100 }, () =>
      backoffDelay(2, null, { baseMs: 500, maxMs: 30_000, jitter: 0.25, random: () => 0 }),
    )
    expect(new Set(fixed).size).toBe(1)

    const spread = Array.from({ length: 100 }, () =>
      backoffDelay(2, null, { baseMs: 500, maxMs: 30_000, jitter: 0.25, random: Math.random }),
    )
    expect(new Set(spread).size).toBeGreaterThan(20)
  })

  it('treats a zero or absent wait as no floor', () => {
    expect(backoffDelay(1, 0, { ...options })).toBe(500)
    expect(backoffDelay(1, null, { ...options })).toBe(500)
  })

  it('discards a nonsense wait rather than propagating it', () => {
    // `Math.max(NaN, x)` is NaN, so an unguarded header here would yield a NaN delay.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(backoffDelay(1, bad, { ...options })).toBe(500)
    }
  })
})