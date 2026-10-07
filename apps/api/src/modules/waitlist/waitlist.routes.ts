import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { AuditAction } from '../../generated/prisma/client.js'
import { recordAudit } from '../../lib/audit.js'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../http/errors.js'
import { requireAdmin, requireAuth } from '../../http/auth-middleware.js'
import { getWaitlistStatus, peopleAhead } from './waitlist.service.js'

/**
 * Public: no session required, because the registration page has to show a live counter
 * to someone who has not signed up yet.
 */
export function createWaitlistRouter(): Router {
  const router = Router()

  router.get('/status', async (req: Request, res: Response): Promise<void> => {
    const email = z.string().trim().toLowerCase().email().safeParse(req.query.email)
    if (!email.success) throw AppError.badRequest('VALIDATION_ERROR', 'A valid email query parameter is required')

    const snapshot = await getWaitlistStatus(email.data)
    res.json(snapshot)
  })

  router.get('/count', async (_req: Request, res: Response): Promise<void> => {
    // Anonymous counter for the marketing footer. No email, so nothing to correlate.
    const waitingCount = await prisma.waitlistEntry.count({ where: { status: 'WAITING' } })
    res.json({ waitingCount })
  })

  return router
}

/** For the signed-in applicant: their own position and how many people are ahead. */
export function createMyWaitlistRouter(): Router {
  const router = Router()
  router.use(requireAuth)

  router.get('/status', async (req: Request, res: Response): Promise<void> => {
    const email = req.user!.email
    const snapshot = await getWaitlistStatus(email)
    const ahead =
      snapshot.position === null ? null : await peopleAhead(snapshot.position)

    res.json({ ...snapshot, positionInLine: ahead })
  })

  return router
}

