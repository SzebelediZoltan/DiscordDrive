import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { loadEnv } from '../config/env.js'
import { logger } from '../config/logger.js'

/**
 * A single PrismaClient for the whole process.
 *
 * Prisma 7 ships no Rust engine: the generated client is a query compiler that needs a
 * driver adapter, so the connection string is supplied here rather than read from the
 * schema at runtime.
 */
const databaseUrl = loadEnv().DATABASE_URL

/**
 * The Prisma CLI honours `?schema=` in DATABASE_URL, but the runtime adapter does not: pg
 * only understands a fixed set of connection parameters and ignores the rest, leaving the
 * default `public` search_path. Generated queries then resolve unqualified table names
 * against `public`.
 *
 * That is invisible in normal use and dangerous in tests, which point DATABASE_URL at a
 * throwaway schema: every model query would silently hit real tables, and the TRUNCATE
 * between test cases would delete them.
 *
 * The adapter's own `schema` option is the supported way to fix this, because it is what
 * the query compiler uses when it builds SQL. Setting `search_path` through `options` is
 * not equivalent -- raw SQL honours it, model queries do not -- which is precisely the
 * half-working state this replaced.
 */
function configuredSchema(url: string): string | undefined {
  const schema = new URL(url).searchParams.get('schema')
  if (schema === null || schema === 'public') return undefined
  // Validated rather than interpolated: this ends up in generated SQL identifiers.
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`DATABASE_URL has an unsupported schema name: ${JSON.stringify(schema)}`)
  }
  return schema
}

const schema = configuredSchema(databaseUrl)

const adapter = new PrismaPg(
  { connectionString: databaseUrl, max: loadEnv().DISCORD_GLOBAL_CONCURRENCY + 4 },
  // Undefined rather than absent, so the adapter keeps its default for the public schema.
  schema === undefined ? undefined : { schema },
)

export const prisma = new PrismaClient({
  adapter,
  log: loadEnv().LOG_LEVEL === 'debug' ? ['warn', 'error'] : ['error'],
})

/**
 * The schema Prisma generates qualified table names for, or undefined for `public`.
 *
 * Exported because raw SQL sent through this client is *not* qualified: it resolves against
 * the session `search_path`, which stays `public`. Anything writing raw statements against
 * these tables (test truncation, future reporting queries) has to name the schema itself,
 * and this is the only reliable source for what it is.
 */
export const prismaSchema: string | undefined = schema

export type PrismaTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** Closes the pool. Called on shutdown so the container exits promptly. */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect()
  logger.debug('prisma disconnected')
}