import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/lib/passwords.js'
import { prisma, resetDatabase } from './helpers/db.js'
import { startFakeDiscord, type FakeDiscordHandle } from './helpers/fake-discord-server.js'

/**
 * The sharing surface end to end: the owner's three-mode access model, the capability
 * carried by a public link, what a grant shows up as in the recipient's drive, and the
 * validation rules on the SPECIFIC recipient list.
 *
 * Geometry matches the download suite (8 MiB chunks, three per message), so a 9 MiB file
 * is two chunks in one message and the byte assertions stay cheap.
 */

const MIB = 1024 * 1024
const SNOWFLAKE = '1234567890123456789'
const TOKEN = 'share-test-webhook-token-abcdef'
const URL = `https://discord.com/api/webhooks/${SNOWFLAKE}/${TOKEN}`

process.env.CHUNK_SIZE_MIB = '8'
process.env.CHUNKS_PER_MESSAGE = '3'

const CHUNK = 8 * MIB
const PASSWORD = 'Passw0rd123'
const SMALL_FILE = [CHUNK, MIB]
const expectedWhole = Buffer.concat([Buffer.alloc(CHUNK, 0), Buffer.alloc(MIB, 1)])

let fake: FakeDiscordHandle
let app: Awaited<ReturnType<typeof loadApp>>

async function loadApp() {
  const { createApp } = await import('../src/app.js')
  return createApp()
}

async function createUser(email: string, overrides: { status?: 'ACTIVE' | 'PENDING' } = {}) {
  return prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      displayName: email.split('@')[0],
      role: 'USER',
      status: overrides.status ?? 'ACTIVE',
      approvedAt: overrides.status === 'PENDING' ? null : new Date(),
      onboardedAt: overrides.status === 'PENDING' ? null : new Date(),
    },
  })
}

async function signIn(email: string) {
  await createUser(email)
  const agent = request.agent(app)
  const response = await agent.post('/api/auth/login').send({ email, password: PASSWORD })
  expect(response.status).toBe(200)
  return agent
}

async function createWebhook(agent: ReturnType<typeof request.agent>) {
  const response = await agent.post('/api/webhooks').send({ name: 'Storage', url: URL })
  expect(response.status).toBe(201)
  return response.body.webhook as { id: string }
}

async function uploadComplete(agent: ReturnType<typeof request.agent>, name: string): Promise<string> {
  const init = await agent
    .post('/api/files/init')
    .send({ name, sizeBytes: String(9 * MIB), mimeType: 'application/octet-stream' })
  expect(init.status).toBe(201)
  const fileId = init.body.upload.fileId as string

  for (const [index, size] of SMALL_FILE.entries()) {
    const sent = await agent
      .post(`/api/files/${fileId}/chunks/${index}`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.alloc(size, index))
    expect(sent.status).toBe(200)
  }
  const complete = await agent.post(`/api/files/${fileId}/complete`).send({})
  expect(complete.status).toBe(200)
  return fileId
}

/** Reads a byte route into a Buffer, with an explicit binary parser so the body is not retyped. */
function binaryGet(agent: { get: (url: string) => request.Test }, url: string) {
  return agent
    .get(url)
    .buffer(true)
    .parse((res, cb) => {
      const pieces: Buffer[] = []
      res.on('data', (piece: Buffer) => pieces.push(piece))
      res.on('end', () => cb(null, Buffer.concat(pieces)))
    })
}

function errorBody(response: { body: unknown }): { error: { code: string; details?: unknown } } {
  if (Buffer.isBuffer(response.body)) {
    return JSON.parse(response.body.toString('utf8')) as { error: { code: string; details?: unknown } }
  }
  // JSON routes (share PATCH, search) parse the error body for us already.
  return response.body as { error: { code: string; details?: unknown } }
}

beforeAll(async () => {
  fake = await startFakeDiscord({ maxAttachmentBytes: 10 * MIB })
  process.env.DISCORD_API_BASE = fake.url
  const { resetEnvCache } = await import('../src/config/env.js')
  resetEnvCache()
  app = await loadApp()
})

afterAll(async () => {
  await fake.stop()
})

