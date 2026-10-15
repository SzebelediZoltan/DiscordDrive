import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, Folder, FolderInput, Home } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { listFiles, type FolderRow } from '@/lib/files/api'
import { cn } from '@/lib/utils'

interface MoveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fileName: string
  onCommit: (folderId: string | null) => Promise<boolean>
}

/**
 * Move picker: a tiny in-dialog file system over the same list API the explorer uses, so
 * the destination list always matches what the user sees when they get there. "Move here"
 * targets whichever folder is being browsed (the root when no folder is open).
 */
export function MoveDialog({ open, onOpenChange, fileName, onCommit }: MoveDialogProps) {
  const [location, setLocation] = useState<{ id: string | null; name: string }>({ id: null, name: 'My files' })
  const [path, setPath] = useState<{ id: string | null; name: string }[]>([])
  const [folders, setFolders] = useState<FolderRow[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setLocation({ id: null, name: 'My files' })
    setPath([])
    setBusy(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    listFiles({ folderId: location.id, limit: 200 })
      .then(({ listing }) => {
        if (!cancelled) setFolders(listing.folders)
      })
      .catch(() => {
        if (!cancelled) setFolders([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, location.id])

  function descend(folder: FolderRow) {
    setPath((current) => [...current, { id: location.id, name: location.name }])
    setLocation({ id: folder.id, name: folder.name })
  }

  function ascend() {
    const parent = path[path.length - 1]
    setPath((current) => current.slice(0, -1))
    setLocation(parent ?? { id: null, name: 'My files' })
  }

  async function commit() {
    setBusy(true)
    const ok = await onCommit(location.id)
    setBusy(false)
    if (ok) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move “{fileName}”</DialogTitle>
          <DialogDescription>Pick the destination folder, then confirm.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <Button type="button" variant="ghost" size="xs" onClick={() => { setPath([]); setLocation({ id: null, name: 'My files' }) }}>
              <Home aria-hidden />
              My files
            </Button>
            {path.map((step) => (
              <span key={step.id ?? 'root'} className="flex items-center gap-1">
                <ChevronRight className="size-3.5 text-faint" aria-hidden />
                <span className="max-w-32 truncate">{step.name}</span>
              </span>
            ))}
            {(location.id !== null || path.length > 0) && (
              <>
                <ChevronRight className="size-3.5 text-faint" aria-hidden />
                <span className="max-w-32 truncate text-ink">{location.name}</span>
              </>
            )}
          </div>

          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : folders.length === 0 ? (
            <p className="rounded-(--radius-control) border border-dashed border-line py-6 text-center text-sm text-muted-foreground">
              No subfolders here — files can still be moved to this location.
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-(--radius-control) border border-line">
              {folders.map((folder) => (
                <li key={folder.id}>
                  <button
                    type="button"
                    onClick={() => descend(folder)}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm outline-none transition-colors',
                      'hover:bg-muted focus-visible:bg-muted',
                    )}
                  >
                    <Folder className="size-4 text-blurple-soft" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink">{folder.name}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {folder.fileCount} file{folder.fileCount === 1 ? '' : 's'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          {location.id !== null && (
            <Button type="button" variant="ghost" onClick={ascend}>
              <ArrowLeft aria-hidden />
              Up
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={() => void commit()}>
            <FolderInput aria-hidden />
            {busy ? 'Moving…' : `Move to “${location.name}”`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}