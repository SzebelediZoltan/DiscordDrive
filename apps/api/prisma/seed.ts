/**
 * Idempotent seed.
 *
 * Creates the default admin so a fresh stack has a way in. The password comes from
 * ADMIN_PASSWORD and defaults to the documented value, which is exactly why the
 * warning at the end is unconditional rather than first-run-only.
 *
 * Run with `tsx`: the Prisma 7 client generator emits TypeScript, not JavaScript, so
 * plain `node --experimental-strip-types` cannot resolve the `.js` specifiers that
 * NodeNext requires.
 */
import '../src/config/dotenv.js'
import { randomBytes, scryptSync } from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, Role, UserStatus } from '../src/generated/prisma/client.js'

const DEFAULT_ADMIN_EMAIL = 'szebe99@gmail.com'
const DEFAULT_ADMIN_PASSWORD = 'Harkaly88'

/**
 * scrypt from the Node standard library: no dependency, and a memory-hard KDF.
 * The login path uses the same primitive via `src/lib/passwords.ts` (issue #3).
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. Run scripts/setup-env.sh first.')

  const email = (process.env.ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL).toLowerCase()
  const password = process.env.ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) })

  try {
    const existing = await prisma.user.findUnique({ where: { email } })

    if (existing) {
      // Never reset an existing admin's password: re-running the seed must not
      // silently hand a known default back to a live deployment.
      console.log(`admin already present: ${email} (role=${existing.role}, status=${existing.status})`)
    } else {
      const admin = await prisma.user.create({
        data: {
          email,
          passwordHash: hashPassword(password),
          displayName: 'DiscordDrive Admin',
          role: Role.ADMIN,
          status: UserStatus.ACTIVE,
          approvedAt: new Date(),
          onboardedAt: new Date(),
        },
      })
      console.log(`created admin: ${admin.email}`)
    }

    if (password === DEFAULT_ADMIN_PASSWORD) {
      console.warn('')
      console.warn('  ============================================================')
      console.warn('   ADMIN_PASSWORD is still the built-in default value.')
      console.warn('   Set a real password in .env before exposing this deployment.')
      console.warn('  ============================================================')
      console.warn('')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
