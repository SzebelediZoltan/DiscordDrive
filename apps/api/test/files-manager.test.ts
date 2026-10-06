import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/lib/passwords.js'
import { prisma, resetDatabase } from './helpers/db.js'
import { startFakeDiscord, type FakeDiscordHandle } from './helpers/fake-discord-server.js'

/**
 * The file-manager API: list + search + pagination, folder CRUD, and the per-file
 * rename / move / soft-delete actions the explorer drives.
 *
 * Share the upload suite's geometry (8 MiB chunks, three per message) so a complete file is
 * two chunks in one message and everything here stays fast. Files are uploaded the same way
 * a real client does, which is also what proves the list only ever shows completed work.
 */

const MIB = 1024 * 1024
const SNOWFLAKE = '1234567890123456789'
const TOKEN = 'files-manager-test-webhook-token'
const URL = `https://discord.com/api/webhooks/${SNOWFLAKE}/${TOKEN}`

process.env.CHUNK_SIZE_MIB = '8'
process.env.CHUNKS_PER_MESSAGE = '3'

const PASSWORD = 'Passw0rd123'
const SIZE = 9 * MIB

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

async function createWebhook(agent: ReturnType<typeof request.agent>) {
  const response = await agent.post('/api/webhooks').send({ name: 'Storage', url: URL })
  expect(response.status).toBe(201)
}

async function uploadComplete(agent: ReturnType<typeof request.agent>, name: string, mimeType = 'application/octet-stream'): Promise<string> {
  const init = await agent
    .post('/api/files/init')
    .send({ name, sizeBytes: String(SIZE), mimeType })
  expect(init.status).toBe(201)
  const fileId = init.body.upload.fileId as string

  // 8 MiB of 0x00, then 1 MiB of 0x01: the two chunks could not be more distinguishable.
  for (const [chunkIndex, chunkSize] of [
    [0, 8 * MIB],
    [1, MIB],
  ] as const) {
    const sent = await agent
      .post(`/api/files/${fileId}/chunks/${chunkIndex}`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.alloc(chunkSize, chunkIndex))
    expect(sent.status).toBe(200)
  }
  const complete = await agent.post(`/api/files/${fileId}/complete`).send({})
  expect(complete.status).toBe(200)
  return fileId
}

async function list(agent: ReturnType<typeof request.agent>, query: Record<string, string | number> = {}) {
  const response = await agent.get('/api/files').query(query)
  expect(response.status).toBe(200)
  return response.body.listing as {
    folders: { id: string; name: string; parentId: string | null; fileCount: number; childFolderCount: number }[]
    files: {
      id: string
      name: string
      mimeType: string
      folderId: string | null
      status: string
      linkHealthy: boolean
      botRefreshEnabled: boolean
      linkExpiresAt: string | null
    }[]
    ancestors: { id: string; name: string }[]
    nextCursor: string | null
  }
}

async function createFolder(
  agent: ReturnType<typeof request.agent>,
  name: string,
  parentId?: string,
): Promise<{ id: string; name: string; parentId: string | null }> {
  const response = await agent
    .post('/api/folders')
    .send({ name, ...(parentId ? { parentId } : {}) })
  expect(response.status).toBe(201)
  return response.body.folder as { id: string; name: string; parentId: string | null }
}

