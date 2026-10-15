import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/lib/passwords.js'
import { prisma, resetDatabase } from './helpers/db.js'
import { startFakeDiscord, type FakeDiscordHandle } from './helpers/fake-discord-server.js'

/**
 * The inline preview route end to end: `Content-Type`/`Content-Disposition` for in-browser
 * rendering, HTTP Range with 206/Content-Range so video and audio can seek with partial
 * byte windows, and the same owner-or-grant authorization as download. The slice boundaries
 * are chosen against the 8 MiB chunk geometry: a cross-boundary range must bridge exactly
 * two chunks without touching a third, and a suffix range must not need Discord round-trips
 * that the rest of the file would.
 */

const MIB = 1024 * 1024
const SNOWFLAKE = '1234567890123456789'
const TOKEN = 'preview-test-webhook-token-abcdef'
const URL = `https://discord.com/api/webhooks/${SNOWFLAKE}/${TOKEN}`

process.env.CHUNK_SIZE_MIB = '8'
process.env.CHUNKS_PER_MESSAGE = '3'

const CHUNK = 8 * MIB
const SIZE = 9 * MIB
const PASSWORD = 'Passw0rd123'
const SMALL_FILE = [CHUNK, MIB]
// 8 MiB of 0x00 then 1 MiB of 0x01: the two chunks could not be more distinguishable, so
// a range that straddles the boundary is unmistakable byte-for-byte.
const expectedWhole = Buffer.concat([Buffer.alloc(CHUNK, 0), Buffer.alloc(MIB, 1)])

let fake: FakeDiscordHandle
let app: Awaited<ReturnType<typeof loadApp>>

async function loadApp() {
  const { createApp } = await import('../src/app.js')
  return createApp()
}

async function signIn(email: string) {
  await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      displayName: email.split('@')[0],
      role: 'USER',
      status: 'ACTIVE',
      approvedAt: new Date(),
      onboardedAt: new Date(),
    },
  })
  const agent = request.agent(app)
  const response = await agent.post('/api/auth/login').send({ email, password: PASSWORD })
  expect(response.status).toBe(200)
  return agent
}

async function createWebhook(agent: ReturnType<typeof request.agent>) {
  const response = await agent.post('/api/webhooks').send({ name: 'Storage', url: URL })
  expect(response.status).toBe(201)
}

