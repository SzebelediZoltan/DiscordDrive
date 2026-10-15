import { Navigate, useSearchParams } from 'react-router'
import { Loader2 } from 'lucide-react'
import { useCurrentUser } from '@/hooks/use-current-user'
import { OnboardingPage } from '@/pages/OnboardingPage'

/**
 * Gate for the /onboarding route, which lives outside the app shell on purpose: the
 * wizard is a full-screen experience with no sidebar chrome. Admins never enter the
 * wizard (they predate onboarding), and anyone who already finished it is bounced back
 * to the dashboard — a completed wizard must not be replays. `?again=1` opts into a
 * replay (the Settings "Redo the setup guide" link), bypassing the completion redirect.
 */
export function OnboardingGate() {
  const { user, loading } = useCurrentUser()
  const [searchParams] = useSearchParams()
  const replay = searchParams.get('again') === '1'

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center" role="status" aria-label="Checking your session">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  if (!replay && (user.role === 'ADMIN' || user.onboardingComplete)) return <Navigate to="/dashboard" replace />
  return <OnboardingPage user={user} />
}