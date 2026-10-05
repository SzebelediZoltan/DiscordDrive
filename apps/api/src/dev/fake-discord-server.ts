/**
 * Standalone entry point for the fake Discord server, so the stack can run against it
 * (`FAKE_DISCORD=true`, or `docker compose --profile fake-discord up`) and so tests can
 * hit it over HTTP without importing the factory.
 */
import { createFakeDiscord } from './fake-discord.js'

const port = Number(process.env.FAKE_DISCORD_PORT ?? 4001)

createFakeDiscord({
  linkTtlMs: (Number(process.env.FAKE_DISCORD_LINK_TTL_S ?? 3600)) * 1000,
}).app.listen(port, () => {
  console.log(`fake discord listening on :${port} (links expire after ${process.env.FAKE_DISCORD_LINK_TTL_S ?? 3600}s)`)
})
