import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/lib/passwords.js'
import { prisma, resetDatabase } from './helpers/db.js'
import { startFakeDiscord, type FakeDiscordHandle } from './helpers/fake-discord-server.js'

/**
 * The upload API end to end: init, chunk, complete, abort, against a fake Discord.
 *
 * The chunk geometry is deliberately small — 8 MiB chunks, three per message — so a test
 * file is four requests rather than a hundred and twenty-eight, while still exercising the
 * batching, buffering and resume behaviour that only shows up once a file spans more than
 * one message. The 1 GiB planning case is asserted without sending a single byte, because
 * the arithmetic is the part that has to be right there.
 */

const MIB = 1024 * 1024
const SNOWFLAKE = '1234567890123456789'
const TOKEN = 'upload-test-webhook-token-abcdef'
const URL = `https://discord.com/api/webhooks/${SNOWFLAKE}/${TOKEN}`

// Set before anything reads the environment: the whole file depends on this geometry.
process.env.CHUNK_SIZE_MIB = '8'
process.env.CHUNKS_PER_MESSAGE = '3'

const CHUNK = 8 * MIB
const PASSWORD = 'Passw0rd123'

let fake: FakeDiscordHandle
let app: Awaited<ReturnType<typeof loadApp>>

async function loadApp() {
  const { createApp } = await import('../src/app.js')
  return createApp()
}

async function createUser(email: string, onboarded = true) {
  return prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      displayName: email.split('@')[0],
      role: 'USER',
      status: 'ACTIVE',
      approvedAt: new Date(),
      onboardedAt: onboarded ? new Date() : null,
    },
  })
}

/** Creates the account and signs the agent in, returning the agent for convenience. */
async function signIn(email: string, options: { onboarded?: boolean } = {}) {
  await createUser(email, options.onboarded)
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

async function initUpload(
  agent: ReturnType<typeof request.agent>,
  body: Record<string, unknown>,
) {
  return agent.post('/api/files/init').send(body)
}

function sendChunk(
  agent: ReturnType<typeof request.agent>,
  fileId: string,
  index: number,
  size: number,
  fill = index % 256,
) {
  return agent
    .post(`/api/files/${fileId}/chunks/${index}`)
    .set('content-type', 'application/octet-stream')
    .send(Buffer.alloc(size, fill))
}

/** Sizes of a 9 MiB file at an 8 MiB chunk size: a full chunk plus the remainder. */
const SMALL_FILE = [CHUNK, MIB]

async function sendAll(
  agent: ReturnType<typeof request.agent>,
  fileId: string,
  sizes: number[],
): Promise<void> {
  for (const [index, size] of sizes.entries()) {
    const response = await sendChunk(agent, fileId, index, size)
    expect(response.status).toBe(200)
  }
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
  // Two messages per upload is the point of this suite; the fake's own limiter would only
  // add wall-clock time to an assertion that is about our pacing, which is tested elsewhere.
  fake.control.setRateLimit(null)
  await resetDatabase()
})

