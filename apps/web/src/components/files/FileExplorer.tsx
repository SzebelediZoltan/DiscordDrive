import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  downloadUrl,
  shareLinkUrl,
  verifyFile,
  type FileRow,
  type FolderRow,
} from '@/lib/files/api'
import { useFileManager } from '@/hooks/use-file-manager'
import { useUploadQueue } from '@/hooks/use-upload-queue'
import { toast } from 'sonner'
import { Breadcrumbs } from './Breadcrumbs'
import { ConfirmDialog } from './Confirm'
import { EmptyState } from './EmptyState'
import { FilesToolbar } from './FilesToolbar'
import { FileGrid, FileList, type ExplorerActions } from './GridAndList'
import { FolderNameDialog } from './FolderNameDialog'
import { MoveDialog } from './MoveDialog'
import { PreviewDialog } from './PreviewDialog'
import { ShareDialog } from './ShareDialog'

interface DialogTarget {
  file: FileRow | null
  folder: FolderRow | null
}

/**
 * The virtual file system: toolbar, breadcrumbs, grid/list, row actions and every dialog.
 * Mutations go through the file-manager hook, which reloads the page from the server — the
 * grid and list literally cannot drift apart.
 */
export function FileExplorer() {
  const fm = useFileManager()
  const { queue } = useUploadQueue()

  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<DialogTarget & { mode: 'rename-folder' | 'rename-file' } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DialogTarget | null>(null)
  const [moveTarget, setMoveTarget] = useState<FileRow | null>(null)
  const [shareTarget, setShareTarget] = useState<FileRow | null>(null)
  const [previewTarget, setPreviewTarget] = useState<FileRow | null>(null)

  const startDownload = (file: FileRow) => {
    const anchor = document.createElement('a')
    anchor.href = downloadUrl(file.id)
    anchor.download = file.name
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  const copyLink = async (file: FileRow) => {
    try {
      // A live public share link beats the owner-only download URL for anything shared.
      const href = file.shareToken ? shareLinkUrl(file.shareToken) : downloadUrl(file.id)
      await navigator.clipboard.writeText(`${window.location.origin}${href}`)
      toast.success(file.shareToken ? 'Share link copied' : 'Private link copied')
    } catch {
      toast.error('Could not copy the link')
    }
  }

  const hasNothing =
    fm.listing.folders.length === 0 && fm.listing.files.length === 0 && fm.listing.shared.length === 0
  const loading = fm.loading && hasNothing
  const empty = !loading && hasNothing

  // A brand-new account has no webhook attached yet; surface it instead of an empty folder.
  const [checkedWebhooks, setCheckedWebhooks] = useState(false)
  const [hasWebhook, setHasWebhook] = useState(true)
  useEffect(() => {
    if (!empty || checkedWebhooks) return
    fetch('/api/webhooks', { credentials: 'same-origin' })
      .then((res) => res.ok && res.json())
      .then((body) => setHasWebhook((body?.webhooks?.length ?? 0) > 0))
      .catch(() => setHasWebhook(true))
      .finally(() => setCheckedWebhooks(true))
  }, [empty, checkedWebhooks])

  const actions: ExplorerActions = {
    openFolder: (folderId) => fm.openFolder(folderId),
    openFilePreview: (file) => setPreviewTarget(file),
    folderMenu: (folder) => ({
      rename: () => setRenameTarget({ file: null, folder, mode: 'rename-folder' }),
      delete: () => setDeleteTarget({ file: null, folder }),
    }),
    fileMenu: (file) => {
      // A row handed to a recipient is read-only here: no share, move, rename or delete.
      const shared = file.sharedBy !== null
      return {
        onDownload: () => startDownload(file),
        onPreview: () => setPreviewTarget(file),
        ...(shared
          ? {}
          : {
              onVerify: async () => {
                try {
                  const { result } = await verifyFile(file.id)
                  const ok = result.chunks.filter((chunk) => chunk.ok).length
                  if (result.ok) {
                    toast.success(`"${file.name}" is intact`, {
                      description: `${ok}/${result.chunks.length} chunks verified`,
                    })
                  } else {
                    toast.error(`"${file.name}" failed verification`, {
                      description: `${result.chunks.length - ok} chunk${result.chunks.length - ok === 1 ? '' : 's'} did not match`,
                    })
                  }
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : 'Could not verify this file')
                }
              },
              onCopyLink: () => copyLink(file),
              onShare: () => setShareTarget(file),
              onRename: () => setRenameTarget({ file, folder: null, mode: 'rename-file' }),
              onMove: () => setMoveTarget(file),
              onDelete: () => setDeleteTarget({ file, folder: null }),
            }),
      }
    },
    onDropFiles: (files, folderId) => {
      // The queue provider toasts each file it queues; no extra summary needed here.
      queue.enqueue(files, folderId)
    },
  }

  async function handleRename(name: string): Promise<boolean> {
    if (renameTarget?.mode === 'rename-folder' && renameTarget.folder) {
      return fm.renameFolder(renameTarget.folder, name)
    }
    if (renameTarget?.mode === 'rename-file' && renameTarget.file) {
      return fm.renameFile(renameTarget.file, name)
    }
    return false
  }

  const deletingFolder = deleteTarget?.folder ?? null
  const deletingFile = deleteTarget?.file ?? null
  const deletingName = deletingFolder?.name ?? deletingFile?.name ?? ''

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Breadcrumbs ancestors={fm.ancestors} onNavigate={fm.openFolder} />
        {fm.search && (
          <p className="text-xs text-muted-foreground">
            Showing matches for “{fm.search}”
          </p>
        )}
      </div>

      <FilesToolbar
        search={fm.search}
        onSearch={fm.setSearch}
        view={fm.view}
        onView={fm.setView}
        onNewFolder={() => setCreateOpen(true)}
      />

      {loading ? (
        <ExplorerSkeleton />
      ) : empty ? (
        fm.search ? (
          <EmptyState variant="search" />
        ) : hasWebhook ? (
          <EmptyState variant="empty" />
        ) : (
          <EmptyState variant="webhook" />
        )
      ) : fm.view === 'grid' ? (
        <FileGrid
          folders={fm.listing.folders}
          files={fm.listing.files}
          shared={fm.listing.shared}
          actions={actions}
        />
      ) : (
        <FileList
          folders={fm.listing.folders}
          files={fm.listing.files}
          shared={fm.listing.shared}
          actions={actions}
        />
      )}

      {(fm.listing.nextCursor || fm.loadingMore) && (
        <div className="flex justify-center pt-1">
          <Button type="button" variant="outline" onClick={() => void fm.loadMore()} disabled={fm.loadingMore}>
            {fm.loadingMore ? 'Loading…' : 'Load more'}
            {!fm.loadingMore && <ChevronDown aria-hidden />}
          </Button>
        </div>
      )}

      <FolderNameDialog open={createOpen} onOpenChange={setCreateOpen} target={null} mode="create" onSubmit={fm.createFolder} />

      {renameTarget && (
        <FolderNameDialog
          open={renameTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null)
          }}
          target={renameTarget.folder ?? renameTarget.file}
          mode={renameTarget.mode}
          onSubmit={handleRename}
        />
      )}

      {(deletingFolder !== null || deletingFile !== null) && (
        <ConfirmDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null)
          }}
          title={`Delete “${deletingName}”?`}
          description={
            deletingFolder
              ? 'The folder and everything inside it (files and subfolders) will be deleted so its name can be reused. Downloads through it stop immediately.'
              : 'The file is gone from your storage (name freed, share link dead). This cannot be undone.'
          }
          confirmLabel="Delete"
          onConfirm={() =>
            deletingFolder ? fm.removeFolder(deletingFolder) : deletingFile ? fm.removeFile(deletingFile) : Promise.resolve()
          }
        />
      )}

      {moveTarget && (
        <MoveDialog
          open={moveTarget !== null}
          onOpenChange={(open) => {
            if (!open) setMoveTarget(null)
          }}
          fileName={moveTarget.name}
          onCommit={(folderId) => fm.moveFile(moveTarget, folderId)}
        />
      )}

      {shareTarget && (
        <ShareDialog
          open={shareTarget !== null}
          onOpenChange={(open) => {
            if (!open) setShareTarget(null)
          }}
          file={shareTarget}
          onSaved={() => fm.reload()}
        />
      )}

      {previewTarget && (
        <PreviewDialog
          open={previewTarget !== null}
          onOpenChange={(open) => {
            if (!open) setPreviewTarget(null)
          }}
          file={previewTarget}
        />
      )}
    </div>
  )
}

function ExplorerSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="card-surface space-y-3 p-4">
            <Skeleton className="size-7" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  )
}