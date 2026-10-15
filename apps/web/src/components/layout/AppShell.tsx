import { Outlet } from 'react-router'
import { Logo } from '@/components/brand/Logo'
import { MobileNav } from '@/components/layout/MobileNav'
import { SidebarNav } from '@/components/layout/SidebarNav'
import { UserMenu } from '@/components/layout/UserMenu'
import { useCurrentUser } from '@/hooks/use-current-user'

export function AppShell() {
  const { user, loading, refresh } = useCurrentUser()

  return (
    <div className="min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-sidebar lg:flex">
        <div className="flex h-16 items-center border-b border-border px-5">
          <Logo />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SidebarNav user={user} />
        </div>
        <div className="border-t border-border p-2">
          <UserMenu user={user} loading={loading} onRefresh={refresh} />
        </div>
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-border bg-canvas/85 px-4 backdrop-blur lg:hidden">
          <MobileNav user={user} />
          <Logo />
          <div className="ml-auto">
            <UserMenu user={user} loading={loading} onRefresh={refresh} />
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}