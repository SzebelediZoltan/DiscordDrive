import { AuditAction, ChunkStatus } from '../../generated/prisma/client.js'
import { loadEnv } from '../../config/env.js'
import { prisma } from '../../lib/prisma.js'
import { recordAudit } from '../../lib/audit.js'
import { getMessage } from '../webhooks/discord.client.js'
import { getBotToken } from '../webhooks/webhook.service.js'
import { expiryFromUrl } from './attachment-url.js'

/**
 * The CDN link refresher.
 *
 * A webhook URL alone can post attachments but can never read a message back, so a
 * webhook-only deployment rots: every `cdn.discordapp.com` link is signed with an `ex`
 * that expires, and the stored URLs die. The refresh path needs a bot token — an account
 * credential — and `GET /channels/{channelId}/messages/{messageId}` returns every
 * attachment of a message freshly signed. One such read therefore repairs a whole batch:
 * whichever of the up-to-10 chunks in the message were still healthy are re-armed by the
 * same response.
 *
 * Two callers. Lazy: a download about to hit an expired link (or a CDN 403/404 mid-stream)
 * refreshes the owning batch on the spot and retries once. Proactive: a scheduler sweeps
 * for batches whose oldest link is within the lead window and refreshes them ahead of a
 * user ever asking. Both funnel through `refreshBatch`, so there is one place where the
 * mapping between Discord attachments and our chunk rows is decided.
 *
 /**
 * The pairing is by array *position*, not filename. Our attachments are named
 * `chunk-00000.bin` … per message (see the multipart builder), so the name encodes only a
 * message-local position and can never identify a chunk. The upload path already maps
 * `attachmentUrls[position]` onto the batch's chunk rows when it persists them, trusting
 * Discord to echo attachments in the order they were sent; reusing that same positional
 * pairing here keeps one file described by one mapping. Two guards stop a wrong pairing
 * from being silent: the message read must return exactly as many attachments as the batch
 * has chunks, and every attachment's size must equal its chunk's recorded `sizeBytes`.
 * Either mismatch marks the chunk FAILED rather than streaming bytes that are not ours.
 */

export type RefreshFailureReason = 'NO_BOT_TOKEN' | 'NO_MESSAGE_ID' | 'DISCORD_REJECTED'

export interface RefreshBatchOutcome {
  ok: boolean
  /** Attachments successfully re-armed with a fresh signed URL. */
  refreshed: number
  /** Chunks this batch owns that came back missing or with a different size. */
  failed: number
  /** Whether a bot token is configured even if this particular refresh failed. */
  hasBotToken: boolean
  reason: RefreshFailureReason | 'SUCCESS'
  message: string
}

const noop = (): void => {}

/**
 * Per-batch promise chain, so a sweep and two concurrent download pre-flights do not each
 * issue their own bot read for the same message. The refresh is idempotent regardless, but
 * Discord budgets bot reads per token and a duplicate costs both a round trip and budget.
 */
const batchLocks = new Map<string, Promise<void>>()

function withBatchLock<T>(batchId: string, fn: () => Promise<T>): Promise<T> {
  const previous = batchLocks.get(batchId) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.then(noop, noop)
  batchLocks.set(batchId, tail)
  // Dropped once nobody is still queued behind this attempt; an idle process must not
  // accumulate one entry per batch it has ever touched.
  void tail.then(() => {
    if (batchLocks.get(batchId) === tail) batchLocks.delete(batchId)
  })
  return run
}

/** Test seam: purges the lock table so one case cannot inherit another's queued work. */
export function resetLinkRefreshState(): void {
  batchLocks.clear()
}

/**
 * Re-reads one batch's message through the bot and rewrites every chunk row with the
 * freshly signed URLs. One call repairs the whole batch, which is why a download that hits
 * an expired link pays for exactly one bot read and not one per chunk.
 *
 * Runs under `withBatchLock`: two callers refreshing the same batch would otherwise both
 * consume a bot read and write, and nothing about that race makes either answer wrong.
 */
