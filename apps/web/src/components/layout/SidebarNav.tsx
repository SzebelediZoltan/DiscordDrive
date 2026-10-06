import { NavLink } from 'react-router'
import { LayoutDashboard, Settings, ShieldCheck } from 'lucide-react'
import type { SessionUser } from '@/hooks/use-current-user'
import { cn } from '@/lib/utils'

const baseLinks = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/settings', label: 'Settings', icon: Settings },
]

function linkClass(isActive: boolean) {
  return cn(
    'relative flex h-9 items-center gap-2.5 rounded-(--radius-control) px-3 text-sm text-muted outline-none transition-colors',
    'focus-visible:ring-2 focus-visible:ring-ring/60 hover:bg-sidebar-accent hover:text-ink',
    isActive && 'bg-sidebar-accent font-medium text-ink',
  )
}

export function SidebarNav({ user, onNavigate }: { user: SessionUser | null; onNavigate?: () => void }) {
  const links =
    user?.role === 'ADMIN' ? [...baseLinks, { to: '/admin', label: 'Admin', icon: ShieldCheck }] : baseLinks

  return (
    <nav className="flex flex-col gap-1" aria-label="Main">
      {links.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          onClick={onNavigate}
          className={({ isActive }) => linkClass(isActive)}
        >
          {({ isActive }) => (
            <>
              <Icon
                className={cn('size-4 shrink-0 transition-colors', isActive ? 'text-blurple-soft' : 'text-faint')}
                aria-hidden
              />
              <span>{label}</span>
              {isActive && (
                <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-blurple" />
              )}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}