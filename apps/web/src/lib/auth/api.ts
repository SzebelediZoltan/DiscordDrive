/** Typed client for the auth + waitlist APIs and the error classifier the screens share. */

export class AuthApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: unknown

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'AuthApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown } | null
}

export async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    let parsed: ErrorBody | null = null
    try {
      parsed = (await res.json()) as ErrorBody
    } catch {
      parsed = null
    }
    throw new AuthApiError(
      parsed?.error?.code ?? `HTTP_${res.status}`,
      parsed?.error?.message ?? 'Something went wrong, please try again',
      res.status,
      parsed?.error?.details,
    )
  }

  return res.json() as Promise<Record<string, unknown>>
}

export function asApiError(error: unknown): AuthApiError {
  if (error instanceof AuthApiError) return error
  return new AuthApiError('UNKNOWN', error instanceof Error ? error.message : 'Something went wrong, please try again', 0)
}

export interface WaitlistSnapshot {
  position: number | null
  waitingCount: number
}

export function waitlistCount(): Promise<{ waitingCount: number }> {
  return fetch('/api/waitlist/count', { credentials: 'same-origin' }).then((res) => res.json() as Promise<{ waitingCount: number }>)
}

export function waitlistStatus(email: string): Promise<WaitlistSnapshot> {
  return fetch(`/api/waitlist/status?email=${encodeURIComponent(email)}`, { credentials: 'same-origin' }).then(
    (res) => res.json() as Promise<WaitlistSnapshot>,
  )
}

/**
 * Distinct headings so an account state reads differently from a typo. Returns null when
 * the failure is just a bad credential, where the inline error already says enough.
 */
export function failureTitle(error: AuthApiError): string | null {
  switch (error.code) {
    case 'ACCOUNT_PENDING':
      return 'Waiting for approval'
    case 'ACCOUNT_SUSPENDED':
      return 'Account suspended'
    case 'RATE_LIMITED':
      return 'Too many attempts'
    default:
      return null
  }
}

export function retryAfterHint(error: AuthApiError): string | null {
  const details = error.details as { retryAfterSeconds?: number } | null
  if (error.code !== 'RATE_LIMITED' || typeof details?.retryAfterSeconds !== 'number') return null
  const seconds = Math.ceil(details.retryAfterSeconds)
  return `You can try again in ${seconds} second${seconds === 1 ? '' : 's'}.`
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function passwordChecks(password: string) {
  return {
    length: password.length >= 10,
    lower: /[a-z]/.test(password),
    upper: /[A-Z]/.test(password),
    digit: /[0-9]/.test(password),
  }
}