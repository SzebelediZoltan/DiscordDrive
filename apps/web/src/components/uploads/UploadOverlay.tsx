import { useEffect, useReducer, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleSlash,
  Clock3,
  FileSearch,
  Loader2,
  Minus,
  Pause,
  Play,
  RotateCcw,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useUploadQueue } from '@/hooks/use-upload-queue'
import {
  formatBytes,
  isTaskActive,
  taskProgress,
  type UploadQueue,
  type UploadTask,
} from '@/lib/upload/queue'

// ---------------------------------------------------------------------------
// Per-row helpers
// ---------------------------------------------------------------------------

function useSpeed(task: UploadTask): number {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const sample = useRef({ at: Date.now(), bytes: task.transferredBytes })

  useEffect(() => {
    if (!isTaskActive(task)) return
    const interval = setInterval(() => bump(), 1_000)
    return () => clearInterval(interval)
    // Re-arm only on status change: the interval exists purely to re-render for
    // the speed sample, so tracking the task object would restart it every tick.
  }, [task.status])

  const now = Date.now()
  const elapsed = (now - sample.current.at) / 1000
  const bytes = task.transferredBytes
  let speed = 0
  if (elapsed >= 0.8 && bytes >= sample.current.bytes) {
    speed = (bytes - sample.current.bytes) / elapsed
    sample.current = { at: now, bytes }
  }
  return speed
}

function UploadRow({
  task,
  queue,
  onPickFile,
}: {
  task: UploadTask
  queue: UploadQueue
  onPickFile: (taskId: string) => void
}) {
  const speed = useSpeed(task)
  const active = isTaskActive(task)
  const uploading = task.status === 'uploading'
  const paused = task.status === 'paused'
  const completed = task.status === 'completed'
  const failed = task.status === 'failed'
  const pct = taskProgress(task)

  const remainingBytes = task.sizeBytes - task.committedBytes
  const etaSeconds = speed > 0 && remainingBytes > 0 ? remainingBytes / speed : null

  return (
    <li className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{task.fileName}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{formatBytes(task.sizeBytes)}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              {uploading && etaSeconds !== null && (
                <>
                  <Clock3 className="size-3" aria-hidden />
                  {Math.ceil(etaSeconds)}s left
                </>
              )}
              {uploading && speed > 0 && <span>{formatBytes(speed)}/s</span>}
              {paused && (task.fileMissing ? 'Paused — no file to continue, pick it below' : 'Paused')}
              {failed && <span className="text-critical">{task.error}</span>}
            </span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {uploading && (
            <Button size="sm" variant="ghost" aria-label={`Pause ${task.fileName}`} onClick={() => queue.pause(task.id)}>
              <Pause className="size-3.5" aria-hidden />
            </Button>
          )}
          {paused && !task.fileMissing && (
            <Button size="sm" variant="ghost" aria-label={`Resume ${task.fileName}`} onClick={() => queue.resume(task.id)}>
              <Play className="size-3.5" aria-hidden />
            </Button>
          )}
          {paused && task.fileMissing && (
            <Button size="sm" variant="ghost" aria-label={`Choose ${task.fileName} to continue`} onClick={() => onPickFile(task.id)}>
              <FileSearch className="size-3.5" aria-hidden />
            </Button>
          )}
          {failed && task.retriable && (
            <Button size="sm" variant="ghost" aria-label={`Retry ${task.fileName}`} onClick={() => queue.retry(task.id)}>
              <RotateCcw className="size-3.5" aria-hidden />
            </Button>
          )}
          {active || paused || failed ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-critical"
              aria-label={`Cancel ${task.fileName}`}
              onClick={() => queue.cancel(task.id)}
            >
              <X className="size-3.5" aria-hidden />
            </Button>
          ) : completed ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Dismiss ${task.fileName}`}
              onClick={() => queue.cancel(task.id, { notifyServer: false })}
            >
              <CheckCircle2 className="size-3.5 text-positive" aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>

      <div
        className="relative h-2 overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${task.fileName} upload progress`}
      >
        <motion.div
          className={cn('h-full rounded-full bg-blurple', uploading && 'progress-shimmer overflow-hidden')}
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ ease: 'easeOut', duration: 0.25 }}
        />
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

