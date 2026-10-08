import { useEffect, useState } from 'react'
import { Check, Copy, Link2, Loader2, Lock, Search, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  getShareState,
  searchUsers,
  setShareState,
  shareLinkUrl,
  type FileRow,
  type ShareGrantee,
  type ShareMode,
} from '@/lib/files/api'
import { cn } from '@/lib/utils'

interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Reload the listing after a successful save so the row's share mode is fresh. */
  onSaved?: () => void
  file: FileRow
}

interface ModeChoice {
  mode: ShareMode
  title: string
  description: string
  icon: typeof Lock
}

const MODES: ModeChoice[] = [
  { mode: 'RESTRICTED', title: 'Only you', description: 'Nobody else can open this file.', icon: Lock },
  {
    mode: 'LINK',
    title: 'Anyone with the link',
    description: 'Anyone holding the link can download it, without an account.',
    icon: Link2,
  },
  {
    mode: 'SPECIFIC',
    title: 'People in DiscordDrive',
    description: 'Only the accounts you pick, shown in their own drive.',
    icon: Users,
  },
]

/** Delimits the ~0.2 s autocomplete debounce the search route expects. */
const SEARCH_DEBOUNCE_MS = 200

/**
 * The share dialog: Google-Drive-style mode cards (private / link / specific accounts), a
 * recipient autocomplete for SPECIFIC (debounced, accounts only, self never returned) and,
 * once link sharing is on, a copyable URL — the one value everyone opened the dialog for.
 * Saving keeps the dialog open so copy-link is reachable in one flow.
 */
