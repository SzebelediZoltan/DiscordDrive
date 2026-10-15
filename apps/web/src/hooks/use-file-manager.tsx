import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import {
  FilesApiError,
  createFolder as apiCreateFolder,
  deleteFile as apiDeleteFile,
  deleteFolder as apiDeleteFolder,
  listFiles,
  moveFile as apiMoveFile,
  renameFile as apiRenameFile,
  renameFolder as apiRenameFolder,
  type FileRow,
  type FolderRow,
  type Listing,
} from '@/lib/files/api'

/**
 * Drives the file explorer: current folder + debounced search + pagination, with the URL
 * holding the folder so a refresh (or a shared link) reopens the same place.
 *
 * `folderId` is deliberately not in `useState` — the URL is the source of truth, which makes
 * "back to root", breadcrumbs and deep links all fall out of the router instead of bespoke
 * state. Every mutation ends in a reload of the page (not a hand-edited row), so grid and
 * list always show the same data by construction.
 */

const PAGE_SIZE = 50

/** Where the grid/list pick is remembered so a reload opens the drive the same way. */
const VIEW_STORAGE_KEY = 'ddrive:file-view:v1'

const EMPTY_LISTING: Listing = { folders: [], files: [], shared: [], ancestors: [], nextCursor: null }

function toastError(error: unknown, fallback: string): void {
  const message = error instanceof FilesApiError ? error.message : error instanceof Error ? error.message : fallback
  toast.error(message)
}

export interface FileManager {
  loading: boolean
  loadingMore: boolean
  listing: Listing
  folderId: string | null
  ancestors: { id: string; name: string }[]
  search: string
  setSearch: (value: string) => void
  view: 'grid' | 'list'
  setView: (view: 'grid' | 'list') => void
  openFolder: (folderId: string | null) => void
  createFolder: (name: string) => Promise<boolean>
  renameFolder: (folder: FolderRow, name: string) => Promise<boolean>
  removeFolder: (folder: FolderRow) => Promise<void>
  renameFile: (file: FileRow, name: string) => Promise<boolean>
  moveFile: (file: FileRow, folderId: string | null) => Promise<boolean>
  removeFile: (file: FileRow) => Promise<void>
  loadMore: () => Promise<void>
  reload: () => void
}

export function useFileManager(): FileManager {
  const [searchParams, setSearchParams] = useSearchParams()
  const folderId = searchParams.get('folder') === 'root' ? null : searchParams.get('folder')

  const [view, setView] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const setViewPersisted = useCallback((next: 'grid' | 'list') => {
    setView(next)
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next)
    } catch {
      /* storage can be unavailable (private mode); the pick just lives for the tab */
    }
  }, [])
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listing, setListing] = useState<Listing>(EMPTY_LISTING)
  const [version, setVersion] = useState(0)

  const requestId = useRef(0)

  // Debounce the search box into a server query; 300 ms keeps every keystroke from firing a
  // request while still feeling immediate on a fast connection.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])

  const reload = useCallback(() => setVersion((v) => v + 1), [])

  const openFolder = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(searchParams)
      if (id) next.set('folder', id)
      else next.delete('folder')
      setSearchParams(next)
    },
    [searchParams, setSearchParams],
  )

  useEffect(() => {
    const id = ++requestId.current
    setLoading(true)

    listFiles({
      folderId,
      search: debouncedSearch || undefined,
      limit: PAGE_SIZE,
    })
      .then(({ listing }) => {
        if (id !== requestId.current) return
        setListing(listing)
      })
      .catch((error) => {
        if (id !== requestId.current) return
        // A folder that vanished (deleted elsewhere while open) resets to the root instead
        // of pinning the user on an error page.
        if (error instanceof FilesApiError && error.status === 404) {
          toast.error('That folder no longer exists')
          openFolder(null)
          return
        }
        toastError(error, 'Could not load this folder')
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false)
      })
  }, [folderId, debouncedSearch, version])

  const loadMore = useCallback(async () => {
    if (loadingMore || !listing.nextCursor) return
    setLoadingMore(true)
    try {
      const { listing: next } = await listFiles({
        folderId,
        search: debouncedSearch || undefined,
        cursor: listing.nextCursor,
        limit: PAGE_SIZE,
      })
      setListing((current) => ({
        folders: current.folders,
        files: [...current.files, ...next.files],
        // The shared inbox only ever arrives once, on the browse page; later pages keep it.
        shared: next.shared.length > 0 ? next.shared : current.shared,
        ancestors: current.ancestors,
        nextCursor: next.nextCursor,
      }))
    } catch (error) {
      toastError(error, 'Could not load the next page')
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, listing, folderId, debouncedSearch])

  const create = useCallback(
    async (name: string): Promise<boolean> => {
      try {
        await apiCreateFolder(name, folderId ?? undefined)
        reload()
        return true
      } catch (error) {
        toastError(error, 'Could not create the folder')
        return false
      }
    },
    [folderId, reload],
  )

  const renameFolder = useCallback(
    async (folder: FolderRow, name: string): Promise<boolean> => {
      try {
        await apiRenameFolder(folder.id, name)
        reload()
        return true
      } catch (error) {
        toastError(error, 'Could not rename the folder')
        return false
      }
    },
    [reload],
  )

  const removeFolder = useCallback(
    async (folder: FolderRow): Promise<void> => {
      try {
        const { deleted } = await apiDeleteFolder(folder.id)
        reload()
        toast.success(`Deleted "${folder.name}"`, {
          description:
            deleted.deletedFiles > 0
              ? `${deleted.deletedFolders} folder${deleted.deletedFolders === 1 ? '' : 's'} and ${deleted.deletedFiles} file${deleted.deletedFiles === 1 ? '' : 's'} removed`
              : undefined,
        })
      } catch (error) {
        toastError(error, 'Could not delete the folder')
      }
    },
    [reload],
  )

  const renameFile = useCallback(
    async (file: FileRow, name: string): Promise<boolean> => {
      try {
        await apiRenameFile(file.id, name)
        reload()
        return true
      } catch (error) {
        toastError(error, 'Could not rename the file')
        return false
      }
    },
    [reload],
  )

  const moveFile = useCallback(
    async (file: FileRow, destination: string | null): Promise<boolean> => {
      try {
        await apiMoveFile(file.id, destination)
        reload()
        return true
      } catch (error) {
        toastError(error, 'Could not move the file')
        return false
      }
    },
    [reload],
  )

  const removeFile = useCallback(
    async (file: FileRow): Promise<void> => {
      try {
        await apiDeleteFile(file.id)
        reload()
        toast.success(`Deleted "${file.name}"`)
      } catch (error) {
        toastError(error, 'Could not delete the file')
      }
    },
    [reload],
  )

  const isRoot = folderId === null

  return {
    loading,
    loadingMore,
    listing,
    folderId,
    ancestors: isRoot ? [] : listing.ancestors,
    search,
    setSearch,
    view,
    setView: setViewPersisted,
    openFolder,
    createFolder: create,
    renameFolder,
    removeFolder,
    renameFile,
    moveFile,
    removeFile,
    loadMore,
    reload,
  }
}