import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { AuditAction } from '../../generated/prisma/client.js'
import { recordAudit } from '../../lib/audit.js'
import { encrypt } from '../../lib/crypto.js'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../http/errors.js'
import { requireAuth, requireOnboarded } from '../../http/auth-middleware.js'
import { getWebhookInfo } from './discord.client.js'
import { probeWebhookLimit, recordTestFailure, testWebhook } from './webhook.probe.js'
import {
  createWebhookSchema,
  parseWebhookUrl,
  updateWebhookSchema,
  validateBotToken,
} from './webhook.schemas.js'
import { decryptCredential, loadWebhook, presentWebhook } from './webhook.service.js'

/**
 * Every route is scoped by `userId`. There is no route that accepts a webhook id without
 * also constraining the owner, so a valid id belonging to someone else is a 404 rather than
 * someone else's credential being read or deleted.
 */

const idSchema = z.string().cuid('Invalid webhook id')

export function createWebhookRouter(): Router {
  const router = Router()
  router.use(requireAuth, requireOnboarded)

  router.get('/', async (req: Request, res: Response): Promise<void> => {
    const rows = await prisma.webhook.findMany({
      where: { userId: req.user!.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })
    res.json({ webhooks: await Promise.all(rows.map(presentWebhook)) })
  })

  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = idSchema.safeParse(req.params.id)
    if (!id.success) throw AppError.notFound('Webhook not found')

    res.json({ webhook: await presentWebhook(await loadWebhook(req.user!.id, id.data)) })
  })

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const parsed = createWebhookSchema.safeParse(req.body)
    if (!parsed.success) throw AppError.badRequest('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request')

    const url = parseWebhookUrl(parsed.data.url)
    const botToken = validateBotToken(parsed.data.botToken)

    const urlCipher = encrypt(url.normalized)
    const botCipher = botToken === null ? null : encrypt(botToken)

    const created = await prisma.$transaction(async (tx) => {
      // The first webhook becomes the default without being asked, so a new user has one
      // working storage destination before they open the file manager.
      const existing = await tx.webhook.count({ where: { userId: req.user!.id } })
      const isDefault = parsed.data.isDefault === true || existing === 0

      if (isDefault) {
        await tx.webhook.updateMany({ where: { userId: req.user!.id, isDefault: true }, data: { isDefault: false } })
      }

      const row = await tx.webhook.create({
        data: {
          userId: req.user!.id,
          name: parsed.data.name,
          webhookId: url.webhookId,
          webhookUrlEnc: urlCipher.enc,
          webhookUrlIv: urlCipher.iv,
          webhookUrlTag: urlCipher.tag,
          botTokenEnc: botCipher?.enc ?? null,
          botTokenIv: botCipher?.iv ?? null,
          botTokenTag: botCipher?.tag ?? null,
          isDefault,
        },
      })

      await recordAudit(
        {
          action: AuditAction.WEBHOOK_CREATED,
          targetUserId: req.user!.id,
          actorUserId: req.user!.id,
          actorIp: req.ip,
          // Name and the non-secret snowflake only. The URL and token are never logged,
          // not even hashed, because a hash of a short token is a brute-force away from
          // the token itself.
          meta: { webhookId: row.id, name: row.name, discordWebhookId: row.webhookId, hasBotToken: botToken !== null },
        },
        tx,
      )

      return row
    })

    res.status(201).json({ webhook: await presentWebhook(created) })
  })

  router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = idSchema.safeParse(req.params.id)
    if (!id.success) throw AppError.badRequest('VALIDATION_ERROR', 'Invalid webhook id')

    const parsed = updateWebhookSchema.safeParse(req.body)
    if (!parsed.success) throw AppError.badRequest('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request')

    // Loaded first so ownership is checked before anything is written, and so a 404 is
    // returned for someone else's webhook rather than a partial update.
    await loadWebhook(req.user!.id, id.data)
    const data: Record<string, unknown> = {}

    if (parsed.data.name !== undefined) data.name = parsed.data.name

    if (parsed.data.url !== undefined) {
      const url = parseWebhookUrl(parsed.data.url)
      const cipher = encrypt(url.normalized)
      data.webhookId = url.webhookId
      data.webhookUrlEnc = cipher.enc
      data.webhookUrlIv = cipher.iv
      data.webhookUrlTag = cipher.tag
      // A new URL means the old measurements describe a different destination.
      data.maxChunkBytes = null
      data.lastTestStatus = 'UNKNOWN'
      data.lastTestedAt = null
      data.lastTestError = null
      data.channelId = null
    }

    if (parsed.data.botToken !== undefined) {
      const token = validateBotToken(parsed.data.botToken)
      if (token === null) {
        data.botTokenEnc = null
        data.botTokenIv = null
        data.botTokenTag = null
      } else {
        const cipher = encrypt(token)
        data.botTokenEnc = cipher.enc
        data.botTokenIv = cipher.iv
        data.botTokenTag = cipher.tag
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (parsed.data.isDefault === true) {
        await tx.webhook.updateMany({
          where: { userId: req.user!.id, isDefault: true, id: { not: id.data } },
          data: { isDefault: false },
        })
        data.isDefault = true
      }

      return tx.webhook.update({ where: { id: id.data }, data })
    })

    res.json({ webhook: await presentWebhook(updated) })
  })

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = idSchema.safeParse(req.params.id)
    if (!id.success) throw AppError.badRequest('VALIDATION_ERROR', 'Invalid webhook id')

    const existing = await loadWebhook(req.user!.id, id.data)

    await prisma.$transaction(async (tx) => {
      await tx.webhook.delete({ where: { id: id.data } })

      // Promote another webhook rather than leaving the user with none, since every upload
      // needs a default destination.
      if (existing.isDefault) {
        const next = await tx.webhook.findFirst({
          where: { userId: req.user!.id },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
        if (next) await tx.webhook.update({ where: { id: next.id }, data: { isDefault: true } })
      }

      await recordAudit(
        {
          action: AuditAction.WEBHOOK_DELETED,
          targetUserId: req.user!.id,
          actorUserId: req.user!.id,
          actorIp: req.ip,
          meta: { webhookId: id.data, name: existing.name },
        },
        tx,
      )
    })

    res.status(204).end()
  })

  router.post('/:id/test', async (req: Request, res: Response): Promise<void> => {
    const id = idSchema.safeParse(req.params.id)
    if (!id.success) throw AppError.badRequest('VALIDATION_ERROR', 'Invalid webhook id')

    const row = await loadWebhook(req.user!.id, id.data)
    const url = await decryptCredential(row)

    // Metadata first: a deleted webhook fails here with 404 before a message is posted,
    // which is a cheaper way to learn the same thing.
    const info = await getWebhookInfo(url)
    if (!info.ok) {
      // Persisted here as well as in the send path, because this branch is where a
      // deleted or mistyped webhook is actually caught. Leaving it unrecorded would mean
      // the dashboard shows "never tested" for the most common failure there is.
      await recordTestFailure(row.id, info.message)
      res.json({ ok: false, code: info.code, message: info.message, latencyMs: info.latencyMs })
      return
    }

    const result = await testWebhook({
      url: url.normalized,
      webhookName: row.name,
      sentBy: req.user!.email,
      webhookRowId: row.id,
    })

    await recordAudit({
      action: AuditAction.WEBHOOK_TESTED,
      targetUserId: req.user!.id,
      actorUserId: req.user!.id,
      actorIp: req.ip,
      meta: { webhookId: row.id, ok: result.ok },
    })

    if (result.ok) {
      res.json({
        ok: true,
        latencyMs: result.latencyMs,
        channelId: result.channelId,
        message: 'Check your Discord channel for a confirmation message.',
      })
      return
    }

    res.json({ ok: false, code: result.code, message: result.message, latencyMs: result.latencyMs })
  })

  router.post('/:id/probe-limit', async (req: Request, res: Response): Promise<void> => {
    const id = idSchema.safeParse(req.params.id)
    if (!id.success) throw AppError.badRequest('VALIDATION_ERROR', 'Invalid webhook id')

    const row = await loadWebhook(req.user!.id, id.data)
    const url = await decryptCredential(row)

    const result = await probeWebhookLimit(row.id, url.normalized)

    // Kept as a warning rather than an error: the probe worked, and the user should know
    // their channel now holds the test messages it cost.
    res.json({
      ...result,
      maxChunkMiB: Number((result.maxChunkBytes / (1024 * 1024)).toFixed(2)),
      warning:
        result.messagesLeftBehind > 0
          ? `The probe posted ${result.messagesLeftBehind} test message(s) to your channel. Delete them in Discord if you do not want them.`
          : null,
    })
  })

  return router
}
