/**
 * Starts the fake Discord server and repoints the API at it.
 *
 * Imported for its side effect as the *first* import in `server.ts`. ES module imports
 * are evaluated in declaration order, so this runs before `config/logger` builds
 * itself and before `loadEnv()` caches the environment. Repointing
 * DISCORD_API_BASE from here rather than from server.ts body code is what makes the
 * override visible to the cached env.
 */
import { loadEnv } from '../config/env.js'
import { createFakeDiscord, type FakeDiscordControl } from './fake-discord.js'

const env = loadEnv()

let control: FakeDiscordControl | null = null

if (env.FAKE_DISCORD) {
  const created = createFakeDiscord({
    linkTtlMs: env.FAKE_DISCORD_LINK_TTL_S * 1000,
    botToken: env.FAKE_DISCORD_BOT_TOKEN,
    maxAttachmentBytes: env.CHUNK_SIZE_MIB,
  })

  const fakeBase = `http://127.0.0.1:${env.FAKE_DISCORD_PORT}/api/v10`

  // An explicit DISCORD_API_BASE wins, so someone can still point the API at the fake
  // running as a separate container while overriding its advertised address.
  const override = process.env.DISCORD_API_BASE
  if (override === undefined || override === 'https://discord.com/api/v10') {
    process.env.DISCORD_API_BASE = fakeBase
  }

  created.app.listen(env.FAKE_DISCORD_PORT, () => {
    console.log(
      `[fake-discord] listening on :${env.FAKE_DISCORD_PORT} (links expire after ${env.FAKE_DISCORD_LINK_TTL_S}s)`,
    )
  })

  control = created.control
}

export function fakeDiscordControl(): FakeDiscordControl | null {
  return control
}