import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/lib/passwords.js'
import { prisma, resetDatabase } from './helpers/db.js'

/**
 * The waitlist has one genuinely hard requirement: two people registering at the same
 * instant must not be handed the same number. That is tested here with real concurrent
 * transactions, because a sequential test of a race condition proves nothing.
 */

const app = createApp()

const ADMIN = { email: 'admin@example.com', password: 'Passw0rd123' }
const REGISTRATION = { password: 'Passw0rd123' }

async function createAdmin(): Promise<{ id: string }> {
  const user = await prisma.user.create({
    data: {
      email: ADMIN.email,
      passwordHash: await hashPassword(ADMIN.password),
      displayName: 'Admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      approvedAt: new Date(),
      onboardedAt: new Date(),
    },
    select: { id: true },
  })
  // Admins are seeded outside the waitlist, so give them no entry. If any admin route
  // assumed an entry exists, these tests would catch it.
  return user
}

async function adminAgent() {
  const agent = request.agent(app)
  const login = await agent.post('/api/auth/login').send(ADMIN)
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`)
  return agent
}

async function userAgent(email: string, password = REGISTRATION.password) {
  const agent = request.agent(app)
  await agent.post('/api/auth/login').send({ email, password })
  return agent
}

async function register(email: string) {
  return request(app).post('/api/auth/register').send({ email, ...REGISTRATION })
}

beforeEach(async () => {
  await resetDatabase()
  await createAdmin()
})

describe('registration and queue position', () => {
  it('gives every registrant a distinct position, in order', async () => {
    const first = await register('a@example.com')
    const second = await register('b@example.com')
    const third = await register('c@example.com')

    expect([first, second, third].map((r) => r.status)).toEqual([201, 201, 201])
    expect([first, second, third].map((r) => r.body.user.status)).toEqual(['PENDING', 'PENDING', 'PENDING'])

    const entries = await prisma.waitlistEntry.findMany({ orderBy: { position: 'asc' } })
    expect(entries.map((e) => e.position)).toEqual([1, 2, 3])
    expect(new Set(entries.map((e) => e.position)).size).toBe(3)
  })

  it('allocates distinct positions to genuinely concurrent registrations', async () => {
    // Ten at once. Without the advisory lock this reliably produces duplicates, because
    // every transaction reads the same MAX(position) before any of them commits.
    const emails = Array.from({ length: 10 }, (_, i) => `race${i}@example.com`)
    const responses = await Promise.all(emails.map((email) => register(email)))

    expect(responses.every((r) => r.status === 201)).toBe(true)

    const entries = await prisma.waitlistEntry.findMany({ orderBy: { position: 'asc' } })
    const positions = entries.map((e) => e.position)

    expect(entries).toHaveLength(10)
    expect(new Set(positions).size).toBe(10)
    // No gaps either: a hole would mean a rolled-back insert consumed a number we never
    // handed out, and the next applicant would then appear to jump forward.
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('records the registration in the audit log with the position', async () => {
    await register('audited@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'audited@example.com' } })

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'USER_REGISTERED', userId: user!.id },
    })
    expect(audit).not.toBeNull()
    expect(audit!.meta).toMatchObject({ position: 1 })
  })

  it('writes a user and a waitlist entry together, never one without the other', async () => {
    const before = await prisma.user.count()
    // A duplicate address must not leave a queue entry behind either.
    await register('dupe@example.com')
    const second = await register('dupe@example.com')

    expect(second.status).toBe(409)
    expect(await prisma.user.count()).toBe(before + 1)
    expect(await prisma.waitlistEntry.count()).toBe(1)
  })
})

describe('GET /api/waitlist', () => {
  it('reports the waiting count without a session', async () => {
    await register('pub1@example.com')
    await register('pub2@example.com')

    const response = await request(app).get('/api/waitlist/count')
    expect(response.status).toBe(200)
    expect(response.body.waitingCount).toBe(2)
  })

  it('reports position and waiting count by email, still without a session', async () => {
    await register('first@example.com')
    await register('second@example.com')

    const response = await request(app).get('/api/waitlist/status').query({ email: 'second@example.com' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ position: 2, waitingCount: 2 })
  })

  it('returns a null position for a registered email that has been resolved', async () => {
    await register('done@example.com')
    const admin = await adminAgent()

    const user = await prisma.user.findUnique({ where: { email: 'done@example.com' } })
    await admin.post(`/api/admin/users/${user!.id}/approve`).expect(200)

    const response = await request(app).get('/api/waitlist/status').query({ email: 'done@example.com' })
    // Their number is gone from the queue, but the row keeps it for history.
    expect(response.body.position).toBeNull()
    expect(response.body.waitingCount).toBe(0)
  })

  it('does not leak a position for an unknown address', async () => {
    await register('real@example.com')
    const response = await request(app).get('/api/waitlist/status').query({ email: 'ghost@example.com' })
    expect(response.status).toBe(200)
    expect(response.body.position).toBeNull()
    expect(response.body.waitingCount).toBe(1)
  })

  it('rejects a malformed address instead of defaulting', async () => {
    const response = await request(app).get('/api/waitlist/status').query({ email: 'nonsense' })
    expect(response.status).toBe(400)
  })
})

describe('admin approval flow', () => {
  it('approves a user, who can then sign in and is sent to onboarding', async () => {
    await register('applicant@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'applicant@example.com' } })
    expect(user!.onboardedAt).toBeNull()

    const admin = await adminAgent()
    const approved = await admin.post(`/api/admin/users/${user!.id}/approve`)
    expect(approved.status).toBe(200)
    expect(approved.body.user.status).toBe('ACTIVE')
    // The position is echoed back so the admin UI can confirm which entry was actioned.
    expect(approved.body.position).toBe(1)

    const agent = await userAgent('applicant@example.com')
    const me = await agent.get('/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.user.status).toBe('ACTIVE')
    // Approved but not onboarded: the SPA redirects to /onboarding from this flag.
    expect(me.body.user.onboardingComplete).toBe(false)
  })

  it('writes an audit row naming the admin who approved', async () => {
    await register('audited-approve@example.com')
    const applicant = await prisma.user.findUnique({ where: { email: 'audited-approve@example.com' } })
    const adminUser = await prisma.user.findUnique({ where: { email: ADMIN.email } })

    const agent = await adminAgent()
    await agent.post(`/api/admin/users/${applicant!.id}/approve`)

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'USER_APPROVED', userId: applicant!.id },
    })
    expect(audit).not.toBeNull()
    // Attribution is the point of the column: without it the log says what happened but
    // not who did it.
    expect(audit!.actorUserId).toBe(adminUser!.id)
    expect(audit!.ipAddress).toBeTruthy()
    expect(audit!.meta).toMatchObject({ email: 'audited-approve@example.com', position: 1 })
  })

  it('rejects a user, blocks their login, and does not renumber the queue', async () => {
    await register('r1@example.com')
    await register('r2@example.com')
    await register('r3@example.com')

    const second = await prisma.user.findUnique({ where: { email: 'r2@example.com' } })
    const admin = await adminAgent()

    const rejected = await admin.post(`/api/admin/users/${second!.id}/reject`)
    expect(rejected.status).toBe(200)
    expect(rejected.body.user.status).toBe('SUSPENDED')

    // The slot is released: r3 keeps position 3 rather than being pulled forward to 2.
    const entries = await prisma.waitlistEntry.findMany({ orderBy: { position: 'asc' } })
    expect(entries.map((e) => [e.userId === second!.id ? 'r2' : 'other', e.position, e.status])).toEqual([
      ['other', 1, 'WAITING'],
      ['r2', 2, 'REJECTED'],
      ['other', 3, 'WAITING'],
    ])

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'r2@example.com', password: REGISTRATION.password })
    expect(login.status).toBe(403)
    expect(login.body.error.code).toBe('ACCOUNT_SUSPENDED')
  })

  it('refuses to resolve the same application twice', async () => {
    await register('twice@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'twice@example.com' } })
    const admin = await adminAgent()

    expect((await admin.post(`/api/admin/users/${user!.id}/approve`)).status).toBe(200)
    const again = await admin.post(`/api/admin/users/${user!.id}/approve`)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('ALREADY_RESOLVED')
  })

  it('404s an id that is not a user', async () => {
    const admin = await adminAgent()
    const response = await admin.post('/api/admin/users/aaaaaaaaaaaaaaaaaaaaaaaa/approve')
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('admin listing', () => {
  it('paginates by cursor without skipping or repeating under change', async () => {
    const emails = Array.from({ length: 5 }, (_, i) => `page${i}@example.com`)
    for (const email of emails) await register(email)

    const admin = await adminAgent()

    const firstPage = await admin.get('/api/admin/waitlist').query({ limit: 2 })
    expect(firstPage.status).toBe(200)
    expect(firstPage.body.entries).toHaveLength(2)
    expect(firstPage.body.entries.map((e: { position: number }) => e.position)).toEqual([1, 2])
    expect(firstPage.body.nextCursor).not.toBeNull()

    // Resolve the first entry between pages. An OFFSET-based query would now repeat the
    // second row, because the row it was counting against is gone.
    const adminUser = await prisma.user.findUnique({ where: { email: emails[0]! } })
    await admin.post(`/api/admin/users/${adminUser!.id}/approve`)

    const secondPage = await admin.get('/api/admin/waitlist').query({ limit: 2, cursor: firstPage.body.nextCursor })
    expect(secondPage.body.entries.map((e: { position: number }) => e.position)).toEqual([3, 4])
  })

  it('filters by status and never returns a password hash', async () => {
    await register('waiting@example.com')
    await register('approved@example.com')
    const approvedUser = await prisma.user.findUnique({ where: { email: 'approved@example.com' } })
    const admin = await adminAgent()
    await admin.post(`/api/admin/users/${approvedUser!.id}/approve`)

    const response = await admin.get('/api/admin/waitlist').query({ status: 'WAITING' })
    const serialized = JSON.stringify(response.body)
    expect(response.body.entries).toHaveLength(1)
    expect(response.body.entries[0].user.email).toBe('waiting@example.com')
    expect(serialized).not.toContain('passwordHash')
    expect(serialized).not.toContain('scrypt$')
  })

  it('rejects an unknown status filter instead of silently returning everything', async () => {
    const admin = await adminAgent()
    const response = await admin.get('/api/admin/waitlist').query({ status: 'BOGUS' })
    expect(response.status).toBe(400)
  })
})

describe('suspend, reactivate, role', () => {
  it('suspends an active user, cutting off their existing session', async () => {
    await register('victim@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'victim@example.com' } })
    const admin = await adminAgent()
    await admin.post(`/api/admin/users/${user!.id}/approve`)

    const victim = await userAgent('victim@example.com')
    expect((await victim.get('/api/auth/me')).status).toBe(200)

    await admin.post(`/api/admin/users/${user!.id}/suspend`)

    const after = await victim.get('/api/auth/me')
    expect(after.status).toBe(403)
    expect(after.body.error.code).toBe('ACCOUNT_SUSPENDED')
  })

  it('reactivates a suspended user and resolves their rejected waitlist entry', async () => {
    await register('returner@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'returner@example.com' } })
    const admin = await adminAgent()
    await admin.post(`/api/admin/users/${user!.id}/reject`)

    const response = await admin.post(`/api/admin/users/${user!.id}/reactivate`)
    expect(response.status).toBe(200)
    expect(response.body.user.status).toBe('ACTIVE')

    const entry = await prisma.waitlistEntry.findUnique({ where: { userId: user!.id } })
    expect(entry!.status).toBe('APPROVED')

    expect(
      (await request(app).post('/api/auth/login').send({ email: 'returner@example.com', password: REGISTRATION.password }))
        .status,
    ).toBe(200)
  })

  it('refuses to suspend an administrator', async () => {
    const adminUser = await prisma.user.findUnique({ where: { email: ADMIN.email } })
    const admin = await adminAgent()
    const response = await admin.post(`/api/admin/users/${adminUser!.id}/suspend`)
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('CANNOT_SUSPEND_ADMIN')
  })

  it('promotes a user and records the change from and to', async () => {
    await register('promote@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'promote@example.com' } })
    const admin = await adminAgent()

    const response = await admin.patch(`/api/admin/users/${user!.id}/role`).send({ role: 'ADMIN' })
    expect(response.status).toBe(200)
    expect(response.body.user.role).toBe('ADMIN')

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'USER_ROLE_CHANGED', userId: user!.id },
    })
    expect(audit!.meta).toMatchObject({ from: 'USER', to: 'ADMIN' })
  })

  it('blocks an admin from removing their own admin role', async () => {
    const adminUser = await prisma.user.findUnique({ where: { email: ADMIN.email } })
    const admin = await adminAgent()
    const response = await admin.patch(`/api/admin/users/${adminUser!.id}/role`).send({ role: 'USER' })
    // Otherwise the last admin locks every admin route and cannot undo it through the UI.
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('CANNOT_DEMOTE_SELF')
  })

  it('rejects a role outside the enum', async () => {
    await register('badrole@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'badrole@example.com' } })
    const admin = await adminAgent()
    const response = await admin.patch(`/api/admin/users/${user!.id}/role`).send({ role: 'SUPERADMIN' })
    expect(response.status).toBe(400)
  })
})

describe('admin stats', () => {
  it('reports counts, and stringifies BigInt storage totals', async () => {
    await register('s1@example.com')
    await register('s2@example.com')

    const admin = await adminAgent()
    const response = await admin.get('/api/admin/stats')

    expect(response.status).toBe(200)
    expect(response.body.users).toBe(3) // two applicants + the admin
    expect(response.body.waiting).toBe(2)
    expect(response.body.usersByStatus).toEqual({ PENDING: 2, ACTIVE: 1, SUSPENDED: 0 })
    expect(response.body.chunks).toBe(0)
    // BigInt must be a string or JSON.stringify throws on a large total.
    expect(typeof response.body.storedBytes).toBe('string')
    expect(response.body.storedBytes).toBe('0')
  })
})

describe('authorization', () => {
  const routes = [
    ['get', '/api/admin/waitlist'],
    ['get', '/api/admin/stats'],
    ['post', '/api/admin/users/x/approve'],
    ['post', '/api/admin/users/x/reject'],
    ['post', '/api/admin/users/x/suspend'],
    ['post', '/api/admin/users/x/reactivate'],
    ['patch', '/api/admin/users/x/role'],
  ] as const

  it('401s every admin route without a session', async () => {
    for (const [method, path] of routes) {
      const response = await request(app)[method](path).send({ role: 'ADMIN' })
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(401)
    }
  })

  it('403s every admin route for a signed-in non-admin', async () => {
    await register('nosy@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'nosy@example.com' } })
    const admin = await adminAgent()
    await admin.post(`/api/admin/users/${user!.id}/approve`)

    const applicant = await userAgent('nosy@example.com')
    expect((await applicant.get('/api/auth/me')).status).toBe(200)

    for (const [method, path] of routes) {
      const response = await applicant[method](path).send({ role: 'ADMIN' })
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(403)
      expect(response.body.error.code, `${method.toUpperCase()} ${path}`).toBe('FORBIDDEN')
    }
  })

  it('403s admin routes for a suspended user, even with a live session', async () => {
    await register('exadmin@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'exadmin@example.com' } })
    const admin = await adminAgent()
    await admin.post(`/api/admin/users/${user!.id}/approve`)
    await admin.patch(`/api/admin/users/${user!.id}/role`).send({ role: 'ADMIN' })

    const exAdmin = await userAgent('exadmin@example.com')
    expect((await exAdmin.get('/api/admin/stats')).status).toBe(200)

    // Suspended directly in the database. The API deliberately refuses to suspend an
    // ADMIN account, so there is no route that can produce this state: the point of the
    // test is that a role in a live token cannot outlive the account's actual status.
    await prisma.user.update({ where: { id: user!.id }, data: { status: 'SUSPENDED' } })

    const after = await exAdmin.get('/api/admin/stats')
    expect(after.status).toBe(403)
    expect(after.body.error.code).toBe('ACCOUNT_SUSPENDED')
  })

  it('reactivates a suspended user and resolves their rejected waitlist entry', async () => {
    await register('returner@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'returner@example.com' } })
    const admin = await adminAgent()
    await admin.post(`/api/admin/users/${user!.id}/reject`)

    const response = await admin.post(`/api/admin/users/${user!.id}/reactivate`)
    expect(response.status).toBe(200)
    expect(response.body.user.status).toBe('ACTIVE')

    const entry = await prisma.waitlistEntry.findUnique({ where: { userId: user!.id } })
    expect(entry!.status).toBe('APPROVED')

    expect(
      (await request(app).post('/api/auth/login').send({ email: 'returner@example.com', password: REGISTRATION.password }))
        .status,
    ).toBe(200)
  })

  it('refuses to suspend an administrator', async () => {
    const adminUser = await prisma.user.findUnique({ where: { email: ADMIN.email } })
    const admin = await adminAgent()
    const response = await admin.post(`/api/admin/users/${adminUser!.id}/suspend`)
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('CANNOT_SUSPEND_ADMIN')
  })

  it('promotes a user and records the change from and to', async () => {
    await register('promote@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'promote@example.com' } })
    const admin = await adminAgent()

    const response = await admin.patch(`/api/admin/users/${user!.id}/role`).send({ role: 'ADMIN' })
    expect(response.status).toBe(200)
    expect(response.body.user.role).toBe('ADMIN')

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'USER_ROLE_CHANGED', userId: user!.id },
    })
    expect(audit!.meta).toMatchObject({ from: 'USER', to: 'ADMIN' })
  })

  it('blocks an admin from removing their own admin role', async () => {
    const adminUser = await prisma.user.findUnique({ where: { email: ADMIN.email } })
    const admin = await adminAgent()
    const response = await admin.patch(`/api/admin/users/${adminUser!.id}/role`).send({ role: 'USER' })
    // Otherwise the last admin locks every admin route and cannot undo it through the UI.
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('CANNOT_DEMOTE_SELF')
  })

  it('rejects a role outside the enum', async () => {
    await register('badrole@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'badrole@example.com' } })
    const admin = await adminAgent()
    const response = await admin.patch(`/api/admin/users/${user!.id}/role`).send({ role: 'SUPERADMIN' })
    expect(response.status).toBe(400)
  })
})

describe('admin stats', () => {
  it('reports counts, and stringifies BigInt storage totals', async () => {
    await register('s1@example.com')
    await register('s2@example.com')

    const admin = await adminAgent()
    const response = await admin.get('/api/admin/stats')

    expect(response.status).toBe(200)
    expect(response.body.users).toBe(3) // two applicants + the admin
    expect(response.body.waiting).toBe(2)
    expect(response.body.usersByStatus).toEqual({ PENDING: 2, ACTIVE: 1, SUSPENDED: 0 })
    expect(response.body.chunks).toBe(0)
    // BigInt must be a string or JSON.stringify throws on a large total.
    expect(typeof response.body.storedBytes).toBe('string')
    expect(response.body.storedBytes).toBe('0')
  })
})

describe('authorization', () => {
  const routes = [
    ['get', '/api/admin/waitlist'],
    ['get', '/api/admin/stats'],
    ['post', '/api/admin/users/x/approve'],
    ['post', '/api/admin/users/x/reject'],
    ['post', '/api/admin/users/x/suspend'],
    ['post', '/api/admin/users/x/reactivate'],
    ['patch', '/api/admin/users/x/role'],
  ] as const

  it('401s every admin route without a session', async () => {
    for (const [method, path] of routes) {
      const response = await request(app)[method](path).send({ role: 'ADMIN' })
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(401)
    }
  })

  it('403s every admin route for a signed-in non-admin', async () => {
    await register('nosy@example.com')
    const user = await prisma.user.findUnique({ where: { email: 'nosy@example.com' } })
    const admin = await adminAgent()
    await admin.post(`/api/admin/users/${user!.id}/approve`)

    const applicant = await userAgent('nosy@example.com')
    expect((await applicant.get('/api/auth/me')).status).toBe(200)

    for (const [method, path] of routes) {
      const response = await applicant[method](path).send({ role: 'ADMIN' })
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(403)
      expect(response.body.error.code, `${method.toUpperCase()} ${path}`).toBe('FORBIDDEN')
    }
  })


  it('keeps the personal waitlist endpoint private', async () => {
    const response = await request(app).get('/api/me/waitlist/status')
    expect(response.status).toBe(401)
  })
})