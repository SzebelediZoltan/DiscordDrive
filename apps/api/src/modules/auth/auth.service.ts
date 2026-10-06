import { Role, UserStatus } from '../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { hashPassword, verifyPassword } from '../../lib/passwords.js'
import { registerWithWaitlist } from '../waitlist/waitlist.service.js'
import { AppError } from '../../http/errors.js'
import type { LoginInput, RegisterInput } from './auth.schemas.js'
import type { AuthenticatedUser } from '../../types/auth.js'

/**
 * The service returns only the user. Token minting belongs to the route, which owns the
 * cookie and CSRF headers; keeping it here would mean the service also had to know about
 * cookie options.
 */

/**
 * A syntactically valid scrypt record with a fixed salt, used to spend the same CPU
 * time as a real login when the account does not exist.
 *
 * Without it, "no such user" returns in microseconds while "wrong password" takes
 * ~100ms of scrypt, and that difference is a free account-enumeration oracle. The
 * record has to be *verified* against, not merely awaited: a precomputed hash only
 * pays the cost once, after which the branch resolves in a microtask again.
 */
const DUMMY_STORED_HASH = `scrypt$${'ab'.repeat(16)}$${'cd'.repeat(64)}`

/**
 * Creates the account and its queue position in one transaction. Delegates to the
 * waitlist module so the position is allocated under the advisory lock rather than
 * being a separate step that could half-complete.
 */
export async function register(input: RegisterInput, actorIp?: string | null): Promise<AuthenticatedUser> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } })
  if (existing) {
    // Reveals that the address is taken, which is intentional: registration is the one
    // place where telling the user is more useful than hiding it.
    throw AppError.conflict('EMAIL_TAKEN', 'An account with that email already exists')
  }

  const displayName = input.displayName ?? input.email.split('@')[0]!

  const created = await registerWithWaitlist({
    email: input.email,
    passwordHash: await hashPassword(input.password),
    displayName,
    actorIp: actorIp ?? null,
  })

  // No session is issued: a pending user must not be handed a token that almost every
  // route would then reject with ACCOUNT_PENDING.
  return {
    id: created.id,
    email: created.email,
    displayName: created.displayName,
    role: Role.USER,
    status: UserStatus.PENDING,
    approvedAt: null,
    onboardedAt: null,
  }
}

export async function login(input: LoginInput): Promise<AuthenticatedUser> {
  const user = await prisma.user.findUnique({ where: { email: input.email } })

  // Both branches run one scrypt verification, so the response time carries no
  // information about whether the address is registered.
  const valid = user
    ? await verifyPassword(input.password, user.passwordHash)
    : (await verifyPassword(input.password, DUMMY_STORED_HASH), false)

  if (!user || !valid) {
    // One message and one status for "no such account" and "wrong password", so the
    // response cannot be used to enumerate registered addresses.
    throw AppError.unauthorized('INVALID_CREDENTIALS', 'Incorrect email or password')
  }

  return toAuthenticatedUser(user)
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw AppError.unauthorized()

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw AppError.badRequest('WRONG_PASSWORD', 'Current password is incorrect')
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  })
}

export async function getUser(userId: string): Promise<AuthenticatedUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw AppError.unauthorized()
  return toAuthenticatedUser(user)
}

type UserRow = {
  id: string
  email: string
  displayName: string | null
  role: Role
  status: UserStatus
  approvedAt: Date | null
  onboardedAt: Date | null
}

function toAuthenticatedUser(user: UserRow): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    // The column is nullable for users who never set one; '' is easier for the UI than
    // a null check, and `publicUser` already falls back to the email local part.
    displayName: user.displayName ?? '',
    role: user.role,
    status: user.status,
    approvedAt: user.approvedAt,
    onboardedAt: user.onboardedAt,
  }
}

export function publicUser(user: AuthenticatedUser) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName === '' ? user.email.split('@')[0]! : user.displayName,
    role: user.role,
    status: user.status,
    approved: user.status === UserStatus.ACTIVE,
    onboardingComplete: user.onboardedAt !== null,
  }
}