async function uploadComplete(agent: ReturnType<typeof request.agent>): Promise<string> {
  const init = await agent
    .post('/api/files/init')
    .send({ name: 'clip.bin', sizeBytes: String(SIZE), mimeType: 'application/octet-stream' })
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

/** Reads a byte route with an explicit binary parser so the body is not retyped. */
function binaryView(agent: ReturnType<typeof request.agent>, url: string, range?: string) {
  let req = agent.get(url).buffer(true)
  if (range) req = req.set('Range', range)
  return req.parse((res, cb) => {
    const pieces: Buffer[] = []
    res.on('data', (piece: Buffer) => pieces.push(piece))
    res.on('end', () => cb(null, Buffer.concat(pieces)))
  })
}

function expectBytes(actual: unknown, expected: Buffer): void {
  expect(Buffer.isBuffer(actual) && (actual as Buffer).equals(expected)).toBe(true)
}

function errorBody(response: { body: unknown }): { error: { code: string; details?: unknown } } {
  if (Buffer.isBuffer(response.body)) {
    return JSON.parse(response.body.toString('utf8')) as { error: { code: string; details?: unknown } }
  }
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

describe('preview', () => {
  it('serves the whole file inline for in-browser rendering', async () => {
    const agent = await signIn('viewer@example.com')
    await createWebhook(agent)
    const fileId = await uploadComplete(agent)

    const response = await binaryView(agent, `/api/files/${fileId}/view`)

    expect(response.status).toBe(200)
    expectBytes(response.body, expectedWhole)
    expect(response.headers['content-type']).toBe('application/octet-stream')
    expect(response.headers['content-disposition'] ?? '').toContain('inline')
    expect(response.headers['content-length']).toBe(String(SIZE))
    expect(response.headers['accept-ranges']).toBe('bytes')
    expect(fake.control.stats().botReads).toBe(0)
  })

  it('answers a byte range with 206 and Content-Range', async () => {
    const agent = await signIn('range@example.com')
    await createWebhook(agent)
    const fileId = await uploadComplete(agent)

    const response = await binaryView(agent, `/api/files/${fileId}/view`, 'bytes=0-4')

    expect(response.status).toBe(206)
    expect(response.headers['content-range']).toBe(`bytes 0-4/${SIZE}`)
    expectBytes(response.body, expectedWhole.subarray(0, 5))
    expect(response.headers['content-length']).toBe('5')
  })

  it('slices a range that straddles the chunk boundary without a third chunk', async () => {
    const agent = await signIn('bridge@example.com')
    await createWebhook(agent)
    const fileId = await uploadComplete(agent)

    // 8 MiB boundary: 8 bytes of trailing 0x00 then 2 bytes of leading 0x01.
    const response = await binaryView(agent, `/api/files/${fileId}/view`, 'bytes=8388600-8388609')

    expect(response.status).toBe(206)
    expect(response.headers['content-range']).toBe(`bytes 8388600-8388609/${SIZE}`)
    expectBytes(response.body, expectedWhole.subarray(8388600, 8388610))
    expect(response.headers['content-length']).toBe('10')
  })

  it('supports suffix and open-ended ranges', async () => {
    const agent = await signIn('tail@example.com')
    await createWebhook(agent)
    const fileId = await uploadComplete(agent)

    const suffix = await binaryView(agent, `/api/files/${fileId}/view`, 'bytes=-5')
    expect(suffix.status).toBe(206)
    expect(suffix.headers['content-range']).toBe(`bytes ${SIZE - 5}-${SIZE - 1}/${SIZE}`)
    expectBytes(suffix.body, expectedWhole.subarray(SIZE - 5))

    const open = await binaryView(agent, `/api/files/${fileId}/view`, 'bytes=8388608-')
    expect(open.status).toBe(206)
    expect(open.headers['content-range']).toBe(`bytes 8388608-${SIZE - 1}/${SIZE}`)
    expectBytes(open.body, expectedWhole.subarray(8388608))
  })

  it('answers 416 with a */N hint for an unsatisfiable range', async () => {
    const agent = await signIn('past-end@example.com')
    await createWebhook(agent)
    const fileId = await uploadComplete(agent)

    const response = await binaryView(agent, `/api/files/${fileId}/view`, `bytes=${SIZE}-`)

    // The error happens before any byte is written, so it is a clean JSON envelope.
    expect(response.status).toBe(416)
    const body = errorBody(response)
    expect(body.error.code).toBe('RANGE_NOT_SATISFIABLE')
    expect(body.error.details).toMatchObject({ contentRange: `bytes */${SIZE}` })
  })

  it('lets a grant recipient preview, and a stranger or revoked file get 404', async () => {
    const owner = await signIn('share-owner@example.com')
    await createWebhook(owner)
    const fileId = await uploadComplete(owner)

    const grantee = await signIn('share-grantee@example.com')
    const share = await owner
      .patch(`/api/files/${fileId}/share`)
      .send({ mode: 'SPECIFIC', emails: ['share-grantee@example.com'] })
    expect(share.status).toBe(200)

    const allowed = await binaryView(grantee, `/api/files/${fileId}/view`, 'bytes=0-4')
    expect(allowed.status).toBe(206)
    expectBytes(allowed.body, expectedWhole.subarray(0, 5))

    const stranger = await signIn('share-stranger@example.com')
    const denied = await binaryView(stranger, `/api/files/${fileId}/view`)
    expect(denied.status).toBe(404)

    // The moment the owner makes the file private, the grant and the preview both die.
    await owner.patch(`/api/files/${fileId}/share`).send({ mode: 'RESTRICTED' })
    const revoked = await binaryView(grantee, `/api/files/${fileId}/view`)
    expect(revoked.status).toBe(404)
  })
})