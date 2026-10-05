import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { loadEnv } from '../config/env.js'
import { AppError } from '../http/errors.js'

/**
 * AES-256-GCM for the two credentials this app holds: webhook URLs and bot tokens.
 *
 * Why GCM rather than CBC: GCM authenticates as well as encrypts, so a tampered
 * ciphertext fails loudly instead of decrypting to attacker-chosen garbage. That matters
 * here because a wrong plaintext would be posted to Discord as if it were a real webhook.
 *
 * IV, ciphertext and auth tag are stored in separate columns. The IV is not secret and does
 * not need to be, but it must never be reused with the same key, which is why it is random
 * per encryption and not derived.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // 96 bits, the size GCM is specified for.
const TAG_LENGTH = 16

function key(): Buffer {
  const { APP_ENCRYPTION_KEY } = loadEnv()
  return Buffer.from(APP_ENCRYPTION_KEY, 'hex')
}

export interface Ciphertext {
  enc: string
  iv: string
  tag: string
}

export function encrypt(plaintext: string): Ciphertext {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key(), iv)

  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

  return {
    enc: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

export function decrypt({ enc, iv, tag }: Ciphertext): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))

    return Buffer.concat([
      decipher.update(Buffer.from(enc, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // A failure here means a wrong APP_ENCRYPTION_KEY or a modified row. Either way the
    // caller must not proceed as if it had a usable credential.
    throw AppError.unavailable(
      'CREDENTIAL_UNREADABLE',
      'Stored credentials could not be decrypted. APP_ENCRYPTION_KEY may have changed.',
    )
  }
}

/**
 * Safe to log, safe to return over the API.
 *
 * Shows the Discord host and the webhook id, which are not secrets, and the last 4
 * characters of the token, which is enough for a person to recognise which of their
 * webhooks this is. Everything else is dropped.
 */
export function maskWebhookUrl(url: string): { hint: string; last4: string } {
  const last4 = url.slice(-4)
  return { hint: 'https://discord.com/api/webhooks/…', last4 }
}

export function maskToken(token: string): { hint: string; last4: string } {
  return { hint: '••••••••', last4: token.slice(-4) }
}