beforeEach(async () => {
  fake.control.reset()
  fake.control.setRateLimit(null)
  fake.control.setLinkTtlMs(60 * 60 * 1000)
  await resetDatabase()
})

describe('sharing', () => {
  it('defaults to private, then mints a stable public link that streams without auth', async () => {
    const owner = await signIn('alice@example.com')
    await createWebhook(owner)
    const fileId = await uploadComplete(owner, 'private.bin')

    const initial = await owner.get(`/api/files/${fileId}/share`)
    expect(initial.status).toBe(200)
    expect(initial.body.share).toEqual({ mode: 'RESTRICTED', token: null, grantees: [] })

    const link = await owner.patch(`/api/files/${fileId}/share`).send({ mode: 'LINK' })
    expect(link.status).toBe(200)
    const token = link.body.share.token as string
    expect(token).toBeTruthy()
    expect(link.body.share.mode).toBe('LINK')

    // The token survives a second LINK write — the same link keeps working.
    const reapply = await owner.patch(`/api/files/${fileId}/share`).send({ mode: 'LINK' })
    expect(reapply.body.share.token).toBe(token)

    // No auth involved: the token is the entire capability.
    const streamed = await binaryGet(request(app), `/api/share/${token}`)
    expect(streamed.status).toBe(200)
    expect(Buffer.isBuffer(streamed.body) && streamed.body.equals(expectedWhole)).toBe(true)
    expect(streamed.headers['content-disposition'] ?? '').toContain('attachment')
    expect(streamed.headers['content-length']).toBe(String(9 * MIB))
    expect(fake.control.stats().botReads).toBe(0)

    // The owner sees the token; a stranger browsing by id still gets nothing.
    const meta = await owner.get(`/api/files/${fileId}`)
    expect(meta.body.file.shareMode).toBe('LINK')
    const stranger = await signIn('stranger@example.com')
    const shadowed = await binaryGet(stranger, `/api/files/${fileId}/download`)
    expect(shadowed.status).toBe(404)
  })

  it('kills a public link the moment the owner returns the file to private', async () => {
    const owner = await signIn('bob@example.com')
    await createWebhook(owner)
    const fileId = await uploadComplete(owner, 'revoked.bin')

    const link = await owner.patch(`/api/files/${fileId}/share`).send({ mode: 'LINK' })
    const token = link.body.share.token as string

    const restricted = await owner.patch(`/api/files/${fileId}/share`).send({ mode: 'RESTRICTED' })
    expect(restricted.status).toBe(200)
    expect(restricted.body.share).toMatchObject({ mode: 'RESTRICTED', token: null })
    expect(restricted.body.share.grantees).toEqual([])

    const dead = await binaryGet(request(app), `/api/share/${token}`)
    expect(dead.status).toBe(404)
    expect(errorBody(dead).error.code).toBe('NOT_FOUND')
  })

  it('grants specific accounts read access that appears in their drive, read-only', async () => {
    const owner = await signIn('carol@example.com')
    await createWebhook(owner)
    const fileId = await uploadComplete(owner, 'spec.bin')
    const buddy = await signIn('buddy@example.com')

    const shared = await owner.patch(`/api/files/${fileId}/share`).send({
      mode: 'SPECIFIC',
      emails: ['BUDDY@example.com', 'buddy@example.com'],
    })
    expect(shared.status).toBe(200)
    expect(shared.body.share.mode).toBe('SPECIFIC')
    expect(shared.body.share.token).toBeNull()
    // Duplicate emails collapse to one grant, matched case-insensitively.
    expect(shared.body.share.grantees).toHaveLength(1)
    expect(shared.body.share.grantees[0].email).toBe('buddy@example.com')

    const state = await owner.get(`/api/files/${fileId}/share`)
    expect(state.body.share.grantees).toMatchObject([{ email: 'buddy@example.com', displayName: 'buddy' }])

    // The recipient sees it under their own root listing as a shared file, with the owner
    // attached and no token leaking to them.
    const recipientDrive = await buddy.get('/api/files')
    expect(recipientDrive.body.listing.files).toEqual([])
    expect(recipientDrive.body.listing.shared).toHaveLength(1)
    const row = recipientDrive.body.listing.shared[0]
    expect(row.id).toBe(fileId)
    expect(row.shareToken).toBeNull()
    expect(row.sharedBy).toMatchObject({ email: 'carol@example.com', displayName: 'carol' })

    // The owner's drive shows it as their own file, not in the shared inbox.
    const ownerDrive = await owner.get('/api/files')
    expect(ownerDrive.body.listing.files[0].shareMode).toBe('SPECIFIC')
    expect(ownerDrive.body.listing.shared).toEqual([])

    // The grantee can download, a stranger cannot, and the recipient cannot re-share
    // (owner-only route).
    const bytes = await binaryGet(buddy, `/api/files/${fileId}/download`)
    expect(bytes.status).toBe(200)
    expect(Buffer.isBuffer(bytes.body) && bytes.body.equals(expectedWhole)).toBe(true)

    const other = await signIn('other@example.com')
    const denied = await binaryGet(other, `/api/files/${fileId}/download`)
    expect(denied.status).toBe(404)

    const reshare = await buddy.patch(`/api/files/${fileId}/share`).send({ mode: 'LINK' })
    expect(reshare.status).toBe(404)

    const audit = await prisma.auditLog.findFirst({ where: { action: 'FILE_SHARE_CHANGED' } })
    expect(audit?.meta).toMatchObject({ fileId, mode: 'SPECIFIC', grantees: 1 })
  })

  it('rejects unknown accounts, self-sharing, and an empty SPECIFIC list', async () => {
    const owner = await signIn('dave@example.com')
    await createWebhook(owner)
    const fileId = await uploadComplete(owner, 'strict.bin')

    const unknown = await owner.patch(`/api/files/${fileId}/share`).send({
      mode: 'SPECIFIC',
      emails: ['ghost@example.com'],
    })
    expect(unknown.status).toBe(400)
    expect(errorBody(unknown).error.code).toBe('UNKNOWN_USER')

    const self = await owner.patch(`/api/files/${fileId}/share`).send({
      mode: 'SPECIFIC',
      emails: ['dave@example.com'],
    })
    expect(self.status).toBe(400)
    expect(errorBody(self).error.code).toBe('SHARE_WITH_SELF')

    const empty = await owner.patch(`/api/files/${fileId}/share`).send({ mode: 'SPECIFIC', emails: [] })
    expect(empty.status).toBe(400)
    expect(errorBody(empty).error.code).toBe('VALIDATION_ERROR')
  })

  it('autocompletes only ACTIVE onboarded accounts and never the caller', async () => {
    const owner = await signIn('eva@example.com')
    await createWebhook(owner)
    await prisma.user.create({
      data: {
        email: 'waiting@example.com',
        passwordHash: await hashPassword(PASSWORD),
        displayName: 'waiting partner',
        role: 'USER',
        status: 'PENDING',
      },
    })
    await prisma.user.create({
      data: {
        email: 'friend@example.com',
        passwordHash: await hashPassword(PASSWORD),
        displayName: 'friend partner',
        role: 'USER',
        status: 'ACTIVE',
        approvedAt: new Date(),
        onboardedAt: new Date(),
      },
    })

    // Partial on display name, case-insensitive, excluding the caller and pending accounts.
    const byName = await owner.get('/api/users/search').query({ q: 'FRIE' })
    expect(byName.status).toBe(200)
    expect(byName.body.users).toEqual([
      { id: expect.any(String), email: 'friend@example.com', displayName: 'friend partner' },
    ])

    // Partial on email also resolves.
    const byEmail = await owner.get('/api/users/search').query({ q: 'friend@exa' })
    expect(byEmail.body.users.map((u: { email: string }) => u.email)).toEqual(['friend@example.com'])

    // The caller's own email and a pending account never surface.
    const ownerSearch = await owner.get('/api/users/search').query({ q: 'eva' })
    expect(ownerSearch.body.users.some((u: { email: string }) => u.email === 'eva@example.com')).toBe(false)
    const pendingSearch = await owner.get('/api/users/search').query({ q: 'waiting' })
    expect(pendingSearch.body.users.every((u: { displayName: string }) => u.displayName !== 'waiting partner')).toBe(true)

    // A non-empty search term is required.
    const blank = await owner.get('/api/users/search').query({ q: '' })
    expect(blank.status).toBe(400)
  })
})