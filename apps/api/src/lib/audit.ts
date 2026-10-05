import { AuditAction, Prisma } from '../generated/prisma/client.js'
import { prisma } from './prisma.js'

/**
 * `meta` must never carry a webhook URL or a bot token. Callers pass structured facts
 * (ids, counts, a truncated reason) precisely so that a future refactor cannot start
 * logging a secret by accident. Never spread a request body in here.
 */
export type AuditMeta = Record<string, string | number | boolean | null>

interface AuditInput {
  action: AuditAction
  /** The account the action was performed on. Null for pre-registration events. */
  targetUserId?: string | null
  /** The admin who performed the action, when there is one. */
  actorUserId?: string | null
  actorIp?: string | null
  meta?: AuditMeta
}

/**
 * Writes an audit row. Accepts an optional transaction client so an admin action and its
 * audit record commit together: an approval that succeeded without a trace is worse than
 * one that failed outright.
 */
export async function recordAudit(
  input: AuditInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await client.auditLog.create({
    data: {
      action: input.action,
      userId: input.targetUserId ?? null,
      actorUserId: input.actorUserId ?? null,
      meta: input.meta ? (input.meta as Prisma.InputJsonValue) : undefined,
      ipAddress: input.actorIp ?? null,
    },
  })
}