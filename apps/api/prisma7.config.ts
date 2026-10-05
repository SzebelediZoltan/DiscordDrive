import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, env } from 'prisma/config'

// The repo holds a single `.env` at its root, so the CLI has to walk up to find it.
// An `apps/api/.env` takes precedence, which keeps per-developer overrides possible.
const here = dirname(fileURLToPath(import.meta.url))
for (const [index, path] of [resolve(here, '../../.env'), resolve(here, '.env')].entries()) {
  if (existsSync(path)) config({ path, override: index > 0, quiet: true })
}

// Named prisma7.config.ts on purpose: from Prisma 7.10 the CLI accepts either this
// or prisma.config.ts, and only the latter is the Prisma 8 format. The versioned
// name means a future v8 CLI will not silently reinterpret this file.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
})
