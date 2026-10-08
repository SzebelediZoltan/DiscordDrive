import { AuditAction, ChunkStatus, FileStatus, type ShareMode } from '../../generated/prisma/client.js'
import { recordAudit } from '../../lib/audit.js'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../http/errors.js'

/**
 * The file-manager read and mutation surface: list + search + pagination, folder CRUD, and
 * the per-file rename / move / soft-delete actions the explorer's row menu drives.
 *
 * Listing is one "page of a folder" query rather than several separate fetch-on-mount calls.
 * Search replaces the folder browse entirely (server-side, across the whole tree, so paging
 * never silently skips a folder), and the link-health fields are computed for exactly the
 * returned page, never per file.
 */

const MAX_DEPTH = 64

interface FileRowBase {
  id: string
  userId: string
  name: string
  originalName: string
  sizeBytes: bigint
  mimeType: string
  status: FileStatus
  sha256: string | null
  folderId: string | null
  folder: { name: string } | null
  chunkCount: number
  shareMode: ShareMode
  shareToken: string | null
  user: { id: string; email: string; displayName: string | null }
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  deletedAt: Date | null
}

/**
 * One entry in a listing. `folderName` is the row's parent folder when it has one.
 * The share fields are owner-only: the owner sees their mode and token (so menu state and
 * the copy-link action can render), while a row handed to a recipient carries `sharedBy`
 * — the account that shared the file with them — and no token.
 */
export interface FileRow {
  id: string
  name: string
  originalName: string
  sizeBytes: string
  mimeType: string
  status: string
  sha256: string | null
  folderId: string | null
  folderName: string | null
  chunkCount: number
  shareMode: string
  shareToken: string | null
  sharedBy: { id: string; email: string; displayName: string } | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  deletedAt: Date | null
  linkHealthy: boolean
  linkExpiresAt: string | null
  botRefreshEnabled: boolean
}

export interface FolderRow {
  id: string
  name: string
  parentId: string | null
  fileCount: number
  childFolderCount: number
}

export interface ListResult {
  folders: FolderRow[]
  files: FileRow[]
  /**
   * Files other accounts have shared with the user, newest first, capped at 200, and never
   * paginated (it is a "share inbox", not a browser). Present only on the root listing for
   * now; search already folds shared matches into `files`.
   */
  shared: FileRow[]
  ancestors: { id: string; name: string }[]
  /** The last file id of a page; pass it back as `cursor` to fetch the next page. */
  nextCursor: string | null
}

export async function listEntries(input: {
  userId: string
  folderId?: string
  search?: string
  cursor?: string
  limit?: number
}): Promise<ListResult> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const search = input.search?.trim()

  // The current folder may come from the URL on a refresh, so it is resolved and checked
  // for ownership before the paging query knows anything about it.
  const ancestors = await resolveAncestors(input.userId, input.folderId)

  if (search) {
    // Server-side search is global — it spans every folder the caller owns *and* every file
    // shared with them, so a result can never be hidden behind an unvisited folder. The
    // match set paginates with the same keyset cursor as browse mode.
    const files = await pagedFiles({
      where: {
        status: { not: FileStatus.DELETED },
        OR: [
          {
            userId: input.userId,
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { mimeType: { contains: search, mode: 'insensitive' } },
            ],
          },
          {
            shares: { some: { userId: input.userId } },
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { mimeType: { contains: search, mode: 'insensitive' } },
            ],
          },
        ],
      },
      cursor: input.cursor,
      limit,
    })

    return {
      folders: [],
      files: await presentFileRows(takePage(files, limit), input.userId),
      shared: [],
      ancestors,
      nextCursor: files.length > limit ? files[limit - 1]!.id : null,
    }
  }

  const currentId = ancestors[ancestors.length - 1]?.id ?? null

  const [folders, files, sharedFiles] = await Promise.all([
    prisma.folder.findMany({
      where: { userId: input.userId, parentId: currentId },
      orderBy: { name: 'asc' },
    }),
    pagedFiles({
      where: { userId: input.userId, folderId: currentId, status: { not: FileStatus.DELETED } },
      cursor: input.cursor,
      limit,
    }),
    currentId === null
      ? prisma.fileObject.findMany({
          where: { status: { not: FileStatus.DELETED }, shares: { some: { userId: input.userId } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 200,
          include: fileListInclude,
        })
      : Promise.resolve([]),
  ])

  const folderIds = folders.map((f) => f.id)
  const childMap = new Map<string, number>()
  const fileMap = new Map<string, number>()
  if (folderIds.length > 0) {
    const [childCounts, fileCounts] = await Promise.all([
      prisma.folder.groupBy({
        by: ['parentId'],
        where: { userId: input.userId, parentId: { in: folderIds } },
        _count: { _all: true },
      }),
      prisma.fileObject.groupBy({
        by: ['folderId'],
        where: { userId: input.userId, folderId: { in: folderIds }, status: { not: FileStatus.DELETED } },
        _count: { _all: true },
      }),
    ])
    for (const row of childCounts) if (row.parentId) childMap.set(row.parentId, row._count._all)
    for (const row of fileCounts) if (row.folderId) fileMap.set(row.folderId, row._count._all)
  }

  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      fileCount: fileMap.get(f.id) ?? 0,
      childFolderCount: childMap.get(f.id) ?? 0,
    })),
    files: await presentFileRows(takePage(files, limit), input.userId),
    shared: await presentFileRows(sharedFiles, input.userId),
    ancestors,
    nextCursor: files.length > limit ? files[limit - 1]!.id : null,
  }
}

