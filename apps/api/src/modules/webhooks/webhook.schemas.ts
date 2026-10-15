import { z } from 'zod'
import { AppError } from '../../http/errors.js'

/**
 * A Discord webhook URL is a live credential: anyone holding it can post to the user's
 * channel. So it is parsed strictly rather than accepted as "any URL" — a typo that
 * pointed at some other host would otherwise be stored encrypted and then fail later,
 * mid-upload, with an error the user cannot act on.
 *
 * Accepted hosts are Discord's own. `discordapp.com` is the legacy host and still resolves
 * for old webhooks, so it is allowed; nothing else is.
 */

const SNOWFLAKE = String.raw`\d{17,20}`

const WEBHOOK_URL_RE = new RegExp(
  String.raw`^https://(?:discord(?:app)?\.com)/api(?:/v\d+)?/webhooks/(${SNOWFLAKE})/([A-Za-z0-9_.\-]+)$`,
)

export interface ParsedWebhookUrl {
  webhookId: string
  token: string
  /** Normalised to the current host and path, so a legacy URL is rewritten on save. */
  normalized: string
}

export function parseWebhookUrl(input: string): ParsedWebhookUrl {
  const value = input.trim()

  const match = WEBHOOK_URL_RE.exec(value)
  if (!match) {
    // Separate the "not a URL" case from the "wrong shape" case, because the fix differs.
    let parsed: URL | null = null
    try {
      parsed = new URL(value)
    } catch {
      throw AppError.badRequest('INVALID_WEBHOOK_URL', 'That does not look like a URL')
    }

    if (parsed.protocol !== 'https:') {
      throw AppError.badRequest('INVALID_WEBHOOK_URL', 'A Discord webhook URL must start with https://')
    }

    throw AppError.badRequest(
      'INVALID_WEBHOOK_URL',
      'A Discord webhook URL looks like https://discord.com/api/webhooks/<id>/<token>',
    )
  }

  const [, webhookId, token] = match as unknown as [string, string, string]

  return {
    webhookId,
    token,
    normalized: `https://discord.com/api/webhooks/${webhookId}/${token}`,
  }
}

/**
 * Bot tokens are far more powerful than a webhook: a bot token is an account credential
 * that can act anywhere the bot can. Shape is validated so an obvious paste error is
 * caught at setup rather than at refresh time, hours later.
 *
 * The check is deliberately loose about exact length and character classes. Discord has
 * changed its token format before, and rejecting a valid future token at setup would be
 * worse than accepting a malformed one that fails loudly on first use.
 */
const BOT_TOKEN_RE = /^[A-Za-z0-9._\-]{50,120}$/

export function validateBotToken(token: string | undefined | null): string | null {
  if (token === undefined || token === null || token.trim() === '') return null

  const value = token.trim()
  if (!BOT_TOKEN_RE.test(value)) {
    throw AppError.badRequest(
      'INVALID_BOT_TOKEN',
      'That does not look like a Discord bot token. Copy it from Developer Portal > Bot > Reset Token.',
    )
  }
  return value
}

export const createWebhookSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the webhook a name').max(64),
    url: z.string().trim().min(1, 'A webhook URL is required').max(300),
    /** Optional. Only needed if you want attachment links to survive their expiry. */
    botToken: z.string().trim().max(200).optional(),
    isDefault: z.boolean().optional().default(false),
  })
  .strict()

export const updateWebhookSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    url: z.string().trim().min(1).max(300).optional(),
    botToken: z.string().trim().max(200).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')

/**
 * A message for the test button. Discord renders this in the user's channel, so it says who
 * sent it and that it is a test — otherwise a user who clicks it has no idea what just
 * appeared next to their uploads.
 */
export function testEmbed(input: { webhookName: string; sentBy: string }) {
  return {
    // No `username` override on purpose: Discord forbids the substrings "discord" and
    // "clyde" (case-insensitive) in a webhook username, so a branded override like
    // "DiscordDrive" is rejected with 400 code 50035. Posting without the field shows
    // the webhook's own name instead, which is what the user set in Discord anyway.
    embeds: [
      {
        title: 'DiscordDrive is connected',
        description:
          'This channel is now used as storage by DiscordDrive. Chunks uploaded here are private to the webhook that sent them — they are not visible in the channel itself.',
        color: 0x5865f2,
        fields: [
          { name: 'Webhook', value: input.webhookName, inline: true },
          { name: 'Verified by', value: input.sentBy, inline: true },
        ],
        footer: { text: 'DiscordDrive · storage channel' },
        timestamp: new Date().toISOString(),
      },
    ],
  }
}