describe('init', () => {
  it('plans a 1 GiB file as 128 chunks of 8 MiB without moving any bytes', async () => {
    const agent = await signIn('plan@example.com')
    await createWebhook(agent)

    const response = await initUpload(agent, {
      name: 'big.bin',
      sizeBytes: '1073741824',
      mimeType: 'application/octet-stream',
    })

    expect(response.status).toBe(201)
    expect(response.body.upload.chunkSizeBytes).toBe(CHUNK)
    expect(response.body.upload.chunkCount).toBe(128)
    expect(response.body.upload.received).toEqual([])
    // Planning costs nothing: no message has been posted and no chunk row exists.
    expect(fake.control.stats().webhookPosts).toBe(0)
    expect(await prisma.chunk.count()).toBe(0)
  })

  it('carries a size above 2^31 as a string, and refuses one that is not a safe integer', async () => {
    const agent = await signIn('bigint@example.com')
    await createWebhook(agent)

    // 512 GiB: the largest file the product accepts, and a value a 32-bit column would
    // truncate to zero. Exactly 65536 chunks of 8 MiB.
    const asString = await initUpload(agent, { name: 'huge.bin', sizeBytes: '549755813888' })
    expect(asString.status).toBe(201)
    expect(asString.body.upload.sizeBytes).toBe('549755813888')
    expect(asString.body.upload.chunkCount).toBe(65536)

    // 2^53 + 1 as a string: past the point where a JSON number could hold it, so it has to
    // arrive as text and be refused here rather than silently rounded.
    const beyondSafe = await initUpload(agent, { name: 'unsafe.bin', sizeBytes: '9007199254740993' })
    expect(beyondSafe.status).toBe(413)
    expect(beyondSafe.body.error.code).toBe('FILE_TOO_LARGE')

    // A number that cannot be represented exactly is a client bug, not a size.
    const asNumber = await initUpload(agent, { name: 'unsafe.bin', sizeBytes: 1e20 })
    expect(asNumber.status).toBe(400)
    expect(asNumber.body.error.code).toBe('INVALID_FILE_SIZE')
  })

  it('caps the chunk size at the webhook\'s probed ceiling', async () => {
    const agent = await signIn('probed@example.com')
    const webhook = await createWebhook(agent)
    await prisma.webhook.update({ where: { id: webhook.id }, data: { maxChunkBytes: 3 * MIB } })

    const response = await initUpload(agent, { name: 'small.bin', sizeBytes: String(10 * MIB) })

    expect(response.status).toBe(201)
    expect(response.body.upload.chunkSizeBytes).toBe(3 * MIB)
    expect(response.body.upload.chunkCount).toBe(4)
  })

  it('refuses to start without a storage webhook', async () => {
    const agent = await signIn('nowebhook@example.com')

    const response = await initUpload(agent, { name: 'a.bin', sizeBytes: '1024' })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('NO_WEBHOOK')
  })

  it('refuses a second file with the same name once the first is complete', async () => {
    const agent = await signIn('dupe@example.com')
    await createWebhook(agent)

    const first = await initUpload(agent, { name: 'report.pdf', sizeBytes: String(9 * MIB) })
    await sendAll(agent, first.body.upload.fileId, SMALL_FILE)
    await agent.post(`/api/files/${first.body.upload.fileId}/complete`).send({})

    const second = await initUpload(agent, { name: 'report.pdf', sizeBytes: String(9 * MIB) })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('FILE_EXISTS')
  })

  it('returns 428 before onboarding is finished', async () => {
    const agent = await signIn('new@example.com', { onboarded: false })

    const response = await initUpload(agent, { name: 'a.bin', sizeBytes: '1024' })

    expect(response.status).toBe(428)
    expect(response.body.error.code).toBe('ONBOARDING_REQUIRED')
  })
})