/**
 * Walks the parent chain for a folder id so breadcrumbs are correct at any depth in one
 * round trip (plus the ownership check), and the caller reuses the last entry as its
 * "current folder" — a null top-level chain means the request is browsing the root.
 */
async function resolveAncestors(userId: string, folderId?: string): Promise<{ id: string; name: string }[]> {
  if (!folderId) return []
  const chain: { id: string; name: string }[] = []

  let current: { id: string; name: string; parentId: string | null } | null = await prisma.folder.findFirst({
    where: { id: folderId, userId },
    select: { id: true, name: true, parentId: true },
  })
  if (!current) throw AppError.notFound('Folder not found')

  for (let hops = 0; hops < MAX_DEPTH && current; hops++) {
    chain.unshift({ id: current.id, name: current.name })
    current = current.parentId
      ? await prisma.folder.findFirst({
          where: { id: current.parentId, userId },
          select: { id: true, name: true, parentId: true },
        })
      : null
  }

  return chain
}

const fileListInclude = {
  folder: { select: { name: true } },
  user: { select: { id: true, email: true, displayName: true } },
} as const

async function pagedFiles(input: {
  where: NonNullable<Parameters<typeof prisma.fileObject.findMany>[0]>['where']
  cursor?: string
  limit: number
}): Promise<FileRowBase[]> {
  return prisma.fileObject.findMany({
    where: input.where,
    // Keyset pagination on the row id, like the admin waitlist: inserting a new file (the
    // common case here) moves an OFFSET window and silently skips a row, while a cursor
    // page stays stable. Newest files surface first.
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    include: fileListInclude,
  })
}

/** Removes the lookahead row that decided whether a page has more entries. */
function takePage<T>(rows: T[], limit: number): T[] {
  return rows.length > limit ? rows.slice(0, limit) : rows
}

/**
 * Adds the per-row link-health fields for exactly the files in a page, in three aggregate
 * queries rather than N per-file metadata calls. `linkHealthy` mirrors the download path's
 * definition — every chunk re-armed and none expired — so the badge in the UI never
 * disagrees with whether a download would actually succeed.
 *
 * `viewerId` frames the share fields per row: the owner sees `shareMode`/`shareToken`, a
 * grant recipient sees `sharedBy` pointing at the account that shared the file with them.
 */
