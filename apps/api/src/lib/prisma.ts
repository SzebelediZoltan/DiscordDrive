import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { loadEnv } from '../config/env.js'
import { logger } from '../config/logger.js'

/**
 * A single PrismaClient for the whole process.
 *
 * Prisma 7 ships no Rust engine: the generated client is a query compiler that needs
 * a driver adapter, so the connection string is supplied here rather than read from
 * the schema at runtime.
 */
const adapter = new PrismaPg({
  connectionString: loadEnv().DATABASE_URL,
  max: loadEnv().DISCORD_GLOBAL_CONCURRENCY + 4,
})

export const prisma = new PrismaClient({
  adapter,
  log: loadEnv().LOG_LEVEL === 'debug' ? ['warn', 'error'] : ['error'],
})

export type PrismaTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** Closes the pool. Called on shutdown so the container exits promptly. */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect()
  logger.debug('prisma disconnected')
}
