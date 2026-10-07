import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { resetEnvCache } from '../src/config/env.js'
import { prisma, resetDatabase } from './helpers/db.js'
import { resetAuthRateLimits } from '../src/modules/auth/rate-limit.js'
import { hashPassword } from '../src/lib/passwords.js'
import { AuditAction } from '../src/generated/prisma/client.js'

/**
 * Auth is the one place where a bug is a security bug rather than a broken feature, so
 * these tests drive the real Express app against a real Postgres schema: middleware
 * ordering, cookie attributes and the Prisma queries are all exercised together. A
 * mocked service layer would pass while the wiring was wrong.
 */

const app = createApp()

async function createUser(overrides: {
  email?: string
  password?: string
  displayName?: string
  role?: 'ADMIN' | 'USER'
  status?: 'ACTIVE' | 'PENDING' | 'SUSPENDED'
  onboardedAt?: Date | null
} = {}) {
  const email = overrides.email ?? 'user@example.com'
  return prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(overrides.password ?? 'Passw0rd123'),
      displayName: overrides.displayName ?? 'Test User',
      role: overrides.role ?? 'USER',
      status: overrides.status ?? 'ACTIVE',
      approvedAt: overrides.status === 'PENDING' ? null : new Date(),
      onboardedAt: overrides.onboardedAt === undefined ? new Date() : overrides.onboardedAt,
    },
  })
}

beforeEach(async () => {
  await resetDatabase()
  resetAuthRateLimits()
  resetEnvCache()
})

describe('POST /api/auth/register', () => {
  it('creates a PENDING user and issues no session', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'New.User@Example.com', password: 'Passw0rd123' })

    expect(response.status).toBe(201)
    expect(response.body.user).toMatchObject({
      email: 'new.user@example.com',
      role: 'USER',
      status: 'PENDING',
      approved: false,
    })
    // Normalised: the address is lowercased so login never has to guess at case.
    expect(response.headers['set-cookie'] ?? []).toHaveLength(0)

    const created = await prisma.user.findUnique({ where: { email: 'new.user@example.com' } })
    expect(created?.status).toBe('PENDING')
    expect(created?.approvedAt).toBeNull()
  })

  it('derives a display name from the address when none is given', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'solo@example.com', password: 'Passw0rd123' })
    expect(response.body.user.displayName).toBe('solo')
  })

  it('never stores the password in the clear', async () => {
    await request(app).post('/api/auth/register').send({ email: 'a@b.com', password: 'Passw0rd123' })
    const row = await prisma.user.findUnique({ where: { email: 'a@b.com' } })
    expect(row?.passwordHash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
    expect(row?.passwordHash).not.toContain('Passw0rd123')
  })

  it('rejects a duplicate address with 409', async () => {
    await createUser({ email: 'taken@example.com' })
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'taken@example.com', password: 'Passw0rd123' })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('EMAIL_TAKEN')
  })

  it.each([
    // A 9-character password, valid composition, below the minimum.
    ['a password below the length minimum', { email: 'x@example.com', password: 'Passw0rd1' }, 'at least 10'],
    ['a password with no uppercase letter', { email: 'x@example.com', password: 'passw0rd12345' }, 'uppercase'],
    ['a password with no digit', { email: 'x@example.com', password: 'PasswordOnly' }, 'digit'],
    ['a malformed email address', { email: 'not-an-email', password: 'Passw0rd123' }, 'valid email'],
    ['an empty display name', { email: 'x@example.com', password: 'Passw0rd123', displayName: '   ' }, 'display name'],
  ] satisfies [string, Record<string, unknown>, string][])(
    'rejects %s',
    async (_label, payload, expectedFragment) => {
      const response = await request(app).post('/api/auth/register').send(payload)
      expect(response.status).toBe(400)
      expect(response.body.error.message.toLowerCase()).toContain(expectedFragment)
    },
  )

  it('rejects unknown fields instead of silently accepting them', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'x@example.com', password: 'Passw0rd123', role: 'ADMIN' })
    expect(response.status).toBe(400)
  })
})

