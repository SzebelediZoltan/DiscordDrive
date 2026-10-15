import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/lib/passwords.js'
import { decrypt } from '../src/lib/crypto.js'
import { prisma, resetDatabase } from './helpers/db.js'
import { startFakeDiscord, type FakeDiscordHandle } from './helpers/fake-discord-server.js'

/**
 * Webhook credentials are the most sensitive thing this app stores: a webhook URL is a live
 * credential, and a bot token is an account credential. These tests therefore assert on
 * absence as much as on behaviour — no response may contain the plaintext, and no column
 * may hold it.
 *
 * The app is created after DISCORD_API_BASE is pointed at a fake server, because the
 * Discord client reads that base once at import. A real Discord is never contacted.
 */

const SNOWFLAKE = '1234567890123456789'
const TOKEN = 'fake-webhook-token-value-abcdef'
const BOT_TOKEN = 'MTE5NDU2Nzg5MDEyMzQ1Njc4.GhIjkl.MnOprstuvwXyZ0123456789abcdefghijkl'
const URL = `https://discord.com/api/webhooks/${SNOWFLAKE}/${TOKEN}`

let fake: FakeDiscordHandle
let app: Awaited<ReturnType<typeof loadApp>>
let agent: ReturnType<typeof request.agent>

async function loadApp() {
  const { createApp } = await import('../src/app.js')
  return createApp()
}

const CREDENTIAL = { email: 'owner@example.com', password: 'Passw0rd123' }

async function createUser(overrides: { onboarded?: boolean } = {}) {
  return prisma.user.create({
    data: {
      email: CREDENTIAL.email,
      passwordHash: await hashPassword(CREDENTIAL.password),
      displayName: 'Owner',
      role: 'USER',
      status: 'ACTIVE',
      approvedAt: new Date(),
      onboardedAt: overrides.onboarded === false ? null : new Date(),
    },
  })
}

beforeAll(async () => {
  fake = await startFakeDiscord({ maxAttachmentBytes: 10 * 1024 * 1024 })
  process.env.DISCORD_API_BASE = fake.url
  const { resetEnvCache } = await import('../src/config/env.js')
  resetEnvCache()
  app = await loadApp()
  agent = request.agent(app)
})

afterAll(async () => {
  await fake.stop()
})

beforeEach(async () => {
  fake.control.reset()
  // The probe deliberately makes more requests than Discord's default per-webhook budget,
  // which is the point of the pacing it now does. Left on, it would 429 and the test would
  // be asserting on the limiter rather than on the probe.
  fake.control.setRateLimit(null)
  await resetDatabase()
})

describe('webhook URL validation', () => {
  it('rejects a non-Discord host', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)

    const response = await agent.post('/api/webhooks').send({ name: 'Evil', url: 'https://evil.example.com/hook' })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_WEBHOOK_URL')
  })

  it('rejects a URL that is not https', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)

    const response = await agent
      .post('/api/webhooks')
      .send({ name: 'Plain', url: `http://discord.com/api/webhooks/${SNOWFLAKE}/${TOKEN}` })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_WEBHOOK_URL')
  })

  it('rejects a Discord URL that is not a webhook, with a message that says what to paste', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)

    const response = await agent
      .post('/api/webhooks')
      .send({ name: 'Wrong path', url: 'https://discord.com/api/v10/users/@me' })
    expect(response.status).toBe(400)
    expect(response.body.error.message).toMatch(/api\/webhooks/i)
  })

  it('rejects a non-URL outright', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    const response = await agent.post('/api/webhooks').send({ name: 'Bad', url: 'not a url at all' })
    expect(response.status).toBe(400)
  })

  it('accepts the legacy discordapp.com host and normalises it', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)

    const response = await agent
      .post('/api/webhooks')
      .send({ name: 'Legacy', url: `https://discordapp.com/api/webhooks/${SNOWFLAKE}/${TOKEN}` })

    expect(response.status).toBe(201)
    expect(response.body.webhook.webhookId).toBe(SNOWFLAKE)

    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: response.body.webhook.id } })
    const stored = decrypt({ enc: row.webhookUrlEnc, iv: row.webhookUrlIv, tag: row.webhookUrlTag })
    // Rewritten on save so one code path deals with one host.
    expect(stored).toBe(`https://discord.com/api/webhooks/${SNOWFLAKE}/${TOKEN}`)
  })

  it('rejects a bot token that is obviously wrong, and accepts a plausible one', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)

    const bad = await agent
      .post('/api/webhooks')
      .send({ name: 'Bad token', url: URL, botToken: 'too-short' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('INVALID_BOT_TOKEN')

    const good = await agent
      .post('/api/webhooks')
      .send({ name: 'Good token', url: URL, botToken: BOT_TOKEN })
    expect(good.status).toBe(201)
    expect(good.body.webhook.hasBotToken).toBe(true)
  })
})

