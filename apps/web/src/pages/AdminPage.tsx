import { ShieldCheck } from 'lucide-react'
import { ScreenshotPlaceholder } from '@/components/brand/ScreenshotPlaceholder'
import { useCurrentUser } from '@/hooks/use-current-user'

export function AdminPage() {
  const { user } = useCurrentUser()

  if (user && user.role !== 'ADMIN') {
    return (
      <div className="space-y-8">
        <header className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Admin</h1>
          <p className="text-sm text-muted-foreground">Administrator area.</p>
        </header>
        <div className="card-surface flex flex-col items-center gap-3 p-10 text-center">
          <ShieldCheck className="size-8 text-faint" aria-hidden />
          <p className="text-sm text-muted-foreground">This area is restricted to admins.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Admin</h1>
        <p className="text-sm text-muted-foreground">Manage approvals, accounts and storage.</p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Approvals</h2>
        <ScreenshotPlaceholder caption="[SCREENSHOT: Admin — pending account approvals with Approve / Reject actions]" />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Overview</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {['Users', 'Storage used', 'Webhooks'].map((label) => (
            <div key={label} className="card-surface p-5">
              <p className="text-sm font-medium text-ink">{label}</p>
              <p className="mt-1 text-xs text-faint">Waiting on the admin dashboard work.</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}