async function presentFileRows(files: FileRowBase[], viewerId: string): Promise<FileRow[]> {
  if (files.length === 0) return []

  const ids = files.map((f) => f.id)
  const [chunks, batches] = await Promise.all([
    prisma.chunk.findMany({
      where: { fileId: { in: ids }, status: { in: [ChunkStatus.STORED, ChunkStatus.EXPIRED] } },
      select: { fileId: true, urlExpiresAt: true, status: true },
    }),
    prisma.chunkBatch.findMany({
      where: { chunks: { some: { fileId: { in: ids } } } },
      select: {
        chunks: { where: { fileId: { in: ids } }, select: { fileId: true } },
        webhook: { select: { botTokenEnc: true } },
      },
    }),
  ])

  const now = Date.now()
  const byFile = new Map<string, { expiries: number[]; allStored: boolean }>()
  for (const chunk of chunks) {
    const entry = byFile.get(chunk.fileId) ?? { expiries: [], allStored: true }
    if (chunk.urlExpiresAt) entry.expiries.push(chunk.urlExpiresAt.getTime())
    if (chunk.status !== ChunkStatus.STORED) entry.allStored = false
    byFile.set(chunk.fileId, entry)
  }
  const botByFile = new Set<string>()
  for (const batch of batches) {
    if (batch.webhook.botTokenEnc === null) continue
    for (const chunk of batch.chunks) botByFile.add(chunk.fileId)
  }

  return files.map((file) => {
    const health = byFile.get(file.id)
    const expiries = health?.expiries ?? []
    const linkExpiresAt = expiries.length > 0 ? new Date(Math.min(...expiries)) : null
    const isOwner = file.userId === viewerId
    // For a row handed to a recipient, the someone who shared it is the file's owner.
    return {
      id: file.id,
      name: file.name,
      originalName: file.originalName,
      sizeBytes: file.sizeBytes.toString(),
      mimeType: file.mimeType,
      status: file.status,
      sha256: file.sha256,
      folderId: file.folderId,
      folderName: file.folder?.name ?? null,
      chunkCount: file.chunkCount,
      shareMode: file.shareMode,
      shareToken: isOwner ? file.shareToken : null,
      sharedBy: isOwner
        ? null
        : { id: file.user.id, email: file.user.email, displayName: file.user.displayName ?? '' },
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      completedAt: file.completedAt,
      deletedAt: file.deletedAt,
      linkHealthy:
        file.status === FileStatus.COMPLETE &&
        (health?.allStored ?? false) &&
        expiries.every((t) => t > now),
      linkExpiresAt: linkExpiresAt?.toISOString() ?? null,
      botRefreshEnabled: botByFile.has(file.id),
    }
  })
}

// ---------------------------------------------------------------------------
// Folder CRUD
// ---------------------------------------------------------------------------

async function ownedFolder(userId: string, folderId: string) {
  const folder = await prisma.folder.findFirst({ where: { id: folderId, userId } })
  if (!folder) throw AppError.notFound('Folder not found')
  return folder
}

function validateFolderName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw AppError.badRequest('VALIDATION_ERROR', 'A folder name is required')
  if (trimmed.length > 255) throw AppError.badRequest('VALIDATION_ERROR', 'Folder names are at most 255 characters')
  return trimmed
}

export async function createFolder(input: { userId: string; name: string; parentId?: string }) {
  const name = validateFolderName(input.name)

  let parentId: string | null = null
  if (input.parentId) {
    const parent = await ownedFolder(input.userId, input.parentId)
    parentId = parent.id
  }

  const existing = await prisma.folder.findFirst({ where: { userId: input.userId, parentId, name } })
  if (existing) throw AppError.conflict('FOLDER_EXISTS', 'A folder with that name already exists here')

  const folder = await prisma.folder.create({ data: { userId: input.userId, parentId, name } })
  await recordAudit({
    action: AuditAction.FOLDER_CREATED,
    actorUserId: input.userId,
    targetUserId: input.userId,
    meta: { folderId: folder.id, parentId, name },
  })
  return { id: folder.id, name: folder.name, parentId: folder.parentId }
}

export async function renameFolder(input: { userId: string; folderId: string; name: string }) {
  const name = validateFolderName(input.name)
  const folder = await ownedFolder(input.userId, input.folderId)

  const existing = await prisma.folder.findFirst({
    where: { userId: input.userId, parentId: folder.parentId, name },
  })
  if (existing && existing.id !== folder.id) {
    throw AppError.conflict('FOLDER_EXISTS', 'A folder with that name already exists here')
  }

  const updated = await prisma.folder.update({ where: { id: folder.id }, data: { name } })
  await recordAudit({
    action: AuditAction.FOLDER_RENAMED,
    actorUserId: input.userId,
    targetUserId: input.userId,
    meta: { folderId: folder.id, from: folder.name, to: name },
  })
  return { id: updated.id, name: updated.name }
}

