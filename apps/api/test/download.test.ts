import { createHash } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/lib/passwords.js'
import { prisma, resetDatabase } from './helpers/db.js'
import { startFakeDiscord, type FakeDiscordHandle } from './helpers/fake-discord-server.js'

/**
 * The read side of the file API end to end: download, integrity verify, and the CDN link
 * refresh that keeps downloads working after a signed URL expires.
 *
 * It deliberately shares the upload suite's geometry (8 MiB chunks, three per message) so a
 * 9 MiB file is two chunks in one message — enough to prove order is preserved and that one
 * bot read repairs a whole batch, without spending minutes moving bytes.
 *
 * The refresh story is tested through the fake's `linkTtlMs` control:
 *  - links born valid download with zero bot reads;
 *  - links born expired (TTL 0) and no bot token surface as a clean 410 `LINK_EXPIRED`;
 *  - links born expired with a bot token are re-armed by exactly one message read and the
 *    download succeeds against the freshly signed URLs.
 */

const MIB = 1024 * 1024
const SNOWFLAKE = '1234567890123456789'
const TOKEN = 'download-test-webhook-token-abcdef'
const URL = `https://discord.com/api/webhooks/${SNOWFLAKE}/${TOKEN}`

// Same geometry as the upload suite, set before the environment cache is read.
process.env.CHUNK_SIZE_MIB = '8'
process.env.CHUNKS_PER_MESSAGE = '3'

const CHUNK = 8 * MIB
const PASSWORD = 'Passw0rd123'
const SMALL_FILE = [CHUNK, MIB]
// 8 MiB of 0x00 then 1 MiB of 0x01: the two chunks could not be more distinguishable.
const expectedWhole = Buffer.concat([Buffer.alloc(CHUNK, 0), Buffer.alloc(MIB, 1)])

let fake: FakeDiscordHandle
let app: Awaited<ReturnType<typeof loadApp>>

async function loadApp() {
  const { createApp } = await import('../src/app.js')
  return createApp()
}

