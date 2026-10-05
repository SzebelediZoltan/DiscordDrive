import { WebhookTestStatus } from '../../generated/prisma/client.js'
import { decrypt, encrypt, maskToken, maskWebhookUrl } from '../../lib/crypto.js'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../http/errors.js'
import type { ParsedWebhookUrl } from './webhook.schemas.js'

/**
 * Storage for webhook credentials.
 *
 * Every read of the encrypted columns goes through `decryptCredential`, and nothing outside
 * this module ever touches `webhookUrlEnc` or `botTokenEnc` directly. That is the whole
 * point of the module: an accidental `select` somewhere else cannot leak a credential,
 * because the plaintext only exists inside these functions.
 */

type WebhookRow = {
  id: string
  userId: string
  name: string
  webhookId: string
  webhookUrlEnc: string
  webhookUrlIv: string
  webhookUrlTag: string
  botTokenEnc: string | null
  botTokenIv: string | null
  botTokenTag: string | null
  channelId: string | null
  isDefault: boolean
  maxChunkBytes: number | null
  lastTestStatus: WebhookTestStatus
  lastTestedAt: Date | null
  lastTestError: string | null
  createdAt: Date
  updatedAt: Date
}

export async function decryptCredential(row: WebhookRow): Promise<ParsedWebhookUrl> {
  const url = decrypt({ enc: row.webhookUrlEnc, iv: row.webhookUrlIv, tag: row.webhookUrlTag })
  // Re-validated on the way out: a row written by an older build, or one edited directly in
  // the database, must not be able to make the API talk to an arbitrary host.
  const { parseWebhookUrl } = await import('./webhook.schemas.js')
  return parseWebhookUrl(url)
}

export async function getBotToken(row: WebhookRow): Promise<string | null> {
  if (!row.botTokenEnc || !row.botTokenIv || !row.botTokenTag) return null
  return decrypt({ enc: row.botTokenEnc, iv: row.botTokenIv, tag: row.botTokenTag })
}

export async function loadWebhook(userId: string, id: string): Promise<WebhookRow> {
  const row = await prisma.webhook.findFirst({ where: { id, userId } })
  if (!row) throw AppError.notFound('Webhook not found')
  return row
}

/**
 * The API shape. Note what is absent: the URL, the token, and anything derived from either
 * beyond a masked last-4. `hasBotToken` tells the UI whether to offer link refresh without
 * revealing the credential.
 *
 * Async because it decrypts to compute the last-4 hints. That is a deliberate trade: a
 * keyed digest would avoid it but would produce a value that is not the real last four
 * characters, so a user checking their webhook against Discord's own UI would see a
 * mismatch and file a bug. Correctness for the person reading it wins over one AES decrypt
 * on a list endpoint.
 */
export async function presentWebhook(row: WebhookRow) {
  const url = await decryptCredential(row)
  const botToken = await getBotToken(row)

  return {
    id: row.id,
    name: row.name,
    webhookId: row.webhookId,
    urlHint: maskWebhookUrl(url.normalized),
    tokenLast4: url.token.slice(-4),
    hasBotToken: botToken !== null,
    botTokenLast4: botToken === null ? null : maskToken(botToken).last4,
    channelId: row.channelId,
    isDefault: row.isDefault,
    maxChunkBytes: row.maxChunkBytes,
    lastTestStatus: row.lastTestStatus,
    lastTestedAt: row.lastTestedAt,
    lastTestError: row.lastTestError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function setDefault(userId: string, id: string): Promise<void> {
  // Transactional because "exactly one default per user" is the invariant, and two
  // concurrent requests would otherwise leave two defaults behind.
  await prisma.$transaction([
    prisma.webhook.updateMany({ where: { userId, isDefault: true, id: { not: id } }, data: { isDefault: false } }),
    prisma.webhook.update({ where: { id, userId }, data: { isDefault: true } }),
  ])
}