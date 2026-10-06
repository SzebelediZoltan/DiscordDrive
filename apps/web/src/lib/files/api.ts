/**
 * Typed client for the file-manager API: list + search + pagination, folder CRUD, and the
 * per-file actions the explorer's row menu drives.
 *
 * The server always answers with the `{ error: { code, message, details } }` envelope, so a
 * single error type carries the code through to toasts instead of a generic message.
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
  createdAt: string
  updatedAt: string
  completedAt: string | null
  deletedAt: string | null
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

export interface Listing {
  folders: FolderRow[]
  files: FileRow[]
  ancestors: { id: string; name: string }[]
  nextCursor: string | null
}

export interface VerifyChunkResult {
  index: number
  ok: boolean
  expectedSha256: string | null
  actualSha256: string
  expectedSizeBytes: string
  actualSizeBytes: string
  error: string | null
}

export interface VerifyResult {
  ok: boolean
  sha256: string
  chunks: VerifyChunkResult[]
  totalExpectedBytes: string
  totalReadBytes: string
}

export class FilesApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'FilesApiError'
    this.code = code
    this.status = status
  }
}

interface ErrorBody {
  code?: string
  message?: string
  error?: ErrorBody | null
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })

  if (!res.ok) {
    let body: ErrorBody | null = null
    try {
      body = (await res.json()) as ErrorBody
    } catch {
      body = null
    }
    const parsed = body?.error ?? body ?? {}
    throw new FilesApiError(parsed.code ?? `HTTP_${res.status}`, parsed.message ?? `Request failed (${res.status})`, res.status)
  }
  return (await res.json()) as T
}

export function listFiles(params: {
  folderId?: string | null
  search?: string
  cursor?: string | null
  limit?: number
}): Promise<{ listing: Listing }> {
  const qs = new URLSearchParams()
  if (params.folderId) qs.set('folderId', params.folderId)
  if (params.search) qs.set('search', params.search)
  if (params.cursor) qs.set('cursor', params.cursor)
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  const query = qs.toString()
  return apiFetch<{ listing: Listing }>(`/api/files${query ? `?${query}` : ''}`)
}

export function createFolder(name: string, parentId?: string): Promise<{ folder: FolderRow }> {
  return apiFetch<{ folder: FolderRow }>('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name, ...(parentId ? { parentId } : {}) }),
  })
}

export function renameFolder(folderId: string, name: string): Promise<{ folder: FolderRow }> {
  return apiFetch<{ folder: FolderRow }>(`/api/folders/${encodeURIComponent(folderId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

export function deleteFolder(folderId: string): Promise<{ deleted: { deletedFolders: number; deletedFiles: number } }> {
  return apiFetch<{ deleted: { deletedFolders: number; deletedFiles: number } }>(`/api/folders/${encodeURIComponent(folderId)}`, {
    method: 'DELETE',
  })
}

export function renameFile(fileId: string, name: string): Promise<{ file: { id: string; name: string } }> {
  return apiFetch<{ file: { id: string; name: string } }>(`/api/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

export function moveFile(fileId: string, folderId: string | null): Promise<{ file: { id: string; folderId: string | null } }> {
  return apiFetch<{ file: { id: string; folderId: string | null } }>(`/api/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ folderId }),
  })
}

export function deleteFile(fileId: string): Promise<{ deleted: { id: string } }> {
  return apiFetch<{ deleted: { id: string } }>(`/api/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
  })
}

export function verifyFile(fileId: string): Promise<{ result: VerifyResult }> {
  return apiFetch<{ result: VerifyResult }>(`/api/files/${encodeURIComponent(fileId)}/verify`)
}

/** The same-origin streaming download URL; safe to hand to an anchor or the clipboard. */
export function downloadUrl(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}/download`
}