/**
 * In-memory stand-in for the parts of Discord's API that DiscordDrive depends on.
 *
 * Why this exists: the entire product is built on behaviour that is awkward to test
 * against the real service — signed CDN URLs that expire, 429 rate-limit bursts, and
 * 10 attachments per message. Reproducing those on demand makes the expiry, refresh
 * and backoff paths reachable in tests, and lets `docker compose up` demo the full
 * stack with zero real webhooks.
 *
 * Implemented surface:
 *   POST /api/v10/webhooks/:webhookId/:token     multipart, up to 10 files
 *   GET  /api/v10/webhooks/:webhookId/:token     webhook metadata
 *   GET  /api/v10/channels/:channelId/messages/:messageId   bot-token read (refresh)
 *   GET  /cdn/attachments/:channelId/:id/:filename?ex=&is=&hm=   signed CDN bytes
 *   POST /__control/...                          test knobs, never present in prod
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { Express } from 'express'
import express from 'express'
import Busboy from 'busboy'

export interface FakeDiscordOptions {
  /** Lifetime of a signed CDN URL. 0 makes links born expired, for refresh tests. */
  linkTtlMs?: number
  /** Attachment size ceiling, mirroring Discord rejecting oversized webhook files. */
  maxAttachmentBytes?: number
  /** Real Discord allows 5 webhook requests per 2 s. */
  rateLimit?: { limit: number; windowMs: number }
  /** Token the fake demands on the bot-read route. */
  botToken?: string
  /** Share an externally supplied ETag/hash secret with a second instance. */
  cdnSecret?: string
}

export interface FakeDiscordControl {
  /** Force the next `count` webhook POSTs to fail with `status`. */
  queueFailures(count: number, status: number, retryAfterSeconds?: number): void
  /** Override the rate limiter (used to disable it in unrelated tests). */
  setRateLimit(rateLimit: FakeDiscordOptions['rateLimit'] | null): void
  setLinkTtlMs(ttl: number): void
  setMaxAttachmentBytes(bytes: number): void
  /** Corrupt stored bytes for one attachment, for integrity-verify tests. */
  corruptAttachment(attachmentId: string): void
  /** Delete an attachment, simulating Discord-side data loss. */
  deleteAttachment(attachmentId: string): void
  stats(): {
    webhookPosts: number
    storedAttachments: number
    storedBytes: number
    botReads: number
    cdnReads: number
    rateLimited: number
  }
  reset(): void
}

interface StoredAttachment {
  id: string
  webhookId: string
  channelId: string
  messageId: string
  filename: string
  bytes: Buffer
}

interface StoredMessage {
  id: string
  webhookId: string
  channelId: string
  attachmentIds: string[]
  createdAt: number
}

const DEFAULT_OPTIONS: Required<Pick<FakeDiscordOptions, 'linkTtlMs' | 'maxAttachmentBytes' | 'botToken'>> = {
  linkTtlMs: 60 * 60 * 1000,
  // Discord's effective webhook attachment ceiling sits well under its documented
  // 20 MB user limit; 8 MiB matches what webhook uploads actually accept.
  maxAttachmentBytes: 8 * 1024 * 1024,
  botToken: 'test-bot-token',
}