describe('credential handling', () => {
  it('never returns the webhook URL or token from any endpoint', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)

    const created = await agent.post('/api/webhooks').send({ name: 'Secret', url: URL, botToken: BOT_TOKEN })
    expect(created.status).toBe(201)

    // Every read path, and the whole response body, not just the fields we looked at.
    // Thunks, not requests: a supertest request object is single-use.
    const endpoints = [
      () => agent.get('/api/webhooks'),
      () => agent.get(`/api/webhooks/${created.body.webhook.id}`),
      () => agent.patch(`/api/webhooks/${created.body.webhook.id}`).send({ name: 'Renamed' }),
      () => agent.post(`/api/webhooks/${created.body.webhook.id}/test`),
    ]

    for (const call of endpoints) {
      const response = await call()
      const body = JSON.stringify(response.body)
      expect(body).not.toContain(TOKEN)
      expect(body).not.toContain(BOT_TOKEN)
      expect(body).not.toContain('webhookUrlEnc')
      expect(body).not.toContain('botTokenEnc')
      expect(body).not.toContain(SNOWFLAKE + '/' + TOKEN)
    }
  })

  it('stores the URL and token encrypted, never in the clear', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    await agent.post('/api/webhooks').send({ name: 'Secret', url: URL, botToken: BOT_TOKEN })

    const row = await prisma.webhook.findFirstOrThrow({ where: { name: 'Secret' } })

    expect(row.webhookUrlEnc).not.toContain(TOKEN)
    expect(row.botTokenEnc).not.toContain(BOT_TOKEN)
    expect(row.webhookUrlEnc).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(row.webhookUrlIv).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(row.webhookUrlTag).toMatch(/^[A-Za-z0-9+/=]+$/)

    // And they decrypt back to exactly what was sent.
    expect(decrypt({ enc: row.webhookUrlEnc, iv: row.webhookUrlIv, tag: row.webhookUrlTag })).toBe(URL)
    expect(decrypt({ enc: row.botTokenEnc!, iv: row.botTokenIv!, tag: row.botTokenTag! })).toBe(BOT_TOKEN)
  })

  it('gives two encryptions of the same URL different ciphertext', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    await agent.post('/api/webhooks').send({ name: 'One', url: URL })
    await agent.post('/api/webhooks').send({ name: 'Two', url: URL })

    const rows = await prisma.webhook.findMany({ orderBy: { name: 'asc' } })
    // A reused IV under one key leaks the XOR of two messages. Random per encryption is the
    // reason identical credentials do not produce identical ciphertext.
    expect(rows[0]!.webhookUrlEnc).not.toBe(rows[1]!.webhookUrlEnc)
    expect(rows[0]!.webhookUrlIv).not.toBe(rows[1]!.webhookUrlIv)
  })

  it('offers a masked hint so the user can tell their webhooks apart', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    const created = await agent.post('/api/webhooks').send({ name: 'Secret', url: URL, botToken: BOT_TOKEN })

    expect(created.body.webhook.tokenLast4).toBe(TOKEN.slice(-4))
    expect(created.body.webhook.urlHint).not.toContain(TOKEN)
    expect(created.body.webhook.urlHint).toHaveProperty('hint', 'https://discord.com/api/webhooks/…')
    expect(created.body.webhook.urlHint).toHaveProperty('last4', TOKEN.slice(-4))
  })

  it('does not put the credential in an audit row', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    await agent.post('/api/webhooks').send({ name: 'Audited', url: URL, botToken: BOT_TOKEN })

    const audits = await prisma.auditLog.findMany({ where: { action: 'WEBHOOK_CREATED' } })
    expect(audits).toHaveLength(1)
    const serialised = JSON.stringify(audits[0]!.meta)
    expect(serialised).not.toContain(TOKEN)
    expect(serialised).not.toContain(BOT_TOKEN)
    // The snowflake is not a secret, and it is genuinely useful in a log.
    expect(audits[0]!.meta).toMatchObject({ name: 'Audited', discordWebhookId: SNOWFLAKE })
  })
})

