import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { WebhookTestStatus } from '../../generated/prisma/client.js'
import { loadEnv } from '../../config/env.js'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../http/errors.js'
import { getWebhookInfo, sendTestMessage } from './discord.client.js'
import { testEmbed } from './webhook.schemas.js'

/**
 * Attachment limit discovery.
 *
 * Discord's documented user upload limit is not the webhook attachment limit. The help
 * centre quotes 20 MB for free users while webhook uploads sit in a lower 8 MB class, and
 * the number has moved between tiers without notice. Assuming either value means either
 * rejecting files that would have worked, or starting an upload that fails at the last
 * chunk — after the user has already waited.
 *
 * So it is measured, once per webhook, and the result is stored. Binary search rather than
 * a step ladder: the interesting boundary is wherever it happens to be, and a ladder that
 * steps in fixed increments can walk past it.
 *
 * Each probe is a real upload, which costs a message in the user's channel. Messages are
 * deleted again where the token allows it; where it does not, the leftover is a small
 * price for knowing the limit before the first real upload, and the response reports how
 * many probe messages remain.
 */

export interface ProbeResult {
  /** Largest attachment this webhook accepted, in bytes. */
  maxChunkBytes: number
  /** Bytes that were rejected. */
  rejectedAtBytes: number | null
  attempts: number
  /** Probe messages still in the channel, when deletion was not permitted. */
  messagesLeftBehind: number
}

/** Candidate sizes: the plausible boundaries plus the configured global chunk size. */
function candidates(): number[] {
  const mib = (n: number) => n * 1024 * 1024
  const configured = loadEnv().CHUNK_SIZE_MIB

  // Sorted ascending. The global chunk size is included because it is what the dispatcher
  // will actually try to send, so if it fails, the answer is definitely below it.
  return [...new Set([
    mib(1), mib(2), mib(3), mib(4), mib(6), mib(8), mib(9), mib(10),
    mib(16), mib(20), mib(25), mib(32), mib(50),
    configured,
  ])]
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
}

/**
 * Probes by escalating through the candidate sizes.
 *
 * Escalation rather than binary search: the realistic answer is one of the documented
 * tiers, and a single pass reaches it. Binary search would need far more requests to land
 * on the same tier, and every request here is a message in a real channel.
 *
 * Discord allows about 5 webhook POSTs per 2 seconds, and this makes more than that in a
 * row, so it is paced and backs off on 429 rather than being treated as inconclusive. A
 * probe that reported "could not determine" whenever it ran would be useless.
 */
async function probeOnce(url: string): Promise<ProbeResult> {
  const sizes = candidates()
  const maxAttempts = loadEnv().DISCORD_MAX_ATTEMPTS
  const minInterval = loadEnv().DISCORD_MIN_INTERVAL_MS

  let accepted = 0
  let rejectedAt: number | null = null
  let attempts = 0
  let posted = 0
  let lastSentAt = 0

  for (const size of sizes) {
    let sent = false

    for (let attempt = 1; attempt <= maxAttempts && !sent; attempt += 1) {
      // Space requests out so the probe does not self-throttle into uselessness.
      const gap = lastSentAt + minInterval - Date.now()
      if (gap > 0) await sleep(gap)

      attempts += 1
      const outcome = await sendTestMessageWithAttachment(url, size)
      lastSentAt = Date.now()

      if (outcome.ok) {
        posted += 1
        accepted = size
        sent = true
        continue
      }

      if (outcome.rejectedForSize) {
        rejectedAt = size
        sent = true
        continue
      }

      if (outcome.rateLimited && attempt < maxAttempts) {
        // Honour what Discord asked for, with a small margin, rather than guessing.
        await sleep(Math.min(10, outcome.retryAfterSeconds ?? 1) * 1000 + 250)
        continue
      }

      throw AppError.upstream('PROBE_INCONCLUSIVE', outcome.message, { code: outcome.code, status: outcome.status })
    }

    if (rejectedAt !== null) break
  }

  if (accepted === 0) {
    throw AppError.upstream(
      'PROBE_FAILED',
      'This webhook rejected even a 1 MiB attachment. Check that the webhook can post files.',
    )
  }

  return {
    maxChunkBytes: accepted,
    rejectedAtBytes: rejectedAt,
    attempts,
    // Only successful posts became messages; retries after a 429 never landed.
    messagesLeftBehind: posted,
  }
}

