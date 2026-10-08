import { randomBytes } from 'node:crypto'
import { AuditAction, ShareMode, type FileObject } from '../../generated/prisma/client.js'
import { AppError } from '../../http/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { prisma } from '../../lib/prisma.js'

/**
 * The sharing surface: the owner's three-mode access model (private / public link /
 * specific users) plus the user-autocomplete the share dialog searches PENDING-free.
 *
 * Access rules borrowed from how Drive treats a sharing dialog:
 *  - `RESTRICTED` is the default. Nothing is shared and no token exists.
 *  - `LINK` mints an unguessable token. The token is the entire capability: the public
 *    `/api/share/:token` route streams the file with no account involved. A token is kept
 *    stable once minted (the same link keeps working), and cleared the instant the mode
 *    leaves LINK, so a link that should be dead stops streaming at the same write that
 *    revokes it.
 *  - `SPECIFIC` grants read access to a set of accounts. Those grants appear in the
 *    recipient's own drive (vetoed by the listing route) and pass the download/view
 *    authorization check, but nothing here is a capability — file ids and user ids are
 *    not secrets.
 *
 * Whatever the mode, a shared file is read-only for the recipient: rename, move, delete
 * and the share dialog itself stay owner-only.
 */

export interface ShareGrantee {
  id: string
  email: string
  displayName: string
}

export interface ShareState {
  mode: ShareMode
  token: string | null
  grantees: ShareGrantee[]
}

const MAX_GRANTEES = 100

async function ownedFile(input: { userId: string; fileId: string }): Promise<FileObject> {
  const file = await prisma.fileObject.findFirst({ where: { id: input.fileId, userId: input.userId } })
  if (!file || file.status === 'DELETED') throw AppError.notFound('File not found')
  return file
}

/**
 * Mints a token that does not already belong to some other public link. The uniqueness
 * check plus a collision retry keeps a rare birthday-collision from failing the write.
 */
async function generateShareToken(): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomBytes(24).toString('base64url')
    const taken = await prisma.fileObject.findUnique({ where: { shareToken: token }, select: { id: true } })
    if (!taken) return token
  }
  throw AppError.unavailable('TOKEN_EXHAUSTED', 'Could not mint a unique share token, try again')
}

// ---------------------------------------------------------------------------
// Owner-side state
// ---------------------------------------------------------------------------

export async function getShareState(input: { userId: string; fileId: string }): Promise<ShareState> {
  const file = await ownedFile(input)
  return presentShareState(file, await grantsFor(file.id))
}