describe('chunk upload', () => {
  it('buffers a partial message and flushes it once the batch is full', async () => {
    const agent = await signIn('buffer@example.com')
    await createWebhook(agent)

    const init = await initUpload(agent, { name: 'movie.mkv', sizeBytes: String(25 * MIB) })
    const fileId = init.body.upload.fileId
    expect(init.body.upload.chunkCount).toBe(4)

    const first = await sendChunk(agent, fileId, 0, CHUNK)
    const second = await sendChunk(agent, fileId, 1, CHUNK)
    // Still buffered: three chunks are needed before a Discord message is worth sending.
    expect(first.body.stored).toBe(false)
    expect(first.body.batchId).toBeNull()
    expect(second.body.stored).toBe(false)
    expect(fake.control.stats().webhookPosts).toBe(0)

    const third = await sendChunk(agent, fileId, 2, CHUNK)
    expect(third.body.stored).toBe(true)
    expect(third.body.batchId).toBeTruthy()
    expect(fake.control.stats().webhookPosts).toBe(1)

    const fourth = await sendChunk(agent, fileId, 3, MIB)
    expect(fourth.body.stored).toBe(false)

    const complete = await agent.post(`/api/files/${fileId}/complete`).send({})
    expect(complete.status).toBe(200)
    expect(complete.body.upload.received).toEqual([0, 1, 2, 3])

    const stats = fake.control.stats()
    expect(stats.webhookPosts).toBe(2)
    expect(stats.storedAttachments).toBe(4)
    expect(stats.storedBytes).toBe(25 * MIB)

    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: fileId } })
    expect(file.status).toBe('COMPLETE')
    expect(file.sizeBytes).toBe(BigInt(25 * MIB))

    const chunks = await prisma.chunk.findMany({ where: { fileId }, orderBy: { index: 'asc' } })
    expect(chunks).toHaveLength(4)
    expect(chunks.every((chunk) => chunk.status === 'STORED')).toBe(true)
    expect(chunks[0]!.batchId).toBe(chunks[1]!.batchId)
    expect(chunks[0]!.batchId).not.toBe(chunks[3]!.batchId)
    // Every chunk carries the CDN URL and its expiry, which is what makes later refresh
    // possible without re-reading the message.
    expect(chunks.every((chunk) => chunk.cdnUrl !== null)).toBe(true)
    expect(chunks.every((chunk) => chunk.urlExpiresAt !== null)).toBe(true)

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { fileId } })
    expect(session.status).toBe('COMPLETED')
    expect(session.receivedChunks).toBe(4)

    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPLOAD_COMPLETED' } })
    expect(audit?.userId).toBe((await prisma.user.findFirst())!.id)
  })

  it('reports only durable chunks when the same file is initialised again', async () => {
    const agent = await signIn('resume@example.com')
    await createWebhook(agent)

    const first = await initUpload(agent, { name: 'draft.txt', sizeBytes: String(25 * MIB) })
    const fileId = first.body.upload.fileId

    await sendChunk(agent, fileId, 0, CHUNK)
    await sendChunk(agent, fileId, 1, CHUNK)
    await sendChunk(agent, fileId, 2, CHUNK)
    // Sent, but never flushed: it exists only in this process's buffer.
    await sendChunk(agent, fileId, 3, MIB)

    const resumed = await initUpload(agent, { name: 'draft.txt', sizeBytes: String(25 * MIB) })
    expect(resumed.status).toBe(201)
    expect(resumed.body.upload.fileId).toBe(fileId)
    // [0, 1, 2] reached Discord; 3 did not, so a client that trusts this list will re-send
    // exactly the one chunk that would otherwise be lost if the process restarted.
    expect(resumed.body.upload.received).toEqual([0, 1, 2])

    const byClientId = await initUpload(agent, {
      name: 'something-else.bin',
      sizeBytes: '1',
      clientId: 'client-abc',
    })
    expect(byClientId.status).toBe(201)
    const byClientIdAgain = await initUpload(agent, {
      name: 'different-again.bin',
      sizeBytes: '2',
      clientId: 'client-abc',
    })
    expect(byClientIdAgain.body.upload.fileId).toBe(byClientId.body.upload.fileId)
  })

  it('purges a dead session so re-initialising the same client id starts fresh', async () => {
    const agent = await signIn('stale@example.com')
    await createWebhook(agent)

    const first = await initUpload(agent, { name: 'draft.txt', sizeBytes: String(MIB), clientId: 'stale-c1' })
    expect(first.status).toBe(201)
    const staleFileId = first.body.upload.fileId

    // The dashboard's delete soft-deletes the file but leaves the ACTIVE session behind.
    const removed = await agent.delete(`/api/files/${staleFileId}`)
    expect(removed.status).toBe(200)

    // Resuming would hand the client a file whose every chunk POST answers "File not found".
    // Instead the dead session is purged and a fresh file is created on the same client id.
    const again = await initUpload(agent, { name: 'draft.txt', sizeBytes: String(MIB), clientId: 'stale-c1' })
    expect(again.status).toBe(201)
    expect(again.body.upload.fileId).not.toBe(staleFileId)

    // The fresh file is fully usable end to end.
    const freshFileId = again.body.upload.fileId
    const chunk = await sendChunk(agent, freshFileId, 0, MIB)
    expect(chunk.status).toBe(200)
    const done = await agent.post(`/api/files/${freshFileId}/complete`)
    expect(done.status).toBe(200)
    expect(done.body.upload.status).toBe('COMPLETE')
  })

  it('accepts a repeated send of a chunk that is already stored', async () => {
    const agent = await signIn('idempotent@example.com')
    await createWebhook(agent)

    const init = await initUpload(agent, { name: 'again.bin', sizeBytes: String(25 * MIB) })
    const fileId = init.body.upload.fileId

    await sendChunk(agent, fileId, 0, CHUNK)
    await sendChunk(agent, fileId, 1, CHUNK)
    const third = await sendChunk(agent, fileId, 2, CHUNK)
    expect(third.body.stored).toBe(true)

    const after = fake.control.stats().webhookPosts
    const repeat = await sendChunk(agent, fileId, 0, CHUNK)

    expect(repeat.status).toBe(200)
    expect(repeat.body.stored).toBe(true)
    expect(repeat.body.batchId).toBe(third.body.batchId)
    // No second Discord round trip: the bytes are already there.
    expect(fake.control.stats().webhookPosts).toBe(after)
    expect(await prisma.chunk.count({ where: { fileId } })).toBe(3)
  })

  it('rejects a re-send whose contents disagree with the stored chunk', async () => {
    const agent = await signIn('conflict@example.com')
    await createWebhook(agent)

    const init = await initUpload(agent, { name: 'conflict.bin', sizeBytes: String(25 * MIB) })
    const fileId = init.body.upload.fileId

    // Same framing as the idempotent case: a few chunks settle onto Discord storage,
    // then chunk 0 comes back with bytes that do not match what was stored.
    await sendChunk(agent, fileId, 0, CHUNK)
    await sendChunk(agent, fileId, 1, CHUNK)
    await sendChunk(agent, fileId, 2, CHUNK)

    const conflicting = await sendChunk(agent, fileId, 0, CHUNK, 200)

    expect(conflicting.status).toBe(409)
    expect(conflicting.body.error.code).toBe('CHUNK_CONFLICT')

    // The stored chunk is untouched and no second chunk row sneaks in at index 0.
    expect(await prisma.chunk.count({ where: { fileId } })).toBe(3)
  })

  it('rejects a chunk that is not exactly the declared size', async () => {
    const agent = await signIn('size@example.com')
    await createWebhook(agent)
    const init = await initUpload(agent, { name: 's.bin', sizeBytes: String(25 * MIB) })
    const fileId = init.body.upload.fileId

    const short = await sendChunk(agent, fileId, 0, CHUNK - 1)
    expect(short.status).toBe(400)
    expect(short.body.error.code).toBe('CHUNK_SIZE_MISMATCH')

    // The over-sized case is caught from Content-Length, before a byte is read.
    const long = await sendChunk(agent, fileId, 0, CHUNK + 1)
    expect(long.status).toBe(413)
    expect(long.body.error.code).toBe('CHUNK_SIZE_MISMATCH')

    expect(await prisma.chunk.count({ where: { fileId } })).toBe(0)
  })

  it('rejects an index outside the file, and an unauthenticated caller', async () => {
    const agent = await signIn('bounds@example.com')
    await createWebhook(agent)
    const init = await initUpload(agent, { name: 'b.bin', sizeBytes: String(25 * MIB) })
    const fileId = init.body.upload.fileId

    const outOfRange = await sendChunk(agent, fileId, 4, 1)
    expect(outOfRange.status).toBe(400)
    expect(outOfRange.body.error.code).toBe('CHUNK_INDEX_OUT_OF_RANGE')

    const anonymous = await request(app)
      .post(`/api/files/${fileId}/chunks/0`)
      .set('content-type', 'application/octet-stream')
      // A single byte: the 401 is answered before the body is read, so sending 8 MiB here
      // would only race the connection teardown and surface as EPIPE.
      .send(Buffer.alloc(1))
    expect(anonymous.status).toBe(401)
  })

  it('hands another user a 404 rather than a hint that the file exists', async () => {
    const owner = await signIn('owner@example.com')
    await createWebhook(owner)
    const init = await initUpload(owner, { name: 'secret.bin', sizeBytes: String(25 * MIB) })
    const fileId = init.body.upload.fileId

    const stranger = await signIn('stranger@example.com')
    await createWebhook(stranger)

    const read = await stranger.post(`/api/files/${fileId}/complete`).send({})
    expect(read.status).toBe(404)

    const write = await sendChunk(stranger, fileId, 0, CHUNK)
    expect(write.status).toBe(404)
  })
})

