import { FolderPlus, LayoutGrid, List, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface FilesToolbarProps {
  search: string
  onSearch: (value: string) => void
  view: 'grid' | 'list'
  onView: (view: 'grid' | 'list') => void
  onNewFolder: () => void
}

/** Search (debounced upstream), view toggle and the new-folder action. */
export function FilesToolbar({ search, onSearch, view, onView, onNewFolder }: FilesToolbarProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <label className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search files and types…"
          aria-label="Search files"
          className="h-9 w-full rounded-(--radius-control) border border-line bg-surface-raised pl-9 pr-3 text-sm text-ink outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      </label>

      <div className="flex items-center gap-2">
        <div className="inline-flex items-center rounded-(--radius-control) border border-line bg-surface-raised p-0.5" aria-label="View">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Grid view"
            aria-pressed={view === 'grid'}
            onClick={() => onView('grid')}
            className={cn(view === 'grid' && 'bg-muted text-ink')}
          >
            <LayoutGrid aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="List view"
            aria-pressed={view === 'list'}
            onClick={() => onView('list')}
            className={cn(view === 'list' && 'bg-muted text-ink')}
          >
            <List aria-hidden />
          </Button>
        </div>

        <Button type="button" onClick={onNewFolder}>
          <FolderPlus aria-hidden />
          New folder
        </Button>
      </div>
    </div>
  )
}