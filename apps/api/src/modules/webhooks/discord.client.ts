import { loadEnv } from '../../config/env.js'
import { AppError } from '../../http/errors.js'
import type { ParsedWebhookUrl } from './webhook.schemas.js'

/**
 * The only place that knows how to talk to Discord.
 *
 * Deliberately thin: it takes a full webhook URL and returns either a result or an error
 * carrying Discord's own message. Nothing here knows about the database or about users,
 * because a credential leak is far easier to prevent when the Discord-facing code has no
 * idea what a user is.
 */

export interface DiscordResult<T> {
  ok: true
  data: T
  latencyMs: number
}

export interface DiscordFailure {
  ok: false
  /** Discord's numeric error code, e.g. 10003 for a missing channel. */
  code: number
  /** Discord's own message. Passed through so the user sees what Discord actually said. */
  message: string
  latencyMs: number
  /** HTTP status, which is the only thing that distinguishes a 429 from a dead webhook. */
  status: number
  /**
   * How long to wait before retrying, from `Retry-After` or the rate-limit headers.
   * Discord answers 429 with `code: 0`, so a caller cannot recognise a rate limit from the
   * code alone — this is the signal that it was throttling rather than rejecting.
   */
  retryAfterSeconds: number | null
}

export type DiscordOutcome<T> = DiscordResult<T> | DiscordFailure

interface DiscordMessage {
  id: string
  channel_id: string
  attachments: { id: string; filename: string; size: number; url: string }[]
}

export interface WebhookInfo {
  id: string
  name: string | null
  channel_id: string | null
  type: number | null
}

/**
 * Reads how long Discord wants us to wait.
 *
 * Prefers the body field, then the header, then the reset timestamp. Discord uses all
 * three depending on the endpoint, and honouring the wrong one means either hammering a
 * limit that is already exhausted or sleeping far longer than needed.
 */
function parseRetryAfter(response: Response, bodyRetryAfter: number | undefined): number | null {
  if (typeof bodyRetryAfter === 'number' && Number.isFinite(bodyRetryAfter)) return bodyRetryAfter

  const header = response.headers.get('retry-after')
  if (header !== null) {
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return seconds
    // A date rather than a delay.
    const at = Date.parse(header)
    if (!Number.isNaN(at)) return Math.max(0, Math.round((at - Date.now()) / 1000))
  }

  const reset = response.headers.get('x-ratelimit-reset-after')
  if (reset !== null) {
    const seconds = Number(reset)
    if (Number.isFinite(seconds)) return seconds
  }

  return null
}

/**
 * Discord error codes worth explaining. An unrecognised code still surfaces Discord's own
 * message, so this table improves the common cases rather than gating them.
 */
const ERROR_HINTS: Record<number, string> = {
  10003: 'That channel no longer exists. The channel was probably deleted.',
  10007: 'This channel is archived, so new messages cannot be posted to it.',
  10008: 'The message is blocked by this channel\'s posting rules.',
  10011: 'The webhook does not have a channel any more.',
  20009: 'This channel is too slow to respond right now. Try again in a moment.',
  40005: 'That file is too large for this webhook. Probe the attachment limit to find the real ceiling.',
  40006: 'The webhook has been deleted. Create a new webhook in Discord and update it here.',
  40036: 'The webhook token is no longer valid. Reset it in Discord and enter the new URL.',
  50001: 'Discord rejected the request without saying why. This is usually a webhook that was deleted.',
  50035: 'Discord rejected the request. If you just pasted this URL, make sure it is the webhook URL and not the API URL.',
  50045: 'This file is too large for Discord to accept.',
}

/**
 * Human-readable text for a failed Discord call. Prefers our hint for a known code,
 * because Discord's own message for 40036 is a bare "Invalid Webhook Token" with no
 * indication of what the user should do next.
 */
export function describeDiscordError(code: number, message: string): string {
  const hint = ERROR_HINTS[code]
  if (hint && hint.toLowerCase() !== message.toLowerCase()) return hint
  if (hint) return hint
  return message || 'Discord rejected the request'
}

/**
 * Discord's canonical API version, used for every request.
 *
 * Webhook URLs are accepted unversioned (`/api/webhooks/...`) because that is what Discord
 * shows users in the UI, but the versioned form is the one worth sending: it pins the
 * response shape instead of tracking whatever Discord considers current.
 */
const API_VERSION = 'v10'

/**
 * Discord is reached through a caller-supplied base URL so the fake server can stand in.
 * Failures are mapped to `DiscordFailure` rather than thrown: a bad webhook is an expected
 * outcome the UI must render, not an exception.
 *
 * `url` may be absolute (a stored webhook URL) or relative (a message read built from ids).
 * Both are resolved against Discord's host purely to extract a path — the request itself
 * goes to the configured base, never to whatever host the credential names.
 */