/**
 * Deletes a folder and its whole subtree. Files are soft-deleted (their metadata rows
 * survive, so a restore could un-delete them), then the folder rows are hard-deleted; the
 * schema's `FolderTree` cascade takes the child rows with them. Hard-deleting the folder is
 * what frees the `@@unique([userId, parentId, name])` slot, so a recreated folder can keep
 * the same name.
 */
export async function deleteFolder(input: { userId: string; folderId: string }) {
  const folder = await ownedFolder(input.userId, input.folderId)

  // Collect the subtree ids in a breadth-first walk. Depth is bounded in practice by the UI,
  // but the loop guards against a cyclic parent chain spinning the process forever.
  const folderIds: string[] = []
  let frontier = [folder.id]
  for (let hops = 0; frontier.length > 0 && hops < MAX_DEPTH; hops++) {
    folderIds.push(...frontier)
    const children = await prisma.folder.findMany({
      where: { parentId: { in: frontier } },
      select: { id: true },
    })
    frontier = children.map((c) => c.id)
  }

  const deleted = await prisma.$transaction(async (tx) => {
    const files = await tx.fileObject.updateMany({
      where: { folderId: { in: folderIds } },
      data: { status: FileStatus.DELETED, deletedAt: new Date() },
    })
    await tx.folder.deleteMany({ where: { id: { in: folderIds } } })
    await recordAudit(
      {
        action: AuditAction.FOLDER_DELETED,
        actorUserId: input.userId,
        targetUserId: input.userId,
        meta: { folderId: folder.id, folders: folderIds.length, files: files.count, name: folder.name },
      },
      tx,
    )
    return { files: files.count, folders: folderIds.length }
  })

  return { id: folder.id, deletedFolders: deleted.folders, deletedFiles: deleted.files }
}

// ---------------------------------------------------------------------------
// Per-file actions
// ---------------------------------------------------------------------------

async function ownedFile(input: { userId: string; fileId: string }) {
  const file = await prisma.fileObject.findFirst({
    where: { id: input.fileId, userId: input.userId },
  })
  if (!file) throw AppError.notFound('File not found')
  return file
}

export async function renameFile(input: { userId: string; fileId: string; name: string }) {
  const name = input.name.trim()
  if (!name) throw AppError.badRequest('VALIDATION_ERROR', 'A file name is required')

  const file = await ownedFile(input)
  const existing = await prisma.fileObject.findFirst({
    where: { userId: input.userId, folderId: file.folderId, name },
  })
  if (existing && existing.id !== file.id) {
    throw AppError.conflict('FILE_EXISTS', 'A file with that name already exists here')
  }

  const updated = await prisma.fileObject.update({ where: { id: file.id }, data: { name } })
  await recordAudit({
    action: AuditAction.FILE_RENAMED,
    actorUserId: input.userId,
    targetUserId: input.userId,
    meta: { fileId: file.id, from: file.name, to: name },
  })
  return { id: updated.id, name: updated.name }
}

export async function moveFile(input: { userId: string; fileId: string; folderId: string | null }) {
  const file = await ownedFile(input)

  let folderId: string | null = null
  if (input.folderId) {
    const folder = await ownedFolder(input.userId, input.folderId)
    folderId = folder.id
  }

  const existing = await prisma.fileObject.findFirst({
    where: { userId: input.userId, folderId, name: file.name },
  })
  if (existing && existing.id !== file.id) {
    throw AppError.conflict('FILE_EXISTS', 'A file with that name already exists here')
  }

  const updated = await prisma.fileObject.update({
    where: { id: file.id },
    data: { folderId },
  })
  await recordAudit({
    action: AuditAction.FILE_MOVED,
    actorUserId: input.userId,
    targetUserId: input.userId,
    meta: { fileId: file.id, fromFolder: file.folderId, toFolder: folderId },
  })
  return { id: updated.id, folderId: updated.folderId }
}

export async function softDeleteFile(input: { userId: string; fileId: string }) {
  const file = await ownedFile(input)

  await prisma.$transaction(async (tx) => {
    await tx.fileObject.update({
      where: { id: file.id },
      data: { status: FileStatus.DELETED, deletedAt: new Date() },
    })
    await recordAudit(
      {
        action: AuditAction.FILE_DELETED,
        actorUserId: input.userId,
        targetUserId: input.userId,
        meta: { fileId: file.id, name: file.name, folderId: file.folderId },
      },
      tx,
    )
  })
  return { id: file.id }
}