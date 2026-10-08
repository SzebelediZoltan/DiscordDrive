import { useEffect, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { Check, Loader2, RefreshCw } from 'lucide-react'
import { AuthFrame } from '@/components/auth/AuthFrame'
import { Button } from '@/components/ui/button'
import { useCurrentUser } from '@/hooks/use-current-user'
import { waitlistStatus, type WaitlistSnapshot } from '@/lib/auth/api'

/**
 * The queue ticket. Hooked to the real /api/waitlist/status, so the number on screen is
 * the exact number the server assigned at registration — the counter and the API can
 * never disagree because there is only one source.
 */
export function WaitlistPage() {
  const [searchParams] = useSearchParams()
  const email = (searchParams.get('email') ?? '').trim().toLowerCase()

  const { user, refresh, loading: sessionLoading } = useCurrentUser()

  const [snapshot, setSnapshot] = useState<WaitlistSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    if (!email) return
    let alive = true
    const tick = () =>
      waitlistStatus(email)
        .then((data) => {
          if (!alive) return
          setSnapshot(data)
          setError(null)
          if (data.position === null) setResolved(true)
        })
        .catch(() => {
          if (alive) setError('Could not reach the queue right now.')
        })
    void tick()
    const timer = setInterval(tick, 15_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [email])

  // The moment an admin approves, the snapshot reports no position. Re-read the session
  // once so the "cleared" state can hand straight to the app when possible.
  useEffect(() => {
    if (resolved) void refresh()
  }, [resolved, refresh])

  // A freshly approved user still has a working session cookie after the queue clears;
  // bounce to the dashboard, whose onboarding gate (issue #11) sends them onward.
  if (user) return <Navigate to="/dashboard" replace />

  if (!email) {
    return (
      <AuthFrame>
        <NoEmail />
      </AuthFrame>
    )
  }

  return (
    <AuthFrame excludeSelf>
      <div className="space-y-6">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Your spot is saved</h1>
          <p className="text-sm text-muted-foreground">
            We keep the number exact — an administrator reviews requests in order.
          </p>
        </div>

        {error && !snapshot && (
          <div className="rounded-(--radius-control) bg-critical/10 px-3 py-2 text-sm text-critical" role="alert">
            {error}
          </div>
        )}

        {snapshot === null && !error ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {sessionLoading ? 'Checking your session…' : 'Reading your place in line…'}
          </div>
        ) : resolved ? (
          <Resolved />
        ) : snapshot && snapshot.position !== null ? (
          <QueueTicket
            position={snapshot.position}
            waitingCount={snapshot.waitingCount}
            email={email}
            onRefresh={() => void refresh()}
          />
        ) : (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Reading your place in line…
          </div>
        )}
      </div>
    </AuthFrame>
  )
}

function QueueTicket({
  position,
  waitingCount,
  email,
  onRefresh,
}: {
  position: number
  waitingCount: number
  email: string
  onRefresh: () => void
}) {
  // The count the server assigns includes the viewer's own reservation, so the ticket
  // reports how many others are actually ahead: total minus the seat you are standing in.
  const othersWaiting = Math.max(0, waitingCount - 1)

  return (
    <div className="relative">
      {/* Perforation notches: the canvas circles that make the card read as a ticket stub. */}
      <span aria-hidden className="absolute -left-2 top-14 size-4 rounded-full bg-canvas ring-1 ring-line" />
      <span aria-hidden className="absolute -right-2 top-14 size-4 rounded-full bg-canvas ring-1 ring-line" />

      <div className="card-surface overflow-hidden">
        <div className="space-y-1 border-b border-dashed border-line px-6 py-4">
          <p className="font-mono text-[0.65rem] font-medium uppercase tracking-[0.2em] text-blurple-soft">
            Reserved seat
          </p>
          <p className="text-xs text-muted-foreground">{email}</p>
        </div>

        <div className="px-6 py-6">
          <p className="font-mono text-6xl font-semibold tabular-nums tracking-tight text-ink">
            #{position.toLocaleString()}
          </p>
          <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <span className="relative flex size-2" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-caution opacity-70" />
              <span className="relative inline-flex size-2 rounded-full bg-caution" />
            </span>
            {othersWaiting > 0
              ? `${othersWaiting} person${othersWaiting === 1 ? '' : 's'} waiting`
              : 'You are next in line'}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-dashed border-line bg-surface-raised/60 px-6 py-3">
          <p className="text-xs text-faint">Updates on their own every few seconds.</p>
          <Button variant="ghost" size="xs" onClick={onRefresh}>
            <RefreshCw aria-hidden />
            Refresh
          </Button>
        </div>
      </div>
    </div>
  )
}

function Resolved() {
  return (
    <div className="card-surface space-y-4 p-8 text-center">
      <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-positive/10 text-positive">
        <Check className="size-6" aria-hidden />
      </span>
      <div className="space-y-1">
        <h2 className="font-medium text-ink">You’re cleared</h2>
        <p className="text-sm text-muted-foreground">
          Your spot came up. Sign in and set up your storage webhook — it takes about a minute.
        </p>
      </div>
      <Button asChild className="w-full">
        <Link to="/login">Sign in</Link>
      </Button>
    </div>
  )
}

function NoEmail() {
  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">We don’t know who you are</h1>
        <p className="text-sm text-muted-foreground">
          The queue page needs the email you registered with. If you haven’t registered yet, start there.
        </p>
      </div>
      <Button asChild className="w-full">
        <Link to="/register">Create an account</Link>
      </Button>
    </div>
  )
}