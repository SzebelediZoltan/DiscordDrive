import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  CircleCheck,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LogOut,
  PlugZap,
  RefreshCw,
  Sparkles,
  UserRound,
  Webhook,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import { Logo } from '@/components/brand/Logo'
import { ScreenshotPlaceholder } from '@/components/brand/ScreenshotPlaceholder'
import { Button } from '@/components/ui/button'
import type { SessionUser } from '@/hooks/use-current-user'
import { useCurrentUser } from '@/hooks/use-current-user'
import { asApiError, isSessionLost, logout } from '@/lib/onboarding/api'
import type { AuthApiError } from '@/lib/onboarding/api'
import {
  completeOnboarding,
  createWebhook,
  listWebhooks,
  testWebhook,
  updateWebhook,
} from '@/lib/onboarding/api'
import type { OnboardingWebhook, TestResult } from '@/lib/onboarding/api'
import { clearProgress, readProgress, writeProgress } from '@/lib/onboarding/progress'
import { cn } from '@/lib/utils'

const STEPS = [
  {
    label: 'Server',
    title: 'Create a dedicated server',
    caption: '[SCREENSHOT: Discord — "Create Your Server" menu]',
    copy: 'Fresher Discord servers make a Neat home for your files. A single-purpose server keeps uploads out of your community channels.',
  },
  {
    label: 'Channel',
    title: 'Create a channel and its webhook',
    caption: '[SCREENSHOT: Discord — Server Settings → Integrations → Webhooks → New Webhook]',
    copy: 'A channel is where the chunks land. DiscordDrive posts them silently — you will never see file noise in the chat.',
  },
  {
    label: 'Connect',
    title: 'Wire your webhook',
    caption: '[SCREENSHOT: The webhook URL pasted into DiscordDrive]',
    copy: 'The URL is a key. We validate it, save it encrypted, then send a live message to prove the connection works.',
  },
  {
    label: 'Finish',
    title: 'Keep links alive, then go',
    caption: '[SCREENSHOT: Discord — Developer Portal → Bot → Copy Token]',
    copy: 'Optional: a bot token lets DiscordDrive refresh download links before Discord expires them. Your drive still works without it.',
  },
] as const

const WEBHOOK_RE = /^https:\/\/(?:discord(?:app)?\.com)\/api(?:\/v\d+)?\/webhooks\/\d{17,20}\/[A-Za-z0-9_.\-]+$/

function webhookUrlIssue(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'A webhook URL is required.'
  if (!/^https:/i.test(trimmed)) return 'A Discord webhook URL must start with https://.'
  if (!WEBHOOK_RE.test(trimmed))
    return 'That does not look like a webhook. It should be https://discord.com/api/webhooks/<id>/<token>.'
  return null
}

interface OnboardingPageProps {
  user: SessionUser
}

