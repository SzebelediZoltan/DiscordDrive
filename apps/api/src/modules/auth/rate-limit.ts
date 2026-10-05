/**
 * Deliberately not a shared cache: rate-limit state is per-process and per-IP, and a
 * login flood is not the workload that needs cross-instance coordination. A multi-node
 * deployment should put a real limiter at the edge; this exists so a single process is
 * not trivially brute-forceable.
 */

interface Bucket {
  failures: number[]
  successes: number[]
  lockedUntil: number | null
}

const buckets = new Map<string, Bucket>()

const SWEEP_INTERVAL_MS = 60_000
let lastSweep = Date.now()

function sweep(windowMs: number, now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return
  lastSweep = now
  for (const [key, bucket] of buckets) {
    bucket.failures = bucket.failures.filter((t) => now - t < windowMs)
    bucket.successes = bucket.successes.filter((t) => now - t < windowMs)
    if (bucket.failures.length === 0 && bucket.successes.length === 0 && bucket.lockedUntil === null) {
      buckets.delete(key)
    } else if (bucket.lockedUntil !== null && bucket.lockedUntil <= now) {
      bucket.lockedUntil = null
    }
  }
}

function bucketFor(key: string, windowMs: number, now: number): Bucket {
  sweep(windowMs, now)
  const existing = buckets.get(key)
  if (existing) return existing
  const created: Bucket = { failures: [], successes: [], lockedUntil: null }
  buckets.set(key, created)
  return created
}

export interface RateLimitVerdict {
  allowed: boolean
  retryAfterSeconds: number
}

/**
 * Failures are counted first and dominate: once an IP trips the failure limit it is
 * locked out entirely, so a successful guess cannot be used to launder a credential
 * stuffing run back under the limit.
 */
export function checkAuthRateLimit(
  ip: string,
  env: { AUTH_RATE_LIMIT_FAILURES: number; AUTH_RATE_LIMIT_WINDOW_MS: number; AUTH_RATE_LIMIT_SUCCESSES: number },
  now = Date.now(),
): RateLimitVerdict {
  const bucket = bucketFor(`auth:${ip}`, env.AUTH_RATE_LIMIT_WINDOW_MS, now)

  if (bucket.lockedUntil !== null && bucket.lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.lockedUntil - now) / 1000) }
  }

  if (bucket.successes.length >= env.AUTH_RATE_LIMIT_SUCCESSES) {
    return { allowed: false, retryAfterSeconds: Math.ceil(env.AUTH_RATE_LIMIT_WINDOW_MS / 1000) }
  }

  return { allowed: true, retryAfterSeconds: 0 }
}

export function recordAuthFailure(
  ip: string,
  env: { AUTH_RATE_LIMIT_FAILURES: number; AUTH_RATE_LIMIT_WINDOW_MS: number; AUTH_RATE_LIMIT_SUCCESSES: number },
  now = Date.now(),
): RateLimitVerdict {
  const bucket = bucketFor(`auth:${ip}`, env.AUTH_RATE_LIMIT_WINDOW_MS, now)
  bucket.failures.push(now)
  bucket.successes = []

  if (bucket.failures.length >= env.AUTH_RATE_LIMIT_FAILURES) {
    bucket.lockedUntil = now + env.AUTH_RATE_LIMIT_WINDOW_MS
    return { allowed: false, retryAfterSeconds: Math.ceil(env.AUTH_RATE_LIMIT_WINDOW_MS / 1000) }
  }

  return { allowed: true, retryAfterSeconds: 0 }
}

export function recordAuthSuccess(
  ip: string,
  env: { AUTH_RATE_LIMIT_FAILURES: number; AUTH_RATE_LIMIT_WINDOW_MS: number; AUTH_RATE_LIMIT_SUCCESSES: number },
  now = Date.now(),
): void {
  const bucket = bucketFor(`auth:${ip}`, env.AUTH_RATE_LIMIT_WINDOW_MS, now)
  bucket.successes.push(now)
  // A confirmed correct password clears the failure run, so one typo does not
  // accumulate toward a lockout the user cannot escape.
  bucket.failures = []
  bucket.lockedUntil = null
}

/** Test-only. */
export function resetAuthRateLimits(): void {
  buckets.clear()
  lastSweep = Date.now()
}