import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The repo keeps a single `.env` at its root rather than one per app, so both the
 * API server and the Prisma CLI have to walk up to find it. An `apps/api/.env` wins
 * when present, which is what makes per-developer or per-test overrides possible.
 *
 * Imported for its side effect as the very first import of `server.ts`: ES module
 * imports are evaluated in order, so this has run before the logger builds itself.
 */
const here = dirname(fileURLToPath(import.meta.url))

// apps/api/src/config -> src -> api -> apps -> repo root
const candidates = [resolve(here, '../../../../.env'), resolve(here, '../../.env')]

for (const [index, path] of candidates.entries()) {
  if (!existsSync(path)) continue
  // Later candidates override earlier ones.
  config({ path, override: index > 0, quiet: true })
}