export function OnboardingPage({ user }: OnboardingPageProps) {
  const navigate = useNavigate()
  const { refresh } = useCurrentUser()

  const [step, setStep] = useState(() => readProgress(user.id)?.step ?? 0)
  const [ackServer, setAckServer] = useState(step > 0)
  const [ackChannel, setAckChannel] = useState(step > 1)

  const [webhook, setWebhook] = useState<OnboardingWebhook | null>(null)
  const [testedOk, setTestedOk] = useState(() => readProgress(user.id)?.testedOk ?? false)

  const [url, setUrl] = useState('')
  const [webhookName, setWebhookName] = useState('My Drive')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [savedTest, setSavedTest] = useState<TestResult | null>(null)
  const [connectError, setConnectError] = useState<AuthApiError | null>(null)

  const [botToken, setBotToken] = useState('')
  const [botTokenVisible, setBotTokenVisible] = useState(false)
  const [attachingToken, setAttachingToken] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<AuthApiError | null>(null)
  const [signingOut, setSigningOut] = useState(false)

  const urlInput = useRef<HTMLInputElement>(null)
  const urlIssue = webhookUrlIssue(url)

  // Resuming: if a webhook was saved earlier, bring it back so step 2 (and the token
  // step) pick up where the user left off instead of demanding a re-paste.
  useEffect(() => {
    if (step !== 2 || webhook !== null) return
    const stored = readProgress(user.id)
    if (!stored?.webhookId) return
    let alive = true
    void listWebhooks()
      .then(({ webhooks }) => {
        if (!alive) return
        const found = webhooks.find((w) => w.id === stored.webhookId)
        if (found) {
          setWebhook(found)
          setWebhookName(found.name)
          setTestedOk(stored.testedOk === true)
        }
      })
      .catch((error: unknown) => {
        if (isSessionLost(error)) {
          void refresh()
          navigate('/login', { replace: true })
          return
        }
        /* any other failure leaves the form empty; the user can re-paste */
      })
    return () => {
      alive = false
    }
  }, [step, webhook, user.id])

  const persist = (next: Parameters<typeof writeProgress>[1]) =>
    writeProgress(user.id, next)

  function goTo(next: number) {
    if (next > step) {
      persist({ step: next, webhookId: webhook?.id, webhookName, testedOk })
    }
    setStep(next)
  }

  /**
   * Session loss is never a wizard failure. Whatever request was in flight just lost its
   * right to act; take the user back to the sign-in screen where the gate explains why.
   * Returns true when the session really is gone, so a handler can skip its own error
   * state and drop straight to a clean redirect.
   */
  function sessionLost(error: unknown): boolean {
    if (!isSessionLost(error)) return false
    clearProgress(user.id)
    void refresh()
    navigate('/login', { replace: true })
    return true
  }

  async function handleSignOut() {
    setSigningOut(true)
    try {
      await logout()
      clearProgress(user.id)
      await refresh()
      navigate('/login', { replace: true })
    } catch {
      /* the cookie may already be gone; the redirect still lands on a clean form */
      navigate('/login', { replace: true })
    } finally {
      setSigningOut(false)
    }
  }

  async function saveAndVerify(event: FormEvent) {
    event.preventDefault()
    if (urlIssue) {
      urlInput.current?.focus()
      return
    }
    setSaving(true)
    setConnectError(null)
    setSavedTest(null)
    try {
      const { webhook: created } = await createWebhook({ name: webhookName, url })
      setWebhook(created)
      setTestedOk(false)
      persist({ step: 2, webhookId: created.id, webhookName: created.name, testedOk: false })
      await runTest(created.id, created.name)
    } catch (error) {
      if (sessionLost(error)) return
      setConnectError(asApiError(error))
    } finally {
      setSaving(false)
    }
  }

  async function runTest(webhookId: string, nameOfWebhook: string) {
    setTesting(true)
    setSavedTest(null)
    try {
      const result = await testWebhook(webhookId)
      setSavedTest(result)
      if (result.ok) {
        setTestedOk(true)
        persist({ step: 2, webhookId, webhookName: nameOfWebhook, testedOk: true })
        setWebhook((prev) =>
          prev?.id === webhookId ? { ...prev, channelId: result.channelId ?? prev.channelId } : prev,
        )
      }
    } catch (error) {
      if (sessionLost(error)) return
      setSavedTest({ ok: false, message: asApiError(error).message })
    } finally {
      setTesting(false)
    }
  }

  async function attachToken() {
    if (!webhook || !botToken.trim()) return
    setAttachingToken(true)
    setFinishError(null)
    try {
      const existing = webhook
      const { webhook: updated } = await updateWebhook(existing.id, { botToken: botToken.trim() })
      setWebhook(updated)
      setBotToken('')
      await finishAfterToken()
    } catch (error) {
      if (sessionLost(error)) return
      setFinishError(asApiError(error))
    } finally {
      setAttachingToken(false)
    }
  }

  async function finishAfterToken() {
    setFinishing(true)
    setFinishError(null)
    try {
      await completeOnboarding()
      clearProgress(user.id)
      await refresh()
      navigate('/dashboard', { replace: true })
    } catch (error) {
      if (sessionLost(error)) return
      setFinishError(asApiError(error))
      setFinishing(false)
    }
  }

  const canAdvance = useMemo(() => {
    switch (step) {
      case 0:
        return ackServer
      case 1:
        return ackChannel
      case 2:
        return webhook !== null && (testedOk || savedTest?.ok === true)
      case 3:
        return true
      default:
        return false
    }
  }, [step, ackServer, ackChannel, webhook, testedOk, savedTest])

  return (
    <div className="relative flex min-h-dvh flex-col items-center overflow-hidden bg-canvas px-4 py-8 sm:px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--color-line)_0.6px,transparent_0.6px)] [background-size:22px_22px] opacity-25 [mask-image:linear-gradient(to_bottom,black,transparent_80%)]"
      />
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-blurple/20 blur-[120px]" />

      <header className="relative z-10 flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="hidden font-mono text-xs text-faint sm:block">SETUP</span>
          <span className="rounded-full border border-line bg-surface-raised px-2 py-0.5 font-mono text-[0.65rem] tabular-nums text-faint">
            {step + 1} / {STEPS.length}
          </span>
        </div>
        <SignedInChip user={user} busy={signingOut} onSignOut={() => void handleSignOut()} />
      </header>

      <div className="relative z-10 mt-8 w-full max-w-3xl">
        <div className="overflow-hidden rounded-(--radius-card) border border-line bg-surface/70 shadow-2xl shadow-black/40 ring-1 ring-white/5 backdrop-blur">
          <ProgressRail step={step} />

          <div className="hidden h-0.5 w-full bg-surface-hover sm:block">
            <div
              className="h-full bg-linear-to-r from-blurple-soft to-violet transition-all duration-500"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="grid gap-x-8 gap-y-8 p-6 sm:p-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"
            >
              <div className="hidden md:block">
                <ScreenshotPlaceholder caption={STEPS[step].caption} />
              </div>

              <div className="space-y-6 md:max-h-[27rem] md:overflow-y-auto md:pr-1">
                <div className="space-y-1.5">
                  <p className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-blurple-soft">
                    <Sparkles className="size-3.5" aria-hidden />
                    {STEPS[step].label}
                  </p>
                  <h2 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
                    {STEPS[step].title}
                  </h2>
                  <p className="text-sm leading-relaxed text-muted-foreground">{STEPS[step].copy}</p>
                </div>

                {step === 0 && (
                  <>
                    <ol className="space-y-3 text-sm text-muted-foreground">
                      <StepInstruction index={1}>In Discord, click + on your server list and pick "Create My Own".</StepInstruction>
                      <StepInstruction index={2}>Choose a template — "Blank" is fine — and name it anything.</StepInstruction>
                      <StepInstruction index={3}>Mark it Community-owned if Discord asks, then press Create.</StepInstruction>
                    </ol>
                    <CheckRow checked={ackServer} onChange={setAckServer}>
                      I created the server
                    </CheckRow>
                  </>
                )}

                {step === 1 && (
                  <>
                    <ol className="space-y-3 text-sm text-muted-foreground">
                      <StepInstruction index={1}>Inside your new server, create a channel — "drive-files", say.</StepInstruction>
                      <StepInstruction index={2}>Open Server Settings → Integrations → Webhooks.</StepInstruction>
                      <StepInstruction index={3}>Click "New Webhook", give it a name, and copy its URL.</StepInstruction>
                    </ol>
                    <CheckRow checked={ackChannel} onChange={setAckChannel}>
                      I have a webhook URL I can paste
                    </CheckRow>
                  </>
                )}

                {step === 2 && (
                  <>
                    {webhook === null ? (
                      <form className="space-y-4" onSubmit={saveAndVerify} noValidate>
                        <Field label="Webhook name" hint="Shown in your Discord chat when a test lands.">
                          <input
                            className={inputCls}
                            value={webhookName}
                            maxLength={64}
                            onChange={(e) => setWebhookName(e.target.value)}
                          />
                        </Field>
                        <Field
                          label="Webhook URL"
                          hint="https://discord.com/api/webhooks/… — pasted straight from Discord."
                        >
                          <input
                            ref={urlInput}
                            className={cn(inputCls, urlIssue && 'border-caution')}
                            value={url}
                            onChange={(e) => {
                              setUrl(e.target.value)
                              setConnectError(null)
                            }}
                            placeholder="https://discord.com/api/webhooks/…"
                            spellCheck={false}
                            aria-invalid={urlIssue !== null}
                          />
                          {urlIssue && (
                            <p className="mt-1.5 text-xs text-caution" role="alert">
                              {urlIssue}
                            </p>
                          )}
                        </Field>
                        {connectError && (
                          <p className="flex items-start gap-2 text-xs text-caution" role="alert">
                            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                            {connectError.message}
                          </p>
                        )}
                        <Button type="submit" className="w-full" disabled={saving || !!urlIssue} size="lg">
                          {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <PlugZap className="size-4" aria-hidden />}
                          {saving ? 'Saving…' : 'Save & verify'}
                        </Button>
                      </form>
                    ) : (
                      <div className="space-y-4">
                        <ConnectedWebhook webhook={webhook} onReconnect={() => setWebhook(null)} />
                        <div className="space-y-2">
                          <Button
                            size="lg"
                            className="w-full"
                            onClick={() => void runTest(webhook.id, webhook.name)}
                            disabled={testing}
                          >
                            {testing ? (
                              <Loader2 className="size-4 animate-spin" aria-hidden />
                            ) : (
                              <RefreshCw className="size-4" aria-hidden />
                            )}
                            {testing ? 'Sending test message…' : testedOk ? 'Test again' : 'Test connection'}
                          </Button>
                          {savedTest && <TestResultView result={savedTest} />}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {step === 3 && (
                  <div className="space-y-4">
                    <div className="flex items-start gap-3 rounded-(--radius-card) border border-line bg-surface-raised/60 p-4">
                      <KeyRound className="mt-0.5 size-4 shrink-0 text-blurple-soft" aria-hidden />
                      <div className="min-w-0 text-sm text-muted-foreground">
                        {webhook?.hasBotToken ? (
                          <>
                            <p className="font-medium text-ink">A bot token is already attached</p>
                            <p className="mt-1">
                              It ends in <span className="font-mono text-xs">…{webhook.botTokenLast4}</span>. Leave the
                              field empty to keep it, or paste a new one to replace it.
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="font-medium text-ink">Why optional?</p>
                            <p className="mt-1">
                              Discord deletes webhook attachment links when they expire. A bot token lets DiscordDrive
                              refresh them, so files shared by link stay reachable for 24 hours like Discord promises.
                              Without one, you can still upload and it just works in the app.
                            </p>
                          </>
                        )}
                      </div>
                    </div>

                    <Field
                      label="Bot token (optional)"
                      hint="Discord → Developer Portal → your app → Bot → Reset Token → Copy."
                    >
                      <div className="relative">
                        <input
                          className={cn(inputCls, 'pr-10 font-mono')}
                          type={botTokenVisible ? 'text' : 'password'}
                          value={botToken}
                          onChange={(e) => {
                            setBotToken(e.target.value)
                            setFinishError(null)
                          }}
                          placeholder="Nzkzhj…"
                          spellCheck={false}
                          aria-invalid={finishError?.code === 'INVALID_BOT_TOKEN'}
                        />
                        <button
                          type="button"
                          onClick={() => setBotTokenVisible((v) => !v)}
                          className="absolute inset-y-0 right-0 grid w-10 place-items-center text-faint hover:text-ink"
                          aria-label={botTokenVisible ? 'Hide token' : 'Show token'}
                        >
                          {botTokenVisible ? (
                            <EyeOff className="size-4" aria-hidden />
                          ) : (
                            <Eye className="size-4" aria-hidden />
                          )}
                        </button>
                      </div>
                      {finishError?.code === 'INVALID_BOT_TOKEN' && (
                        <p className="mt-1.5 text-xs text-caution" role="alert">
                          {finishError.message}
                        </p>
                      )}
                    </Field>

                    {finishError && finishError.code !== 'INVALID_BOT_TOKEN' && (
                      <p className="flex items-start gap-2 text-xs text-caution" role="alert">
                        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        {finishError.message}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          </AnimatePresence>

          <footer className="flex items-center justify-between border-t border-line bg-surface/50 px-6 py-4 sm:px-8">
            <Button variant="ghost" onClick={() => goTo(step - 1)} disabled={step === 0}>
              <ArrowLeft className="size-4" aria-hidden />
              Back
            </Button>

            {step < STEPS.length - 1 ? (
              <Button onClick={() => goTo(step + 1)} disabled={!canAdvance || testing}>
                Next
                <ArrowRight className="size-4" aria-hidden />
              </Button>
            ) : (
              <Button
                onClick={() => void (botToken.trim() ? attachToken() : finishAfterToken())}
                disabled={finishing || attachingToken}
              >
                {finishing || attachingToken ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Check className="size-4" aria-hidden />
                )}
                {finishing || attachingToken ? (botToken.trim() ? 'Attaching…' : 'Finishing…') : 'Launch my drive'}
              </Button>
            )}
          </footer>
        </div>

        <p className="mt-4 text-center font-mono text-xs text-faint">
          Setup takes about three minutes · your webhook URL is encrypted, never stored in the browser
        </p>
        <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
          <UserRound className="size-3.5 text-blurple-soft" aria-hidden />
          The webhook will be linked to{' '}
          <span className="font-mono text-blurple-soft">{user.email}</span> — only this profile can manage it.
        </p>
      </div>
    </div>
  )
}

const inputCls =
  'w-full rounded-(--radius-control) border border-line bg-canvas px-3 py-2 text-sm text-ink placeholder:text-faint outline-none focus-visible:border-blurple focus-visible:ring-3 focus-visible:ring-blurple/25'

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-sm font-medium text-ink">{label}</label>
        <span className="text-[0.7rem] leading-none text-faint">{hint}</span>
      </div>
      {children}
    </div>
  )
}

function StepInstruction({ index, children }: { index: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border border-line bg-surface-raised font-mono text-[0.7rem] text-faint">
        {index}
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  )
}

function CheckRow({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  children: React.ReactNode
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-3 rounded-(--radius-card) border border-line bg-surface-raised/60 px-4 py-3 transition-colors has-[:checked]:border-blurple/50 has-[:checked]:bg-blurple/5">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="grid size-5 place-items-center rounded-md border border-line bg-canvas text-canvas transition-colors peer-checked:border-blurple peer-checked:bg-blurple peer-checked:text-white">
        <Check className={cn('size-3.5', !checked && 'opacity-0')} aria-hidden />
      </span>
      <span className="text-sm font-medium text-ink">{children}</span>
    </label>
  )
}

function ConnectedWebhook({
  webhook,
  onReconnect,
}: {
  webhook: OnboardingWebhook
  onReconnect: () => void
}) {
  return (
    <div className="space-y-3 rounded-(--radius-card) border border-positive/30 bg-positive/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-(--radius-control) border border-positive/30 bg-positive/10 text-positive">
            <Webhook className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="font-medium text-ink">{webhook.name}</p>
            <p className="mt-0.5 truncate font-mono text-xs text-faint">{webhook.urlHint}</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onReconnect}>
          Change
        </Button>
      </div>
    </div>
  )
}

function TestResultView({ result }: { result: TestResult }) {
  if (result.ok) {
    return (
      <div className="flex items-start gap-3 rounded-(--radius-card) border border-positive/30 bg-positive/5 p-4 text-sm">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium text-ink">Connected — a message landed in your channel</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {result.latencyMs !== undefined && `Round-trip in ${result.latencyMs}ms. `}
            Chunks posted here are private to the webhook — they do not appear in the chat.
          </p>
        </div>
      </div>
    )
  }

  const hint =
    result.code === 404
      ? 'Discord says this webhook is gone. It was deleted or the id is wrong — recreate it in Integrations → Webhooks, then re-test.'
      : result.code === 401
        ? 'Discord refused the URL: the token part is likely incomplete. Copy the whole webhook URL from Integrations → Webhooks, then re-test.'
        : result.code === 403
          ? 'Discord will not let this webhook post here. Check the channel permissions for the webhook, then re-test.'
          : null

  return (
    <div className="flex items-start gap-3 rounded-(--radius-card) border border-caution/40 bg-caution/5 p-4 text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium text-ink">{result.message ?? 'That webhook could not be reached.'}</p>
        {hint && <p className="mt-1 text-xs text-caution">{hint}</p>}
      </div>
    </div>
  )
}

function SignedInChip({
  user,
  busy,
  onSignOut,
}: {
  user: SessionUser
  busy: boolean
  onSignOut: () => void
}) {
  const initials = (user.displayName || user.email)
    .trim()
    .split(/\s+/)
    .map((word) => word[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <div className="flex items-center gap-2.5 rounded-(--radius-control) border border-line bg-surface-raised px-3 py-1.5">
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-full border border-blurple/30 bg-blurple/10 font-mono text-[0.65rem] font-semibold text-blurple-soft"
      >
        {initials}
      </span>
      <div className="hidden min-w-0 text-left sm:block">
        <p className="max-w-48 truncate text-xs font-medium leading-tight text-ink">
          {user.displayName || user.email}
        </p>
        <p className="truncate font-mono text-[0.65rem] leading-tight text-faint">{user.email}</p>
      </div>
      <span className="hidden h-4 w-px bg-line sm:block" aria-hidden />
      <Button
        variant="ghost"
        size="sm"
        onClick={onSignOut}
        disabled={busy}
        className="px-1.5 text-faint"
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <LogOut className="size-3.5" aria-hidden />
        )}
        <span className="hidden sm:inline">Sign out</span>
      </Button>
    </div>
  )
}

function ProgressRail({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-3 px-6 pt-6 sm:px-8" aria-hidden="true">
      {STEPS.map((s, i) => {
        const done = i < step
        const active = i === step
        return (
          <div key={s.label} className="flex flex-1 items-center gap-3">
            <span
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-full border font-mono text-xs transition-colors',
                done && 'border-blurple bg-blurple text-white',
                active && 'border-blurple bg-blurple/10 text-blurple-soft',
                !done && !active && 'border-line text-faint',
              )}
            >
              {done ? <Check className="size-3.5" /> : active ? i + 1 : i + 1}
            </span>
            <span
              className={cn(
                'hidden text-xs font-medium sm:block',
                active ? 'text-ink' : done ? 'text-muted-foreground' : 'text-faint',
              )}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className={cn('h-px flex-1', done ? 'bg-blurple/60' : 'bg-line')} />
            )}
          </div>
        )
      })}
    </div>
  )
}