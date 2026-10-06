import { z } from 'zod'
import { AppError } from '../../http/errors.js'

/**
 * Upload request shapes.
 *
 * `sizeBytes` is deliberately accepted as a string as well as a number. A JavaScript
 * number silently loses precision above 2^53 and a 32-bit parse truncates above 2 GiB, and
 * this API is specifically for files where both are reachable. Anything that arrives as a
 * number is checked for being a safe integer before it is converted, so the failure is a
 * clear 400 rather than a file that is silently stored at the wrong size.
 */
export const initUploadSchema = z.object({
  name: z.string().trim().min(1, 'A file name is required').max(255),
  sizeBytes: z.union([z.string(), z.number()]),
  mimeType: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .default('application/octet-stream'),
  folderId: z.string().cuid().nullish(),
  clientId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional(),
})

export const chunkIndexSchema = z.coerce
  .number({ error: 'Chunk index must be a number' })
  .int('Chunk index must be a whole number')
  .min(0, 'Chunk index must not be negative')
  // Far above any reachable chunk count; it exists so a hostile index fails here rather
  // than in BigInt arithmetic downstream.
  .max(10_000_000)

/** Parses a size that must survive intact as a `BigInt` all the way to Postgres. */
export function parseSizeBytes(raw: string | number): bigint {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      throw AppError.badRequest(
        'INVALID_FILE_SIZE',
        'sizeBytes is not a safe integer. Send it as a decimal string instead of a JSON number.',
      )
    }
    if (raw <= 0) throw AppError.badRequest('INVALID_FILE_SIZE', 'sizeBytes must be greater than zero')
    return BigInt(raw)
  }

  if (!/^[1-9]\d*$/.test(raw)) {
    throw AppError.badRequest('INVALID_FILE_SIZE', 'sizeBytes must be a positive whole number')
  }
  return BigInt(raw)
}

export function parseChunkIndex(raw: string): number {
  const parsed = chunkIndexSchema.safeParse(raw)
  if (!parsed.success) {
    throw AppError.badRequest('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid chunk index')
  }
  return parsed.data
}