export function createFakeDiscord(options: FakeDiscordOptions = {}): { app: Express; control: FakeDiscordControl } {
  const app = express()

  let linkTtlMs = options.linkTtlMs ?? DEFAULT_OPTIONS.linkTtlMs
  let maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_OPTIONS.maxAttachmentBytes
  let botToken = options.botToken ?? DEFAULT_OPTIONS.botToken
  let rateLimit = options.rateLimit ?? { limit: 5, windowMs: 2000 }
  const cdnSecret = options.cdnSecret ?? randomBytes(16).toString('hex')

  const attachments = new Map<string, StoredAttachment>()
  const messages = new Map<string, StoredMessage>()
  /** webhookId -> array of request timestamps inside the current window. */
  const buckets = new Map<string, number[]>()
  const forcedFailures: { status: number; retryAfterSeconds?: number }[] = []

  const stats = { webhookPosts: 0, botReads: 0, cdnReads: 0, rateLimited: 0 }

  /** Discord's `hm` is a checksum over the id and the expiry, so tampering fails. */
  const signatureFor = (attachmentId: string, expiresAt: number): string =>
    createHmac('sha256', cdnSecret).update(`${attachmentId}:${expiresAt}`).digest('hex').slice(0, 32)

  const expiryFor = (): number => Math.floor((Date.now() + linkTtlMs) / 1000)

  /** Mirrors the real signed URL shape, including the hex expiry Discord uses. */
  const cdnUrlFor = (attachment: StoredAttachment): string => {
    const expiresAt = expiryFor()
    const issuedAt = Math.floor(Date.now() / 1000)
    const params = new URLSearchParams({
      ex: expiresAt.toString(16),
      is: issuedAt.toString(16),
      hm: signatureFor(attachment.id, expiresAt),
    })
    return `/cdn/attachments/${attachment.channelId}/${attachment.id}/${encodeURIComponent(attachment.filename)}?${params}`
  }

  const serializeAttachment = (attachment: StoredAttachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    size: attachment.bytes.byteLength,
    content_type: 'application/octet-stream',
    url: cdnUrlFor(attachment),
  })

  const serializeMessage = (message: StoredMessage) => ({
    id: message.id,
    channel_id: message.channelId,
    webhook_id: message.webhookId,
    type: 19,
    timestamp: new Date(message.createdAt).toISOString(),
    attachments: message.attachmentIds
      .map((id) => attachments.get(id))
      .filter((a): a is StoredAttachment => a !== undefined)
      .map(serializeAttachment),
  })

  app.disable('x-powered-by')

  // Only the control routes need a JSON body. The webhook route must stay raw so its
  // multipart body streams straight into Busboy.
  app.use('/__control', express.json())

  app.get('/api/v10/webhooks/:webhookId/:token', (req, res) => {
    if (req.params.token.length < 10) {
      res.status(404).json({ code: 10015, message: 'Unknown webhook' })
      return
    }
    res.json({ id: req.params.webhookId, name: 'fake-webhook', channel_id: `channel-${req.params.webhookId}` })
  })

  app.post('/api/v10/webhooks/:webhookId/:token', async (req, res) => {
    const { webhookId } = req.params
    // Real Discord answers an execute-webhook with `204 No Content` unless the caller
    // asks for the created message via `wait=true`. DiscordDrive always waits, but the
    // fake refuses to fabricate a body for a request that would not have got one — that
    // mismatch is exactly how a “message landed but the app crashed” bug escaped before.
    const wait = req.query.wait === 'true'

    // Same token check as the GET route. Without it a deleted webhook still accepts uploads
    // on POST, which hides the single most common real failure — and makes "report a dead
    // webhook instead of retrying it" untestable.
    if (req.params.token.length < 10) {
      res.status(404).json({ code: 10015, message: 'Unknown Webhook' })
      return
    }

    stats.webhookPosts += 1

    const rateLimitHeaders = (remaining: number, resetAt: number) => {
      res.setHeader('X-RateLimit-Limit', String(rateLimit?.limit ?? 5))
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)))
      res.setHeader('X-RateLimit-Reset', (resetAt / 1000).toFixed(3))
      res.setHeader('X-RateLimit-Reset-After', Math.max(0, (resetAt - Date.now()) / 1000).toFixed(3))
      res.setHeader('X-RateLimit-Bucket', `fake-${webhookId}`)
      res.setHeader('X-RateLimit-Scope', 'user')
    }

    const now = Date.now()
    const forced = forcedFailures.shift()
    if (forced) {
      res.setHeader('Retry-After', String(forced.retryAfterSeconds ?? 1))
      rateLimitHeaders(0, now + (forced.retryAfterSeconds ?? 1) * 1000)
      res.status(forced.status).json({ code: 0, message: 'forced failure' })
      return
    }

    if (rateLimit) {
      const window = (buckets.get(webhookId) ?? []).filter((t) => now - t < rateLimit.windowMs)
      if (window.length >= rateLimit.limit) {
        // The window resets when its oldest surviving request falls out of it.
        const oldest = window[0] ?? now
        const retryAfter = Math.max(1, Math.ceil((oldest + rateLimit.windowMs - now) / 1000))
        window.push(now)
        buckets.set(webhookId, window)
        stats.rateLimited += 1
        res.setHeader('Retry-After', String(retryAfter))
        rateLimitHeaders(0, oldest + rateLimit.windowMs)
        res.status(429).json({ code: 0, message: 'You are being rate limited.', retry_after: retryAfter })
        return
      }
      window.push(now)
      buckets.set(webhookId, window)
      rateLimitHeaders(rateLimit.limit - window.length, now + rateLimit.windowMs)
    }

    const contentType = req.headers['content-type'] ?? ''

    // Discord accepts a JSON payload for a message with no attachment: content, embeds, or
    // both. That is what a "test this webhook" button sends, so the fake has to accept it
    // or the happy path of the whole feature is untestable.
    if (contentType.startsWith('application/json')) {
      const channelId = `channel-${webhookId}`
      const messageId = `message-${randomUUID()}`

      let payload: { content?: string; embeds?: unknown[]; username?: string } = {}
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.status(400).json({ code: 50006, message: 'Invalid JSON payload' })
        return
      }

      // Discord rejects a message with neither content nor embeds.
      if (!payload.content && !payload.embeds?.length) {
        res.status(400).json({ code: 50006, message: 'Cannot send an empty message' })
        return
      }

      // Webhook usernames must not contain "discord" or "clyde" (case-insensitive); a
      // branded override like "DiscordDrive" is exactly the kind of payload real Discord
      // answers 50035 to. Replicating the rule keeps that class of bug green in CI.
      const username = payload.username
      if (typeof username === 'string' && /discord|clyde/i.test(username)) {
        res.status(400).json({ code: 50035, message: 'Invalid Form Body' })
        return
      }

      messages.set(messageId, { id: messageId, webhookId, channelId, attachmentIds: [], createdAt: Date.now() })
      if (wait) res.status(200).json(serializeMessage(messages.get(messageId)!))
      else res.status(204).end()
      return
    }

    if (!contentType.startsWith('multipart/form-data')) {
      res.status(400).json({ code: 50006, message: 'Cannot send an empty message' })
      return
    }

    const channelId = `channel-${webhookId}`
    const messageId = `message-${randomUUID()}`
    const received: StoredAttachment[] = []
    let overflow = false
    let payloadJson = ''

    const parser = Busboy({
      headers: req.headers,
      limits: { files: 10, fileSize: maxAttachmentBytes + 1, fields: 20 },
    })

    parser.on('field', (fieldname, value) => {
      // Chunks attach a payload_json part, where a stray `username` override would be
      // rejected by real Discord with 50035. Capture it so the rule below applies to the
      // upload path too, not just the test-message path.
      if (fieldname === 'payload_json') payloadJson = value
    })

    parser.on('file', (fieldname, stream, info) => {
      const chunks: Buffer[] = []
      let size = 0
      let tooLarge = false

      stream.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > maxAttachmentBytes) {
          tooLarge = true
          return
        }
        chunks.push(chunk)
      })
      stream.on('limit', () => {
        tooLarge = true
      })
      stream.on('end', () => {
        if (tooLarge) {
          overflow = true
          return
        }
        const attachment: StoredAttachment = {
          id: `attachment-${randomUUID()}`,
          webhookId,
          channelId,
          messageId,
          filename: info.filename,
          bytes: Buffer.concat(chunks),
        }
        attachments.set(attachment.id, attachment)
        received.push(attachment)
      })
    })

    parser.on('error', () => {
      if (!res.headersSent) res.status(400).json({ code: 50006, message: 'Malformed multipart body' })
    })

    parser.on('close', () => {
      if (res.headersSent) return

      if (overflow || received.length === 0) {
        // Discord rejects an oversized webhook upload with 40005, not a bare 413.
        res.status(received.length === 0 && !overflow ? 400 : 400).json({
          code: 40005,
          message: overflow ? 'Request entity too large' : 'Cannot send an empty message',
        })
        return
      }

      // The same username rule as the JSON path: a multipart upload carrying a branded
      // username like "DiscordDrive" is exactly what real Discord answers 50035 to.
      if (payloadJson) {
        try {
          const payload = JSON.parse(payloadJson) as { username?: unknown }
          const username = payload.username
          if (typeof username === 'string' && /discord|clyde/i.test(username)) {
            res.status(400).json({ code: 50035, message: 'Invalid Form Body' })
            return
          }
        } catch {
          res.status(400).json({ code: 50006, message: 'Cannot send an empty message' })
          return
        }
      }

      messages.set(messageId, {
        id: messageId,
        webhookId,
        channelId,
        attachmentIds: received.map((a) => a.id),
        createdAt: Date.now(),
      })
      if (wait) res.status(200).json(serializeMessage(messages.get(messageId)!))
      else res.status(204).end()
    })

    req.pipe(parser)
  })

  /** The documented bot-authenticated read that hands back freshly signed URLs. */
  app.get('/api/v10/channels/:channelId/messages/:messageId', (req, res) => {
    const header = req.headers.authorization
    if (header !== `Bot ${botToken}`) {
      res.status(401).json({ code: 0, message: '401: Unauthorized' })
      return
    }
    stats.botReads += 1

    const message = messages.get(req.params.messageId)
    if (!message || message.channelId !== req.params.channelId) {
      res.status(404).json({ code: 10008, message: 'Unknown Message' })
      return
    }
    res.json(serializeMessage(message))
  })

  app.get('/cdn/attachments/:channelId/:attachmentId/:filename', (req, res) => {
    stats.cdnReads += 1

    const attachment = attachments.get(req.params.attachmentId)
    if (!attachment || attachment.channelId !== req.params.channelId) {
      res.status(404).json({ code: 10008, message: 'Unknown attachment' })
      return
    }

    const expiresAt = Number.parseInt(String(req.query.ex ?? ''), 16)
    const expected = signatureFor(attachment.id, expiresAt)
    const provided = String(req.query.hm ?? '')

    const signaturesMatch =
      provided.length === expected.length && timingSafeEqual(Buffer.from(provided), Buffer.from(expected))

    // Unsigned or expired links are indistinguishable from missing ones, exactly as
    // on Discord's CDN. This is what makes the refresh path mandatory, not optional.
    if (!signaturesMatch || Number.isNaN(expiresAt) || expiresAt * 1000 <= Date.now()) {
      res.status(404).send('This content is no longer available.')
      return
    }

    res.setHeader('Content-Length', String(attachment.bytes.byteLength))
    res.setHeader('Content-Type', 'application/octet-stream')
    res.end(attachment.bytes)
  })

  // ---- test knobs -----------------------------------------------------------

  app.post('/__control/reset', (_req, res) => {
    attachments.clear()
    messages.clear()
    buckets.clear()
    forcedFailures.length = 0
    stats.webhookPosts = 0
    stats.botReads = 0
    stats.cdnReads = 0
    stats.rateLimited = 0
    res.json({ ok: true })
  })

  app.post('/__control/fail-next', (req, res) => {
    const count = Number(req.body?.count ?? 1)
    const status = Number(req.body?.status ?? 429)
    const retryAfterSeconds = req.body?.retryAfterSeconds === undefined ? undefined : Number(req.body.retryAfterSeconds)
    for (let i = 0; i < count; i += 1) forcedFailures.push({ status, retryAfterSeconds })
    res.json({ ok: true, queued: count })
  })

  app.post('/__control/config', (req, res) => {
    if (req.body?.linkTtlMs !== undefined) linkTtlMs = Number(req.body.linkTtlMs)
    if (req.body?.maxAttachmentBytes !== undefined) maxAttachmentBytes = Number(req.body.maxAttachmentBytes)
    if (req.body?.botToken !== undefined) botToken = String(req.body.botToken)
    if ('rateLimit' in req.body) {
      rateLimit = (req.body.rateLimit ?? null) as typeof rateLimit
      if (rateLimit) buckets.clear()
    }
    res.json({ ok: true, linkTtlMs, maxAttachmentBytes, rateLimit })
  })

  const control: FakeDiscordControl = {
    queueFailures(count, status, retryAfterSeconds) {
      for (let i = 0; i < count; i += 1) forcedFailures.push({ status, retryAfterSeconds })
    },
    setRateLimit(next) {
      rateLimit = (next ?? null) as typeof rateLimit
      if (next) buckets.clear()
    },
    setLinkTtlMs(ttl) {
      linkTtlMs = ttl
    },
    setMaxAttachmentBytes(bytes) {
      maxAttachmentBytes = bytes
    },
    corruptAttachment(attachmentId) {
      const attachment = attachments.get(attachmentId)
      if (attachment) attachment.bytes = Buffer.from(attachment.bytes.map((b) => (b ^ 0xff) & 0xff))
    },
    deleteAttachment(attachmentId) {
      attachments.delete(attachmentId)
    },
    stats() {
      return {
        ...stats,
        storedAttachments: attachments.size,
        storedBytes: [...attachments.values()].reduce((total, a) => total + a.bytes.byteLength, 0),
      }
    },
    reset() {
      attachments.clear()
      messages.clear()
      buckets.clear()
      forcedFailures.length = 0
      stats.webhookPosts = 0
      stats.botReads = 0
      stats.cdnReads = 0
      stats.rateLimited = 0
    },
  }

  return { app, control }
}