import { useEffect, useState } from 'react'
import { FolderPlus, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface FolderNameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The row being renamed, or null when creating a folder. */
  target: { id: string; name: string } | null
  /** 'rename-file' instead of 'rename-folder' changes the copy; create always means folder. */
  mode: 'create' | 'rename-folder' | 'rename-file'
  onSubmit: (name: string) => Promise<boolean>
}

/** Create/rename dialog shared by the explorer's new-folder button and the row menus. */
export function FolderNameDialog({ open, onOpenChange, target, mode, onSubmit }: FolderNameDialogProps) {
  const [name, setName] = useState(target?.name ?? '')
  const [busy, setBusy] = useState(false)
  const isRename = mode !== 'create'

  useEffect(() => {
    if (open) {
      setName(target?.name ?? '')
      setBusy(false)
    }
  }, [open, target])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    const ok = await onSubmit(trimmed)
    if (ok) onOpenChange(false)
    setBusy(false)
  }

  const title = mode === 'create' ? 'New folder' : mode === 'rename-folder' ? 'Rename folder' : 'Rename file'
  const constraint =
    mode === 'create'
      ? 'Folders can nest as deep as you like.'
      : mode === 'rename-folder'
        ? 'The name must be unique among its sibling folders.'
        : 'File names must be unique within their folder.'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{constraint}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={mode === 'create' ? 'e.g. Screenshots' : 'Name'}
              autoFocus
              maxLength={255}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim() === ''}>
              {isRename ? <Pencil aria-hidden /> : <FolderPlus aria-hidden />}
              {busy ? (isRename ? 'Renaming…' : 'Creating…') : isRename ? 'Rename' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}