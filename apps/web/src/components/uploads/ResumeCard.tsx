import { useRef } from 'react'
import { History, PackageOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUploadQueue } from '@/hooks/use-upload-queue'
import { formatBytes } from '@/lib/upload/queue'

/** Uploads interrupted by a page refresh lose their File handle; re-pick it here. */
export function ResumeCard() {
  const { queue, tasks } = useUploadQueue()
  const inputRef = useRef<HTMLInputElement>(null)
  const missing = tasks.filter((task) => task.fileMissing)
  if (missing.length === 0) return null

  function handleFiles(list: FileList | null) {
    if (!list) return
    const files = [...list]
    const leftovers: File[] = []
    for (const file of files) {
      const match = missing.find((task) => task.fileName === file.name && task.sizeBytes === file.size)
      if (match) queue.attachFile(match.id, file)
      else leftovers.push(file)
    }
    if (leftovers.length > 0) queue.enqueue(leftovers)
  }

  return (
    <div className="card-surface p-6">
      <div className="flex items-center gap-2">
        <History className="size-4 text-blurple-soft" aria-hidden />
        <h2 className="text-sm font-medium text-ink">Incomplete uploads from before</h2>
      </div>
      <p className="mt-1 text-xs text-muted">
        Your chunks are safe on the server. Pick the same file again and only the missing pieces are re-sent.
      </p>
      <ul className="mt-4 space-y-2">
        {missing.map((task) => (
          <li key={task.id} className="flex items-center justify-between gap-3 rounded-(--radius-control) border border-border px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm text-ink">{task.fileName}</p>
              <p className="text-xs text-faint">{formatBytes(task.sizeBytes)}</p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => inputRef.current?.click()}
            >
              <PackageOpen className="size-3.5" aria-hidden />
              Choose file
            </Button>
          </li>
        ))}
      </ul>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        multiple
        onChange={(event) => {
          handleFiles(event.target.files)
          event.target.value = ''
        }}
      />
    </div>
  )
}