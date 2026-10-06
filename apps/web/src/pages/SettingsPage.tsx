import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { ScreenshotPlaceholder } from '@/components/brand/ScreenshotPlaceholder'
import { useCurrentUser } from '@/hooks/use-current-user'

export function SettingsPage() {
  const { user } = useCurrentUser()

  return (
    <div className="space-y-8">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Profile, webhook destination and appearance live here.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Profile</h2>
        <div className="card-surface space-y-4 p-6">
          <div className="flex items-center gap-4">
            <div className="size-10 rounded-full bg-muted text-center text-sm font-medium leading-10 text-muted-foreground">
              {user?.displayName.slice(0, 1).toUpperCase() ?? '?'}
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">{user?.displayName ?? '—'}</p>
              <p className="truncate text-sm text-muted-foreground">{user?.email ?? 'Signed out'}</p>
            </div>
          </div>
          <p className="text-xs text-faint">
            Editing your display name and password ships with the account screens.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Discord destination</h2>
        <ScreenshotPlaceholder
          caption="[SCREENSHOT: Discord Server Settings -> Integrations -> Webhooks -> New Webhook]"
          className="max-w-2xl"
        />
        <p className="text-xs text-faint">
          The webhook onboarding wizard wires your Discord channel. Learn more in{' '}
          <Link to="/settings" className="inline-flex items-center gap-1 text-blurple-soft underline-offset-4 hover:underline">
            the guide
            <ArrowUpRight className="size-3" aria-hidden />
          </Link>
          .
        </p>
      </section>
    </div>
  )
}