export async function refreshBatch(batchId: string): Promise<RefreshBatchOutcome> {
  return withBatchLock(batchId, async () => {
    const batch = await prisma.chunkBatch.findUnique({
      where: { id: batchId },
      include: { webhook: true, chunks: true },
    })
    if (!batch) {
      return { ok: false, refreshed: 0, failed: 0, hasBotToken: false, reason: 'NO_MESSAGE_ID', message: 'This batch no longer exists' }
    }

    const token = await getBotToken(batch.webhook)
    if (token === null) {
      return {
        ok: false,
        refreshed: 0,
        failed: 0,
        hasBotToken: false,
        reason: 'NO_BOT_TOKEN',
        message: 'No bot token is configured on this webhook, so the expired link cannot be refreshed.',
      }
    }
    if (!batch.channelId || !batch.messageId) {
      return {
        ok: false,
        refreshed: 0,
        failed: 0,
        hasBotToken: true,
        reason: 'NO_MESSAGE_ID',
        message: 'This batch has no message to re-read. The file must be re-uploaded.',
      }
    }

    const outcome = await getMessage(batch.channelId, batch.messageId, token)
    if (!outcome.ok) {
      // A deleted message, a revoked token, a channel the bot lost access to: no amount of
      // retrying here helps, and the download path should surface it as-is.
      return {
        ok: false,
        refreshed: 0,
        failed: 0,
        hasBotToken: true,
        reason: 'DISCORD_REJECTED',
        message: outcome.message,
      }
    }

    // The message echoes attachments in the order the upload sent them, so a batch's chunks
    // (sorted by index) pair 1:1 with the attachments (in array order).
    const byPosition = [...batch.chunks].sort((a, b) => a.index - b.index)

    let refreshed = 0
    let failed = 0
    const fileIds = new Set<string>()

    await prisma.$transaction(async (tx) => {
      for (const [position, chunk] of byPosition.entries()) {
        fileIds.add(chunk.fileId)
        const attachment = outcome.data.attachments[position]
        if (attachment === undefined) {
          // The attachment is gone from Discord (message edited, data loss). The chunk
          // cannot be served truthfully any more; verify will report it as failed.
          await tx.chunk.update({ where: { id: chunk.id }, data: { status: ChunkStatus.FAILED } })
          failed += 1
          continue
        }
        if (BigInt(attachment.size) !== chunk.sizeBytes) {
          // Paired by position yet holding a different number of bytes than we recorded:
          // whatever sits in that message is not the chunk we stored. A loud failure beats
          // streaming bytes that belong to a different index.
          await tx.chunk.update({ where: { id: chunk.id }, data: { status: ChunkStatus.FAILED } })
          failed += 1
          continue
        }
        await tx.chunk.update({
          where: { id: chunk.id },
          data: {
            cdnUrl: attachment.url,
            urlExpiresAt: expiryFromUrl(attachment.url),
            status: ChunkStatus.STORED,
          },
        })
        refreshed += 1
      }
      await tx.chunkBatch.update({ where: { id: batch.id }, data: { refreshedAt: new Date() } })
    })

    const userIds = await prisma.fileObject.findMany({
      where: { id: { in: [...fileIds] }, status: { not: 'DELETED' }, linkHealthyAt: null },
      select: { id: true, userId: true },
    })

    await prisma.fileObject.updateMany({
      where: { id: { in: [...fileIds] }, status: { not: 'DELETED' } },
      data: refreshed > 0 ? { linkHealthyAt: new Date() } : { linkHealthyAt: null },
    })

    // Audited after the writes so the audit rows see the final state; one row per file so
    // an admin's per-user audit trail shows each repaired file, not one giant batch entry.
    for (const file of userIds) {
      await recordAudit({
        action: AuditAction.LINK_REFRESHED,
        targetUserId: file.userId,
        meta: { batchId: batch.id, fileId: file.id, messageId: batch.messageId ?? '', refreshed, failed },
      })
    }

    return {
      ok: refreshed > 0,
      refreshed,
      failed,
      hasBotToken: true,
      reason: 'SUCCESS',
      message: '',
    }
  })
}

/**
 * The proactive half: every batch that owns a stored chunk whose link expires within the
 * lead window (or was never parseable) is refreshed, so users open files that are already
 * re-armed instead of asking the first download to pay for it.
 *
 * Limited per sweep so one run cannot hammer the bot with every batch in one burst; the
 * scheduler calls this repeatedly, and anything still short is caught on the next pass.
 */
export async function refreshExpiringBatches(options: {
  leadMs?: number
  limit?: number
} = {}): Promise<{ scanned: number; refreshed: number; failed: number }> {
  const leadMs = options.leadMs ?? loadEnv().LINK_REFRESH_LEAD_MS
  const threshold = new Date(Date.now() + leadMs)

  const batches = await prisma.chunkBatch.findMany({
    where: {
      chunks: {
        some: {
          status: ChunkStatus.STORED,
          OR: [{ urlExpiresAt: null }, { urlExpiresAt: { lt: threshold } }],
        },
      },
      // Only batches whose webhook can actually answer are worth a bot read.
      webhook: { botTokenEnc: { not: null } },
    },
    select: { id: true },
    take: options.limit ?? 200,
  })

  let refreshed = 0
  let failed = 0
  for (const batch of batches) {
    const outcome = await refreshBatch(batch.id)
    if (outcome.ok) refreshed += outcome.refreshed
    if (outcome.failed > 0) failed += outcome.failed
  }
  return { scanned: batches.length, refreshed, failed }
}

export interface LinkRefreshScheduler {
  stop(): void
}

/**
 * Background sweeper for the API process. Runs on an unref'd timer so it never holds a
 * shut-down container open, guards against overlapping passes, and hands errors to the
 * logger rather than crashing the sweep silently.
 */
export function startLinkRefreshScheduler(options: {
  leadMs?: number
  intervalMs?: number
  onError?: (err: unknown) => void
} = {}): LinkRefreshScheduler {
  const env = loadEnv()
  const intervalMs = options.intervalMs ?? env.LINK_REFRESH_INTERVAL_MS
  const leadMs = options.leadMs ?? env.LINK_REFRESH_LEAD_MS

  let inFlight = false
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const tick = async (): Promise<void> => {
    if (!inFlight && !stopped) {
      inFlight = true
      try {
        await refreshExpiringBatches({ leadMs })
      } catch (err) {
        options.onError?.(err)
      } finally {
        inFlight = false
      }
    }
    schedule()
  }

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(tick, intervalMs)
    // The process (and the test suite) must be able to exit while this is waiting.
    timer.unref?.()
  }

  // First pass shortly after boot, not after a whole interval: a process that comes back
  // up after a long downtime should start repairing links immediately.
  timer = setTimeout(tick, Math.min(intervalMs, 60_000))
  timer.unref?.()

  return {
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
    },
  }
}