describe('complete', () => {
  it('refuses while chunks are missing, and says which ones', async () => {
    const agent = await signIn('incomplete@example.com')
    await createWebhook(agent)
    const init = await initUpload(agent, { name: 'partial.bin', sizeBytes: String(25 * MIB) })
    const fileId = init.body.upload.fileId

    await sendChunk(agent, fileId, 0, CHUNK)
    await sendChunk(agent, fileId, 1, CHUNK)

    const response = await agent.post(`/api/files/${fileId}/complete`).send({})

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('INCOMPLETE_UPLOAD')
    expect(response.body.error.details.missing).toEqual([2, 3])
    expect(response.body.error.details.receivedChunks).toBe(2)

    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: fileId } })
    expect(file.status).not.toBe('COMPLETE')
  })

  it('is idempotent once the file is already complete', async () => {
    const agent = await signIn('twice@example.com')
    await createWebhook(agent)
    const init = await initUpload(agent, { name: 'done.bin', sizeBytes: String(9 * MIB) })
    const fileId = init.body.upload.fileId

    await sendAll(agent, fileId, SMALL_FILE)

    const first = await agent.post(`/api/files/${fileId}/complete`).send({})
    const posts = fake.control.stats().webhookPosts
    const second = await agent.post(`/api/files/${fileId}/complete`).send({})

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.upload.status).toBe('COMPLETE')
    // Nothing is re-posted to finish a file that is already finished.
    expect(fake.control.stats().webhookPosts).toBe(posts)
    expect(await prisma.auditLog.count({ where: { action: 'UPLOAD_COMPLETED' } })).toBe(1)
  })
})