describe('CRUD and ownership', () => {
  it('makes the first webhook the default automatically', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)

    const first = await agent.post('/api/webhooks').send({ name: 'First', url: URL })
    expect(first.body.webhook.isDefault).toBe(true)

    const second = await agent
      .post('/api/webhooks')
      .send({ name: 'Second', url: `https://discord.com/api/webhooks/${SNOWFLAKE}/another-token-value` })
    expect(second.body.webhook.isDefault).toBe(false)
    expect(first.body.webhook.isDefault).toBe(true)
  })

  it('keeps exactly one default when a second is promoted', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    const first = await agent.post('/api/webhooks').send({ name: 'First', url: URL })
    const second = await agent
      .post('/api/webhooks')
      .send({ name: 'Second', url: `https://discord.com/api/webhooks/${SNOWFLAKE}/another-token-value` })

    await agent.patch(`/api/webhooks/${second.body.webhook.id}`).send({ isDefault: true })

    const defaults = await prisma.webhook.count({ where: { userId: (await prisma.user.findUniqueOrThrow({ where: { email: CREDENTIAL.email } })).id, isDefault: true } })
    expect(defaults).toBe(1)
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id: first.body.webhook.id } })).isDefault).toBe(false)
  })

  it('promotes another webhook when the default is deleted', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    const first = await agent.post('/api/webhooks').send({ name: 'First', url: URL })
    const second = await agent
      .post('/api/webhooks')
      .send({ name: 'Second', url: `https://discord.com/api/webhooks/${SNOWFLAKE}/another-token-value` })

    await agent.delete(`/api/webhooks/${first.body.webhook.id}`).expect(204)

    // Otherwise the user is left with no default and every upload has nowhere to go.
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id: second.body.webhook.id } })).isDefault).toBe(true)
  })

  it('clears the probe result when the URL changes', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    const created = await agent.post('/api/webhooks').send({ name: 'Moving', url: URL })

    await prisma.webhook.update({
      where: { id: created.body.webhook.id },
      data: { maxChunkBytes: 10 * 1024 * 1024, lastTestStatus: 'OK', channelId: 'old-channel' },
    })

    await agent
      .patch(`/api/webhooks/${created.body.webhook.id}`)
      .send({ url: `https://discord.com/api/webhooks/${SNOWFLAKE}/a-different-token-value` })
      .expect(200)

    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: created.body.webhook.id } })
    // The old measurements describe a different destination.
    expect(row.maxChunkBytes).toBeNull()
    expect(row.lastTestStatus).toBe('UNKNOWN')
    expect(row.channelId).toBeNull()
  })

  it('cannot read or delete another user’s webhook', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    const created = await agent.post('/api/webhooks').send({ name: 'Mine', url: URL })

    const other = await prisma.user.create({
      data: {
        email: 'intruder@example.com',
        passwordHash: await hashPassword('Passw0rd123'),
        displayName: 'Intruder',
        status: 'ACTIVE',
        approvedAt: new Date(),
        onboardedAt: new Date(),
      },
    })
    const otherAgent = request.agent(app)
    await otherAgent.post('/api/auth/login').send({ email: other.email, password: 'Passw0rd123' })

    // 404, not 403: the existence of someone else's webhook is not disclosed.
    expect((await otherAgent.patch(`/api/webhooks/${created.body.webhook.id}`).send({ name: 'Stolen' })).status).toBe(404)
    expect((await otherAgent.delete(`/api/webhooks/${created.body.webhook.id}`)).status).toBe(404)
    expect((await otherAgent.get('/api/webhooks')).body.webhooks).toHaveLength(0)
  })

  it('401s every webhook route without a session', async () => {
    const anonymous = request.agent(app)
    for (const [method, path] of [
      ['get', '/api/webhooks'],
      ['post', '/api/webhooks'],
      ['patch', '/api/webhooks/abc'],
      ['delete', '/api/webhooks/abc'],
      ['post', '/api/webhooks/abc/test'],
      ['post', '/api/webhooks/abc/probe-limit'],
    ] as const) {
      const response = await anonymous[method](path).send({ name: 'x', url: URL })
      expect(response.status, `${method} ${path}`).toBe(401)
    }
  })

  it('lets a not-yet-onboarded account create a webhook, since the wizard depends on it', async () => {
    await createUser({ onboarded: false })
    await agent.post('/api/auth/login').send(CREDENTIAL)

    const response = await agent.post('/api/webhooks').send({ name: 'Early', url: URL })
    expect(response.status).toBe(201)
    expect(response.body.webhook.name).toBe('Early')

    const row = await prisma.user.findUnique({ where: { email: CREDENTIAL.email } })
    expect(row!.onboardedAt).toBeNull()
  })
})

