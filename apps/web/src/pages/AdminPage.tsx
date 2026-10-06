import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Files, HardDrive, Loader2, ShieldCheck, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useCurrentUser } from '@/hooks/use-current-user'
import { formatBytes } from '@/lib/upload/queue'

type Tab = 'requests' | 'usage'

type WaitlistEntry = {
  id: string
  position: number
  status: string
  createdAt: string
  resolvedAt: string | null
  user: {
    id: string
    email: string
    displayName: string | null
    status: string
    role: string
    createdAt: string
  }
}

type WaitlistResponse = { entries: WaitlistEntry[]; nextCursor: string | null }

type UsageResponse = {
  totals: { users: number; files: number; storedBytes: string; webhooks: number }
  users: Array<{
    id: string
    email: string
    displayName: string | null
    role: string
    createdAt: string
    files: number
    storedBytes: string
    webhooks: number
  }>
}

type ApiErrorBody = { code?: string; message?: string; details?: unknown }

async function adminApi<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...(init?.method ? { headers: { 'Content-Type': 'application/json' } } : {}),
    ...init,
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) {
    const err = (body as ApiErrorBody | null) ?? {}
    throw new Error(err.message ?? `Request failed (${res.status})`)
  }
  return body as T
}

function formatStoredBytes(raw: string): string {
  try {
    return formatBytes(Number(BigInt(raw)))
  } catch {
    return raw
  }
}

function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="card-surface p-5">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <p className="text-sm font-medium">{label}</p>
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{value}</p>
    </div>
  )
}

export function AdminPage() {
  const { user } = useCurrentUser()
  const [tab, setTab] = useState<Tab>('requests')

  const [entries, setEntries] = useState<WaitlistEntry[] | null>(null)
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [booting, setBooting] = useState<Tab | null>('requests')
  const [actingId, setActingId] = useState<string | null>(null)

  useEffect(() => {
    if (user?.role !== 'ADMIN') return
    let cancelled = false
    setBooting(tab)

    const load = tab === 'requests'
      ? adminApi<WaitlistResponse>('/api/admin/waitlist?status=WAITING&limit=100')
      : adminApi<UsageResponse>('/api/admin/usage')

    load
      .then((data) => {
        if (cancelled) return
        if (tab === 'requests') setEntries((data as WaitlistResponse).entries)
        else setUsage(data as UsageResponse)
        setBooting(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setBooting(null)
        toast(error instanceof Error ? error.message : 'Loading failed')
      })

    return () => {
      cancelled = true
    }
  }, [tab, user?.role])

  async function decide(entry: WaitlistEntry, decision: 'approve' | 'reject') {
    setActingId(entry.id)
    try {
      await adminApi(`/api/admin/users/${entry.user.id}/${decision}`, { method: 'POST', body: '{}' })
      toast(`${entry.user.email} ${decision === 'approve' ? 'approved' : 'rejected'}`)
      setEntries((prev) => prev?.filter((e) => e.id !== entry.id) ?? prev)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Action failed'
      toast(message)
      if (/already resolved/i.test(message)) {
        setEntries((prev) => prev?.filter((e) => e.id !== entry.id) ?? prev)
      }
    } finally {
      setActingId(null)
    }
  }

  // RequireSession already guarantees a session; the role check still has to
  // hold for a `null` user so the admin UI can never render unauthenticated.
  if (!user || user.role !== 'ADMIN') {
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
        <p className="text-sm text-muted-foreground">Approve new accounts and monitor storage usage.</p>
      </header>

      <div className="flex gap-1" role="tablist" aria-label="Admin areas">
        <Button
          variant={tab === 'requests' ? 'secondary' : 'ghost'}
          size="sm"
          className="px-3"
          onClick={() => setTab('requests')}
          role="tab"
          aria-selected={tab === 'requests'}
        >
          Requests
        </Button>
        <Button
          variant={tab === 'usage' ? 'secondary' : 'ghost'}
          size="sm"
          className="px-3"
          onClick={() => setTab('usage')}
          role="tab"
          aria-selected={tab === 'usage'}
        >
          Usage
        </Button>
      </div>

      {tab === 'requests' ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Sign-up requests</h2>
          {booting === 'requests' ? (
            <div className="card-surface flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Loading requests…
            </div>
          ) : (entries?.length ?? 0) === 0 ? (
            <div className="card-surface flex flex-col items-center gap-3 p-10 text-center">
              <Check className="size-8 text-faint" aria-hidden />
              <p className="text-sm text-muted-foreground">No pending requests right now.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {entries?.map((entry) => (
                <li key={entry.id} className="card-surface flex items-center justify-between gap-4 p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="font-mono text-xs text-faint">#{entry.position}</span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">
                        {entry.user.displayName || entry.user.email}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {entry.user.email} · requested {new Date(entry.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive"
                      disabled={actingId === entry.id}
                      onClick={() => decide(entry, 'reject')}
                    >
                      {actingId === entry.id ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      ) : (
                        <X className="size-3.5" aria-hidden />
                      )}
                      Reject
                    </Button>
                    <Button size="sm" disabled={actingId === entry.id} onClick={() => decide(entry, 'approve')}>
                      {actingId === entry.id ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Check className="size-3.5" aria-hidden />
                      )}
                      Approve
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard icon={<Users className="size-4" aria-hidden />} label="Total users" value={usage?.totals.users.toLocaleString() ?? '—'} />
            <StatCard
              icon={<HardDrive className="size-4" aria-hidden />}
              label="Storage used"
              value={usage ? formatStoredBytes(usage.totals.storedBytes) : '—'}
            />
            <StatCard icon={<Files className="size-4" aria-hidden />} label="Files" value={usage?.totals.files.toLocaleString() ?? '—'} />
          </div>

          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Usage by user</h2>
            {booting === 'usage' ? (
              <div className="card-surface flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Loading usage…
              </div>
            ) : (usage?.users.length ?? 0) === 0 ? (
              <div className="card-surface flex flex-col items-center gap-3 p-10 text-center">
                <Users className="size-8 text-faint" aria-hidden />
                <p className="text-sm text-muted-foreground">No active users yet.</p>
              </div>
            ) : (
              <div className="card-surface overflow-hidden">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-5 py-3 text-xs font-medium text-muted-foreground sm:grid-cols-[minmax(0,1fr)_5rem_9rem_6rem]">
                  <p>User</p>
                  <p className="text-right">Files</p>
                  <p className="text-right">Storage</p>
                  <p className="hidden text-right sm:block">Webhooks</p>
                </div>
                <ul>
                  {usage?.users.map((row) => (
                    <li
                      key={row.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-t border-border px-5 py-3 sm:grid-cols-[minmax(0,1fr)_5rem_9rem_6rem]"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">{row.displayName || row.email}</p>
                        <p className="truncate text-xs text-muted-foreground">{row.email}</p>
                      </div>
                      <p className="text-right text-sm tabular-nums text-ink">{row.files.toLocaleString()}</p>
                      <p className="text-right text-sm tabular-nums text-ink">{formatStoredBytes(row.storedBytes)}</p>
                      <p className="hidden text-right text-sm tabular-nums text-muted-foreground sm:block">
                        {row.webhooks.toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}