export function ShareDialog({ open, onOpenChange, onSaved, file }: ShareDialogProps) {
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<ShareMode>('RESTRICTED')
  const [token, setToken] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [saved, setSaved] = useState<{ mode: ShareMode; emails: string[] }>({ mode: 'RESTRICTED', emails: [] })
  const [query, setQuery] = useState('')

  const [results, setResults] = useState<ShareGrantee[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)

  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  const dirty =
    mode !== saved.mode ||
    (mode === 'SPECIFIC' && !sameEmails(saved.emails, selected))

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setSelected([])
    setToken(null)
    setResults([])
    setQuery('')
    setCopied(false)
    getShareState(file.id)
      .then(({ share }) => {
        if (cancelled) return
        const grantees = share.grantees.map((grantee) => grantee.email)
        setMode(share.mode)
        setToken(share.token)
        setSelected(grantees)
        setSaved({ mode: share.mode, emails: grantees })
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Could not load share settings')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, file.id])

  // The autocomplete is a 200 ms debounced server search, scoped to ACTIVE accounts.
  useEffect(() => {
    if (!open || mode !== 'SPECIFIC') return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults([])
      setSearching(false)
      setSearchError(false)
      return
    }
    setSearching(true)
    setSearchError(false)
    const timer = setTimeout(() => {
      searchUsers(trimmed)
        .then(({ users }) => {
          setResults(users.filter((user) => !selected.includes(user.email)))
        })
        .catch(() => setSearchError(true))
        .finally(() => setSearching(false))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, mode, query, selected])

  function toggleSelected(email: string) {
    setSelected((current) =>
      current.includes(email) ? current.filter((e) => e !== email) : [...current, email],
    )
  }

  async function save() {
    setSaving(true)
    try {
      const { share } = await setShareState(file.id, mode, mode === 'SPECIFIC' ? selected : [])
      setToken(share.token)
      // The server re-matches emails, so the authoritative grant list comes back from it.
      const grantees = share.grantees.map((grantee) => grantee.email)
      setSelected(grantees)
      setSaved({ mode: share.mode, emails: grantees })
      toast.success('Share settings saved')
      onSaved?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save share settings')
    } finally {
      setSaving(false)
    }
  }

  async function copyLink() {
    if (!token) return
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${shareLinkUrl(token)}`)
      setCopied(true)
      toast.success('Share link copied')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy the link')
    }
  }

  const shareUrl = token ? `${window.location.origin}${shareLinkUrl(token)}` : ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share “{file.name}”</DialogTitle>
          <DialogDescription>Choose who can open this file. Recipients get read-only access.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div role="radiogroup" aria-label="Who can access" className="grid gap-2">
              {MODES.map((choice) => (
                <button
                  key={choice.mode}
                  type="button"
                  role="radio"
                  aria-checked={mode === choice.mode}
                  onClick={() => setMode(choice.mode)}
                  className={cn(
                    'flex items-start gap-3 rounded-(--radius-control) border p-3 text-left outline-none transition-colors',
                    mode === choice.mode
                      ? 'border-blurple bg-blurple/5 ring-1 ring-blurple/40'
                      : 'border-line hover:bg-muted/50 focus-visible:bg-muted',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                      mode === choice.mode ? 'border-blurple' : 'border-line',
                    )}
                    aria-hidden
                  >
                    {mode === choice.mode && <span className="size-2 rounded-full bg-blurple" />}
                  </span>
                  <choice.icon
                    className={cn('mt-0.5 size-4 shrink-0', mode === choice.mode ? 'text-blurple' : 'text-muted-foreground')}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">{choice.title}</span>
                    <span className="block text-xs text-muted-foreground">{choice.description}</span>
                  </span>
                </button>
              ))}
            </div>

            {mode === 'LINK' &&
              (token ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Link</p>
                  <div className="flex gap-2">
                    <Input value={shareUrl} readOnly aria-label="Share link" className="font-mono text-xs" />
                    <Button type="button" variant="outline" size="sm" onClick={() => void copyLink()}>
                      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Anyone with this link can download the file. Turning link sharing off revokes it.
                  </p>
                </div>
              ) : (
                <p className="rounded-(--radius-control) border border-dashed border-line p-3 text-xs text-muted-foreground">
                  Save to turn on link sharing — the link appears here afterwards.
                </p>
              ))}

            {mode === 'SPECIFIC' && (
              <div className="space-y-3">
                {selected.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5">
                    {selected.map((email) => (
                      <li key={email}>
                        <span className="inline-flex items-center gap-1 rounded-full border border-line bg-muted/60 px-2.5 py-1 text-xs text-ink">
                          {email}
                          <button
                            type="button"
                            aria-label={`Remove ${email}`}
                            onClick={() => toggleSelected(email)}
                            className="text-muted-foreground outline-none hover:text-destructive focus-visible:underline"
                          >
                            ×
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      const exact = results.find((user) => user.email === query.trim())
                      if (event.key === 'Enter' && exact) {
                        event.preventDefault()
                        toggleSelected(exact.email)
                        setQuery('')
                      }
                    }}
                    placeholder="Search people by name or email…"
                    className="pl-8"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {query.trim().length >= 2 && (
                    <div className="absolute top-full z-10 mt-1 w-full overflow-hidden rounded-(--radius-control) border border-line bg-popover shadow-sm">
                      {searching ? (
                        <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" aria-hidden />
                          Searching…
                        </p>
                      ) : searchError ? (
                        <p className="px-3 py-2 text-xs text-destructive">Search failed</p>
                      ) : results.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-muted-foreground">
                          No matching accounts. Only registered DiscordDrive users can be added.
                        </p>
                      ) : (
                        <ul className="max-h-44 overflow-y-auto py-1">
                          {results.map((user) => (
                            <li key={user.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  toggleSelected(user.email)
                                  setQuery('')
                                }}
                                className={cn(
                                  'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm outline-none',
                                  'hover:bg-muted focus-visible:bg-muted',
                                )}
                              >
                                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.65rem] font-medium text-muted-foreground">
                                  {(user.displayName || user.email)[0]?.toUpperCase()}
                                </span>
                                <span className="min-w-0">
                                  <span className="block truncate text-ink">{user.displayName || user.email}</span>
                                  <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {selected.length === 0
                    ? 'Pick at least one account to share with.'
                    : `${selected.length} account${selected.length === 1 ? '' : 's'} can open this file.`}
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button type="button" disabled={!dirty || saving || loading} onClick={() => void save()}>
            {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {saving ? 'Saving…' : dirty ? 'Save' : 'Done'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Compare two email lists as sets — the server dedupes and reorders them after each save. */
function sameEmails(a: string[], b: string[]): boolean {
  const key = (list: string[]) => [...new Set(list.map((email) => email.toLowerCase()))].sort().join('|')
  return key(a) === key(b)
}