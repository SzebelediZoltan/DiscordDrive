import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { LockKeyhole, RefreshCw, Server } from 'lucide-react'
import { Logo } from '@/components/brand/Logo'
import { waitlistCount } from '@/lib/auth/api'
import { cn } from '@/lib/utils'

/**
 * Split-screen auth frame. The left brand panel is the storytelling half — a live,
 * honest counter of people waiting — and the form lives on the right with breathing
 * room. On phones the panel collapses to a compact strip above the card.
 */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,42rem)_minmax(0,1fr)]">
      <BrandPanel />

      <main className="flex flex-col justify-center px-5 py-12 sm:px-10 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Logo />
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}

const FEATURES = [
  { index: '01', Icon: Server, title: 'Backed by Discord', copy: 'Every file is sliced into chunks and stored in a webhook you control.' },
  { index: '02', Icon: RefreshCw, title: 'Resume anywhere', copy: 'Close the tab mid-upload; the queue rebuilds itself on your next visit.' },
  { index: '03', Icon: LockKeyhole, title: 'Yours, not ours', copy: 'No third-party blob store. The server only ever sees your Discord.' },
] as const

function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden border-r border-line bg-surface/40 lg:flex lg:flex-col lg:justify-between lg:p-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--color-line)_0.6px,transparent_0.6px)] [background-size:22px_22px] opacity-30 [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
      />

      <div className="relative">
        <Logo />
      </div>

      <div className="relative max-w-md space-y-8">
        <h1 className="text-4xl font-semibold leading-tight tracking-tight text-ink">
          Your files, parked in a{' '}
          <span className="bg-linear-to-r from-blurple-soft to-violet bg-clip-text text-transparent">Discord webhook</span>.
        </h1>

        <LiveWaitingCard />

        <ul className="space-y-5">
          {FEATURES.map(({ index, Icon, title, copy }) => (
            <li key={index} className="flex gap-4">
              <span className="relative mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-(--radius-control) border border-line bg-surface-raised text-blurple-soft">
                <Icon className="size-4" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-medium text-ink">
                  <span className="mr-2 font-mono text-xs text-faint">{index}</span>
                  {title}
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{copy}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative font-mono text-xs text-faint">DISCORDDRIVE · STATUS: LIVE</p>
    </aside>
  )
}

/**
 * The honest counter: polls the real public waitlist count and animates the digit as it
 * changes. "No fake urgency counters" — this is the server's number, verbatim.
 */
export function LiveWaitingCard({ compact = false, className }: { compact?: boolean; className?: string }) {
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    const tick = () =>
      waitlistCount()
        .then(({ waitingCount }) => {
          if (alive) setCount(waitingCount)
        })
        .catch(() => {
          /* keep the last known number; the pill reads `—` when none ever arrived */
        })
    void tick()
    const timer = setInterval(tick, 10_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const label = count === null ? null : `${count} person${count === 1 ? '' : 's'} before you`
  const digits = count?.toLocaleString() ?? '—'

  if (compact) {
    return (
      <div
        className={cn(
          'inline-flex items-center gap-2 rounded-full border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-muted-foreground',
          className,
        )}
      >
        <span className="relative flex size-2" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-positive opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-positive" />
        </span>
        Live · {digits} waiting
      </div>
    )
  }

  return (
    <div className="relative flex items-center gap-5 overflow-hidden rounded-(--radius-card) border border-line bg-surface p-5">
      <div className="font-mono text-5xl font-semibold tabular-nums tracking-tight text-ink">{digits}</div>
      <div className="min-w-0 space-y-1">
        <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span className="relative flex size-2" aria-hidden>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-positive opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-positive" />
          </span>
          {count === null ? 'Syncing…' : label}
        </p>
        <p className="text-xs text-faint">Access is granted by an administrator.</p>
      </div>
    </div>
  )
}

/** Tiny live pill used above the registration form. */
export function LiveWaitingPill({ className }: { className?: string }) {
  return <LiveWaitingCard compact className={className} />
}