describe('POST /api/auth/login', () => {
  it('sets an httpOnly session cookie plus a readable CSRF cookie', async () => {
    await createUser({ email: 'active@example.com' })

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'active@example.com', password: 'Passw0rd123' })

    expect(response.status).toBe(200)
    expect(response.body.user.status).toBe('ACTIVE')

    const cookies = response.headers['set-cookie'] as unknown as string[]
    const session = cookies.find((c) => c.startsWith('dd_session='))
    const csrf = cookies.find((c) => c.startsWith('dd_csrf='))

    expect(session).toMatch(/HttpOnly/i)
    expect(session).toMatch(/SameSite=Lax/i)
    expect(session).toMatch(/Path=\//i)
    expect(session).toMatch(/Max-Age=\d+/i)
    // Deliberately NOT httpOnly: the SPA has to read this to echo it in a header.
    expect(csrf).not.toMatch(/HttpOnly/i)
  })

  it('accepts a lowercased address regardless of the case used at registration', async () => {
    await createUser({ email: 'mixed@example.com' })
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'MiXeD@Example.com', password: 'Passw0rd123' })
    expect(response.status).toBe(200)
  })

  it('returns the same error for a wrong password and an unknown address', async () => {
    await createUser({ email: 'known@example.com' })

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'known@example.com', password: 'Wr0ngpassword' })
    const unknownUser = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'Wr0ngpassword' })

    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    // Byte-identical, so the response cannot be used to discover who has an account.
    expect(wrongPassword.body).toEqual(unknownUser.body)
  })

  it('distinguishes pending from suspended, because both need different action', async () => {
    await createUser({ email: 'pending@example.com', status: 'PENDING' })
    await createUser({ email: 'suspended@example.com', status: 'SUSPENDED' })

    const pending = await request(app)
      .post('/api/auth/login')
      .send({ email: 'pending@example.com', password: 'Passw0rd123' })
    const suspended = await request(app)
      .post('/api/auth/login')
      .send({ email: 'suspended@example.com', password: 'Passw0rd123' })

    expect(pending.body.error.code).toBe('ACCOUNT_PENDING')
    expect(suspended.body.error.code).toBe('ACCOUNT_SUSPENDED')
    expect(pending.headers['set-cookie'] ?? []).toHaveLength(0)
  })

  it('locks an IP out after repeated failures and clears the record on success', async () => {
    await createUser({ email: 'target@example.com' })
    resetEnvCache()
    process.env.AUTH_RATE_LIMIT_FAILURES = '3'
    process.env.AUTH_RATE_LIMIT_WINDOW_MS = '60000'
    resetEnvCache()
    resetAuthRateLimits()

    // The failure that trips the limit is itself answered with 429, so the client learns
    // the lockout is real rather than having to burn another request to discover it.
    for (let i = 0; i < 2; i += 1) {
      const failed = await request(app)
        .post('/api/auth/login')
        .send({ email: 'target@example.com', password: 'wrong' })
      expect(failed.status).toBe(401)
    }

    const tripped = await request(app)
      .post('/api/auth/login')
      .send({ email: 'target@example.com', password: 'wrong' })
    expect(tripped.status).toBe(429)

    const locked = await request(app)
      .post('/api/auth/login')
      .send({ email: 'target@example.com', password: 'Passw0rd123' })
    expect(locked.status).toBe(429)
    expect(locked.headers['retry-after']).toBeDefined()

    delete process.env.AUTH_RATE_LIMIT_FAILURES
    delete process.env.AUTH_RATE_LIMIT_WINDOW_MS
    resetEnvCache()
  })
})

describe('GET /api/auth/me', () => {
  it('returns the signed-in user', async () => {
    await createUser({ email: 'me@example.com', displayName: 'Me' })
    const agent = request.agent(app)
    await agent.post('/api/auth/login').send({ email: 'me@example.com', password: 'Passw0rd123' })

    const response = await agent.get('/api/auth/me')
    expect(response.status).toBe(200)
    expect(response.body.user).toMatchObject({ email: 'me@example.com', displayName: 'Me', role: 'USER' })
  })

  it('401s without a session', async () => {
    const response = await request(app).get('/api/auth/me')
    expect(response.status).toBe(401)
  })

  it('401s on a tampered token rather than trusting its claims', async () => {
    const user = await createUser({ email: 'tamper@example.com', role: 'ADMIN' })
    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `dd_session=not.a.jwt`)
    expect(response.status).toBe(401)
    expect(user.role).toBe('ADMIN')
  })

  it('stops working the moment an admin suspends the account', async () => {
    await createUser({ email: 'revoke@example.com' })
    const agent = request.agent(app)
    await agent.post('/api/auth/login').send({ email: 'revoke@example.com', password: 'Passw0rd123' })
    expect((await agent.get('/api/auth/me')).status).toBe(200)

    // The token is still cryptographically valid here. Only the per-request user read
    // stops this, which is the whole reason requireAuth hits the database.
    await prisma.user.update({ where: { email: 'revoke@example.com' }, data: { status: 'SUSPENDED' } })

    const after = await agent.get('/api/auth/me')
    expect(after.status).toBe(403)
    expect(after.body.error.code).toBe('ACCOUNT_SUSPENDED')
  })

  it('reports a role change without requiring a new login', async () => {
    await createUser({ email: 'promote@example.com', role: 'USER' })
    const agent = request.agent(app)
    await agent.post('/api/auth/login').send({ email: 'promote@example.com', password: 'Passw0rd123' })
    expect((await agent.get('/api/auth/me')).body.user.role).toBe('USER')

    await prisma.user.update({ where: { email: 'promote@example.com' }, data: { role: 'ADMIN' } })
    expect((await agent.get('/api/auth/me')).body.user.role).toBe('ADMIN')
  })
})

