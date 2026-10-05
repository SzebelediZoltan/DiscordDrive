import { AuditAction, type Prisma } from '../../generated/prisma/client.js'
import { recordAudit } from '../../lib/audit.js'
import { prisma } from '../../lib/prisma.js'

/**
 * Position allocation.
 *
 * Naive `max(position) + 1` is not safe under concurrency: two simultaneous registrations
 * can both read the same max and write the same position. Two things prevent that here.
 *
 * 1. `pg_advisory_xact_lock` serialises the read-and-insert for this table, and holds it
 *    until the transaction commits. Every other writer blocks on the same key.
 * 2. A unique index on `position` is the backstop. If the lock were ever dropped, the
 *    second insert fails loudly instead of silently colliding with a real applicant's slot.
 *
 * Positions are never renumbered. A rejected or suspended applicant keeps their number,
 * because the number is a thing we told a person out loud, not an index into a live set.
 */

/**
 * Arbitrary but fixed. Any other code path locking waitlist work must use this same key.
 * 0x44495343 = "DISC".
 */
const WAITLIST_LOCK_KEY = 0x44495343

export interface WaitlistStatusSnapshot {
  position: number | null
  waitingCount: number
}

async function allocatePosition(tx: Prisma.TransactionClient): Promise<number> {
  // The lock is schema-independent, so raw SQL is fine here.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WAITLIST_LOCK_KEY})`

  // The max is read through Prisma rather than with a raw SELECT. A raw statement would be
  // resolved by Postgres against `search_path`, not by the adapter's configured schema, and
  // would therefore read a different table than the insert that follows it.
  const { _max } = await tx.waitlistEntry.aggregate({ _max: { position: true } })
  return (_max.position ?? 0) + 1
}

/**
 * Creates the user and their queue position in one transaction, so a crash between the
 * two cannot leave an applicant who exists but has no place in line.
 */
export async function registerWithWaitlist(input: {
  email: string
  passwordHash: string
  displayName: string
  actorIp?: string | null
}): Promise<{ id: string; email: string; displayName: string; position: number }> {
  return prisma.$transaction(async (tx) => {
    const position = await allocatePosition(tx)

    const user = await tx.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        displayName: input.displayName,
        status: 'PENDING',
        role: 'USER',
      },
      select: { id: true, email: true, displayName: true },
    })

    await tx.waitlistEntry.create({
      data: { userId: user.id, position, status: 'WAITING' },
    })

    await recordAudit(
      {
        action: AuditAction.USER_REGISTERED,
        targetUserId: user.id,
        actorIp: input.actorIp ?? null,
        meta: { position },
      },
      tx,
    )

    return { id: user.id, email: user.email, displayName: user.displayName ?? '', position }
  })
}

export async function getWaitlistStatus(email: string): Promise<WaitlistStatusSnapshot> {
  const entry = await prisma.waitlistEntry.findFirst({
    where: { user: { email } },
    select: { position: true, status: true },
  })

  const waitingCount = await prisma.waitlistEntry.count({ where: { status: 'WAITING' } })

  // A resolved applicant has no place in line any more. Returning their old position
  // would make the counter claim there are more people ahead than actually waiting.
  const position = entry && entry.status === 'WAITING' ? entry.position : null

  return { position, waitingCount }
}

/** How many people are ahead of this applicant, inclusive of nobody if they are approved. */
export async function peopleAhead(position: number): Promise<number> {
  const ahead = await prisma.waitlistEntry.count({
    where: { status: 'WAITING', position: { lt: position } },
  })
  return ahead + 1
}