export function UploadOverlay() {
  const { queue, tasks } = useUploadQueue()
  const [collapsed, setCollapsed] = useReducer((v: boolean) => !v, false)
  const [hidden, setHidden] = useState(false)
  const [pickFor, setPickFor] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const visible = tasks.length > 0
  const activeCount = tasks.filter(isTaskActive).length
  const failedCount = tasks.filter((t) => t.status === 'failed').length
  const doneCount = tasks.filter((t) => t.status === 'completed').length
  const allFinished = activeCount === 0 && tasks.length > 0

  // A pause after a refresh lost the File handle, so this hidden picker is the overlay's
  // "continue" path: re-select the same file and `attachFile` resumes only the chunks the
  // server is still missing.
  function handlePick(taskId: string) {
    setPickFor(taskId)
    fileInput.current?.click()
  }

  function handlePickChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) {
      if (pickFor) queue.attachFile(pickFor, file)
      else queue.enqueue([file])
    }
    setPickFor(null)
    event.target.value = ''
  }

  // The panel must never trap the user: Escape and a backdrop click tuck it away
  // and a pill restores it, so navigation and the login screen stay reachable
  // while a multi-gigabyte upload is still running.
  useEffect(() => {
    if (!visible || hidden) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setHidden(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visible, hidden])

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        tabIndex={-1}
        aria-label="Choose the file to continue uploading"
        className="hidden"
        onChange={handlePickChange}
      />
      <AnimatePresence>
      {visible && hidden && (
        <motion.button
          key="upload-pill"
          type="button"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.2 }}
          onClick={() => setHidden(false)}
          className="card-surface fixed right-4 bottom-4 z-50 flex items-center gap-2 px-4 py-2.5 text-sm text-ink"
          aria-label={activeCount > 0 ? `Show uploads, ${activeCount} in progress` : 'Show uploads'}
        >
          {activeCount > 0 ? (
            <Loader2 className="size-4 animate-spin text-blurple" aria-hidden />
          ) : (
            <CheckCircle2 className={cn('size-4', failedCount > 0 ? 'text-critical' : 'text-positive')} aria-hidden />
          )}
          {activeCount > 0
            ? `Uploading ${activeCount} file${activeCount === 1 ? '' : 's'}`
            : failedCount > 0
              ? `${failedCount} failed · ${doneCount} done`
              : `${doneCount} of ${tasks.length} done`}
        </motion.button>
      )}

      {visible && !hidden && (
        <motion.div
          key="upload-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/80 backdrop-blur-xl sm:items-center"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setHidden(true)
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ ease: [0.22, 1, 0.36, 1], duration: 0.25 }}
            className="card-surface mx-4 my-8 w-full max-w-xl"
            role="dialog"
            aria-modal="true"
            aria-label="Uploads"
          >
            <div className="flex items-center justify-between border-b border-border p-5">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-ink">
                  {activeCount > 0
                    ? `Uploading ${activeCount} file${activeCount === 1 ? '' : 's'}…`
                    : allFinished
                      ? doneCount === tasks.length
                        ? 'All uploads finished'
                        : `${doneCount} of ${tasks.length} finished`
                      : 'Uploads'}
                </h2>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {failedCount > 0 && `${failedCount} failed · `}
                  {tasks.length} in this batch
                </p>
              </div>
              <div className="flex items-center gap-1">
                {activeCount > 0 && (
                  <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-critical" onClick={() => queue.cancelAll()}>
                    <CircleSlash className="size-3.5" aria-hidden />
                    Cancel all
                  </Button>
                )}
                {allFinished && (
                  <Button size="sm" variant="secondary" onClick={() => queue.cancelAll()}>
                    Done
                  </Button>
                )}
                <Button size="icon-sm" variant="ghost" aria-label="Hide uploads" onClick={() => setHidden(true)}>
                  <Minus className="size-4" aria-hidden />
                </Button>
                {tasks.length > 1 && (
                  <Button size="icon-sm" variant="ghost" aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'} onClick={setCollapsed}>
                    {collapsed ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
                  </Button>
                )}
              </div>
            </div>

            {!collapsed && (
              <ul className="max-h-[60vh] space-y-5 overflow-y-auto p-5">
                {tasks.map((task) => (
                  <UploadRow key={task.id} task={task} queue={queue} onPickFile={handlePick} />
                ))}
              </ul>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
  )
}