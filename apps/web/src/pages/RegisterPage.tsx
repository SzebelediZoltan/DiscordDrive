import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { ArrowRight, Loader2 } from 'lucide-react'
import { AuthFrame, LiveWaitingPill } from '@/components/auth/AuthFrame'
import { FailureBlock } from '@/components/auth/FailureBlock'
import { PasswordHints } from '@/components/auth/PasswordHints'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCurrentUser } from '@/hooks/use-current-user'
import { asApiError, AuthApiError, EMAIL_RE, passwordChecks, postJson } from '@/lib/auth/api'

export function RegisterPage() {
  const navigate = useNavigate()
  const { user } = useCurrentUser()

  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [failure, setFailure] = useState<AuthApiError | null>(null)
  const [busy, setBusy] = useState(false)

  const formError = email !== '' && !EMAIL_RE.test(email) ? 'Enter a valid email address' : null
  const checks = passwordChecks(password)
  const confirmMismatch = confirmPassword !== '' && confirmPassword !== password

  const passwordValid = useMemo(
    () => checks.length && checks.lower && checks.upper && checks.digit,
    [checks],
  )

  if (user) return <Navigate to={user.onboardingComplete ? '/dashboard' : '/onboarding'} replace />

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    setBusy(true)
    try {
      await postJson('/api/auth/register', {
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
      })
      navigate(`/waitlist?email=${encodeURIComponent(email.trim())}`, { replace: true })
    } catch (error) {
      setFailure(asApiError(error))
      setBusy(false)
    }
  }

  return (
    <AuthFrame>
      <div className="space-y-6">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Create your account</h1>
          <p className="text-sm text-muted-foreground">
            New accounts are approved personally. While you wait, here is your place in line — for real.
          </p>
        </div>

        <LiveWaitingPill />

        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="display-name">Display name</Label>
            <Input
              id="display-name"
              autoComplete="name"
              autoFocus
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How you appear to others"
            />
          </div>

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
            <Label htmlFor="password">Set a password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={password !== '' && !passwordValid}
            />
            {password !== '' && <PasswordHints password={password} />}
          </div>

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

          {failure && <FailureBlock error={failure} />}

          <Button
            type="submit"
            className="w-full"
            disabled={
              busy ||
              email === '' ||
              password === '' ||
              formError != null ||
              !passwordValid ||
              confirmPassword === '' ||
              confirmMismatch ||
              !displayName.trim()
            }
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowRight className="size-4" aria-hidden />}
            {busy ? 'Joining the queue…' : 'Join the waitlist'}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-blurple-soft underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </AuthFrame>
  )
}