describe('abort', () => {
  it('leaves nothing behind: file, session, chunks and batches are all gone', async () => {
    const agent = await signIn('abort@example.com')
    await createWebhook(agent)
    const init = await initUpload(agent, { name: 'temp.bin', sizeBytes: String(25 * MIB) })
    const fileId = init.body.upload.fileId

    await sendChunk(agent, fileId, 0, CHUNK)
    await sendChunk(agent, fileId, 1, CHUNK)
    await sendChunk(agent, fileId, 2, CHUNK)
    await sendChunk(agent, fileId, 3, MIB)
    expect(await prisma.chunkBatch.count()).toBe(1)

    const response = await agent.post(`/api/files/${fileId}/abort`).send({})
    expect(response.status).toBe(204)

    expect(await prisma.fileObject.findUnique({ where: { id: fileId } })).toBeNull()
    expect(await prisma.uploadSession.findUnique({ where: { fileId } })).toBeNull()
    expect(await prisma.chunk.count({ where: { fileId } })).toBe(0)
    // The Discord message that held them is not left behind as an orphan batch row.
    expect(await prisma.chunkBatch.count()).toBe(0)

    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPLOAD_ABORTED' } })
    expect(audit?.userId).toBe((await prisma.user.findFirst())!.id)

    const late = await sendChunk(agent, fileId, 0, CHUNK)
    expect(late.status).toBe(404)
  })

  it('refuses to abandon a file that is already complete', async () => {
    const agent = await signIn('abortdone@example.com')
    await createWebhook(agent)
    const init = await initUpload(agent, { name: 'keep.bin', sizeBytes: String(9 * MIB) })
    const fileId = init.body.upload.fileId

    await sendAll(agent, fileId, SMALL_FILE)
    await agent.post(`/api/files/${fileId}/complete`).send({})

    const response = await agent.post(`/api/files/${fileId}/abort`).send({})
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('FILE_ALREADY_COMPLETE')
  })
})

describe('a reduced webhook ceiling', () => {
  it('splits the file at the smaller size and stores it in one pass', async () => {
    const agent = await signIn('replan@example.com')
    const webhook = await createWebhook(agent)
    await prisma.webhook.update({ where: { id: webhook.id }, data: { maxChunkBytes: 3 * MIB } })

    const init = await initUpload(agent, { name: 'cedar.bin', sizeBytes: String(10 * MIB) })
    const fileId = init.body.upload.fileId
    expect(init.body.upload.chunkSizeBytes).toBe(3 * MIB)

    for (const [index, size] of [3 * MIB, 3 * MIB, 3 * MIB, MIB].entries()) {
      const sent = await sendChunk(agent, fileId, index, size)
      expect(sent.status).toBe(200)
    }

    const complete = await agent.post(`/api/files/${fileId}/complete`).send({})
    expect(complete.status).toBe(200)

    expect(fake.control.stats().storedBytes).toBe(10 * MIB)
    // Three 3 MiB parts per message, then the remainder: two messages, no rejections.
    expect(fake.control.stats().webhookPosts).toBe(2)
    expect(fake.control.stats().rateLimited).toBe(0)
  })
})
