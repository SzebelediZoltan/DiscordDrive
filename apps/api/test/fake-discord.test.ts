import { Buffer } from 'node:buffer'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFakeDiscord, type FakeDiscordControl } from '../src/dev/fake-discord.js'

/**
 * The fake Discord server is the foundation of every other test in this project, so it
 * gets verified first: signed-URL expiry, bot-token refresh, 429 bursts and oversized
 * attachments are all behaviours the product depends on, and none of them are
 * comfortably testable against the real service.
 */

let server: Server
let control: FakeDiscordControl
let baseUrl: string

const WEBHOOK_ID = '1234567890123456789'
const WEBHOOK_TOKEN = 'fake-webhook-token-value'
const BOT_TOKEN = 'test-bot-token'

function webhookUrl(): string {
  return `${baseUrl}/api/v10/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`
}

function messageUrl(channelId: string, messageId: string): string {
  return `${baseUrl}/api/v10/channels/${channelId}/messages/${messageId}`
}

interface AttachmentShape {
  id: string
  filename: string
  size: number
  url: string
}

interface MessageShape {
  id: string
  channel_id: string
  attachments: AttachmentShape[]
}

/** Builds a multipart body by hand so the test does not depend on FormData semantics. */
function multipart(
  files: { name: string; bytes: Buffer }[],
  payload: Record<string, unknown> = { content: '' },
): { body: Buffer; contentType: string } {
  const boundary = `----discorddrivetest${Date.now().toString(16)}`
  const parts: Buffer[] = []

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\n\r\n${JSON.stringify(
        payload,
      )}\r\n`,
    ),
  )

  files.forEach((file, index) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files[${index}]"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
    )
    parts.push(file.bytes)
    parts.push(Buffer.from('\r\n'))
  })

  parts.push(Buffer.from(`--${boundary}--\r\n`))

  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

async function upload(files: { name: string; bytes: Buffer }[]): Promise<Response> {
  const { body, contentType } = multipart(files)
  // DiscordDrive always executes webhooks with wait=true, as production does.
  return fetch(`${webhookUrl()}?wait=true`, { method: 'POST', headers: { 'content-type': contentType }, body })
}

async function postJson(payload: object): Promise<Response> {
  return fetch(`${webhookUrl()}?wait=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

beforeAll(async () => {
  const { app, control: c } = createFakeDiscord({ linkTtlMs: 60_000, botToken: BOT_TOKEN })
  control = c
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to bind fake discord')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  control.reset()
  control.setLinkTtlMs(60_000)
  control.setMaxAttachmentBytes(8 * 1024 * 1024)
  control.setRateLimit(null)
})

describe('fake discord: webhook uploads', () => {
  it('accepts a multipart upload and returns a signed CDN url per attachment', async () => {
    const payload = Buffer.from('hello chunk zero')
    const response = await upload([{ name: 'chunk-0000.bin', bytes: payload }])

    expect(response.status).toBe(200)
    const message = (await response.json()) as MessageShape

    expect(message.attachments).toHaveLength(1)
    const attachment = message.attachments[0]!
    expect(attachment.filename).toBe('chunk-0000.bin')
    expect(attachment.size).toBe(payload.byteLength)
    expect(attachment.url).toMatch(/\?ex=[0-9a-f]+&is=[0-9a-f]+&hm=[0-9a-f]+$/)

    // The returned url must actually serve the bytes we sent.
    const fetched = await fetch(new URL(attachment.url, baseUrl))
    expect(fetched.status).toBe(200)
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(payload)
  })

  it('stores up to ten attachments in one message, as a chunk batch does', async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      name: `chunk-${String(i).padStart(4, '0')}.bin`,
      bytes: Buffer.from(`payload-${i}`),
    }))

    const message = (await (await upload(files)).json()) as MessageShape

    expect(message.attachments).toHaveLength(10)
    const ids = new Set(message.attachments.map((a) => a.id))
    expect(ids.size).toBe(10)
  })

  it('rejects an attachment above the size ceiling with Discord error code 40005', async () => {
    control.setMaxAttachmentBytes(1024)
    const response = await upload([{ name: 'too-big.bin', bytes: Buffer.alloc(2048, 7) }])

    expect(response.status).toBe(400)
    const body = (await response.json()) as { code: number; message: string }
    expect(body.code).toBe(40005)
    expect(body.message).toMatch(/too large/i)
  })

  it('rejects a username containing "discord" or "clyde" with 50035, as real Discord does', async () => {
    const forbidden = await postJson({ content: 'hello', username: 'DiscordDrive' })
    expect(forbidden.status).toBe(400)
    const body = (await forbidden.json()) as { code: number; message: string }
    expect(body.code).toBe(50035)
    expect(body.message).toMatch(/form body/i)

    // Same rule is case-insensitive and also covers "clyde".
    const clyde = await postJson({ content: 'hello', username: 'CLYDE-TheCurse' })
    expect(clyde.status).toBe(400)
    expect(((await clyde.json()) as { code: number }).code).toBe(50035)

    // No override at all — how DiscordDrive now posts — must pass.
    const clean = await postJson({ content: 'hello' })
    expect(clean.status).toBe(200)
  })

  it('rejects a multipart payload with a "discord" username with 50035, as real Discord does', async () => {
    const { body, contentType } = multipart(
      [{ name: 'chunk-00000.bin', bytes: Buffer.from('bytes') }],
      { content: '', username: 'DiscordDrive' },
    )
    const forbidden = await fetch(`${webhookUrl()}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    })
    expect(forbidden.status).toBe(400)
    expect(((await forbidden.json()) as { code: number }).code).toBe(50035)

    // The same upload without a username override must pass.
    const clean = await upload([{ name: 'chunk-00000.bin', bytes: Buffer.from('bytes') }])
    expect(clean.status).toBe(200)
  })
})

describe('fake discord: signed link expiry', () => {
  it('serves a link with an intact signature', async () => {
    const message = (await (await upload([{ name: 'a.bin', bytes: Buffer.from('data') }])).json()) as MessageShape
    const response = await fetch(new URL(message.attachments[0]!.url, baseUrl))
    expect(response.status).toBe(200)
  })

  it('404s an expired link, and a tampered expiry fails the same way', async () => {
    control.setLinkTtlMs(0)
    const message = (await (await upload([{ name: 'a.bin', bytes: Buffer.from('data') }])).json()) as MessageShape
    const url = new URL(message.attachments[0]!.url, baseUrl)

    expect((await fetch(url)).status).toBe(404)

    // Keep the signature but push the expiry into the future: the checksum must not match.
    const tampered = new URL(url)
    tampered.searchParams.set('ex', (Math.floor(Date.now() / 1000) + 3600).toString(16))
    expect((await fetch(tampered)).status).toBe(404)
  })

  it('returns freshly signed urls from the bot-authenticated message read', async () => {
    control.setLinkTtlMs(0)
    const message = (await (await upload([{ name: 'a.bin', bytes: Buffer.from('payload') }])).json()) as MessageShape
    const stale = new URL(message.attachments[0]!.url, baseUrl)
    expect((await fetch(stale)).status).toBe(404)

    // Restoring the lifetime and re-reading the message is exactly what the link
    // refresher does, and it must repair the whole message in one call.
    control.setLinkTtlMs(60_000)
    const refreshed = await fetch(messageUrl(message.channel_id, message.id), {
      headers: { authorization: `Bot ${BOT_TOKEN}` },
    })
    expect(refreshed.status).toBe(200)

    const reminted = (await refreshed.json()) as MessageShape
    expect(reminted.attachments[0]!.url).not.toBe(message.attachments[0]!.url)

    const fetched = await fetch(new URL(reminted.attachments[0]!.url, baseUrl))
    expect(fetched.status).toBe(200)
    expect(Buffer.from(await fetched.arrayBuffer()).toString()).toBe('payload')
  })

  it('refuses the message read without a bot token', async () => {
    const message = (await (await upload([{ name: 'a.bin', bytes: Buffer.from('data') }])).json()) as MessageShape

    expect((await fetch(messageUrl(message.channel_id, message.id))).status).toBe(401)
    expect(
      (await fetch(messageUrl(message.channel_id, message.id), { headers: { authorization: 'Bot wrong' } })).status,
    ).toBe(401)
  })
})

describe('fake discord: rate limiting', () => {
  it('returns 429 with Retry-After once the window is exhausted, then recovers', async () => {
    control.setRateLimit({ limit: 3, windowMs: 400 })

    const statuses: number[] = []
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await upload([{ name: `a${i}.bin`, bytes: Buffer.from('x') }])).status)
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200])
    expect(statuses[3]).toBe(429)

    const limited = await upload([{ name: 'again.bin', bytes: Buffer.from('x') }])
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0')

    await new Promise((resolve) => setTimeout(resolve, 450))
    expect((await upload([{ name: 'after.bin', bytes: Buffer.from('x') }])).status).toBe(200)
  })

  it('exposes X-RateLimit headers on successful posts', async () => {
    control.setRateLimit({ limit: 5, windowMs: 2000 })
    const response = await upload([{ name: 'a.bin', bytes: Buffer.from('x') }])
    expect(response.headers.get('x-ratelimit-limit')).toBe('5')
    expect(response.headers.get('x-ratelimit-remaining')).toBe('4')
  })
})

describe('fake discord: test control surface', () => {
  it('forces the next N webhook posts to fail', async () => {
    control.queueFailures(2, 429, 0)
    expect((await upload([{ name: 'a.bin', bytes: Buffer.from('x') }])).status).toBe(429)
    expect((await upload([{ name: 'a.bin', bytes: Buffer.from('x') }])).status).toBe(429)
    expect((await upload([{ name: 'a.bin', bytes: Buffer.from('x') }])).status).toBe(200)
  })

  it('reports and resets stats', async () => {
    await upload([{ name: 'a.bin', bytes: Buffer.from('12345') }])
    const stats = control.stats()
    expect(stats.webhookPosts).toBe(1)
    expect(stats.storedAttachments).toBe(1)
    expect(stats.storedBytes).toBe(5)

    await fetch(`${baseUrl}/__control/reset`, { method: 'POST' })
    expect(control.stats().webhookPosts).toBe(0)
    expect(control.stats().storedAttachments).toBe(0)
  })

  it('supports corrupting stored bytes so integrity verification can be tested', async () => {
    const message = (await (await upload([{ name: 'a.bin', bytes: Buffer.from('original') }])).json()) as MessageShape
    control.corruptAttachment(message.attachments[0]!.id)

    const fetched = await fetch(new URL(message.attachments[0]!.url, baseUrl))
    expect(Buffer.from(await fetched.arrayBuffer()).toString()).not.toBe('original')
  })
})