const listQuerySchema = z.object({
  status: z.enum(['WAITING', 'APPROVED', 'REJECTED', 'CANCELLED']).default('WAITING'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().cuid().optional(),
})

/**
 * Admin endpoints. Every route is behind `requireAdmin`, and every mutating route writes
 * an audit row in the same transaction as the change it describes.
 */
export function createAdminRouter(): Router {
  const router = Router()
  // requireAuth first, and it is not redundant: it is what loads req.user, and it is also
  // what rejects PENDING and SUSPENDED accounts. requireAdmin only checks a role, so
  // without it in front, an admin route would 401 every request.
  router.use(requireAuth, requireAdmin)

  router.get('/waitlist', async (req: Request, res: Response): Promise<void> => {
    const query = listQuerySchema.safeParse(req.query)
    if (!query.success) throw AppError.badRequest('VALIDATION_ERROR', query.error.issues[0]?.message ?? 'Invalid query')

    const { status, limit, cursor } = query.data

    // Keyset pagination on position rather than OFFSET: approving someone shifts the
    // window, so an offset page would silently skip or repeat rows while an admin works.
    const entries = await prisma.waitlistEntry.findMany({
      where: { status },
      orderBy: { position: 'asc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        user: {
          select: { id: true, email: true, displayName: true, status: true, role: true, createdAt: true },
        },
      },
    })

    const hasMore = entries.length > limit
    const page = hasMore ? entries.slice(0, limit) : entries

    res.json({
      entries: page.map((e) => ({
        id: e.id,
        position: e.position,
        status: e.status,
        createdAt: e.createdAt,
        resolvedAt: e.resolvedAt,
        user: e.user,
      })),
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    })
  })

  router.post('/users/:id/approve', async (req: Request, res: Response): Promise<void> => {
    const result = await resolveWaitlist(req, 'approve')
    res.json(result)
  })

  router.post('/users/:id/reject', async (req: Request, res: Response): Promise<void> => {
    const result = await resolveWaitlist(req, 'reject')
    res.json(result)
  })

  router.post('/users/:id/suspend', async (req: Request, res: Response): Promise<void> => {
    const user = await loadUser(req.params.id)

    if (user.role === 'ADMIN') {
      throw AppError.badRequest('CANNOT_SUSPEND_ADMIN', 'An administrator account cannot be suspended here')
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } })
      await recordAudit(
        {
          action: AuditAction.USER_SUSPENDED,
          targetUserId: user.id,
          actorUserId: req.user!.id,
          actorIp: req.ip,
          meta: { email: user.email },
        },
        tx,
      )
    })

    res.json({ user: { id: user.id, email: user.email, status: 'SUSPENDED' } })
  })

  router.post('/users/:id/reactivate', async (req: Request, res: Response): Promise<void> => {
    const user = await loadUser(req.params.id)

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { status: 'ACTIVE', approvedAt: user.approvedAt ?? new Date() },
      })
      await tx.waitlistEntry.updateMany({
        where: { userId: user.id, status: 'REJECTED' },
        data: { status: 'APPROVED', resolvedAt: new Date() },
      })
      await recordAudit(
        {
          action: AuditAction.USER_REACTIVATED,
          targetUserId: user.id,
          actorUserId: req.user!.id,
          actorIp: req.ip,
          meta: { email: user.email },
        },
        tx,
      )
    })

    res.json({ user: { id: user.id, email: user.email, status: 'ACTIVE' } })
  })

  router.patch('/users/:id/role', async (req: Request, res: Response): Promise<void> => {
    const parsed = z.object({ role: z.enum(['ADMIN', 'USER']) }).safeParse(req.body)
    if (!parsed.success) throw AppError.badRequest('VALIDATION_ERROR', 'role must be ADMIN or USER')

    const user = await loadUser(req.params.id)
    const previousRole = user.role

    if (user.id === req.user!.id && parsed.data.role !== 'ADMIN') {
      // Guarding against self-demotion: an admin who removes their own ADMIN role locks
      // every remaining admin out of this router with no way back in through the UI.
      throw AppError.badRequest('CANNOT_DEMOTE_SELF', 'You cannot remove your own administrator role')
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { role: parsed.data.role } })
      await recordAudit(
        {
          action: AuditAction.USER_ROLE_CHANGED,
          targetUserId: user.id,
          actorUserId: req.user!.id,
          actorIp: req.ip,
          meta: { from: previousRole, to: parsed.data.role, email: user.email },
        },
        tx,
      )
    })

    res.json({ user: { id: user.id, email: user.email, role: parsed.data.role } })
  })

  router.get('/usage', async (_req: Request, res: Response): Promise<void> => {
    const [activeUsers, filesByUser, bytesByUser, webhooksByUser, userCount, fileCount, storedBytes, webhookCount] =
      await Promise.all([
        prisma.user.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, email: true, displayName: true, role: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.fileObject.groupBy({
          by: ['userId'],
          where: { status: { not: 'DELETED' } },
          _count: { _all: true },
        }),
        prisma.fileObject.groupBy({
          by: ['userId'],
          where: { status: { not: 'DELETED' } },
          _sum: { sizeBytes: true },
        }),
        prisma.webhook.groupBy({ by: ['userId'], _count: { _all: true } }),
        prisma.user.count({ where: { status: 'ACTIVE' } }),
        prisma.fileObject.count({ where: { status: { not: 'DELETED' } } }),
        prisma.fileObject.aggregate({
          where: { status: { not: 'DELETED' } },
          _sum: { sizeBytes: true },
        }),
        prisma.webhook.count(),
      ])

    const filesMap = new Map(filesByUser.map((row) => [row.userId, row._count._all]))
    const bytesMap = new Map(bytesByUser.map((row) => [row.userId, row._sum.sizeBytes ?? 0n]))
    const webhooksMap = new Map(webhooksByUser.map((row) => [row.userId, row._count._all]))

    const rows = activeUsers
      .map((u) => {
        const bytes = bytesMap.get(u.id)
        return {
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          createdAt: u.createdAt,
          files: filesMap.get(u.id) ?? 0,
          storedBytes: bytes,
          webhooks: webhooksMap.get(u.id) ?? 0,
        }
      })
      .sort((a, b) => (b.storedBytes ?? 0n) > (a.storedBytes ?? 0n) ? 1 : -1)

    res.json({
      totals: {
        users: userCount,
        files: fileCount,
        storedBytes: (storedBytes._sum.sizeBytes ?? 0n).toString(),
        webhooks: webhookCount,
      },
      users: rows.map((row) => ({
        ...row,
        storedBytes: (row.storedBytes ?? 0n).toString(),
      })),
    })
  })

  router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
    const [users, waiting, usersByStatus, uploads, storedBytes, webhookCount, chunkCount] =
      await Promise.all([
        prisma.user.count(),
        prisma.waitlistEntry.count({ where: { status: 'WAITING' } }),
        prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.fileObject.count(),
        prisma.fileObject.aggregate({ _sum: { sizeBytes: true } }),
        prisma.webhook.count(),
        prisma.chunk.count(),
      ])

    const byStatus = Object.fromEntries(usersByStatus.map((s) => [s.status, s._count._all]))

    res.json({
      users,
      waiting,
      usersByStatus: {
        PENDING: byStatus.PENDING ?? 0,
        ACTIVE: byStatus.ACTIVE ?? 0,
        SUSPENDED: byStatus.SUSPENDED ?? 0,
      },
      files: uploads,
      // BigInt cannot cross JSON, and these will outgrow Number.MAX_SAFE_INTEGER at the
      // scale this product targets, so the value is stringified deliberately.
      storedBytes: (storedBytes._sum.sizeBytes ?? 0n).toString(),
      webhooks: webhookCount,
      chunks: chunkCount,
    })
  })

  return router
}

