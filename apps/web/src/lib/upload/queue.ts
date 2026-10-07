import {
  abortUpload,
  completeUpload,
  initUpload,
  uploadChunk,
  UploadApiError,
  type InitBody,
  type UploadReceipt,
} from '@/lib/upload/api'

// ---------------------------------------------------------------------------
// Concurrency and memory budget
// ---------------------------------------------------------------------------

/**
 * Chunks sail raw over HTTP, so the browser holds one ArrayBuffer per in-flight
 * chunk. The budget keeps that flat for a multi-gigabyte file: at most three 8 MiB
 * buffers per file and six across the whole queue, and a chunk is never read into
 * memory until the moment it is sent.
 */
const PER_FILE_CHUNKS = 3
const GLOBAL_CHUNK_SLOTS = 6

/** A lost chunk is re-sent automatically with exponential backoff, capped. */
const MAX_CHUNK_ATTEMPTS = 4
const RETRY_BASE_MS = 1_000
const RETRY_CAP_MS = 30_000

export type UploadStatus = 'queued' | 'initializing' | 'uploading' | 'paused' | 'completed' | 'failed'

export interface ChunkProgress {
  transferredBytes: number
  sizeBytes: number
}

export interface UploadTask {
  id: string
  clientId: string
  fileId: string | null
  fileName: string
  sizeBytes: number
  mimeType: string
  status: UploadStatus
  chunkSizeBytes: number
  chunkCount: number
  /** Durable chunks the server has confirmed as stored. */
  received: Set<number>
  /** Bytes of durable chunks; this is what the progress bar reflects. */
  committedBytes: number
  /** Cumulative bytes sent over the wire (including retries) for throughput. */
  transferredBytes: number
  error: string | null
  retriable: boolean
  /** The local File handle. Null only for uploads hydrated after a refresh. */
  file: File | null
  fileMissing: boolean
  /** The destination folder at enqueue time; uploads land here when provided. */
  folderId: string | null
  startedAt: number | null
  completedAt: number | null
  chunks: Map<number, ChunkProgress>
  attempts: Map<number, number>
  cancels: Map<number, () => void>
  retryPending: Set<number>
  timerIds: ReturnType<typeof setTimeout>[]
  finalising: boolean
}

export type UploadEvent =
  | { type: 'queued'; taskId: string; fileName: string }
  | { type: 'started'; taskId: string; fileName: string }
  | { type: 'completed'; taskId: string; fileName: string }
  | { type: 'failed'; taskId: string; fileName: string; reason: string; retriable: boolean }
  | { type: 'replanned'; taskId: string }

type Listener = () => void

const STORAGE_KEY = 'ddrive:uploads:v1'

interface StoredUpload {
  id: string
  clientId: string
  fileName: string
  sizeBytes: number
  mimeType: string
  folderId: string | null
}

function loadStored(): StoredUpload[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isStoredUpload)
  } catch {
    return []
  }
}

function isStoredUpload(value: unknown): value is StoredUpload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.clientId === 'string' &&
    typeof v.fileName === 'string' &&
    typeof v.sizeBytes === 'number' &&
    typeof v.mimeType === 'string'
  )
}

export class UploadQueue {
  private tasks = new Map<string, UploadTask>()
  private inflight = new Map<string, Set<number>>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private slots = GLOBAL_CHUNK_SLOTS
  private snapshot: UploadTask[] = []
  private listeners = new Set<Listener>()

  onEvent: ((event: UploadEvent) => void) | null = null

  constructor() {
    for (const stored of loadStored()) {
      this.tasks.set(
        stored.id,
        makeTask({
          fileName: stored.fileName,
          sizeBytes: stored.sizeBytes,
          mimeType: stored.mimeType,
          file: null,
          fileMissing: true,
          clientId: stored.clientId,
          folderId: stored.folderId ?? null,
          status: 'paused',
          id: stored.id,
        }),
      )
    }
    this.syncSnapshot()
  }

