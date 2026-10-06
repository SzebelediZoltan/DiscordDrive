import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { ArrowRight, Loader2 } from 'lucide-react'
import { AuthFrame } from '@/components/auth/AuthFrame'
import { FailureBlock } from '@/components/auth/FailureBlock'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCurrentUser } from '@/hooks/use-current-user'
import { asApiError, AuthApiError, EMAIL_RE, postJson } from '@/lib/auth/api'

export function LoginPage() {
  const navigate = useNavigate()
  const { user, refresh } = useCurrentUser()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [failure, setFailure] = useState<AuthApiError | null>(null)
  const [busy, setBusy] = useState(false)

  const formError = email !== '' && !EMAIL_RE.test(email) ? 'Enter a valid email address' : null

  // Post-login landing goes to the dashboard; the onboarding gate (issue #11) reroutes
  // there when onboarding is incomplete, so this stays correct both before and after.
  if (user) return <Navigate to="/dashboard" replace />

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    setBusy(true)
    try {
      await postJson('/api/auth/login', { email: email.trim(), password })
      await refresh()
      navigate('/dashboard', { replace: true })
    } catch (error) {
      setFailure(asApiError(error))
      setBusy(false)
    }
  }

  return (
    <AuthFrame>
      <div className="space-y-6">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            Your files live in a Discord webhook. Sign in to reach them.
          </p>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
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
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {failure && <FailureBlock error={failure} />}

          <Button type="submit" className="w-full" disabled={busy || email === '' || password === '' || formError != null}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowRight className="size-4" aria-hidden />}
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          New here?{' '}
          <Link to="/register" className="font-medium text-blurple-soft underline-offset-4 hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </AuthFrame>
  )
}