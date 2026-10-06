import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
import { Loader2 } from 'lucide-react'
import { useCurrentUser } from '@/hooks/use-current-user'

/**
 * Session gate for the app shell. Shows a neutral spinner while the session is
 * being resolved, then either renders the shell or bounces to /login — typing
 * /dashboard or /admin into the address bar must not reveal the app chrome.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { user, loading } = useCurrentUser()

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center" role="status" aria-label="Checking your session">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}