  getSnapshot(): UploadTask[] {
    return this.snapshot
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // -------------------------------------------------------------------------
  // Public actions
  // -------------------------------------------------------------------------

  enqueue(files: File[], folderId: string | null = null): void {
    for (const file of files) {
      const task = makeTask({
        fileName: file.name,
        sizeBytes: file.size,
        mimeType: file.type || 'application/octet-stream',
        file,
        fileMissing: false,
        clientId: crypto.randomUUID(),
        folderId,
        status: 'queued',
      })
      this.tasks.set(task.id, task)
      this.onEvent?.({ type: 'queued', taskId: task.id, fileName: task.fileName })
    }
    this.persist()
    this.syncSnapshot()
    this.scheduler()
  }

  pause(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    if (task.status === 'paused' || task.status === 'completed' || task.status === 'failed') return
    task.status = 'paused'
    this.releaseInflight(task)
    this.clearTimers(task.id)
    this.persist()
    this.syncSnapshot()
  }

  resume(id: string): void {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'paused' || task.fileMissing) return
    task.status = 'queued'
    this.persist()
    this.syncSnapshot()
    this.scheduler()
  }

  /** Re-selects the local file for an upload that lost its handle after a refresh. */
  attachFile(id: string, file: File): void {
    const task = this.tasks.get(id)
    if (!task || !task.fileMissing) return
    task.file = file
    task.fileMissing = false
    task.status = 'queued'
    this.persist()
    this.syncSnapshot()
    this.scheduler()
  }