describe('file manager — list, search, pagination', () => {
  let user: ReturnType<typeof request.agent>

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
    user = await signIn('owner@example.com')
    await createWebhook(user)
  })

  it('starts empty at the root', async () => {
    const root = await list(user)
    expect(root).toEqual({ folders: [], files: [], ancestors: [], nextCursor: null })
  })

  it('lists a completed file at the root with live link health', async () => {
    const fileId = await uploadComplete(user, 'report.pdf', 'application/pdf')

    const root = await list(user)
    expect(root.folders).toEqual([])
    expect(root.ancestors).toEqual([])
    expect(root.nextCursor).toBeNull()
    expect(root.files).toHaveLength(1)
    expect(root.files[0]).toMatchObject({
      id: fileId,
      name: 'report.pdf',
      mimeType: 'application/pdf',
      folderId: null,
      status: 'COMPLETE',
      linkHealthy: true,
      botRefreshEnabled: false,
    })
    expect(root.files[0]!.linkExpiresAt).toBeTruthy()
  })

  it('nests three levels deep with correct breadcrumbs at each level', async () => {
    const a = await createFolder(user, 'A')
    const b = await createFolder(user, 'B', a.id)
    const c = await createFolder(user, 'C', b.id)

    const root = await list(user)
    expect(root.folders.map((f) => f.name)).toEqual(['A'])
    expect(root.folders[0]).toMatchObject({ id: a.id, childFolderCount: 1, fileCount: 0 })

    const inA = await list(user, { folderId: a.id })
    expect(inA.ancestors).toEqual([{ id: a.id, name: 'A' }])
    expect(inA.folders.map((f) => f.name)).toEqual(['B'])

    const inB = await list(user, { folderId: b.id })
    expect(inB.ancestors).toEqual([{ id: a.id, name: 'A' }, { id: b.id, name: 'B' }])

    const inC = await list(user, { folderId: c.id })
    expect(inC.ancestors).toEqual([{ id: a.id, name: 'A' }, { id: b.id, name: 'B' }, { id: c.id, name: 'C' }])
    expect(inC.folders).toEqual([])
  })

  it('keysets pages of files without skipping or truncating', async () => {
    // Three files, two per page: the second page must hold exactly the third file and no
    // row may appear on both pages.
    const ids = []
    for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
      ids.push(await uploadComplete(user, name))
    }

    const page1 = await list(user, { limit: 2 })
    expect(page1.files).toHaveLength(2)
    expect(page1.nextCursor).toBe(page1.files[page1.files.length - 1]!.id)

    const page2 = await list(user, { limit: 2, cursor: page1.nextCursor! })
    expect(page2.files).toHaveLength(1)
    expect(page2.nextCursor).toBeNull()

    const seen = [...page1.files, ...page2.files].map((f) => f.name)
    expect(seen.sort()).toEqual(['alpha.txt', 'beta.txt', 'gamma.txt'])
  })

  it('searches by name fragment across every folder, case-insensitively', async () => {
    const folder = await createFolder(user, 'Deep')
    const inside = await uploadComplete(user, 'Budget-2026.xlsx')
    await uploadComplete(user, 'Vacation.jpg')
    // Move the spreadsheet into the folder so a search has to cross a folder boundary.
    const moved = await user.patch(`/api/files/${inside}/`).send({ folderId: folder.id })
    expect(moved.status).toBe(200)

    const found = await list(user, { search: 'budget' })
    expect(found.folders).toEqual([])
    expect(found.files.map((f) => f.name)).toEqual(['Budget-2026.xlsx'])
    expect(found.files[0]!.folderId).toBe(folder.id)
    expect(found.files[0]!.status).toBe('COMPLETE')
  })

  it('searches by MIME type', async () => {
    await uploadComplete(user, 'doc.pdf', 'application/pdf')
    await uploadComplete(user, 'shot.png', 'image/png')

    const found = await list(user, { search: 'image/png' })
    expect(found.files.map((f) => f.name)).toEqual(['shot.png'])
  })

  it('paginates search results instead of silently truncating them', async () => {
    for (const name of ['note-a.md', 'note-b.md', 'note-c.md']) {
      await uploadComplete(user, name, 'text/markdown')
    }
    const page1 = await list(user, { search: 'note-', limit: 2 })
    expect(page1.files).toHaveLength(2)
    expect(page1.nextCursor).toBeTruthy()
    const page2 = await list(user, { search: 'note-', limit: 2, cursor: page1.nextCursor! })
    expect(page2.files).toHaveLength(1)
    expect(page2.nextCursor).toBeNull()
  })

  it('does not surface another user’s folders or accept their folder ids', async () => {
    const other = await signIn('other@example.com')
    const folder = await createFolder(other, 'Private')

    // Ownership is enforced: the folder exists for someone else, but a user listing inside
    // it gets 404, exactly as if it had never existed. The other user's data stays put.
    const response = await user.get('/api/files').query({ folderId: folder.id })
    expect(response.status).toBe(404)
    expect((await other.get('/api/files').query({ folderId: folder.id })).status).toBe(200)
  })
})

