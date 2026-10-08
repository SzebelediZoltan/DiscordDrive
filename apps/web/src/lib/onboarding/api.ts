import { AuthApiError, asApiError } from '@/lib/auth/api'

/**
 * Typed client for the two calls the wizard needs (create + test a webhook) plus the
 * completion handshake. The webhook URL is never persisted client-side: once saved it
 * exists only encrypted in the backend, so a resume reads `hasBotToken` / hints instead
 * of a raw credential.
 */

export interface OnboardingWebhook {
  id: string
  name: string
  webhookId: string
  urlHint: { hint: string; last4: string }
  tokenLast4: string
  hasBotToken: boolean
  botTokenLast4: string | null
  channelId: string | null
  isDefault: boolean
  maxChunkBytes: number
  lastTestStatus: string | null
  lastTestedAt: string | null
  lastTestError: string | null
}

export interface TestResult {
  ok: boolean
  /** Discord HTTP status (404 deleted · 401 refused · 429 throttled) or a string code. */
  code?: number | string
  message?: string
  latencyMs?: number
  /** Discord channel snowflake the webhook posts to. */
  channelId?: string
}

async function jsonRequest<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init })
  if (!res.ok) {
    let parsed: { error?: { code?: string; message?: string; details?: unknown } } | null = null
    try {
      parsed = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } } | null
    } catch {
      parsed = null
    }
    // Every authed route answers 401 with `UNAUTHORIZED`, and session loss mid-wizard
    // must read identically whatever op was in flight — not as a webhook- or token-level
    // failure. Normalise the code so handlers can treat it uniformly.
    const code =
      res.status === 401 ? 'UNAUTHORIZED' : parsed?.error?.code ?? `HTTP_${res.status}`
    throw new AuthApiError(
      code,
      parsed?.error?.message ?? 'Something went wrong, please try again',
      res.status,
      parsed?.error?.details,
    )
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

const json = { 'content-type': 'application/json' }

export function createWebhook(input: {
  name: string
  url: string
  botToken?: string
  isDefault?: boolean
}): Promise<{ webhook: OnboardingWebhook }> {
  return jsonRequest('/api/webhooks', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      name: input.name.trim(),
      url: input.url.trim(),
      isDefault: input.isDefault ?? true,
      ...(input.botToken?.trim() ? { botToken: input.botToken.trim() } : {}),
    }),
  })
}

export function updateWebhook(
  id: string,
  patch: { name?: string; url?: string; botToken?: string; isDefault?: boolean },
): Promise<{ webhook: OnboardingWebhook }> {
  return jsonRequest(`/api/webhooks/${id}`, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify(patch),
  })
}

export function listWebhooks(): Promise<{ webhooks: OnboardingWebhook[] }> {
  return jsonRequest('/api/webhooks', { method: 'GET' })
}

export function deleteWebhook(id: string): Promise<void> {
  return jsonRequest(`/api/webhooks/${id}`, { method: 'DELETE' })
}

export function testWebhook(id: string): Promise<TestResult> {
  return jsonRequest(`/api/webhooks/${id}/test`, { method: 'POST', headers: json, body: '{}' })
}

export function completeOnboarding(): Promise<{ user: { onboardingComplete: boolean } }> {
  return jsonRequest('/api/auth/onboarding-complete', {
    method: 'POST',
    headers: json,
    body: '{}',
  })
}

/** Ends the session that gates this wizard, so a different profile can be wired. */
export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
}

/** True when the failure means the session vanished rather than the op itself failing. */
export function isSessionLost(error: unknown): boolean {
  return asApiError(error).status === 401
}

export { asApiError }
export type { AuthApiError }