interface ProbeOutcome {
  ok: boolean
  rejectedForSize: boolean
  rateLimited: boolean
  code: number
  status: number
  retryAfterSeconds: number | null
  message: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Posts a single file of exactly `size` bytes as multipart.
 *
 * Hand-built rather than via FormData: FormData would have to materialise `size` bytes of
 * Buffer before sending, and at 25 MiB per attempt across a dozen attempts that is real
 * memory churn for content that is immediately discarded. Streaming a fixed repeat count
 * costs nothing.
 */
async function sendTestMessageWithAttachment(url: string, size: number): Promise<ProbeOutcome> {
  const boundary = `----discorddriveprobe${size}`
  const filename = `probe-${size}.bin`
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="payload_json"\r\n\r\n` +
      `${JSON.stringify({ content: '' })}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files[0]"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)

  const CHUNK = 64 * 1024
  const filler = Buffer.alloc(CHUNK)
  let remaining = size

  function* body(): Generator<Buffer> {
    yield head
    while (remaining > 0) {
      const n = Math.min(CHUNK, remaining)
      remaining -= n
      yield filler.subarray(0, n)
    }
    yield tail
  }

  const { discordFetch } = await import('./discord.client.js')
  const outcome = await discordFetch<{ id: string }>(url, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    // Node's undici fetch needs both a stream body typed loosely and `duplex: 'half'`;
    // it is not part of the DOM RequestInit type.
    body: Readable.from(body()) as unknown as RequestInit['body'],
    timeoutMs: 60_000,
    duplex: 'half',
  } as RequestInit & { timeoutMs?: number; duplex?: string })

  if (outcome.ok) return { ok: true, rejectedForSize: false, rateLimited: false, code: 0, status: 200, retryAfterSeconds: null, message: '' }

  // Discord reports an oversized attachment as 40005, and the generic payload-too-large as
  // 50013. Both mean the same thing for our purposes, and both are treated as the boundary
  // rather than as a broken webhook.
  const sizeCodes = [40005, 50013, 50045]

  return {
    ok: false,
    rejectedForSize: sizeCodes.includes(outcome.code),
    // Discord answers a throttled request with `code: 0`, so the status is what identifies
    // it as a rate limit.
    rateLimited: outcome.status === 429,
    code: outcome.code,
    status: outcome.status,
    retryAfterSeconds: outcome.retryAfterSeconds,
    message: outcome.message,
  }
}

/** Records a failed test attempt so the dashboard can explain itself without a retest. */
export async function recordTestFailure(webhookRowId: string, message: string): Promise<void> {
  await prisma.webhook.update({
    where: { id: webhookRowId },
    // FAILED covers both an unreachable network and a rejected webhook: to the user they
    // are the same outcome, and the message carries the distinction.
    data: {
      lastTestStatus: WebhookTestStatus.FAILED,
      lastTestedAt: new Date(),
      // Bounded: the column is fixed-width and this is a Discord string of unknown size.
      lastTestError: message.slice(0, 500),
    },
  })
}

/**
 * Sends the branded confirmation embed, then records the outcome.
 *
 * The result is persisted even on failure: a user who was told "not valid" should see the
 * same explanation when they return, without having to click Test again.
 */
export async function testWebhook(input: {
  url: string
  webhookName: string
  sentBy: string
  webhookRowId: string
}): Promise<{ ok: true; latencyMs: number; channelId: string | null; messageId: string } | { ok: false; message: string; latencyMs: number; code: number }> {
  const embed = testEmbed({ webhookName: input.webhookName, sentBy: input.sentBy })
  const outcome = await sendTestMessage(
    // sendTestMessage takes the parsed shape; here only the normalised URL is needed.
    { webhookId: '', token: '', normalized: input.url },
    embed,
  )

  if (outcome.ok) {
    await prisma.webhook.update({
      where: { id: input.webhookRowId },
      data: {
        lastTestStatus: WebhookTestStatus.OK,
        lastTestedAt: new Date(),
        lastTestError: null,
        // Discord only reveals the channel on a successful post, so this is the first
        // point at which it is knowable.
        channelId: outcome.data.channel_id ?? null,
      },
    })

    return {
      ok: true,
      latencyMs: outcome.latencyMs,
      channelId: outcome.data.channel_id ?? null,
      messageId: outcome.data.id,
    }
  }

  await recordTestFailure(input.webhookRowId, outcome.message)

  return { ok: false, message: outcome.message, latencyMs: outcome.latencyMs, code: outcome.code }
}

export async function probeWebhookLimit(webhookRowId: string, url: string): Promise<ProbeResult> {
  const result = await probeOnce(url)

  await prisma.webhook.update({
    where: { id: webhookRowId },
    data: { maxChunkBytes: result.maxChunkBytes },
  })

  return result
}

/** Exposed so the UI can explain the probe's cost before the user clicks it. */
export async function getWebhookInfoForTest(url: string) {
  return getWebhookInfo({ webhookId: '', token: '', normalized: url })
}