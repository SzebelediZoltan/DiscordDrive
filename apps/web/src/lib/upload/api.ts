/** Thin client for the chunked upload API (issue #7 contract). */

export interface UploadInfo {
  fileId: string
  name: string
  sizeBytes: string
  mimeType: string
  folderId: string | null
  chunkSizeBytes: number
  chunkCount: number
  received: number[]
  status: string
}

export interface UploadReceipt {
  index: number
  sizeBytes: string
  sha256: string
  stored: boolean
  batchId: string | null
  urlExpiresAt: string | null
}

export interface InitBody {
  name: string
  sizeBytes: number
  mimeType: string
  folderId?: string | null
  clientId?: string
}

/**
 * API error with the server's stable `code` (UPLOAD_BUSY, FILE_TOO_LARGE, …),
 * used by the queue to decide between auto-retry, re-plan and give-up.
 */
export class UploadApiError extends Error {
  readonly code: string
  readonly retriable: boolean
  readonly details: unknown

  constructor(code: string, message: string, retriable: boolean, details?: unknown) {
    super(message)
    this.name = 'UploadApiError'
    this.code = code
    this.retriable = retriable
    this.details = details
  }
}

interface ErrorBody {
  code?: string
  message?: string
  details?: unknown
  /** The API's error envelope: `{ error: { code, message, details } }`. */
  error?: ErrorBody | null
}

/**
 * The API always answers with `{ error: { code, message, details } }`. Older
 * call sites read the fields at the top level, which silently degraded every
 * failure to `HTTP_<status>` and made REPLAN_REQUIRED / INCOMPLETE_UPLOAD
 * unreachable, so both shapes are accepted here and the envelope wins.
 */
function parseErrorBody(body: ErrorBody | null): ErrorBody {
  return body?.error ?? body ?? {}
}

async function toError(res: Response, fallback: string): Promise<UploadApiError> {
  let raw: ErrorBody | null = null
  try {
    raw = (await res.json()) as ErrorBody
  } catch {
    raw = null
  }
  const body = parseErrorBody(raw)
  const code = body.code ?? `HTTP_${res.status}`
  const message = body.message ?? fallback
  const retriable = res.status >= 500 || res.status === 429
  return new UploadApiError(code, message, retriable, body.details)
}

function generateClientId(): string {
  return crypto.randomUUID()
}

export async function initUpload(
  body: InitBody,
  clientId: string | null = null,
): Promise<{ upload: UploadInfo; clientId: string }> {
  const id = clientId ?? generateClientId()
  const res = await fetch('/api/files/init', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, sizeBytes: String(body.sizeBytes), clientId: id }),
  })
  if (res.status === 201) {
    // The API wraps the session in `{ upload }`. Reading the wrapper flat meant the queue
    // saw `upload.fileId === undefined`, completed nothing and POSTed to
    // `/api/files/undefined/complete` — the "file not found" every upload has always had.
    const body = (await res.json()) as { upload?: UploadInfo } | null
    if (!body?.upload) {
      throw new UploadApiError('MALFORMED_INIT', 'The server did not answer with upload details', false)
    }
    return { upload: body.upload, clientId: id }
  }
  throw await toError(res, 'Could not start the upload')
}

export async function completeUpload(fileId: string): Promise<UploadInfo> {
  const res = await fetch(`/api/files/${encodeURIComponent(fileId)}/complete`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
  })
  if (res.status === 200) return ((await res.json()) as { upload: UploadInfo }).upload
  throw await toError(res, 'Could not finalise the upload')
}

/** Best-effort server-side abort; the queue never blocks on it. */
export async function abortUpload(fileId: string): Promise<void> {
  try {
    await fetch(`/api/files/${encodeURIComponent(fileId)}/abort`, { method: 'POST', credentials: 'same-origin' })
  } catch {
    // Fire and forget: the lock on the name is cleared by a later re-init anyway.
  }
}

export interface ChunkUpload {
  promise: Promise<UploadReceipt>
  cancel: () => void
}

export function uploadChunk(opts: {
  fileId: string
  index: number
  blob: Blob
  onProgress: (loadedBytes: number) => void
}): ChunkUpload {
  let xhr: XMLHttpRequest | null = null
  let cancelled = false

  const cancel = (): void => {
    cancelled = true
    xhr?.abort()
  }

  const promise = new Promise<UploadReceipt>((resolve, reject) => {
    xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/files/${encodeURIComponent(opts.fileId)}/chunks/${opts.index}`)
    xhr.responseType = 'json'
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) opts.onProgress(event.loaded)
    }
    xhr.onload = () => {
      if (cancelled) return
      const body = xhr!.response as (UploadReceipt & ErrorBody) | null
      if (xhr!.status >= 200 && xhr!.status < 300 && body && typeof body.index === 'number') {
        resolve(body as UploadReceipt)
        return
      }
      const error = parseErrorBody(body)
      reject(
        new UploadApiError(
          error.code ?? `HTTP_${xhr!.status}`,
          error.message ?? `Chunk ${opts.index} failed (${xhr!.status})`,
          xhr!.status >= 500 || xhr!.status === 429,
          error.details,
        ),
      )
    }
    xhr.onerror = () => {
      if (!cancelled) reject(new UploadApiError('NETWORK_ERROR', `Chunk ${opts.index} could not reach the server`, true))
    }
    xhr.ontimeout = () => {
      if (!cancelled) reject(new UploadApiError('TIMEOUT', `Chunk ${opts.index} timed out`, true))
    }
    xhr.send(opts.blob)
  })

  return { promise, cancel }
}