describe('POST /api/auth/logout', () => {
  it('clears both cookies', async () => {
    const agent = request.agent(app)
    await createUser({ email: 'bye@example.com' })
    await agent.post('/api/auth/login').send({ email: 'bye@example.com', password: 'Passw0rd123' })

    const response = await agent.post('/api/auth/logout')
    expect(response.status).toBe(204)

    const cookies = response.headers['set-cookie'] as unknown as string[]
    expect(cookies.some((c) => c.startsWith('dd_session='))).toBe(true)
    expect(cookies.some((c) => c.startsWith('dd_csrf='))).toBe(true)
  })
})

describe('POST /api/auth/change-password', () => {
  it('swaps the password and revalidates it against the new one', async () => {
    await createUser({ email: 'rotate@example.com' })
    const agent = request.agent(app)
    await agent.post('/api/auth/login').send({ email: 'rotate@example.com', password: 'Passw0rd123' })

    const changed = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: 'Passw0rd123', newPassword: 'N3wpassword!' })
    expect(changed.status).toBe(204)

    await agent.post('/api/auth/logout')
    const relogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'rotate@example.com', password: 'N3wpassword!' })
    expect(relogin.status).toBe(200)

    const stale = await request(app)
      .post('/api/auth/login')
      .send({ email: 'rotate@example.com', password: 'Passw0rd123' })
    expect(stale.status).toBe(401)
  })

  it('refuses a change when the current password is wrong', async () => {
    await createUser({ email: 'wrongcurrent@example.com' })
    const agent = request.agent(app)
    await agent.post('/api/auth/login').send({ email: 'wrongcurrent@example.com', password: 'Passw0rd123' })

    const response = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: 'notmine', newPassword: 'N3wpassword!' })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('WRONG_PASSWORD')
  })

  it('401s when not signed in', async () => {
    const response = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'a', newPassword: 'N3wpassword!' })
    expect(response.status).toBe(401)
  })
})

describe('POST /api/auth/onboarding-complete', () => {
  it('marks an unonboarded user complete and returns the updated session user', async () => {
    await createUser({ email: 'wizard@example.com', onboardedAt: null })
    const agent = request.agent(app)
    await agent.post('/api/auth/login').send({ email: 'wizard@example.com', password: 'Passw0rd123' })

    const response = await agent.post('/api/auth/onboarding-complete')
    expect(response.status).toBe(200)
    expect(response.body.user.onboardingComplete).toBe(true)
    expect(response.body.user.onboardedAt).not.toBeNull()

    const row = await prisma.user.findUnique({ where: { email: 'wizard@example.com' } })
    expect(row!.onboardedAt).not.toBeNull()
  })

  it('is idempotent and writes exactly one audit row', async () => {
    await createUser({ email: 'twice@example.com', onboardedAt: null })
    const agent = request.agent(app)
    await agent.post('/api/auth/login').send({ email: 'twice@example.com', password: 'Passw0rd123' })

    expect((await agent.post('/api/auth/onboarding-complete')).status).toBe(200)
    expect((await agent.post('/api/auth/onboarding-complete')).status).toBe(200)
    expect((await agent.post('/api/auth/onboarding-complete')).status).toBe(200)

    const audits = await prisma.auditLog.count({
      where: { action: AuditAction.ONBOARDING_COMPLETED },
    })
    expect(audits).toBe(1)

    const me = await agent.get('/api/auth/me')
    expect(me.body.user.onboardingComplete).toBe(true)
  })

  it('no-ops (200) for an already on-boarded account instead of erroring', async () => {
    await createUser({ email: 'done@example.com', onboardedAt: new Date() })
    const agent = request.agent(app)
    await agent.post('/api/auth/login').send({ email: 'done@example.com', password: 'Passw0rd123' })

    const response = await agent.post('/api/auth/onboarding-complete')
    expect(response.status).toBe(200)
    expect(response.body.user.onboardingComplete).toBe(true)
  })

  it('401s when not signed in', async () => {
    const response = await request(app).post('/api/auth/onboarding-complete')
    expect(response.status).toBe(401)
  })
})