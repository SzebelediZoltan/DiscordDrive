import { useState } from 'react'
import {
  ClipboardCopy,
  Download,
  Eye,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Share2,
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
  onPreview?: () => void
  onVerify?: () => void
  onCopyLink?: () => void
  onShare?: () => void
  onRename?: () => void
  onMove?: () => void
  onDelete?: () => void
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

/**
 * The ``…`` menu on a file row. Owner rows get the full surface (preview, download, verify,
 * share/copy-link, move, rename, delete); a row handed to a recipient only ever carries
 * preview and download, so those actions are always optional here.
 */
export function FileRowMenu({ actions }: { actions: RowActions }) {
  const hasOwnerItems = actions.onShare || actions.onCopyLink || actions.onMove || actions.onRename || actions.onDelete
  return (
    <RowMenuShell label="File actions">
      {actions.onPreview && (
        <DropdownMenuItem className={itemClass} onSelect={actions.onPreview}>
          <Eye aria-hidden />
          Preview
        </DropdownMenuItem>
      )}
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
      {actions.onShare && (
        <DropdownMenuItem className={itemClass} onSelect={actions.onShare}>
          <Share2 aria-hidden />
          Share…
        </DropdownMenuItem>
      )}
      {actions.onCopyLink && (
        <DropdownMenuItem className={itemClass} onSelect={actions.onCopyLink}>
          <ClipboardCopy aria-hidden />
          {actions.onShare ? 'Copy link' : 'Get a download link'}
        </DropdownMenuItem>
      )}
      {actions.onMove && (
        <DropdownMenuItem className={itemClass} onSelect={actions.onMove}>
          <FolderInput aria-hidden />
          Move to…
        </DropdownMenuItem>
      )}
      {(actions.onRename || actions.onDelete) && hasOwnerItems && <DropdownMenuSeparator />}
      {actions.onRename && (
        <DropdownMenuItem className={itemClass} onSelect={actions.onRename}>
          <Pencil aria-hidden />
          Rename
        </DropdownMenuItem>
      )}
      {actions.onDelete && (
        <DropdownMenuItem className={destructiveClass} onSelect={actions.onDelete}>
          <Trash2 aria-hidden />
          Delete
        </DropdownMenuItem>
      )}
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