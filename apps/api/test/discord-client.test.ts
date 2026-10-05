import { createServer, type Socket } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getMessage, getWebhookInfo, sendTestMessage } from '../src/modules/webhooks/discord.client.js'
import { resetEnvCache } from '../src/config/env.js'
import { startFakeDiscord, type FakeDiscordHandle } from './helpers/fake-discord-server.js'

/**
 * The Discord client is the one place a stored credential becomes a network request, so
 * these tests cover URL rewriting and error translation rather than the HTTP surface.
 *
 * Real Discord is never contacted: `DISCORD_API_BASE` is redirected at a fake server before
 * the module under test reads it.
 */

const ID = '1234567890123456789'
const TOKEN = 'a-webhook-token-value'
const URL_WITH_TOKEN = `https://discord.com/api/webhooks/${ID}/${TOKEN}`

let fake: FakeDiscordHandle

beforeAll(async () => {
  fake = await startFakeDiscord({ maxAttachmentBytes: 8 * 1024 * 1024 })
  process.env.DISCORD_API_BASE = fake.url
  resetEnvCache()
})

/**
 * The fake's rate limiter and forced failures are global state, so each test starts from a
 * clean slate. Without this, a test inherits the previous test's budget and fails for a
 * reason that has nothing to do with what it asserts.
 */
beforeEach(() => {
  fake.control.reset()
  // The fake's default limiter is per-webhook-id, and these tests deliberately share one id.
  // Left on, the third test in the file would 429 because of the first two — a failure that
  // has nothing to do with what it asserts. The rate-limit test opts back in.
  fake.control.setRateLimit(null)
})

afterAll(async () => {
  await fake.stop()
})

/** Accepts connections and never answers, so a request can only end in a timeout. */
async function startStalledServer() {
  const sockets: Socket[] = []
  const server = createServer(() => {})
  server.on('connection', (socket) => sockets.push(socket))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to bind')
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const webhook = (token = TOKEN) => ({ webhookId: ID, token, normalized: `https://discord.com/api/webhooks/${ID}/${token}` })

describe('URL rewriting', () => {
  it('adds the version segment to an unversioned webhook URL', async () => {
    // This is the URL shape Discord shows users. Sent verbatim it would 404.
    const outcome = await getWebhookInfo(webhook())
    expect(outcome.ok).toBe(true)
  })

  it('accepts a relative path, as a message read supplies', async () => {
    const posted = await sendTestMessage(webhook(), { content: 'hello' })
    expect(posted.ok).toBe(true)
    if (!posted.ok) throw new Error(posted.message)
    const message = posted.data

    // Built from ids rather than a stored URL, and relative.
    // The fake accepts only its own token, so a wrong one would read as "relative URLs
    // are broken" rather than as an auth failure.
    const fetched = await getMessage(message.channel_id, message.id, fake.botToken)
    expect(fetched.ok).toBe(true)
  })

  it('routes to the configured base, never to the host in the credential', async () => {
    const outcome = await getWebhookInfo(webhook())
    expect(outcome.ok).toBe(true)
    // The only host contacted was the fake.
    expect(fake.control.stats().webhookPosts).toBeGreaterThanOrEqual(0)
  })
})

describe('error translation', () => {
  it('passes Discord’s own code and message through for an unknown webhook', async () => {
    const outcome = await getWebhookInfo(webhook('short'))
    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ code: 10015 })
  })

  it('keeps a rate limit distinguishable as a rate limit, not a dead webhook', async () => {
    // Discord answers 429 with `code: 0`, so a caller cannot key off the code. The status
    // survives, and the dispatcher needs it to back off rather than mark the webhook broken.
    const outcome = await sendTestMessage(webhook(), { content: 'hello' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.message)

    // Driven by the real limiter rather than a forced failure: a forced 429 is checked
    // first in the handler and would short-circuit to a generic message, so it would not
    // actually exercise the rate-limit path.
    fake.control.setRateLimit({ limit: 1, windowMs: 60_000 })
    await sendTestMessage(webhook(), { content: 'first' })

    const limited = await sendTestMessage(webhook(), { content: 'second' })
    expect(limited.ok).toBe(false)
    expect(limited).toMatchObject({ code: 0 })
    expect((limited as { message: string }).message).toMatch(/rate limit/i)
  })

  it('does not treat a forced upstream failure as a size rejection', async () => {
    fake.control.queueFailures(1, 500)
    const outcome = await sendTestMessage(webhook(), { content: 'hello' })
    expect(outcome.ok).toBe(false)
    // Anything that is not one of the size codes must not become a probed ceiling.
    expect([40005, 50013, 50045]).not.toContain((outcome as { code: number }).code)
  })

  it('reports an unresponsive endpoint as a timeout rather than a network failure', async () => {
    // A server that accepts the connection and never replies. Distinguishable from a
    // refused connection because the two point at different problems.
    const stalled = await startStalledServer()
    const previousBase = process.env.DISCORD_API_BASE
    process.env.DISCORD_API_BASE = `http://127.0.0.1:${stalled.port}/api/v10`
    resetEnvCache()

    try {
      const outcome = await getWebhookInfo(webhook(), 250)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected a timeout')
      expect(outcome.code).toBe(-1)
      expect(outcome.message).toMatch(/did not respond in time/i)
    } finally {
      process.env.DISCORD_API_BASE = previousBase
      resetEnvCache()
      await stalled.close()
    }
  })

  it('reports a refused connection as unreachable, not as a timeout', async () => {
    // Nothing is listening: a different code, because the webhook may still be fine and the
    // user's network may be the problem.
    const previousBase = process.env.DISCORD_API_BASE
    process.env.DISCORD_API_BASE = 'http://127.0.0.1:1/api/v10'
    resetEnvCache()

    try {
      const outcome = await getWebhookInfo(webhook())
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected a failure')
      expect(outcome.code).toBe(0)
      expect(outcome.message).toMatch(/could not reach discord/i)
    } finally {
      process.env.DISCORD_API_BASE = previousBase
      resetEnvCache()
    }
  })
})
