import { useEffect, useState } from 'react'
import { Download, File as FileIcon, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { downloadUrl, viewUrl, type FileRow } from '@/lib/files/api'
import { formatBytes } from '@/lib/upload/queue'

interface PreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: FileRow
}

/** The text/code renderers fetch the first 512 KiB and show what came back. */
const TEXT_PREVIEW_BYTES = 512 * 1024

const CODE_MIME_PREFIXES = [
  'application/json',
  'application/javascript',
  'application/x-javascript',
  'application/xml',
  'application/sql',
  'application/x-sh',
  'application/x-httpd-php',
  'application/graphql',
  'application/yaml',
  'application/toml',
]

type Renderer = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none'

function rendererFor(mimeType: string): Renderer {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('text/') || CODE_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) return 'text'
  return 'none'
}

/**
 * In-app preview for anything the browser can render: image, video, audio, PDF, or the
 * first 512 KiB of text/code. Data still lives behind the authenticated `/view` endpoint,
 * which answers byte ranges, so video and audio can seek without a full download.
 */
export function PreviewDialog({ open, onOpenChange, file }: PreviewDialogProps) {
  const renderer = rendererFor(file.mimeType)
  const [text, setText] = useState<string | null>(null)
  const [totalBytes, setTotalBytes] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open) return
    setFailed(false)
    if (renderer !== 'text') return

    let cancelled = false
    setText(null)
    setTotalBytes(null)
    fetch(viewUrl(file.id), {
      credentials: 'same-origin',
      headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const contentRange = res.headers.get('content-range')
        const match = /^bytes \d+-\d+\/(\d+)$/.exec(contentRange ?? '')
        if (match) setTotalBytes(Number(match[1]))
        const body = await res.text()
        if (!cancelled) setText(body)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, renderer, file.id])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{file.name}</DialogTitle>
          <DialogDescription>
            {formatBytes(Number(BigInt(file.sizeBytes)))} · {file.mimeType || 'unknown type'}
            {failed && ' · preview unavailable'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden rounded-(--radius-control) border border-line bg-background">
          {renderer === 'image' &&
            (!failed ? (
              <img
                src={viewUrl(file.id)}
                alt={file.name}
                onError={() => setFailed(true)}
                className="mx-auto max-h-[55vh] w-full object-contain"
              />
            ) : (
              <PreviewFallback file={file} />
            ))}

          {renderer === 'video' && (
            <video
              key={file.id}
              src={viewUrl(file.id)}
              controls
              preload="metadata"
              className="mx-auto max-h-[55vh] w-full bg-black"
            >
              Your browser does not support embedded video.
            </video>
          )}

          {renderer === 'audio' && (
            <audio key={file.id} src={viewUrl(file.id)} controls className="mt-10 w-full px-6">
              Your browser does not support embedded audio.
            </audio>
          )}

          {renderer === 'pdf' && (
            <iframe
              title={file.name}
              src={`${viewUrl(file.id)}#toolbar=0`}
              className="h-[55vh] w-full"
            />
          )}

          {renderer === 'text' &&
            (failed ? (
              <PreviewFallback file={file} />
            ) : text === null ? (
              <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Reading preview…
              </p>
            ) : (
              <div className="max-h-[55vh] overflow-auto">
                <pre className="whitespace-pre-wrap break-words bg-background p-4 font-mono text-xs leading-relaxed text-ink">
                  {text}
                  {totalBytes !== null && text.length >= TEXT_PREVIEW_BYTES && (
                    <>
                      {'\n\n'}
                      <span className="text-muted-foreground">
                        — Preview shows the first {formatBytes(TEXT_PREVIEW_BYTES)}; the full file is {formatBytes(totalBytes)}.
                      </span>
                    </>
                  )}
                </pre>
              </div>
            ))}

          {renderer === 'none' && <PreviewFallback file={file} />}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button asChild>
            <a href={downloadUrl(file.id)} download={file.name}>
              <Download aria-hidden />
              Download
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PreviewFallback({ file }: { file: FileRow }) {
  return (
    <div className="flex h-[40vh] flex-col items-center justify-center gap-3 px-8 text-center">
      <FileIcon className="size-10 text-muted-foreground/60" aria-hidden />
      <p className="text-sm text-muted-foreground">
        No in-browser preview for this file type. Download it to open it locally.
      </p>
      <p className="max-w-full truncate font-mono text-xs text-faint">{file.mimeType || 'unknown type'}</p>
    </div>
  )
}