/**
 * A repeated `:id` param arrives as an array. Taking the last value and then validating
 * it means the cuid check is the single place that decides what a user id looks like.
 */
function paramId(rawId: string | string[] | undefined): string | undefined {
  return Array.isArray(rawId) ? rawId[rawId.length - 1] : rawId
}

async function loadUser(rawId: string | string[] | undefined) {
  const id = paramId(rawId)
  if (!id || !z.string().cuid().safeParse(id).success) {
    throw AppError.badRequest('VALIDATION_ERROR', 'A valid user id is required')
  }
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, status: true, approvedAt: true },
  })
  if (!user) throw AppError.notFound('User not found')
  return user
}

/**
 * Approve and reject share their state machine because the difference is a single field,
 * and duplicating it would mean two places to keep consistent.
 */
async function resolveWaitlist(
  req: Request,
  decision: 'approve' | 'reject',
): Promise<{ user: { id: string; email: string; status: string }; position: number | null }> {
  const user = await loadUser(req.params.id)

  const entry = await prisma.waitlistEntry.findUnique({ where: { userId: user.id } })
  if (!entry) throw AppError.notFound('That account has no waitlist entry')
  if (entry.status !== 'WAITING') {
    throw AppError.conflict('ALREADY_RESOLVED', `That application was already ${entry.status.toLowerCase()}`)
  }

  const action = decision === 'approve' ? AuditAction.USER_APPROVED : AuditAction.USER_REJECTED

  const updated = await prisma.$transaction(async (tx) => {
    // `position` is untouched on purpose: renumbering would silently move everyone who
    // was told a specific number, and there is nothing to gain by it.
    await tx.waitlistEntry.update({
      where: { id: entry.id },
      data: { status: decision === 'approve' ? 'APPROVED' : 'REJECTED', resolvedAt: new Date() },
    })

    const next = await tx.user.update({
      where: { id: user.id },
      data:
        decision === 'approve'
          ? { status: 'ACTIVE', approvedAt: new Date() }
          : { status: 'SUSPENDED' },
      select: { id: true, email: true, status: true },
    })

    await recordAudit(
      {
        action,
        targetUserId: user.id,
        actorUserId: req.user!.id,
        actorIp: req.ip,
        meta: { email: user.email, position: entry.position },
      },
      tx,
    )

    return next
  })

  return { user: updated, position: entry.position }
}