describe('file manager — folder and file mutations', () => {
  let user: ReturnType<typeof request.agent>

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
    user = await signIn('owner@example.com')
    await createWebhook(user)
  })

  it('renames a folder and rejects a duplicate sibling name', async () => {
    const folder = await createFolder(user, 'Old')
    const renamed = await user.patch(`/api/folders/${folder.id}`).send({ name: 'New' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.folder.name).toBe('New')

    await createFolder(user, 'Sibling')
    const clash = await user.patch(`/api/folders/${folder.id}`).send({ name: 'Sibling' })
    expect(clash.status).toBe(409)
    expect(clash.body.error.code).toBe('FOLDER_EXISTS')
  })

  it('soft-deletes every file in a subtree and removes the folder rows', async () => {
    const a = await createFolder(user, 'A')
    const b = await createFolder(user, 'B', a.id)
    const fileA = await uploadComplete(user, 'in-a.txt')
    const fileB = await uploadComplete(user, 'in-b.txt')

    const moveToA = await user.patch(`/api/files/${fileA}`).send({ folderId: a.id })
    expect(moveToA.status).toBe(200)
    const moveToB = await user.patch(`/api/files/${fileB}`).send({ folderId: b.id })
    expect(moveToB.status).toBe(200)

    const removed = await user.delete(`/api/folders/${a.id}`)
    expect(removed.status).toBe(200)
    expect(removed.body.deleted).toMatchObject({ deletedFolders: 2, deletedFiles: 2 })

    const root = await list(user)
    expect(root.folders).toEqual([])
    expect(root.files.map((f) => f.id)).toEqual([])

    const [rowA, rowB] = await Promise.all([
      prisma.fileObject.findUnique({ where: { id: fileA } }),
      prisma.fileObject.findUnique({ where: { id: fileB } }),
    ])
    expect(rowA?.status).toBe('DELETED')
    expect(rowA?.deletedAt).toBeTruthy()
    expect(rowB?.status).toBe('DELETED')
  })

  it('renames a file and rejects a duplicate name in the same folder', async () => {
    const fileId = await uploadComplete(user, 'old.txt')
    const renamed = await user.patch(`/api/files/${fileId}`).send({ name: 'new.txt' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.file.name).toBe('new.txt')

    await uploadComplete(user, 'taken.txt')
    const clash = await user.patch(`/api/files/${fileId}`).send({ name: 'taken.txt' })
    expect(clash.status).toBe(409)
    expect(clash.body.error.code).toBe('FILE_EXISTS')
  })

  it('moves a file between folders and back to the root', async () => {
    const a = await createFolder(user, 'A')
    const b = await createFolder(user, 'B')
    const fileId = await uploadComplete(user, 'moving.txt')

    const firstMoves = await user.patch(`/api/files/${fileId}`).send({ folderId: a.id })
    expect(firstMoves.status).toBe(200)
    expect((await list(user, { folderId: a.id })).files.map((f) => f.id)).toEqual([fileId])
    expect((await list(user)).files).toEqual([])

    const secondMove = await user.patch(`/api/files/${fileId}`).send({ folderId: b.id })
    expect(secondMove.status).toBe(200)

    const backToRoot = await user.patch(`/api/files/${fileId}`).send({ folderId: null })
    expect(backToRoot.status).toBe(200)
    expect((await list(user)).files.map((f) => f.id)).toEqual([fileId])
  })

  it('soft-deletes a single file', async () => {
    const fileId = await uploadComplete(user, 'gone.txt')
    const removed = await user.delete(`/api/files/${fileId}`)
    expect(removed.status).toBe(200)

    expect((await list(user)).files.map((f) => f.id)).toEqual([])
    const row = await prisma.fileObject.findUnique({ where: { id: fileId } })
    expect(row?.status).toBe('DELETED')
    expect(row?.deletedAt).toBeTruthy()
  })

  it('refuses mutations on another user’s files and folders', async () => {
    const other = await signIn('other@example.com')
    await createWebhook(other)
    const folder = await createFolder(other, 'Private')
    const fileId = await uploadComplete(other, 'secret.txt')

    expect((await user.patch(`/api/folders/${folder.id}`).send({ name: 'Hijack' })).status).toBe(404)
    expect((await user.delete(`/api/folders/${folder.id}`)).status).toBe(404)
    expect((await user.patch(`/api/files/${fileId}`).send({ name: 'Hijack' })).status).toBe(404)
    expect((await user.delete(`/api/files/${fileId}`)).status).toBe(404)

    // The other user’s files are untouched.
    expect((await other.get('/api/files')).body.listing.files).toHaveLength(1)
  })

  it('uploads can be placed directly into a folder via init folderId', async () => {
    const folder = await createFolder(user, 'Direct')
    const init = await user.post('/api/files/init').send({
      name: 'placed.bin',
      sizeBytes: String(SIZE),
      mimeType: 'application/octet-stream',
      folderId: folder.id,
    })
    expect(init.status).toBe(201)
    expect(init.body.upload.folderId).toBe(folder.id)
    expect((await list(user, { folderId: folder.id })).files.map((f) => f.name)).toEqual(['placed.bin'])
  })
})