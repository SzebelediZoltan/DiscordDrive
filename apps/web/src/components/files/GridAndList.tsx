import { useRef, useState } from 'react'
import {
  AudioLines,
  File as FileIcon,
  FileArchive,
  FileText,
  Film,
  Folder,
  Image as ImageIcon,
  type LucideIcon,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { type FileRow, type FolderRow } from '@/lib/files/api'
import { formatBytes } from '@/lib/upload/queue'
import { cn } from '@/lib/utils'
import { LinkHealthBadge } from './LinkHealthBadge'
import { FileRowMenu, FolderRowMenu, type RowActions } from './RowMenus'

export interface ExplorerActions {
  openFolder: (folderId: string) => void
  /** Clicking a file row/card opens its preview dialog, like any file manager. */
  openFilePreview: (file: FileRow) => void
  folderMenu: (folder: FolderRow) => { rename: () => void; delete: () => void }
  fileMenu: (file: FileRow) => RowActions
  /** Drop of local files onto a folder row; `folderId` null means the page dropzone. */
  onDropFiles: (files: File[], folderId: string | null) => void
}

/**
 * File grid. Folders are drop targets that light up while a file drag passes over them;
 * the highlight is the visible promise that a drop lands in that folder. Files shared with
 * the caller render in their own "Shared with me" section (root browse only).
 */
export function FileGrid({
  folders,
  files,
  shared,
  actions,
}: {
  folders: FolderRow[]
  files: FileRow[]
  shared: FileRow[]
  actions: ExplorerActions
}) {
  return (
    <div className="space-y-6">
      {folders.length > 0 && (
        <section aria-label="Folders" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {folders.map((folder) => (
            <FolderCard key={folder.id} folder={folder} actions={actions} />
          ))}
        </section>
      )}
      {files.length > 0 && (
        <section aria-label="Files" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {files.map((file) => (
            <FileCard key={file.id} file={file} actions={actions} />
          ))}
        </section>
      )}
      {shared.length > 0 && (
        <section aria-label="Files shared with me">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Shared with me</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shared.map((file) => (
              <FileCard key={file.id} file={file} shared actions={actions} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * File list: the same rows as the grid in a dense table, folders first, then a "Shared with
 * me" section when the backend returned one. The data source is identical, so the two views
 * can never disagree.
 */
export function FileList({
  folders,
  files,
  shared,
  actions,
}: {
  folders: FolderRow[]
  files: FileRow[]
  shared: FileRow[]
  actions: ExplorerActions
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-line">
          <TableHead className="w-full sm:w-auto">Name</TableHead>
          <TableHead className="hidden sm:table-cell">Size</TableHead>
          <TableHead className="hidden md:table-cell">Health</TableHead>
          <TableHead className="hidden lg:table-cell">Updated</TableHead>
          <TableHead className="w-10">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {folders.map((folder) => (
          <TableRow
            key={folder.id}
            className="cursor-pointer border-line hover:bg-muted/40"
            onClick={() => actions.openFolder(folder.id)}
          >
            <TableCell className="py-2">
              <span className="flex items-center gap-2.5">
                <Folder className="size-4 shrink-0 text-blurple-soft" aria-hidden />
                <span className="truncate font-medium text-ink">{folder.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  Folder · {folder.fileCount} file{folder.fileCount === 1 ? '' : 's'}
                </span>
              </span>
            </TableCell>
            <TableCell className="hidden py-2 text-sm text-muted-foreground sm:table-cell">—</TableCell>
            <TableCell className="hidden py-2 md:table-cell">
              <span className="text-xs text-muted-foreground">{folder.childFolderCount} subfolder{folder.childFolderCount === 1 ? '' : 's'}</span>
            </TableCell>
            <TableCell className="hidden py-2 text-xs text-muted-foreground lg:table-cell">—</TableCell>
            <TableCell className="py-2">
              <FolderRowMenu
                actions={{
                  rename: () => actions.folderMenu(folder).rename(),
                  delete: () => actions.folderMenu(folder).delete(),
                }}
              />
            </TableCell>
          </TableRow>
        ))}
        {files.map((file) => (
          <FileListRow key={file.id} file={file} actions={actions} />
        ))}
        {shared.length > 0 && (
          <>
            <TableRow className="border-line bg-muted/40">
              <TableCell colSpan={5} className="py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Shared with me
              </TableCell>
            </TableRow>
            {shared.map((file) => (
              <FileListRow key={file.id} file={file} shared actions={actions} />
            ))}
          </>
        )}
      </TableBody>
    </Table>
  )
}

function FileListRow({ file, shared, actions }: { file: FileRow; shared?: boolean; actions: ExplorerActions }) {
  const kind = fileKind(file.mimeType)
  const sender = shared ? (file.sharedBy?.displayName || file.sharedBy?.email) ?? '' : null
  return (
    <TableRow
      className="cursor-pointer border-line hover:bg-muted/40"
      onClick={() => actions.openFilePreview(file)}
    >
      <TableCell className="py-2">
        <span className="flex items-center gap-2.5">
          <kind.Icon className={cn('size-4 shrink-0', kind.tint)} aria-hidden />
          <span className="min-w-0">
            <span className="block truncate font-medium text-ink">{file.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {shared ? `Shared with me · from ${sender}` : (file.folderName ?? file.mimeType)}
            </span>
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden py-2 text-sm text-muted-foreground sm:table-cell">
        {formatBytes(Number(BigInt(file.sizeBytes)))}
      </TableCell>
      <TableCell className="hidden py-2 md:table-cell">
        <LinkHealthBadge file={file} />
      </TableCell>
      <TableCell className="hidden py-2 text-xs text-muted-foreground lg:table-cell">
        {shortDate(file.updatedAt)}
      </TableCell>
      <TableCell className="py-2">
        <FileRowMenu actions={actions.fileMenu(file)} />
      </TableCell>
    </TableRow>
  )
}

function FolderCard({ folder, actions }: { folder: FolderRow; actions: ExplorerActions }) {
  const drop = useFolderDrop((files) => actions.onDropFiles(files, folder.id))

  return (
    <Card className={cn('relative p-4 transition hover:bg-muted/40', drop.showHighlight && 'ring-2 ring-blurple')} {...drop.handlers}>
      <button
        type="button"
        onClick={() => actions.openFolder(folder.id)}
        aria-label={`Open folder ${folder.name}`}
        className="absolute inset-0 z-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      />
      <div className="pointer-events-none relative z-[1] space-y-2">
        <Folder className="size-7 text-blurple-soft" aria-hidden />
        <div>
          <p className="truncate font-medium text-ink">{folder.name}</p>
          <p className="text-xs text-muted-foreground">
            {folder.fileCount} file{folder.fileCount === 1 ? '' : 's'}
            {folder.childFolderCount > 0 && ` · ${folder.childFolderCount} subfolder${folder.childFolderCount === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>
      <div className="absolute right-3 top-3 z-10">
        <FolderRowMenu
          actions={{
            rename: () => actions.folderMenu(folder).rename(),
            delete: () => actions.folderMenu(folder).delete(),
          }}
        />
      </div>
    </Card>
  )
}

function FileCard({ file, actions, shared }: { file: FileRow; actions: ExplorerActions; shared?: boolean }) {
  const kind = fileKind(file.mimeType)
  const sender = shared ? (file.sharedBy?.displayName || file.sharedBy?.email) ?? '' : null
  return (
    <Card className="relative p-4 transition hover:bg-muted/40">
      <button
        type="button"
        onClick={() => actions.openFilePreview(file)}
        aria-label={`Preview ${file.name}`}
        className="absolute inset-0 z-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      />
      <CardContent className="pointer-events-none relative z-[1] p-0">
        <div className="pointer-events-none flex items-start justify-between gap-2">
          <span className={cn('flex size-10 items-center justify-center rounded-lg bg-muted/60', kind.tint)}>
            <kind.Icon className="size-5" aria-hidden />
          </span>
          <span className="pointer-events-auto">
            <FileRowMenu actions={actions.fileMenu(file)} />
          </span>
        </div>
        <div className="pointer-events-none mt-3 space-y-1.5">
          <p className="truncate font-medium text-ink" title={file.name}>
            {file.name}
          </p>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{formatBytes(Number(BigInt(file.sizeBytes)))}</span>
            {shared ? (
              <span className="truncate">from {sender}</span>
            ) : (
              file.folderName && <span className="truncate">in {file.folderName}</span>
            )}
          </p>
          <LinkHealthBadge file={file} />
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Folder drop-target behaviour: highlights only while a drag actually carries files (text
 * drags, internal drags and the like never flash the target) and returns the files on drop.
 */
function useFolderDrop(onDrop: (files: File[]) => void) {
  const [showHighlight, setShowHighlight] = useState(false)
  const depth = useRef(0)

  return {
    showHighlight,
    handlers: {
      onDragEnter: (event: React.DragEvent) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        depth.current += 1
        setShowHighlight(true)
      },
      onDragOver: (event: React.DragEvent) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!event.dataTransfer.types.includes('Files')) return
        depth.current -= 1
        if (depth.current <= 0) {
          depth.current = 0
          setShowHighlight(false)
        }
      },
      onDrop: (event: React.DragEvent) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        depth.current = 0
        setShowHighlight(false)
        const files = [...event.dataTransfer.files]
        if (files.length > 0) onDrop(files)
      },
    },
  }
}

interface FileKind {
  Icon: LucideIcon
  tint: string
}

function fileKind(mimeType: string): FileKind {
  if (mimeType.startsWith('image/')) return { Icon: ImageIcon, tint: 'text-emerald-400/80' }
  if (mimeType.startsWith('video/')) return { Icon: Film, tint: 'text-violet-400/80' }
  if (mimeType.startsWith('audio/')) return { Icon: AudioLines, tint: 'text-amber-300/80' }
  if (mimeType === 'application/zip' || mimeType.includes('compressed') || mimeType.endsWith('+zip')) {
    return { Icon: FileArchive, tint: 'text-sky-400/80' }
  }
  if (mimeType === 'application/pdf' || mimeType.startsWith('text/')) return { Icon: FileText, tint: 'text-rose-400/80' }
  return { Icon: FileIcon, tint: 'text-muted-foreground' }
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}