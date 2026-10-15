import type { NextFunction, Request, Response } from 'express'
import { loadEnv } from '../config/env.js'
import { AppError } from './errors.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Server-side CSRF control for cookie-authenticated mutations.
 *
 * The session cookie is `SameSite=Lax`, so a cross-site form POST never carries it,
 * but Lax is a browser policy rather than something this server can observe. This
 * rejects a mutation whose `Origin` names a different host than the one serving the
 * app — the header a browser cannot be talked out of sending.
 *
 * A request with no `Origin` passes: curl, supertest and other non-browser clients do
 * not send one, and a browser that omits it is not making a cookie-carrying
 * cross-site request. Failing open there keeps the check from ever breaking a
 * legitimate client while still covering the case it exists for.
 */
export function sameOriginGuard(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next()
    return
  }

  const origin = req.headers.origin
  if (!origin) {
    next()
    return
  }

  // `Origin: null` is what a sandboxed iframe or a `file:` document sends — a context
  // an attacker controls and one this app never runs in.
  if (origin === 'null') {
    next(AppError.forbidden('CSRF_ORIGIN_REJECTED', 'Cross-origin request rejected'))
    return
  }

  const allowed = new Set<string>()
  const host = req.headers.host
  if (host) {
    allowed.add(`http://${host}`)
    allowed.add(`https://${host}`)
  }

  for (const entry of loadEnv()
    .CORS_ORIGINS.split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean)) {
    allowed.add(entry)
  }

  if (allowed.has(origin.replace(/\/$/, ''))) {
    next()
    return
  }
  next(AppError.forbidden('CSRF_ORIGIN_REJECTED', 'Cross-origin request rejected'))
}
