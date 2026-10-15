import type { Server } from 'node:http'
import { createFakeDiscord, type FakeDiscordControl } from '../../src/dev/fake-discord.js'

/**
 * A fake Discord server on an ephemeral port for tests that exercise the Discord client.
 *
 * Started per file rather than shared: the control surface (rate limits, forced failures,
 * attachment ceiling) is global state, and leaking it between files is how a test ends up
 * passing for the wrong reason.
 */
export interface FakeDiscordHandle {
  url: string
  /** The token the fake will accept on a `Bot ...` authorization header. */
  botToken: string
  control: FakeDiscordControl
  stop(): Promise<void>
}

const FAKE_BOT_TOKEN = 'MTE5NDU2Nzg5MDEyMzQ1Njc4.GhIjkl.MnOprstuvwXyZ0123456789abcdefghijkl'

export async function startFakeDiscord(options: { maxAttachmentBytes?: number } = {}): Promise<FakeDiscordHandle> {
  const { app, control } = createFakeDiscord({
    botToken: FAKE_BOT_TOKEN,
    maxAttachmentBytes: options.maxAttachmentBytes ?? 10 * 1024 * 1024,
  })

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to bind fake discord')

  return {
    // The base the Discord client expects, including the version segment.
    url: `http://127.0.0.1:${address.port}/api/v10`,
    botToken: FAKE_BOT_TOKEN,
    control,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
