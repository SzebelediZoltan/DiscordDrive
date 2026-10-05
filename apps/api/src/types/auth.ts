import type { Role, UserStatus } from '../generated/prisma/client.js'

/** The identity attached to every authenticated request by `requireAuth`. */
export interface AuthenticatedUser {
  id: string
  email: string
  /** Nullable in the schema; normalised to '' by the service so callers never branch. */
  displayName: string
  role: Role
  status: UserStatus
  approvedAt: Date | null
  onboardedAt: Date | null
}

/**
 * Cleared on logout and on any response the middleware decides to reject, so a
 * deactivation takes effect immediately instead of at token expiry.
 */
export interface SessionRecord {
  id: string
  userId: string
  csrfToken: string
  createdAt: Date
  lastSeenAt: Date
}