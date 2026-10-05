import { prisma } from '../../src/lib/prisma.js'

/**
 * Truncates the tables that tests write to.
 *
 * TRUNCATE ... CASCADE rather than DELETE: it does not fire per-row behaviour, and it
 * resets sequences, so an id assertion is not order-dependent across runs. The
 * migration table is excluded, or the next `migrate deploy` would think nothing was applied.
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

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  )
}

export { prisma }
