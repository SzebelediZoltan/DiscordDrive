// Must stay first: loads the repo-root .env before anything reads process.env.
import './config/dotenv.js'
// Second: starts the fake Discord server and repoints DISCORD_API_BASE before the
// environment is read and cached. See the module for why ordering matters.
import './dev/bootstrap-fake-discord.js'
import { createServer } from 'node:http'
import { createApp } from './app.js'
import { loadEnv } from './config/env.js'
import { logger } from './config/logger.js'

const env = loadEnv()

if (env.ADMIN_PASSWORD === 'Harkaly88') {
  logger.warn(
    'ADMIN_PASSWORD is still the built-in default. Set ADMIN_PASSWORD in .env before exposing this deployment.',
  )
}

const server = createServer(createApp())

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV, fakeDiscord: env.FAKE_DISCORD }, 'discorddrive api listening')
})

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down')
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'error during shutdown')
      process.exit(1)
    }
    process.exit(0)
  })
  // Do not let an in-flight 1 GB download hold the container open forever.
  setTimeout(() => {
    logger.warn('forcing shutdown after grace period')
    process.exit(1)
  }, 15_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
