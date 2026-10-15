import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router'
import {
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  UserRound,
  Webhook,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PasswordHints } from '@/components/auth/PasswordHints'
import { useCurrentUser } from '@/hooks/use-current-user'
import { asApiError, changePassword, passwordChecks, updateProfile } from '@/lib/auth/api'
import type { AuthApiError } from '@/lib/auth/api'
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  testWebhook,
  updateWebhook,
} from '@/lib/onboarding/api'
import type { OnboardingWebhook, TestResult } from '@/lib/onboarding/api'

const WEBHOOK_RE = /^https:\/\/(?:discord(?:app)?\.com)\/api(?:\/v\d+)?\/webhooks\/\d{17,20}\/[A-Za-z0-9_.\-]+$/

function webhookUrlIssue(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'A webhook URL is required.'
  if (!/^https:/i.test(trimmed)) return 'A Discord webhook URL must start with https://.'
  if (!WEBHOOK_RE.test(trimmed))
    return 'That does not look like a webhook. It should be https://discord.com/api/webhooks/<id>/<token>.'
  return null
}

export function SettingsPage() {
  const { user, refresh } = useCurrentUser()

  // --- Profile: display name -------------------------------------------------
  const [displayName, setDisplayName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [nameError, setNameError] = useState<AuthApiError | null>(null)

  useEffect(() => setDisplayName(user?.displayName ?? ''), [user?.displayName])

  async function handleSaveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = displayName.trim()
    if (next === '') return
    setSavingName(true)
    setNameError(null)
    try {
      await updateProfile(next)
      await refresh()
      toast.success('Display name updated')
    } catch (error) {
      setNameError(asApiError(error))
    } finally {
      setSavingName(false)
    }
  }

  // --- Discord destination ----------------------------------------------------
  const [webhooks, setWebhooks] = useState<OnboardingWebhook[] | null>(null)
  const [webhookError, setWebhookError] = useState<AuthApiError | null>(null)
  const [testingActive, setTestingActive] = useState(false)
  const [activeTest, setActiveTest] = useState<TestResult | null>(null)

  const loadWebhooks = useCallback(async () => {
    try {
      const { webhooks: rows } = await listWebhooks()
      setWebhooks(rows)
      setWebhookError(null)
    } catch (error) {
      setWebhookError(asApiError(error))
    }
  }, [])

  useEffect(() => {
    void loadWebhooks()
  }, [loadWebhooks])

  const active = webhooks?.find((w) => w.isDefault) ?? webhooks?.[0] ?? null

  async function testActive() {
    if (!active) return
    setTestingActive(true)
    setActiveTest(null)
    try {
      setActiveTest(await testWebhook(active.id))
    } catch (error) {
      setActiveTest({ ok: false, message: asApiError(error).message })
    } finally {
      setTestingActive(false)
    }
  }

  // --- Change webhook dialog ---------------------------------------------------
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draftName, setDraftName] = useState('My Drive')
  const [draftUrl, setDraftUrl] = useState('')
  const [draftBotToken, setDraftBotToken] = useState('')
  const [draftTokenVisible, setDraftTokenVisible] = useState(false)
  const [testing, setTesting] = useState(false)
  const [applying, setApplying] = useState(false)
  const [draft, setDraft] = useState<OnboardingWebhook | null>(null)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [dialogError, setDialogError] = useState<AuthApiError | null>(null)
  const [botTokenDraft, setBotTokenDraft] = useState(false)

  const urlIssue = webhookUrlIssue(draftUrl)

  function openDialog() {
    setDraftName('My Drive')
    setDraftUrl('')
    setDraftBotToken('')
    setDraftTokenVisible(false)
    setDraft(null)
    setTestResult(null)
    setDialogError(null)
    setBotTokenDraft(false)
    setDialogOpen(true)
  }

  async function discardDraft() {
    const id = draft?.id
    if (!id) return
    setDraft(null)
    try {
      await deleteWebhook(id)
    } catch {
      /* best effort: a stranded untested webhook row would be dead weight on the list */
    }
  }

  async function handleTest() {
    if (urlIssue) return
    setTesting(true)
    setTestResult(null)
    setDialogError(null)
    try {
      await discardDraft()
      const { webhook: created } = await createWebhook({
        name: draftName.trim() || 'My Drive',
        url: draftUrl.trim(),
        botToken: draftBotToken.trim() || undefined,
        isDefault: false,
      })
      setDraft(created)
      const result = await testWebhook(created.id)
      setTestResult(result)
    } catch (error) {
      setDialogError(asApiError(error))
    } finally {
      setTesting(false)
    }
  }

  async function handleApply() {
    if (!draft || testResult?.ok !== true) return
    setApplying(true)
    setDialogError(null)
    try {
      const { webhook: chosen } = await updateWebhook(draft.id, { isDefault: true })
      setDraft(null)
      // Only the webhook the user is actually using stays on the account.
      for (const other of webhooks ?? []) {
        if (other.id === chosen.id) continue
        try {
          await deleteWebhook(other.id)
        } catch {
          /* the active switch is what matters; a leftover row can be cleaned up later */
        }
      }
      toast.success('Storage webhook changed')
      setDialogOpen(false)
      await loadWebhooks()
    } catch (error) {
      setDialogError(asApiError(error))
    } finally {
      setApplying(false)
    }
  }

  function handleCloseDialog(open: boolean) {
    if (!open) {
      void discardDraft()
      setDialogOpen(false)
    }
  }

  // --- Security: change password ----------------------------------------------
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [repeatPassword, setRepeatPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState<AuthApiError | null>(null)

  const checks = passwordChecks(newPassword)
  const passwordValid = checks.length && checks.lower && checks.upper && checks.digit
  const confirmMismatch = repeatPassword !== '' && repeatPassword !== newPassword

  async function handleChangePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPasswordError(null)
    setChangingPassword(true)
    try {
      await changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setRepeatPassword('')
      toast.success('Password changed')
    } catch (error) {
      setPasswordError(asApiError(error))
    } finally {
      setChangingPassword(false)
    }
  }

  return (
    <div className="space-y-8">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Settings</h1>
        <p className="text-sm text-muted-foreground">Profile, webhook destination and your password.</p>
      </header>

      {/* Profile */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Profile</h2>
        <div className="card-surface space-y-5 p-6">
          <div className="flex items-center gap-4">
            <div className="grid size-10 shrink-0 place-items-center rounded-full bg-blurple/10 font-mono text-sm font-semibold text-blurple-soft">
              {(user?.displayName ?? '?').slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">{user?.displayName ?? '—'}</p>
              <p className="truncate text-sm text-muted-foreground">{user?.email ?? 'Signed out'}</p>
            </div>
          </div>

          <form className="space-y-4" onSubmit={handleSaveName} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="display-name">Display name</Label>
              <Input
                id="display-name"
                autoComplete="name"
                maxLength={64}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            {nameError && (
              <p className="flex items-start gap-2 text-xs text-critical" role="alert">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {nameError.message}
              </p>
            )}
            <Button type="submit" size="sm" disabled={savingName || displayName.trim() === '' || displayName.trim() === (user?.displayName ?? '')}>
              {savingName ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
              {savingName ? 'Saving…' : 'Save'}
            </Button>
          </form>
        </div>
      </section>

      {/* Discord destination */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Discord destination</h2>
        <div className="card-surface space-y-5 p-6">
          {webhooks === null ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Reading your webhook…
            </div>
          ) : webhookError ? (
            <div className="space-y-3">
              <p className="flex items-start gap-2 text-sm text-critical" role="alert">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {webhookError.message}
              </p>
              <Button size="sm" variant="secondary" onClick={() => void loadWebhooks()}>
                <RefreshCw className="size-4" aria-hidden />
                Try again
              </Button>
            </div>
          ) : active ? (
            <>
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-(--radius-control) border border-line bg-surface-raised text-blurple-soft">
                    <Webhook className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{active.name}</p>
                    <p className="mt-0.5 truncate font-mono text-xs text-faint">
                      {active.urlHint.hint}
                      <span className="text-ink/70">{active.urlHint.last4}</span>
                    </p>
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.65rem] text-faint">
                      {active.channelId && <span>channel …{active.channelId.slice(-6)}</span>}
                      {active.hasBotToken && <span>bot …{active.botTokenLast4}</span>}
                      {active.lastTestStatus && active.lastTestStatus !== 'UNKNOWN' && (
                        <span className={active.lastTestStatus === 'OK' ? 'text-positive' : 'text-caution'}>
                          last test {active.lastTestStatus.toLowerCase()}
                        </span>
                      )}
                    </p>
                    {active.lastTestError && (
                      <p className="mt-1 truncate text-xs text-caution">{active.lastTestError}</p>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => void testActive()} disabled={testingActive}>
                    {testingActive ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
                    Test
                  </Button>
                  <Button size="sm" onClick={openDialog}>
                    Change
                  </Button>
                </div>
              </div>

              {activeTest && <TestResultInline result={activeTest} />}

              <p className="text-xs text-faint">
                Uploads post to a private webhook — the pieces never show up in your channel chat. To move your drive to
                a different channel or server, change the webhook.
              </p>
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                No webhook yet. Run the setup guide to point DiscordDrive at a channel, then come back here.
              </p>
              <Link to="/onboarding?again=1" className="inline-flex items-center gap-2 text-sm font-medium text-blurple-soft underline-offset-4 hover:underline">
                Run the setup guide
                <ArrowUpRight className="size-4" aria-hidden />
              </Link>
            </div>
          )}

          <div className="border-t border-line pt-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-ink">Setup guide</p>
                <p className="text-xs text-faint">Walk through the Discord steps again whenever you need a refresher.</p>
              </div>
              <Button asChild size="sm" variant="secondary">
                <Link to="/onboarding?again=1">
                  <UserRound className="size-4" aria-hidden />
                  Redo the guide
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Security */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Security</h2>
        <div className="card-surface space-y-5 p-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-(--radius-control) border border-line bg-surface-raised text-blurple-soft">
              <KeyRound className="size-4" aria-hidden />
            </span>
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-ink">Change password</p>
              <p className="text-xs text-muted-foreground">
                Choose a unique password you do not use anywhere else.
              </p>
            </div>
          </div>

          <form className="space-y-4" onSubmit={handleChangePassword} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                aria-invalid={newPassword !== '' && !passwordValid}
              />
              {newPassword !== '' && <PasswordHints password={newPassword} />}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="repeat-password">Repeat new password</Label>
              <Input
                id="repeat-password"
                type="password"
                autoComplete="new-password"
                value={repeatPassword}
                onChange={(e) => setRepeatPassword(e.target.value)}
                aria-invalid={confirmMismatch}
              />
              {confirmMismatch && (
                <p className="text-xs text-critical" role="alert">
                  Passwords do not match
                </p>
              )}
            </div>

            {passwordError && (
              <p className="flex items-start gap-2 text-xs text-critical" role="alert">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {passwordError.message}
              </p>
            )}

            <Button
              type="submit"
              size="sm"
              disabled={
                changingPassword ||
                currentPassword === '' ||
                newPassword === '' ||
                repeatPassword === '' ||
                !passwordValid ||
                confirmMismatch
              }
            >
              {changingPassword ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
              {changingPassword ? 'Changing…' : 'Change password'}
            </Button>
          </form>
        </div>
      </section>

      {/* Change webhook dialog */}
      <Dialog open={dialogOpen} onOpenChange={handleCloseDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change storage webhook</DialogTitle>
            <DialogDescription>
              Paste a webhook URL from Discord, test it, and it replaces your current destination.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="webhook-name">Webhook name</Label>
              <Input
                id="webhook-name"
                maxLength={64}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
              />
              <p className="text-xs text-faint">Shown in your Discord chat when a test message lands.</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="webhook-url">Webhook URL</Label>
              <Input
                id="webhook-url"
                spellCheck={false}
                autoComplete="off"
                placeholder="https://discord.com/api/webhooks/…"
                value={draftUrl}
                onChange={(e) => {
                  setDraftUrl(e.target.value)
                  setDialogError(null)
                }}
                aria-invalid={urlIssue !== null}
              />
              {urlIssue && (
                <p className="text-xs text-caution" role="alert">
                  {urlIssue}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setBotTokenDraft((v) => !v)}
                className="text-xs font-medium text-blurple-soft underline-offset-4 hover:underline"
              >
                {botTokenDraft ? 'Remove bot token step' : 'Attach a bot token (optional)'}
              </button>
            </div>

            {botTokenDraft && (
              <div className="space-y-1.5">
                <Label htmlFor="webhook-token">Bot token</Label>
                <div className="relative">
                  <Input
                    id="webhook-token"
                    type={draftTokenVisible ? 'text' : 'password'}
                    autoComplete="off"
                    className="pr-10 font-mono"
                    placeholder="Nzkzhj…"
                    value={draftBotToken}
                    onChange={(e) => setDraftBotToken(e.target.value)}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setDraftTokenVisible((v) => !v)}
                    className="absolute inset-y-0 right-0 grid w-10 place-items-center text-faint hover:text-ink"
                    aria-label={draftTokenVisible ? 'Hide token' : 'Show token'}
                  >
                    {draftTokenVisible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                  </button>
                </div>
              </div>
            )}

            {dialogError && (
              <p className="flex items-start gap-2 text-xs text-critical" role="alert">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {dialogError.message}
              </p>
            )}

            {testResult && <TestResultInline result={testResult} />}
          </div>

          <DialogFooter className="grid-cols-2 sm:justify-between">
            {testResult?.ok === true ? (
              <Button onClick={() => void handleApply()} disabled={applying} className="col-span-full">
                {applying ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CircleCheck className="size-4" aria-hidden />}
                {applying ? 'Switching…' : 'Use this webhook'}
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => void handleTest()} disabled={testing || !!urlIssue} className="col-span-full">
                {testing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CircleSlash className="size-4" aria-hidden />}
                {testing ? 'Sending test message…' : 'Test webhook'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TestResultInline({ result }: { result: TestResult }) {
  if (result.ok) {
    return (
      <div className="flex items-start gap-3 rounded-(--radius-control) border border-positive/30 bg-positive/5 p-3 text-sm">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium text-ink">Connected — a message landed in your channel</p>
          {result.latencyMs !== undefined && <p className="mt-1 text-xs text-faint">Round-trip in {result.latencyMs}ms.</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-3 rounded-(--radius-control) border border-caution/40 bg-caution/5 p-3 text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium text-ink">{result.message ?? 'That webhook could not be reached.'}</p>
        <p className="mt-1 text-xs text-caution">Check the URL and try again.</p>
      </div>
    </div>
  )
}