async function createUser(email: string) {
  return prisma.user.create({
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
}

async function signIn(email: string) {
  await createUser(email)
  const agent = request.agent(app)
  const response = await agent.post('/api/auth/login').send({ email, password: PASSWORD })
  expect(response.status).toBe(200)
  return agent
}

async function createWebhook(agent: ReturnType<typeof request.agent>, botToken?: string) {
  const body: Record<string, string> = { name: 'Storage', url: URL }
  if (botToken !== undefined) body.botToken = botToken
  const response = await agent.post('/api/webhooks').send(body)
  expect(response.status).toBe(201)
  return response.body.webhook as { id: string }
}

function sendChunk(
  agent: ReturnType<typeof request.agent>,
  fileId: string,
  index: number,
  size: number,
  fill: number,
) {
  return agent
    .post(`/api/files/${fileId}/chunks/${index}`)
    .set('content-type', 'application/octet-stream')
    .send(Buffer.alloc(size, fill))
}

async function uploadComplete(agent: ReturnType<typeof request.agent>, name: string): Promise<string> {
  const init = await agent
    .post('/api/files/init')
    .send({ name, sizeBytes: String(9 * MIB), mimeType: 'application/octet-stream' })
  expect(init.status).toBe(201)
  const fileId = init.body.upload.fileId as string

  for (const [index, size] of SMALL_FILE.entries()) {
    const sent = await sendChunk(agent, fileId, index, size, index)
    expect(sent.status).toBe(200)
  }
  const complete = await agent.post(`/api/files/${fileId}/complete`).send({})
  expect(complete.status).toBe(200)
  return fileId
}

/** Reads a download into a Buffer, with an explicit binary parser so the body is not retyped. */
function download(agent: ReturnType<typeof request.agent>, fileId: string) {
  return agent
    .get(`/api/files/${fileId}/download`)
    .buffer(true)
    .parse((res, cb) => {
      const pieces: Buffer[] = []
      res.on('data', (piece: Buffer) => pieces.push(piece))
      res.on('end', () => cb(null, Buffer.concat(pieces)))
    })
}

/**
 * The binary parser above applies to error responses too — a JSON error body arrives as a
 * Buffer rather than a parsed object, so failures are read back out of the bytes.
 */
function errorBody(response: { body: unknown }): { error: { code: string; details?: unknown } } {
  return JSON.parse((response.body as Buffer).toString('utf8')) as { error: { code: string; details?: unknown } }
}

/**
 * Assert the downloaded bytes. `toEqual` on a multi-MiB Buffer allocates gigabytes of diff
 * structure in jest-expect and would OOM the worker, so the Buffers are compared directly.
 */
function expectBytes(actual: unknown, expected: Buffer): void {
  expect(Buffer.isBuffer(actual) && (actual as Buffer).equals(expected)).toBe(true)
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

describe('download', () => {
  it('streams a file back in chunk order with honest headers and no bot read', async () => {
    const agent = await signIn('read@example.com')
    await createWebhook(agent)
    const fileId = await uploadComplete(agent, 'report café-加.bin')

    const response = await download(agent, fileId)

    expect(response.status).toBe(200)
    // supertest parsed the body with our binary parser; it must equal the exact bytes sent.
    expectBytes(response.body, expectedWhole)
    expect(response.headers['content-length']).toBe(String(9 * MIB))
    expect(response.headers['content-type']).toBe('application/octet-stream')
    // RFC 5987: an ASCII fallback plus the percent-encoded UTF-8 form.
    expect(response.headers['content-disposition'] ?? '').toContain('filename="report caf_-_.bin"')
    expect(response.headers['content-disposition'] ?? '').toContain("filename*=UTF-8''report%20caf%C3%A9-%E5%8A%A0.bin")
    expect(response.headers['cache-control']).toBe('private, no-store')

    // Nothing was about to expire, so the download must not have paid for a bot read.
    expect(fake.control.stats().botReads).toBe(0)
  })

  it('serves link-health metadata the UI can render', async () => {
    const agent = await signIn('meta@example.com')
    await createWebhook(agent, fake.botToken)
    const fileId = await uploadComplete(agent, 'meta.bin')

    const response = await agent.get(`/api/files/${fileId}`)

    expect(response.status).toBe(200)
    expect(response.body.file.sizeBytes).toBe(String(9 * MIB))
    expect(response.body.file.linkHealthy).toBe(true)
    expect(response.body.file.botRefreshEnabled).toBe(true)
    expect(typeof response.body.file.linkExpiresAt).toBe('string')
    expect(new Date(response.body.file.linkExpiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('re-arms expired links through one bot read when the webhook has a token', async () => {
    const agent = await signIn('refresh@example.com')
    await createWebhook(agent, fake.botToken)

    // Links born already expired, then the fake re-signs on refresh with a live lifetime.
    fake.control.setLinkTtlMs(0)
    const fileId = await uploadComplete(agent, 'rearmed.bin')
    fake.control.setLinkTtlMs(60 * 60 * 1000)

    const before = await agent.get(`/api/files/${fileId}`)
    expect(before.body.file.linkHealthy).toBe(false)

    const response = await download(agent, fileId)

    expect(response.status).toBe(200)
    expectBytes(response.body, expectedWhole)
    // One batch, so exactly one message read repaired the whole file.
    expect(fake.control.stats().botReads).toBe(1)
    const rearmed = await prisma.chunk.findMany({ where: { fileId } })
    expect(rearmed.every((c) => c.status === 'STORED' && c.urlExpiresAt !== null)).toBe(true)

    const after = await agent.get(`/api/files/${fileId}`)
    expect(after.body.file.linkHealthy).toBe(true)
    expect(after.body.file.linkRefreshedAt).toBeTruthy()

    const audit = await prisma.auditLog.findFirst({ where: { action: 'LINK_REFRESHED' } })
    expect(audit?.meta).toMatchObject({ refreshed: 2, failed: 0 })
  })

  it('answers 410 LINK_EXPIRED when links are dead and no bot token exists', async () => {
    const agent = await signIn('rot@example.com')
    // No `botToken`: refresh is impossible, which is exactly the state this test asserts on.
    await createWebhook(agent)

    fake.control.setLinkTtlMs(0)
    const fileId = await uploadComplete(agent, 'rotten.bin')

    const response = await download(agent, fileId)

    expect(response.status).toBe(410)
    const body = errorBody(response)
    expect(body.error.code).toBe('LINK_EXPIRED')
    expect(body.error.details).toMatchObject({ expiredChunks: [0, 1], botRefreshEnabled: false })

    // The dead links are recorded, so a later user action (and the UI) sees the truth.
    const chunks = await prisma.chunk.findMany({ where: { fileId } })
    expect(chunks.every((c) => c.status === 'EXPIRED')).toBe(true)
    const expired = await prisma.auditLog.findFirst({ where: { action: 'LINK_EXPIRED' } })
    expect(expired?.meta).toMatchObject({ chunks: 2 })
  })

  it('gives a stranger a 404, and an unfinished file a 409', async () => {
    const owner = await signIn('own@example.com')
    await createWebhook(owner)
    const fileId = await uploadComplete(owner, 'mine.bin')

    const stranger = await signIn('thief@example.com')
    const read = await download(stranger, fileId)
    expect(read.status).toBe(404)
    expect(errorBody(read).error.code).toBe('NOT_FOUND')

    // A file that never reached `complete` is not downloadable even for its owner.
    const partial = await signIn('partial@example.com')
    await createWebhook(partial)
    const init = await partial
      .post('/api/files/init')
      .send({ name: 'half.bin', sizeBytes: String(9 * MIB), mimeType: 'application/octet-stream' })
    const pending = init.body.upload.fileId as string
    await sendChunk(partial, pending, 0, CHUNK, 0)

    const unfinished = await download(partial, pending)
    expect(unfinished.status).toBe(409)
    expect(errorBody(unfinished).error.code).toBe('INCOMPLETE_UPLOAD')
  })
})

describe('verify', () => {
  it('stores the whole-file SHA-256 when every chunk matches its recorded hash', async () => {
    const agent = await signIn('verify-ok@example.com')
    await createWebhook(agent)
    const fileId = await uploadComplete(agent, 'verified.bin')

    const kept = await prisma.fileObject.findUniqueOrThrow({ where: { id: fileId } })
    expect(kept.sha256).toBeNull()

    const response = await agent.get(`/api/files/${fileId}/verify`)
    const expectedSha256 = createHash('sha256').update(expectedWhole).digest('hex')

    expect(response.status).toBe(200)
    expect(response.body.result.ok).toBe(true)
    expect(response.body.result.sha256).toBe(expectedSha256)
    expect(response.body.result.totalReadBytes).toBe(String(9 * MIB))
    expect(response.body.result.chunks).toHaveLength(2)
    expect(response.body.result.chunks.every((c: { ok: boolean }) => c.ok)).toBe(true)

    const stored = await prisma.fileObject.findUniqueOrThrow({ where: { id: fileId } })
    expect(stored.sha256).toBe(expectedSha256)

    const audit = await prisma.auditLog.findFirst({ where: { action: 'FILE_VERIFIED' } })
    expect(audit?.meta).toMatchObject({ fileId, sha256: expectedSha256 })
  })

  it('flags a corrupted chunk and persists no digest', async () => {
    const agent = await signIn('verify-bad@example.com')
    await createWebhook(agent)
    const fileId = await uploadComplete(agent, 'corrupt.bin')

    // Flip every byte of the second chunk on Discord's side: "storage lost a bit".
    const chunks = await prisma.chunk.findMany({ where: { fileId }, select: { index: true, cdnUrl: true } })
    const url = chunks.find((c) => c.index === 1)!.cdnUrl!
    const attachmentId = /\/cdn\/attachments\/[^/]+\/([^/]+)\//.exec(url)![1]!
    fake.control.corruptAttachment(attachmentId)

    const response = await agent.get(`/api/files/${fileId}/verify`)

    expect(response.status).toBe(200)
    expect(response.body.result.ok).toBe(false)
    expect(response.body.result.chunks[0].ok).toBe(true)
    expect(response.body.result.chunks[1].ok).toBe(false)
    expect(response.body.result.chunks[1].error).toMatch(/SHA-256/i)
    expect(response.body.result.totalReadBytes).toBe(String(9 * MIB))

    // A failed verification must not leave a digest on disk that claims the file is intact.
    const stored = await prisma.fileObject.findUniqueOrThrow({ where: { id: fileId } })
    expect(stored.sha256).toBeNull()
  })
})

describe('proactive sweep', () => {
  it('refreshes batches about to expire instead of waiting for a download', async () => {
    const agent = await signIn('sweep@example.com')
    await createWebhook(agent, fake.botToken)
    // Links born inside the default 30-minute lead window, so the sweep must pick them up.
    fake.control.setLinkTtlMs(10 * 60 * 1000)
    const fileId = await uploadComplete(agent, 'swept.bin')

    const { refreshExpiringBatches } = await import('../src/modules/files/link-refresh.service.js')
    const result = await refreshExpiringBatches({ leadMs: 30 * 60 * 1000 })

    expect(result.scanned).toBeGreaterThanOrEqual(1)
    expect(fake.control.stats().botReads).toBe(1)

    const meta = await agent.get(`/api/files/${fileId}`)
    expect(meta.body.file.linkHealthy).toBe(true)
    expect(meta.body.file.linkRefreshedAt).toBeTruthy()
  })
})