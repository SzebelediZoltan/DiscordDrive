import { createHmac, timingSafeEqual } from 'node:crypto'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { Role, UserStatus } from '../generated/prisma/client.js'
import { loadEnv } from '../config/env.js'

/**
 * Stateless session token, httpOnly-cookie only.
 *
 * Role and status are embedded so the common case needs no database round trip, but
 * they are re-read on every request by `requireAuth`. That is deliberate: a token
 * minted before an admin deactivates someone would otherwise keep working until it
 * expired, which is up to a week.
 */

const ISSUER = 'discorddrive'
const AUDIENCE = 'discorddrive-web'

export interface SessionClaims extends JWTPayload {
  sub: string
  email: string
  role: Role
  status: UserStatus
}

let cachedKey: Uint8Array | null = null

function signingKey(): Uint8Array {
  if (cachedKey === null) {
    const { JWT_SECRET } = loadEnv()
    cachedKey = new TextEncoder().encode(JWT_SECRET)
  }
  return cachedKey
}

/** Only used by tests, which change JWT_SECRET between cases. */
export function resetSigningKeyCache(): void {
  cachedKey = null
}

export async function issueSessionToken(claims: SessionClaims): Promise<string> {
  const { JWT_TTL_SECONDS } = loadEnv()
  return new SignJWT({
    email: claims.email,
    role: claims.role,
    status: claims.status,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${JWT_TTL_SECONDS}s`)
    .sign(signingKey())
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    })
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null
    if (payload.role !== Role.ADMIN && payload.role !== Role.USER) return null
    if (payload.status !== UserStatus.ACTIVE && payload.status !== UserStatus.SUSPENDED) return null
    return payload as SessionClaims
  } catch {
    // Expired, wrong signature, wrong issuer, malformed: all mean "not logged in".
    return null
  }
}

const CSRF_HEADER = 'x-csrf-token'
const CSRF_COOKIE = 'dd_csrf'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/**
 * The CSRF cookie must not be httpOnly: the browser needs to read it to echo it back
 * in a header. That is safe on its own because a cross-origin attacker can already
 * force the browser to *send* the cookie but cannot read it to copy its value.
 */
export function csrfTokenFor(sessionId: string): string {
  return createHmac('sha256', signingKey()).update(`csrf:${sessionId}`).digest('hex')
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.byteLength !== bufB.byteLength) return false
  return timingSafeEqual(bufA, bufB)
}

export const CSRF = { HEADER: CSRF_HEADER, COOKIE: CSRF_COOKIE, MAX_AGE_SECONDS }