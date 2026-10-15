import type { LucideIcon } from 'lucide-react'
import { FileSearch, FolderSearch, PlugZap } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Variant = 'empty' | 'search' | 'webhook'

const copy: Record<Variant, { icon: LucideIcon; title: string; hint: string; cta?: { label: string; href: string } }> = {
  empty: {
    icon: FolderSearch,
    title: 'Nothing here yet',
    hint: 'Drop files on the zone above, or create a folder to start organising.',
  },
  search: {
    icon: FileSearch,
    title: 'No matches',
    hint: 'Nothing in your storage matches that search. Try a different name or file type.',
  },
  webhook: {
    icon: PlugZap,
    title: 'No webhook connected',
    hint: 'Files are stored in a Discord webhook. Connect one in Settings before your first upload.',
    cta: { label: 'Open Settings', href: '/settings' },
  },
}

export function EmptyState({ variant }: { variant: Variant }) {
  const { icon: Icon, title, hint, cta } = copy[variant]
  return (
    <div className="card-surface flex flex-col items-center gap-3 px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted/60 text-blurple-soft">
        <Icon className="size-6" aria-hidden />
      </span>
      <div className="space-y-1">
        <h3 className="font-medium text-ink">{title}</h3>
        <p className="max-w-sm text-sm text-muted-foreground">{hint}</p>
      </div>
      {cta && (
        <Button asChild className="mt-1">
          <a href={cta.href}>{cta.label}</a>
        </Button>
      )}
    </div>
  )
}