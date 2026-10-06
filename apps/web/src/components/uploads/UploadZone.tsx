import { useRef, useState } from 'react'
import { CloudUpload } from 'lucide-react'
import { cn } from '@/lib/utils'

interface UploadZoneProps {
  onFiles: (files: File[]) => void
  disabled?: boolean
  label?: string
}

/** Drop-or-browse entry point. Keyboard reachable via the visually-hidden file input. */
export function UploadZone({ onFiles, disabled = false, label = 'Drop files here to upload' }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  function handleFiles(list: FileList | null) {
    if (!list || disabled) return
    const files = [...list]
    if (files.length > 0) onFiles(files)
  }

  return (
    <div
      className={cn(
        'group relative',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        dragging && !disabled && 'glow-blurple',
      )}
      onDragEnter={(event) => {
        event.preventDefault()
        if (disabled) return
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (disabled) return
        event.preventDefault()
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        dragDepth.current -= 1
        if (dragDepth.current <= 0) {
          dragDepth.current = 0
          setDragging(false)
        }
      }}
      onDrop={(event) => {
        event.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        handleFiles(event.dataTransfer.files)
      }}
      onClick={(event) => {
        if (disabled || event.target !== event.currentTarget) return
        inputRef.current?.click()
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          handleFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-3 rounded-(--radius-card) border-2 border-dashed border-line px-6 py-12',
          'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
          dragging && !disabled && 'border-blurple border-solid',
        )}
      >
        <span
          className={cn(
            'flex size-12 items-center justify-center rounded-full bg-muted/60 text-blurple-soft transition-transform',
            dragging && !disabled && 'scale-110',
          )}
        >
          <CloudUpload className="size-6" aria-hidden />
        </span>
        <span className="text-sm font-medium text-ink">{disabled ? 'Sign in to upload' : label}</span>
        <span className="max-w-sm text-center text-xs text-muted-foreground">
          Sliced into chunks and pushed to your Discord webhook. You can close this page and resume later.
        </span>
      </button>
    </div>
  )
}