describe('POST /api/webhooks/:id/test', () => {
  it('sends a real message and reports success with latency', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    const created = await agent.post('/api/webhooks').send({ name: 'Working', url: URL })

    const response = await agent.post(`/api/webhooks/${created.body.webhook.id}/test`)
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(typeof response.body.latencyMs).toBe('number')
    // Discord only reveals the channel on a successful post.
    expect(response.body.channelId).toBe(`channel-${SNOWFLAKE}`)
    expect(fake.control.stats().webhookPosts).toBeGreaterThan(0)

    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: created.body.webhook.id } })
    expect(row.lastTestStatus).toBe('OK')
    expect(row.lastTestError).toBeNull()
  })

  it('surfaces Discord’s own error text when the webhook is invalid', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)

    // A syntactically valid URL the server does not know: the fake answers 10015.
    const created = await agent
      .post('/api/webhooks')
      .send({ name: 'Deleted', url: `https://discord.com/api/webhooks/${SNOWFLAKE}/tok` })

    const response = await agent.post(`/api/webhooks/${created.body.webhook.id}/test`)
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(false)
    expect(response.body.message).toBeTruthy()
    expect(response.body.code).toBe(10015)
  })

  it('records the failure so the user sees it again without retesting', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    const created = await agent
      .post('/api/webhooks')
      .send({ name: 'Broken', url: `https://discord.com/api/webhooks/${SNOWFLAKE}/tok` })

    await agent.post(`/api/webhooks/${created.body.webhook.id}/test`)

    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: created.body.webhook.id } })
    expect(row.lastTestStatus).toBe('FAILED')
    expect(row.lastTestedAt).not.toBeNull()
    expect(row.lastTestError).toBeTruthy()

    // The listing surfaces it, so the dashboard can show a red badge.
    const list = await agent.get('/api/webhooks')
    expect(list.body.webhooks[0].lastTestStatus).toBe('FAILED')
    expect(list.body.webhooks[0].lastTestError).toBeTruthy()
  })
})

describe('POST /api/webhooks/:id/probe-limit', () => {
  it('finds the attachment ceiling and persists it', async () => {
    // Fake ceiling is 10 MiB, so the probe should stop there.
    fake.control.setMaxAttachmentBytes(10 * 1024 * 1024)
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    const created = await agent.post('/api/webhooks').send({ name: 'Probed', url: URL })

    const response = await agent.post(`/api/webhooks/${created.body.webhook.id}/probe-limit`)
    expect(response.status).toBe(200)
    expect(response.body.maxChunkBytes).toBe(10 * 1024 * 1024)
    expect(response.body.maxChunkMiB).toBe(10)
    expect(response.body.rejectedAtBytes).toBe(16 * 1024 * 1024)

    // Persisted, so the dispatcher never emits a chunk this webhook would refuse.
    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: created.body.webhook.id } })
    expect(row.maxChunkBytes).toBe(10 * 1024 * 1024)
  })

  it('honours a smaller ceiling the webhook actually enforces', async () => {
    fake.control.setMaxAttachmentBytes(3 * 1024 * 1024)
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    const created = await agent.post('/api/webhooks').send({ name: 'Small', url: URL })

    const response = await agent.post(`/api/webhooks/${created.body.webhook.id}/probe-limit`)
    expect(response.body.maxChunkBytes).toBe(3 * 1024 * 1024)
    expect(response.body.rejectedAtBytes).toBe(4 * 1024 * 1024)
  })

  it('warns that the probe left messages in the channel', async () => {
    await createUser()
    await agent.post('/api/auth/login').send(CREDENTIAL)
    const created = await agent.post('/api/webhooks').send({ name: 'Chatty', url: URL })

    const response = await agent.post(`/api/webhooks/${created.body.webhook.id}/probe-limit`)
    // Each successful probe is a real message in a real channel. The user is told what it
    // cost, so the count reflects messages that actually landed rather than attempts.
    expect(response.body.messagesLeftBehind).toBeGreaterThan(0)
    expect(response.body.attempts).toBeGreaterThanOrEqual(response.body.messagesLeftBehind)
    expect(response.body.warning).toMatch(/test message/i)
  })
})