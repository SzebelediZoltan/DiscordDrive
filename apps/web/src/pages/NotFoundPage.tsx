import { Link } from 'react-router'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="font-mono text-sm text-faint">404</p>
      <h1 className="text-xl font-semibold tracking-tight text-ink">Page not found</h1>
      <p className="max-w-xs text-sm text-muted">That route does not exist inside DiscordDrive.</p>
      <Button asChild variant="secondary">
        <Link to="/dashboard">Back to your files</Link>
      </Button>
    </div>
  )
}