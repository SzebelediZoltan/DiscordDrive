import type { NextFunction, Request, Response } from 'express'
import type { Role } from '../generated/prisma/client.js'
import { AppError } from './errors.js'
import { prisma } from '../lib/prisma.js'
import { verifySessionToken, type SessionClaims } from '../lib/tokens.js'
import { loadEnv } from '../config/env.js'
import type { AuthenticatedUser } from '../types/auth.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser
    }
  }
}

/**
 * Reads the session cookie, verifies the JWT, then re-loads the user from the database.
 *
 * The database read is not optional. Role and status live in the token for the common
 * case, but an admin who suspends an account expects that account to stop working now,
 * not up to JWT_TTL_SECONDS later. One indexed primary-key lookup is cheap; a stale
 * permission is not.
 */
async function resolveSession(req: Request): Promise<AuthenticatedUser | null> {
  const env = loadEnv()
  const token = req.cookies?.[env.COOKIE_NAME] as string | undefined
  if (!token) return null

  const claims: SessionClaims | null = await verifySessionToken(token)
  if (!claims) return null

  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      status: true,
      approvedAt: true,
      onboardedAt: true,
    },
  })

  // A token for a deleted user is indistinguishable from a valid one to the caller,
  // so this returns null rather than a 401 with a distinct code.
  if (!user) return null
  return { ...user, displayName: user.displayName ?? '' }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const user = await resolveSession(req)

  if (!user) {
    next(AppError.unauthorized())
    return
  }

  if (user.status === 'PENDING') {
    // Deliberately distinct from a bad password: the account is real and the user needs
    // to know they are waiting on an admin, not that they typed their password wrong.
    next(AppError.forbidden('ACCOUNT_PENDING', 'Your account is waiting for approval'))
    return
  }

  if (user.status === 'SUSPENDED') {
    next(AppError.forbidden('ACCOUNT_SUSPENDED', 'Your account has been suspended'))
    return
  }

  req.user = user
  next()
}

/** Attaches `req.user` when a valid session exists, but never rejects. For public pages. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const user = await resolveSession(req)
  if (user && user.status === 'ACTIVE') req.user = user
  next()
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(AppError.unauthorized())
      return
    }
    if (!roles.includes(req.user.role)) {
      next(AppError.forbidden('FORBIDDEN', 'This action requires a different role'))
      return
    }
    next()
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    next(AppError.unauthorized())
    return
  }
  if (req.user.role !== 'ADMIN') {
    next(AppError.forbidden('FORBIDDEN', 'This action requires an administrator account'))
    return
  }
  next()
}

export function requireOnboarded(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(AppError.unauthorized())
    return
  }
  if (req.user.onboardedAt === null) {
    next(new AppError(428, 'ONBOARDING_REQUIRED', 'Finish onboarding before continuing'))
    return
  }
  next()
}