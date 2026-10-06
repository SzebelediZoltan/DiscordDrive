import { useState } from 'react'
import {
  ClipboardCopy,
  Download,
  FolderInput,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface RowActions {
  onDownload?: () => void
  onVerify?: () => void
  onCopyLink?: () => void
  onRename: () => void
  onMove?: () => void
  onDelete: () => void
}

const itemClass =
  'cursor-pointer data-[highlighted]:bg-muted data-[highlighted]:text-ink focus-visible:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50'

const destructiveClass = `${itemClass} text-destructive data-[highlighted]:text-destructive`

interface FolderActions {
  rename: () => void
  delete: () => void
}

/** The ``…`` menu on a folder row. */
export function FolderRowMenu({ actions }: { actions: FolderActions }) {
  return (
    <RowMenuShell label="Folder actions">
      <DropdownMenuItem className={itemClass} onSelect={actions.rename}>
        <Pencil aria-hidden />
        Rename
      </DropdownMenuItem>
      <DropdownMenuItem className={destructiveClass} onSelect={actions.delete}>
        <Trash2 aria-hidden />
        Delete
      </DropdownMenuItem>
    </RowMenuShell>
  )
}

/** The ``…`` menu on a file row: download, verify, copy a link, rename, move, delete. */
export function FileRowMenu({ actions }: { actions: RowActions }) {
  return (
    <RowMenuShell label="File actions">
      {actions.onDownload && (
        <DropdownMenuItem className={itemClass} onSelect={actions.onDownload}>
          <Download aria-hidden />
          Download
        </DropdownMenuItem>
      )}
      {actions.onVerify && (
        <DropdownMenuItem className={itemClass} onSelect={actions.onVerify}>
          <ShieldCheck aria-hidden />
          Verify integrity
        </DropdownMenuItem>
      )}
      {actions.onCopyLink && (
        <DropdownMenuItem className={itemClass} onSelect={actions.onCopyLink}>
          <ClipboardCopy aria-hidden />
          Copy link
        </DropdownMenuItem>
      )}
      <DropdownMenuItem className={itemClass} onSelect={actions.onMove}>
        <FolderInput aria-hidden />
        Move to…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem className={itemClass} onSelect={actions.onRename}>
        <Pencil aria-hidden />
        Rename
      </DropdownMenuItem>
      <DropdownMenuItem className={destructiveClass} onSelect={actions.onDelete}>
        <Trash2 aria-hidden />
        Delete
      </DropdownMenuItem>
    </RowMenuShell>
  )
}

function RowMenuShell({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={(event) => event.stopPropagation()}
          className={open ? 'bg-muted text-ink' : ''}
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}