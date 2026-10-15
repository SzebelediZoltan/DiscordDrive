import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

/**
 * Stored format: `scrypt$<saltHex>$<derivedHex>`.
 *
 * scrypt rather than bcrypt because it is in the Node standard library, so hashing
 * costs no dependency and no native build step, and because it is memory-hard. The
 * async form keeps a login from blocking the event loop, which matters on a single
 * process serving concurrent uploads.
 *
 * The cost parameters are Node's defaults (N=16384, r=8, p=1). They are not stored per
 * hash: changing them later would invalidate every existing password. Bump them only
 * alongside a rehash-on-login migration.
 */
const KEY_LENGTH = 64
const SALT_LENGTH = 16

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scrypt(password, salt, KEY_LENGTH)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

/**
 * Constant-time verification. Returns false rather than throwing for malformed input,
 * so a corrupted row cannot turn into a 500 on the login path.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false

  const [, saltHex, derivedHex] = parts
  if (!saltHex || !derivedHex) return false

  const expected = Buffer.from(derivedHex, 'hex')
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.byteLength)

  if (actual.byteLength !== expected.byteLength) return false
  return timingSafeEqual(actual, expected)
}