  retry(id: string): void {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'failed') return
    task.error = null
    task.retriable = false
    task.status = 'queued'
    this.persist()
    this.syncSnapshot()
    this.scheduler()
  }

  /** True cancel: aborts every in-flight XHR and asks the server to drop the session. */
  cancel(id: string, { notifyServer = true } = {}): void {
    const task = this.tasks.get(id)
    if (!task) return
    this.releaseInflight(task)
    this.clearTimers(task.id)
    this.tasks.delete(id)
    if (notifyServer && task.fileId) void abortUpload(task.fileId)
    this.persist()
    this.syncSnapshot()
    for (const other of this.tasks.values()) if (other.status === 'uploading') this.pump(other)
  }

  cancelAll(): void {
    for (const id of [...this.tasks.keys()]) {
      const done = this.tasks.get(id)?.status === 'completed'
      this.cancel(id, { notifyServer: !done })
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /**
   * Starts every queued upload. Chunk sending is the real concurrency; a request
   * to `init` costs no chunk-sized memory, so it does not need a slot of its own.
   */
  private scheduler(): void {
    for (const task of this.sortedReady()) this.beginUpload(task)
  }

  /** True while the task is still live in the queue; guards against stale promises. */
  private isCurrent(task: UploadTask): boolean {
    return this.tasks.get(task.id) === task
  }

  private sortedReady(): UploadTask[] {
    return [...this.tasks.values()]
      .filter((t) => t.status === 'queued')
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }

  private beginUpload(task: UploadTask): void {
    task.status = 'initializing'
    this.emitChanged()
    const body: InitBody = {
      name: task.fileName,
      sizeBytes: task.sizeBytes,
      mimeType: task.mimeType,
      ...(task.folderId ? { folderId: task.folderId } : {}),
    }
    void initUpload(body, task.clientId)
      .then(({ upload }) => {
        if (!this.isCurrent(task)) return
        task.fileId = upload.fileId
        task.chunkSizeBytes = upload.chunkSizeBytes
        task.chunkCount = upload.chunkCount
        task.received = new Set(upload.received)
        task.committedBytes = sumReceivedBytes(task)
        task.status = 'uploading'
        this.emitEvent({ type: 'started', taskId: task.id, fileName: task.fileName })
        this.persist()
        this.pump(task)
      })
      .catch((error) => {
        if (!this.isCurrent(task)) return
        if (error instanceof UploadApiError && error.retriable && task.status === 'initializing') {
          this.scheduleReinit(task)
        } else {
          const message = error instanceof Error ? error.message : 'The upload could not be started'
          this.fail(task, message, error instanceof UploadApiError ? error.retriable : true)
        }
      })
  }

  /** Pulls the next missing chunk while a slot is free and the per-file cap holds. */
  private pump(task: UploadTask): void {
    while (task.status === 'uploading' && this.slots > 0 && this.inflightOf(task).size < PER_FILE_CHUNKS) {
      const index = this.nextMissing(task)
      if (index === null) break
      this.launchChunk(task, index)
    }

    if (task.status === 'uploading' && this.inflightOf(task).size === 0 && this.nextMissing(task) === null) {
      this.finalise(task)
    }
  }

  private wakeUploaders(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'uploading') this.pump(task)
    }
  }

  private launchChunk(task: UploadTask, index: number): void {
    if (!task.file) return
    const start = index * task.chunkSizeBytes
    const chunkSize = Math.min(task.chunkSizeBytes, task.sizeBytes - start)
    const blob = task.file.slice(start, start + chunkSize)

    this.slots -= 1
    this.inflightOf(task).add(index)
    if (!task.chunks.has(index)) task.chunks.set(index, { transferredBytes: 0, sizeBytes: chunkSize })

    const { promise, cancel } = uploadChunk({
      fileId: task.fileId!,
      index,
      blob,
      onProgress: (loaded) => {
        const chunk = task.chunks.get(index)
        if (!chunk) return
        const delta = loaded - chunk.transferredBytes
        if (delta > 0) {
          chunk.transferredBytes = loaded
          task.transferredBytes += delta
        }
        this.emitChanged()
      },
    })

    task.cancels.set(index, cancel)

    promise
      .then((receipt) => this.onChunkSuccess(task, index, receipt))
      .catch((error) => this.onChunkFailure(task, index, error))
  }

  private onChunkSuccess(task: UploadTask, index: number, receipt: UploadReceipt | null): void {
    this.releaseChunk(task, index)
    if (!this.isCurrent(task)) return
    // A receipt without durable storage means the server buffered it; only the final
    // `complete` decides whether it truly landed. Nothing to remember here.
    if (receipt?.stored && !task.received.has(index)) {
      task.received.add(index)
      task.committedBytes = sumReceivedBytes(task)
      task.attempts.delete(index)
      this.persist()
    }
    this.emitChanged()
    this.wakeUploaders()
  }

  private onChunkFailure(task: UploadTask, index: number, error: unknown): void {
    this.releaseChunk(task, index)
    if (!this.isCurrent(task)) return
    const attempts = (task.attempts.get(index) ?? 0) + 1
    task.attempts.set(index, attempts)

    if (error instanceof UploadApiError && error.code === 'REPLAN_REQUIRED') {
      this.replan(task)
      return
    }

    const retriable = !(error instanceof UploadApiError) || error.retriable
    if (task.status === 'uploading' && retriable && attempts < MAX_CHUNK_ATTEMPTS) {
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_CAP_MS)
      this.scheduleChunkRetry(task, index, delay)
      return
    }

    const message =
      error instanceof UploadApiError && error.code === 'RETRY_EXHAUSTED'
        ? 'The server gave up on this upload'
        : error instanceof Error
          ? error.message
          : 'A chunk could not be uploaded'
    this.fail(task, message, retriable)
  }

  private scheduleChunkRetry(task: UploadTask, index: number, delay: number): void {
    task.retryPending.add(index)
    this.emitChanged()
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      task.retryPending.delete(index)
      if (task.status === 'uploading') this.pump(task)
    }, delay)
    task.timerIds.push(timer)
    this.timers.add(timer)
  }

  private scheduleReinit(task: UploadTask): void {
    const attempts = (task.attempts.get(-1) ?? 0) + 1
    task.attempts.set(-1, attempts)
    if (attempts >= MAX_CHUNK_ATTEMPTS) {
      this.fail(task, 'The server was too busy to start the upload', true)
      return
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_CAP_MS)
    task.status = 'paused'
    this.emitChanged()
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      const current = this.tasks.get(task.id)
      if (!current || current.status !== 'paused') return
      current.status = 'queued'
      this.syncSnapshot()
      this.scheduler()
    }, delay)
    task.timerIds.push(timer)
    this.timers.add(timer)
  }

  /** The webhook ceiling shrank; the session was purged, so start over from init. */
  private replan(task: UploadTask): void {
    this.releaseInflight(task)
    this.clearTimers(task.id)
    task.fileId = null
    task.received = new Set()
    task.committedBytes = 0
    task.attempts.clear()
    task.status = 'initializing'
    this.emitEvent({ type: 'replanned', taskId: task.id })
    const body: InitBody = {
      name: task.fileName,
      sizeBytes: task.sizeBytes,
      mimeType: task.mimeType,
      // A re-plan restarts at a smaller chunk size; the file must still land in the
      // folder it was dropped into rather than the root.
      ...(task.folderId ? { folderId: task.folderId } : {}),
    }
    void initUpload(body, task.clientId)
      .then(({ upload }) => {
        if (!this.isCurrent(task)) return
        task.fileId = upload.fileId
        task.chunkSizeBytes = upload.chunkSizeBytes
        task.chunkCount = upload.chunkCount
        task.received = new Set(upload.received)
        task.committedBytes = sumReceivedBytes(task)
        task.status = 'uploading'
        this.persist()
        this.emitChanged()
        this.pump(task)
      })
      .catch((error) => {
        if (!this.isCurrent(task)) return
        const message = error instanceof Error ? error.message : 'The upload could not be restarted'
        this.fail(task, message, error instanceof UploadApiError ? error.retriable : true)
      })
  }

  private finalise(task: UploadTask): void {
    if (task.finalising) return
    task.finalising = true
    this.emitChanged()
    void completeUpload(task.fileId!)
      .then((upload) => {
        task.status = 'completed'
        task.completedAt = Date.now()
        task.finalising = false
        task.received = new Set(upload.received)
        task.committedBytes = sumReceivedBytes(task)
        this.emitEvent({ type: 'completed', taskId: task.id, fileName: task.fileName })
        this.persist()
        this.emitChanged()
      })
      .catch((error) => {
        task.finalising = false
        if (error instanceof UploadApiError && error.code === 'INCOMPLETE_UPLOAD') {
          const missing = (error.details as { missing?: number[] } | null)?.missing ?? []
          for (const index of missing) {
            task.received.delete(index)
            task.attempts.set(index, 0)
          }
          task.committedBytes = sumReceivedBytes(task)
          this.emitChanged()
          this.wakeUploaders()
          return
        }
        if (error instanceof UploadApiError && error.code === 'REPLAN_REQUIRED') {
          this.replan(task)
          return
        }
        const retriable = !(error instanceof UploadApiError) || error.retriable
        if (retriable && task.status === 'uploading') {
          this.scheduleCompleteRetry(task)
          return
        }
        const message = error instanceof Error ? error.message : 'The upload could not be finalised'
        this.fail(task, message, false)
      })
  }

  private scheduleCompleteRetry(task: UploadTask): void {
    const attempts = (task.attempts.get(-2) ?? 0) + 1
    task.attempts.set(-2, attempts)
    if (attempts >= MAX_CHUNK_ATTEMPTS) {
      this.fail(task, 'The server could not finalise the upload', true)
      return
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_CAP_MS)
    this.emitChanged()
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      const current = this.tasks.get(task.id)
      if (current && !current.finalising && current.status === 'uploading') this.finalise(current)
    }, delay)
    task.timerIds.push(timer)
    this.timers.add(timer)
  }

  // -------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------

  private fail(task: UploadTask, message: string, retriable: boolean): void {
    this.releaseInflight(task)
    this.clearTimers(task.id)
    task.status = 'failed'
    task.error = message
    task.retriable = retriable
    this.emitEvent({
      type: 'failed',
      taskId: task.id,
      fileName: task.fileName,
      reason: message,
      retriable,
    })
    this.persist()
    this.emitChanged()
    this.wakeUploaders()
  }

  private releaseInflight(task: UploadTask): void {
    for (const cancel of task.cancels.values()) cancel()
    task.cancels.clear()
    const set = this.inflight.get(task.id)
    if (set) {
      this.slots += set.size
      this.inflight.delete(task.id)
    }
  }

  private releaseChunk(task: UploadTask, index: number): void {
    const set = this.inflight.get(task.id)
    if (set?.has(index)) {
      set.delete(index)
      this.slots += 1
      if (set.size === 0) this.inflight.delete(task.id)
    }
    task.cancels.delete(index)
  }

  private inflightOf(task: UploadTask): Set<number> {
    let set = this.inflight.get(task.id)
    if (!set) {
      set = new Set()
      this.inflight.set(task.id, set)
    }
    return set
  }

  private nextMissing(task: UploadTask): number | null {
    for (let i = 0; i < task.chunkCount; i += 1) {
      if (!task.received.has(i) && !this.inflightOf(task).has(i) && !task.retryPending.has(i)) return i
    }
    return null
  }

  private clearTimers(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    for (const timer of task.timerIds) {
      clearTimeout(timer)
      this.timers.delete(timer)
    }
    task.timerIds = []
  }

  private persist(): void {
    const list: StoredUpload[] = []
    for (const task of this.tasks.values()) {
      const keep =
        task.status === 'queued' ||
        task.status === 'initializing' ||
        task.status === 'uploading' ||
        task.status === 'paused'
      if (keep) list.push(toStored(task))
    }
    try {
      if (list.length === 0) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
    } catch {
      // Storage can be unavailable (private mode); the queue still works in-memory.
    }
  }

  private emitEvent(event: UploadEvent): void {
    this.onEvent?.(event)
    this.emitChanged()
  }

  private emitChanged(): void {
    this.syncSnapshot()
    for (const listener of this.listeners) listener()
  }

  private syncSnapshot(): void {
    this.snapshot = [...this.tasks.values()]
  }
}

