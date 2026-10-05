import { prisma, prismaSchema } from '../../src/lib/prisma.js'

/**
 * Tables the suite writes to, in an order that lets FK cascades do the work.
 *
 * The `_prisma_migrations` table is deliberately absent: truncating it would make the next
 * `migrate deploy` believe nothing had been applied.
 */
const TABLES = [
  'audit_logs',
  'chunks',
  'chunk_batches',
  'upload_sessions',
  'files',
  'folders',
  'webhooks',
  'waitlist_entries',
  'users',
] as const

/**
 * The schema to qualify table names with.
 *
 * This has to come from the adapter configuration, not from `SELECT current_schema()`:
 * the adapter is given a `schema`, which qualifies the table names Prisma generates, but a
 * raw statement is sent to Postgres verbatim and resolves unqualified names through
 * `search_path`, which stays `public`. An unqualified TRUNCATE would therefore wipe real
 * rows while leaving the test rows in place, and every later case would fail on a unique
 * constraint with no obvious cause. `current_schema()` reports `public` precisely because
 * that is what the session is actually searching.
 */
async function schemaName(): Promise<string> {
  return prismaSchema ?? 'public'
}

export async function resetDatabase(): Promise<void> {
  const schema = await schemaName()

  // Identifiers cannot be parameterised, so the name is validated before interpolation.
  // It comes from current_schema(), but validating costs nothing and keeps the rule local.
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`refusing to truncate in an unexpected schema: ${JSON.stringify(schema)}`)
  }

  const qualified = TABLES.map((table) => `"${schema}"."${table}"`).join(', ')

  // TRUNCATE rather than DELETE: no per-row triggers, and RESTART IDENTITY resets sequences
  // so id assertions do not depend on how many cases ran before this one.
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${qualified} RESTART IDENTITY CASCADE`)
}

export { prisma }