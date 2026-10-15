/**
 * Runs before any test module is imported, so `process.env.DATABASE_URL` already points
 * at the throwaway schema by the time `loadEnv()` first caches it. Setting it here rather
 * than in `globalSetup` is required: global setup executes in a separate process from the
 * test workers, so its environment changes would not reach them.
 *
 * dotenv is loaded first but does not override real environment variables, so the override
 * below wins over a developer's root `.env` while a developer with no `.env` still works.
 */
import '../../src/config/dotenv.js'
import { testDatabaseUrl } from './global-setup.js'

process.env.DATABASE_URL = testDatabaseUrl()
process.env.NODE_ENV = 'test'
// Forced, not defaulted: the root .env sets LOG_LEVEL=info, which would bury the test
// report in a JSON line per request.
process.env.LOG_LEVEL = 'silent'

const { resetEnvCache } = await import('../../src/config/env.js')
const { resetSigningKeyCache } = await import('../../src/lib/tokens.js')
resetEnvCache()
resetSigningKeyCache()