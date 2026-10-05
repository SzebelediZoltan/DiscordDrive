import { Router, type Request, type Response } from 'express'
import { loadEnv } from '../../config/env.js'
import { requireAuth } from '../../http/auth-middleware.js'
import { AppError } from '../../http/errors.js'
import { issueSessionToken, CSRF, csrfTokenFor } from '../../lib/tokens.js'
import type { AuthenticatedUser } from '../../types/auth.js'
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
} from './auth.schemas.js'
import { changePassword, login, publicUser, register } from './auth.service.js'
import { checkAuthRateLimit, recordAuthFailure, recordAuthSuccess } from './rate-limit.js'

/**
 * Zod issues are already specific ("Password must contain an uppercase letter"), so the
 * generic message is unnecessary noise for the caller.
 */
function firstIssue(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? 'Invalid request'
}

/**
 * `req.ip` needs `trust proxy` (set in app.ts) to reflect the real client behind nginx;
 * without it every request would look like it came from the proxy and one user could
 * lock out everyone.
 */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

function applySessionCookies(res: Response, token: string, csrfToken: string): void {
  const env = loadEnv()
  const maxAgeMs = env.JWT_TTL_SECONDS * 1000

  res.cookie(env.COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  })

  res.cookie(CSRF.COOKIE, csrfToken, {
    // Readable by the SPA so it can echo the value back in a header.
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  })
}

function clearSessionCookies(res: Response): void {
  const env = loadEnv()
  res.clearCookie(env.COOKIE_NAME, { path: '/' })
  res.clearCookie(CSRF.COOKIE, { path: '/' })
}

export function createAuthRouter(): Router {
  const router = Router()

  router.post('/register', async (req: Request, res: Response): Promise<void> => {
    const parsed = registerSchema.safeParse(req.body)
    if (!parsed.success) throw AppError.badRequest('VALIDATION_ERROR', firstIssue(parsed.error))

    const user = await register(parsed.data as RegisterInput, req.ip)
    res.status(201).json({
      user: publicUser(user),
      pendingApproval: true,
      message: 'Account created. An administrator has to approve it before you can sign in.',
    })
  })

  router.post('/login', async (req: Request, res: Response): Promise<void> => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) throw AppError.badRequest('VALIDATION_ERROR', firstIssue(parsed.error))

    // Read per request, not at router construction: loadEnv() is memoised, so capturing
    // it here would freeze the limits for the life of the process and make them
    // impossible to tune or to exercise in tests.
    const env = loadEnv()
    const ip = clientIp(req)
    const limit = checkAuthRateLimit(ip, env)
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds))
      throw AppError.tooManyRequests('RATE_LIMITED', 'Too many sign-in attempts. Try again shortly.', limit.retryAfterSeconds)
    }

    const input = parsed.data as LoginInput

    let user: AuthenticatedUser
    try {
      user = await login(input)
    } catch (err) {
      const failure = recordAuthFailure(ip, env)
      if (!failure.allowed) {
        res.setHeader('Retry-After', String(failure.retryAfterSeconds))
        throw AppError.tooManyRequests('RATE_LIMITED', 'Too many failed sign-in attempts', failure.retryAfterSeconds)
      }
      throw err
    }

    if (user.status === 'PENDING') {
      // Not counted as a failure: the credentials were correct.
      throw AppError.forbidden('ACCOUNT_PENDING', 'Your account is waiting for approval')
    }
    if (user.status === 'SUSPENDED') {
      throw AppError.forbidden('ACCOUNT_SUSPENDED', 'Your account has been suspended')
    }

    recordAuthSuccess(ip, env)

    const token = await issueSessionToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
    })
    const csrfToken = csrfTokenFor(user.id)

    applySessionCookies(res, token, csrfToken)
    res.json({ user: publicUser(user) })
  })

  router.post('/logout', (_req: Request, res: Response): void => {
    // Stateless JWT: there is nothing server-side to revoke, so the cookie is the whole
    // logout. The token remains technically valid until it expires, which is why the
    // cookie is httpOnly and short-lived relative to the data it protects.
    clearSessionCookies(res)
    res.status(204).end()
  })

  router.get('/me', requireAuth, (req: Request, res: Response): void => {
    // requireAuth guarantees req.user; reading it again would be a redundant query.
    res.json({ user: publicUser(req.user!) })
  })

  router.post('/change-password', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const parsed = changePasswordSchema.safeParse(req.body)
    if (!parsed.success) throw AppError.badRequest('VALIDATION_ERROR', firstIssue(parsed.error))

    await changePassword(req.user!.id, parsed.data.currentPassword, parsed.data.newPassword)
    res.status(204).end()
  })

  return router
}