function makeTask(input: {
  id?: string
  clientId: string
  fileName: string
  sizeBytes: number
  mimeType: string
  file: File | null
  fileMissing: boolean
  status: UploadStatus
  folderId?: string | null
}): UploadTask {
  return {
    id: input.id ?? crypto.randomUUID(),
    clientId: input.clientId,
    fileId: null,
    fileName: input.fileName,
    sizeBytes: input.sizeBytes,
    mimeType: input.mimeType,
    status: input.status,
    chunkSizeBytes: 0,
    chunkCount: 0,
    received: new Set(),
    committedBytes: 0,
    transferredBytes: 0,
    error: null,
    retriable: false,
    file: input.file,
    fileMissing: input.fileMissing,
    folderId: input.folderId ?? null,
    startedAt: Date.now(),
    completedAt: null,
    chunks: new Map(),
    attempts: new Map(),
    cancels: new Map(),
    retryPending: new Set(),
    timerIds: [],
    finalising: false,
  }
}

function toStored(task: UploadTask): StoredUpload {
  return {
    id: task.id,
    clientId: task.clientId,
    fileName: task.fileName,
    sizeBytes: task.sizeBytes,
    mimeType: task.mimeType,
    folderId: task.folderId,
  }
}

function chunkBytesAt(task: UploadTask, index: number): number {
  const start = index * task.chunkSizeBytes
  return Math.min(task.chunkSizeBytes, Math.max(0, task.sizeBytes - start))
}

function sumReceivedBytes(task: UploadTask): number {
  let total = 0
  for (const index of task.received) total += chunkBytesAt(task, index)
  return total
}

export function taskProgress(task: UploadTask): number {
  if (task.sizeBytes === 0) return 0
  return Math.min(100, Math.round((task.committedBytes / task.sizeBytes) * 1000) / 10)
}

export function isTaskActive(task: UploadTask): boolean {
  return task.status === 'queued' || task.status === 'initializing' || task.status === 'uploading'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = units[0]
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024
    unit = units[i]
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}