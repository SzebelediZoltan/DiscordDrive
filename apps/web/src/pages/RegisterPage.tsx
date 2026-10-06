import { Button } from '@/components/ui/button'
import { Logo } from '@/components/brand/Logo'

export function RegisterPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-16">
      <Logo withWordmark={false} />
      <div className="card-surface w-full max-w-sm space-y-3 p-8 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Join DiscordDrive</h1>
        <p className="text-sm leading-relaxed text-muted">
          New accounts need an admin to approve them before they can sign in. The registration flow lands with the account screens.
        </p>
        <Button asChild variant="secondary" className="mt-2 w-full">
          <a href="/login">Back to sign in</a>
        </Button>
      </div>
    </div>
  )
}