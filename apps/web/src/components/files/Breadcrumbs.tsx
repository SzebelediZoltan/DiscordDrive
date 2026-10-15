import { ChevronRight, Home } from 'lucide-react'
import { cn } from '@/lib/utils'

interface BreadcrumbsProps {
  /** The ancestor chain for the open folder, root first; the last entry is the open folder. */
  ancestors: { id: string; name: string }[]
  onNavigate: (folderId: string | null) => void
}

/** Folder breadcrumbs. The chain comes from the backend, so it is correct at any depth. */
export function Breadcrumbs({ ancestors, onNavigate }: BreadcrumbsProps) {
  const crumbs = [{ id: null, name: 'My files' }, ...ancestors] as { id: string | null; name: string }[]

  return (
    <nav aria-label="Folders" className="flex min-w-0 items-center gap-1 text-sm">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1
        const id = crumb.id
        return (
          <span key={id ?? 'root'} className="flex min-w-0 items-center gap-1">
            {!isLast && (
              <button
                type="button"
                onClick={() => onNavigate(id)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground outline-none transition-colors',
                  'hover:bg-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60',
                )}
              >
                {id === null && <Home className="size-3.5" aria-hidden />}
                <span className="max-w-48 truncate">{crumb.name}</span>
              </button>
            )}
            {isLast && (
              <span
                aria-current="page"
                className="inline-flex max-w-56 items-center gap-1 truncate px-1.5 py-1 font-medium text-ink"
              >
                {crumb.name}
              </span>
            )}
            {!isLast && <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />}
          </span>
        )
      })}
    </nav>
  )
}