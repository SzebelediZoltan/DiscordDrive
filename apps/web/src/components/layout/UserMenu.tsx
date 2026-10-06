import { Link } from 'react-router'
import { ChevronsUpDown, LogIn, LogOut, Settings } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import type { SessionUser } from '@/hooks/use-current-user'
import { cn } from '@/lib/utils'

interface UserMenuProps {
  user: SessionUser | null
  loading: boolean
  onRefresh: () => Promise<void>
  className?: string
}

function initialsOf(user: SessionUser): string {
  return user.displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
}

export function UserMenu({ user, loading, onRefresh, className }: UserMenuProps) {
  if (loading) {
    return (
      <div className={cn('flex items-center gap-2.5', className)}>
        <Skeleton className="size-8 shrink-0 rounded-full" />
        <div className="hidden min-w-0 flex-1 space-y-1.5 sm:block">
          <Skeleton className="h-3.5 w-28 rounded-full" />
          <Skeleton className="h-3 w-20 rounded-full" />
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className={cn('flex w-full items-center justify-between gap-2 rounded-(--radius-control) px-2 py-2', className)}>
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar className="size-8">
            <AvatarFallback className="bg-muted text-muted-foreground">?</AvatarFallback>
          </Avatar>
          <div className="hidden min-w-0 sm:block">
            <p className="truncate text-sm text-muted">Not signed in</p>
          </div>
        </div>
        <Button asChild size="sm" variant="secondary">
          <Link to="/login">
            <LogIn className="size-3.5" aria-hidden />
            Sign in
          </Link>
        </Button>
      </div>
    )
  }

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } finally {
      await onRefresh()
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2.5 rounded-(--radius-control) p-2 text-left outline-none transition-colors',
            'hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/60',
            className,
          )}
        >
          <Avatar className="size-8">
            <AvatarImage src="/brand/icon.png" alt="" />
            <AvatarFallback>{initialsOf(user)}</AvatarFallback>
          </Avatar>
          <span className="hidden min-w-0 flex-1 sm:block">
            <span className="block truncate text-sm font-medium text-ink">{user.displayName}</span>
            <span className="block truncate text-xs text-muted">{user.email}</span>
          </span>
          <ChevronsUpDown className="hidden size-3.5 shrink-0 text-faint sm:block" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <span className="block truncate text-sm text-muted">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings className="size-4" aria-hidden />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void handleLogout()}>
          <LogOut className="size-4" aria-hidden />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}