export async function discordFetch<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<DiscordOutcome<T>> {
  const base = loadEnv().DISCORD_API_BASE
  const target = new URL(url, `https://discord.com`)

  // Insert the version into an existing unversioned `/api` prefix. Prefixing instead would
  // turn `/api/webhooks/x` into `/api/v10/api/webhooks/x`, which 404s.
  const path = /^\/api\/v\d+(\/|$)/.test(target.pathname)
    ? target.pathname
    : target.pathname.replace(/^\/api(?=\/|$)/, `/api/${API_VERSION}`)

  const endpoint = `${base.replace(/\/api\/v\d+\/?$/, '')}${path}${target.search}`

  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 10_000)

  try {
    const response = await fetch(endpoint, { ...init, signal: controller.signal })

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        code?: number
        message?: string
        retry_after?: number
      }
      return {
        ok: false,
        code: body.code ?? response.status,
        message: describeDiscordError(body.code ?? response.status, body.message ?? response.statusText),
        latencyMs: Date.now() - started,
        status: response.status,
        retryAfterSeconds: parseRetryAfter(response, body.retry_after),
      }
    }

    // 204 and empty bodies are legitimate for a couple of routes.
    const text = await response.text()
    return {
      ok: true,
      data: (text ? JSON.parse(text) : null) as T,
      latencyMs: Date.now() - started,
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      code: aborted ? -1 : 0,
      message: aborted
        ? 'Discord did not respond in time. Check the URL and your network, then try again.'
        : 'Could not reach Discord. Check your network connection and try again.',
      latencyMs: Date.now() - started,
      status: 0,
      retryAfterSeconds: null,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function getWebhookInfo(
  webhook: ParsedWebhookUrl,
  timeoutMs?: number,
): Promise<DiscordOutcome<WebhookInfo>> {
  return discordFetch<WebhookInfo>(webhook.normalized, { method: 'GET', timeoutMs })
}

export async function sendTestMessage(
  webhook: ParsedWebhookUrl,
  body: unknown,
  timeoutMs?: number,
): Promise<DiscordOutcome<DiscordMessage>> {
  return discordFetch<DiscordMessage>(webhook.normalized, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
  })
}

export async function getMessage(
  channelId: string,
  messageId: string,
  botToken: string,
  timeoutMs?: number,
): Promise<DiscordOutcome<DiscordMessage>> {
  return discordFetch<DiscordMessage>(
    `/api/v10/channels/${channelId}/messages/${messageId}`,
    { method: 'GET', headers: { authorization: `Bot ${botToken}` }, timeoutMs },
  )
}

export interface CdnOutcome {
  ok: boolean
  /** HTTP status when Discord answered, 0 for a network-level failure. */
  status: number
  /**
   * The raw response, only when `ok`. The caller owns reading `response.body`; nothing
   * here buffers a byte, which is what keeps a download from assembling the file in RAM.
   */
  response: Response | null
  message: string
}

/**
 * Fetches a stored CDN attachment URL without going through `discordFetch`.
 *
 * `discordFetch` rewrites every path onto `DISCORD_API_BASE`, which is exactly what the
 * API routes need and exactly wrong for the CDN: a real signed URL points at
 * `cdn.discordapp.com`, a different host that must not be rerouted onto the API base.
 * Relative URLs only ever occur with the fake server, where they are resolved against
 * the API base's origin so the whole pipeline gains zero-config download support.
 *
 * The timeout covers reaching the headers, not the body: a streamed chunk may legitimately
 * take far longer than that to read, and `Content-Length` is the caller's concern.
 */
export async function fetchAttachment(cdnUrl: string, timeoutMs = 30_000): Promise<CdnOutcome> {
  const base = loadEnv().DISCORD_API_BASE
  const target = cdnUrl.startsWith('/') ? new URL(cdnUrl, base) : new URL(cdnUrl)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(target, { signal: controller.signal })

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        response: null,
        message: response.status === 404 || response.status === 403
          ? 'This file\'s storage link has expired. A fresh link can be fetched with a bot token, or the file can be re-uploaded.'
          : `Discord's CDN rejected the request (HTTP ${response.status})`,
      }
    }

    return { ok: true, status: response.status, response, message: '' }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      response: null,
      message: aborted
        ? 'Discord\'s CDN did not respond in time. Try again in a moment.'
        : 'Could not reach Discord\'s CDN. Check your network connection and try again.',
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function assertNotDiscordFailure<T>(outcome: DiscordOutcome<T>, context: string): T {
  if (outcome.ok) return outcome.data
  throw AppError.upstream('DISCORD_REJECTED', `${context}: ${outcome.message}`, {
    discordCode: outcome.code,
  })
}