async function grantsFor(fileId: string): Promise<ShareGrantee[]> {
  const grants = await prisma.fileShare.findMany({
    where: { fileId },
    select: { user: { select: { id: true, email: true, displayName: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return grants.map((grant) => ({ id: grant.user.id, email: grant.user.email, displayName: grant.user.displayName ?? '' }))
}

async function presentShareState(file: Pick<FileObject, 'id' | 'shareMode' | 'shareToken'>, grantees: ShareGrantee[]): Promise<ShareState> {
  return { mode: file.shareMode, token: file.shareToken, grantees }
}

export async function updateShare(input: {
  userId: string
  fileId: string
  mode: ShareMode
  emails?: string[]
  ip?: string | null
}): Promise<ShareState> {
  const file = await ownedFile({ userId: input.userId, fileId: input.fileId })

  let grantees: ShareGrantee[] = []
  await prisma.$transaction(async (tx) => {
    if (input.mode === ShareMode.RESTRICTED) {
      await tx.fileObject.update({
        where: { id: file.id },
        data: { shareMode: ShareMode.RESTRICTED, shareToken: null },
      })
      await tx.fileShare.deleteMany({ where: { fileId: file.id } })
    } else if (input.mode === ShareMode.LINK) {
      const token = file.shareToken ?? (await generateShareToken())
      await tx.fileObject.update({
        where: { id: file.id },
        data: { shareMode: ShareMode.LINK, shareToken: token },
      })
      // Anyone holding the link outranks a typed-in list; stale grants would re-open the
      // dialog with people the owner never meant to survive the mode change.
      await tx.fileShare.deleteMany({ where: { fileId: file.id } })
    } else {
      const emails = uniqueEmails(input.emails)
      const matches = await tx.user.findMany({
        where: { email: { in: emails, mode: 'insensitive' }, status: 'ACTIVE' },
        select: { id: true, email: true, displayName: true },
      })
      assertSpecifiedUsers(emails, matches, input.userId)

      const desired = matches.map((m) => m.id)
      await tx.fileObject.update({
        where: { id: file.id },
        data: { shareMode: ShareMode.SPECIFIC, shareToken: null },
      })
      if (desired.length > 0) {
        await tx.fileShare.createMany({
          skipDuplicates: true,
          data: desired.map((userId) => ({ fileId: file.id, userId })),
        })
      }
      await tx.fileShare.deleteMany({
        where: { fileId: file.id, userId: { notIn: desired } },
      })
      grantees = matches.map((m) => ({ id: m.id, email: m.email, displayName: m.displayName ?? '' }))
    }

    await recordAudit(
      {
        action: AuditAction.FILE_SHARE_CHANGED,
        actorUserId: input.userId,
        targetUserId: input.userId,
        actorIp: input.ip ?? null,
        meta: { fileId: file.id, mode: input.mode, grantees: input.mode === ShareMode.SPECIFIC ? grantees.length : 0 },
      },
      tx,
    )
  })

  const fresh = await ownedFile({ userId: input.userId, fileId: input.fileId })
  return presentShareState(fresh, input.mode === ShareMode.SPECIFIC ? grantees : await grantsFor(file.id))
}

function uniqueEmails(emails: string[] | undefined): string[] {
  if (!emails) return []
  return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))]
}

function assertSpecifiedUsers(
  emails: string[],
  matches: { id: string; email: string }[],
  ownerId: string,
): void {
  if (emails.length === 0) {
    throw AppError.badRequest('VALIDATION_ERROR', 'Pick at least one person to share with')
  }
  if (emails.length > MAX_GRANTEES) {
    throw AppError.badRequest('VALIDATION_ERROR', `A file can be shared with at most ${MAX_GRANTEES} people`)
  }
  const matched = new Set(matches.map((m) => m.email.toLowerCase()))
  for (const email of emails) {
    if (!matched.has(email)) {
      throw AppError.badRequest('UNKNOWN_USER', `No account matches “${email}”. Share with registered accounts only.`)
    }
  }
  if (matches.some((m) => m.id === ownerId)) {
    throw AppError.badRequest('SHARE_WITH_SELF', 'You cannot share a file with yourself')
  }
}

// ---------------------------------------------------------------------------
// Public link resolution
// ---------------------------------------------------------------------------

/**
 * The capability carried by a share link. Returns the file only when the row is in LINK
 * mode, so an old token that was cleared when the owner switched the mode stops resolving
 * the same moment the row changed — 404 regardless of what the link still claims.
 */
export async function resolvePublicShare(token: string): Promise<FileObject> {
  const file = await prisma.fileObject.findFirst({
    where: { shareToken: token, shareMode: ShareMode.LINK },
  })
  if (!file || file.status === 'DELETED') throw AppError.notFound('File not found')
  return file
}

// ---------------------------------------------------------------------------
// Recipient autocomplete
// ---------------------------------------------------------------------------

/**
 * ACTIVE accounts matching a query fragment on email or display name, never the caller,
 * newest not required and the list capped so a brand-new account with a few thousand users
 * still gets a snappy dropdown.
 */
export async function searchUsers(input: { userId: string; q: string }): Promise<ShareGrantee[]> {
  const q = input.q.trim()
  if (!q) return []
  const users = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      id: { not: input.userId },
      OR: [
        { email: { contains: q, mode: 'insensitive' } },
        { displayName: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, email: true, displayName: true },
    orderBy: { email: 'asc' },
    take: 10,
  })
  return users.map((u) => ({ id: u.id, email: u.email, displayName: u.displayName ?? '' }))
}