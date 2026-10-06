import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { motion } from 'framer-motion'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Logo } from '@/components/brand/Logo'
import { useCurrentUser } from '@/hooks/use-current-user'
import { cn } from '@/lib/utils'

export type AuthMode = 'signIn' | 'signUp'

interface AuthPageProps {
  mode?: AuthMode
}

interface ApiError {
  code?: string
  message: string
}

interface WaitlistSnapshot {
  position: number | null
  waitingCount: number
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let message = 'Something went wrong, please try again'
    try {
      const data = (await res.json()) as { error?: { code?: string; message?: string } | null }
      if (data.error?.message) message = data.error.message
    } catch {
      // Unparseable body; keep the fallback message.
    }
    throw { code: undefined, message } satisfies ApiError
  }
  return res.json() as Promise<Record<string, unknown>>
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function passwordChecks(password: string) {
  return {
    length: password.length >= 10,
    lower: /[a-z]/.test(password),
    upper: /[A-Z]/.test(password),
    digit: /[0-9]/.test(password),
  }
}

function PasswordHints({ password }: { password: string }) {
  const checks = passwordChecks(password)
  const rows: { key: keyof typeof checks; label: string }[] = [
    { key: 'length', label: 'At least 10 characters' },
    { key: 'lower', label: 'A lowercase letter' },
    { key: 'upper', label: 'An uppercase letter' },
    { key: 'digit', label: 'A number' },
  ]
  return (
    <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1" aria-label="Password requirements">
      {rows.map((row) => (
        <li
          key={row.key}
          className={cn(
            'flex items-center gap-1.5 text-xs',
            checks[row.key] ? 'text-positive' : 'text-faint',
          )}
        >
          <Check className={cn('size-3', !checks[row.key] && 'opacity-30')} aria-hidden />
          {row.label}
        </li>
      ))}
    </ul>
  )
}

export function AuthPage({ mode = 'signIn' }: AuthPageProps) {
  const navigate = useNavigate()
  const { user, loading, refresh } = useCurrentUser()

  const [view, setView] = useState<AuthMode>(mode)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Sign-in fields.
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // Sign-up fields.
  const [displayName, setDisplayName] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Post-registration screen.
  const [registered, setRegistered] = useState<{ email: string } | null>(null)
  const [waitlist, setWaitlist] = useState<WaitlistSnapshot | null>(null)

  const signingIn = view === 'signIn'
  const formError = email !== '' && !EMAIL_RE.test(email) ? 'Enter a valid email address' : null
  const checks = passwordChecks(password)
  const confirmMismatch = confirmPassword !== '' && confirmPassword !== password

  const passwordValid = useMemo(
    () => checks.length && checks.lower && checks.upper && checks.digit,
    [checks],
  )

  if (user && !registered) {
    return <Navigate to="/dashboard" replace />
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (signingIn) {
      setBusy(true)
      try {
        await postJson('/api/auth/login', { email: email.trim(), password })
        await refresh()
        navigate('/dashboard', { replace: true })
      } catch (err) {
        setError((err as ApiError).message)
        setBusy(false)
      }
      return
    }

    setBusy(true)
    try {
      await postJson('/api/auth/register', {
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
      })
      setRegistered({ email: email.trim() })
      try {
        const snapshot = (await fetch(
          `/api/waitlist/status?email=${encodeURIComponent(email.trim())}`,
          { credentials: 'same-origin' },
        ).then((res) => res.json())) as WaitlistSnapshot
        setWaitlist(snapshot)
      } catch {
        setWaitlist(null)
      }
    } catch (err) {
      setError((err as ApiError).message)
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-16">
      <Logo to="/" />

      {registered ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="card-surface w-full max-w-sm space-y-3 p-8 text-center"
        >
          <h1 className="text-xl font-semibold tracking-tight text-ink">Almost there</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Your account is waiting for an administrator to approve it before you can sign in.
          </p>
          {waitlist?.position != null && (
            <p className="text-sm font-medium text-ink">
              You are <span className="text-blurple-soft">#{waitlist.position}</span> in line
              {waitlist.waitingCount > 0 && ` · ${waitlist.waitingCount} people waiting`}
            </p>
          )}
          <Button variant="secondary" className="w-full" onClick={() => navigate('/')}>
            Back to sign in
          </Button>
        </motion.div>
      ) : (
        <motion.div
          key={view}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="card-surface w-full max-w-sm p-8"
        >
          <div className="space-y-1.5 text-center">
            <h1 className="text-xl font-semibold tracking-tight text-ink">
              {signingIn ? 'Sign in to DiscordDrive' : 'Create your account'}
            </h1>
            <p className="text-sm text-muted-foreground">
              {signingIn
                ? 'Files live in your Discord webhook — sign in to see them.'
                : 'New accounts are approved by an administrator.'}
            </p>
          </div>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
            {!signingIn && (
              <div className="space-y-1.5">
                <Label htmlFor="display-name">Display name</Label>
                <Input
                  id="display-name"
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="How you appear to others"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-invalid={formError != null}
              />
              {formError && (
                <p className="text-xs text-critical" role="alert">
                  {formError}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">
                {signingIn ? 'Password' : 'Set a password'}
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete={signingIn ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!signingIn && password !== '' && !passwordValid}
              />
              {!signingIn && password !== '' && <PasswordHints password={password} />}
            </div>

            {!signingIn && (
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Repeat password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  aria-invalid={confirmMismatch}
                />
                {confirmMismatch && (
                  <p className="text-xs text-critical" role="alert">
                    Passwords do not match
                  </p>
                )}
              </div>
            )}

            {error && (
              <p className="rounded-(--radius-control) bg-critical/10 px-3 py-2 text-sm text-critical" role="alert">
                {error}
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={
                busy ||
                email === '' ||
                password === '' ||
                formError != null ||
                (!signingIn && (!passwordValid || confirmPassword === '' || confirmMismatch || !displayName.trim()))
              }
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {signingIn ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          <div className="mt-6 border-t border-line pt-5 text-center text-sm text-muted-foreground">
            {signingIn ? (
              <>
                New to DiscordDrive?{' '}
                <button
                  type="button"
                  className="font-medium text-blurple-soft underline-offset-4 hover:underline"
                  onClick={() => setView('signUp')}
                >
                  Create an account
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button
                  type="button"
                  className="font-medium text-blurple-soft underline-offset-4 hover:underline"
                  onClick={() => setView('signIn')}
                >
                  Sign in
                </button>
              </>
            )}
          </div>
        </motion.div>
      )}

      {loading && <p className="text-xs text-faint">Checking your session…</p>}
    </div>
  )
}