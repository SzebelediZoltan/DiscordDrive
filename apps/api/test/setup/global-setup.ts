/**
 * Global setup: prepares a dedicated Postgres schema for the test run.
 *
 * Tests share the same Postgres instance as the dev stack but a separate schema, so they
 * can truncate freely without touching real rows, and can run in parallel with the app.
 * `migrate deploy` is invoked here rather than by a fixture because the schema has to
 * exist before the first query.
 */
import '../../src/config/dotenv.js'
import { execFileSync } from 'node:child_process'
import { PrismaPg } from '@prisma/adapter-pg'
import { Client } from 'pg'

export const TEST_SCHEMA = 'discorddrive_test'

export function testDatabaseUrl(): string {
  const base = process.env.DATABASE_URL
  if (!base) {
    throw new Error('DATABASE_URL must be set to run tests. Use the dev/stack database.')
  }
  const url = new URL(base)
  url.searchParams.set('schema', TEST_SCHEMA)
  return url.toString()
}

/**
 * The connection attempt is wrapped so a stopped stack produces the command to run
 * rather than a bare ECONNREFUSED from deep inside pg.
 */
async function connectAdmin(): Promise<Client> {
  const adminUrl = new URL(testDatabaseUrl())
  adminUrl.searchParams.set('schema', 'public')
  const admin = new Client({ connectionString: adminUrl.toString() })
  try {
    await admin.connect()
  } catch (err) {
    throw new Error(
      `Cannot reach Postgres at ${adminUrl.host}. The suite needs a running stack:\n` +
        '  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db\n' +
        `Original error: ${(err as Error).message}`,
    )
  }
  return admin
}

async function ensureSchema(): Promise<void> {
  const admin = await connectAdmin()
  try {
    // Identifier, not a value, so it cannot be parameterised; it is a compile-time
    // constant above and never user input.
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`)
  } finally {
    await admin.end()
  }
}

export default async function setup(): Promise<void> {
  await ensureSchema()

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'inherit',
  })

  // Touch a connection so a bad URL fails in setup, not as a confusing suite-wide error.
  const client = new PrismaPg({ connectionString: testDatabaseUrl() })
  const { PrismaClient } = await import('../../src/generated/prisma/client.js')
  const prisma = new PrismaClient({ adapter: client })
  try {
    await prisma.$queryRaw`SELECT 1`
  } finally {
    await prisma.$disconnect()
  }
}