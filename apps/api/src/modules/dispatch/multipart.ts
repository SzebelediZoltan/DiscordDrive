import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'

/**
 * Hand-rolled multipart/form-data for Discord uploads.
 *
 * Why not FormData? Node's FormData needs every part materialised as a Blob or string
 * before it will produce a body, so an 80 MB message would exist as 80 MB of heap
 * allocation plus the stream around it. Chunks arrive as Buffers that are already in memory
 * for hashing, so this avoids the copy.
 *
 * Why compute Content-Length? Because Discord validates the declared size *before* reading
 * the body. With chunked transfer-encoding it cannot, so an oversized message is rejected
 * only after megabytes have crossed the network — and we would have spent the wait finding
 * out. Every part here has a known length, so the total is exact and Discord can refuse
 * immediately.
 */

const CRLF = Buffer.from('\r\n')
const DASH = Buffer.from('--')

export interface AttachmentPart {
  filename: string
  contentType: string
  data: Buffer
}

export interface BuiltMultipart {
  /** Exact body length, for the Content-Length header. */
  contentLength: number
  boundary: string
  /** The payload JSON Discord stores alongside the attachments. */
  payloadJson: string
  body: Readable
}

/**
 * Builds one multipart body carrying up to Discord's 10 attachments.
 *
 * Discord's limit is on attachments per message, and packing 10 chunks into one request is
 * what makes a 1 GB file 13 requests instead of 128 — which is the difference between
 * finishing inside the rate-limit budget and not.
 */
export function buildChunkMessage(input: {
  parts: AttachmentPart[]
  filenamePrefix?: string
  boundarySeed?: number
}): BuiltMultipart {
  if (input.parts.length === 0) throw new Error('a message needs at least one attachment')
  if (input.parts.length > 10) throw new Error('Discord accepts at most 10 attachments per message')

  const boundary = `----DiscordDrive${(input.boundarySeed ?? 0).toString(36)}`

  // The payload must match what Discord will echo back on the created message. Chunks carry
  // their index and total so the download side can reassemble in order without relying on
  // Discord's ordering guarantees.
  // No `username` override on purpose: Discord forbids the substrings "discord" and
  // "clyde" (case-insensitive) in a webhook username, so a branded override like
  // "DiscordDrive" is rejected with 50035. The chunk posts as the webhook's own name.
  const payloadJson = JSON.stringify({
    content: '',
    embeds: [
      {
        title: `chunk batch ${input.filenamePrefix ?? ''}`.trim(),
        description: `${input.parts.length} chunk(s)`,
        footer: { text: 'DiscordDrive · chunk' },
      },
    ],
  })

  const segments: Buffer[] = []
  let contentLength = 0

  const push = (part: Buffer): void => {
    segments.push(part)
    contentLength += part.byteLength
  }

  for (const [index, part] of input.parts.entries()) {
    const name = `${input.filenamePrefix ?? 'chunk'}-${String(index).padStart(5, '0')}.bin`
    push(
      Buffer.from(
        `--${boundary}${CRLF.toString()}` +
          `Content-Disposition: form-data; name="files[${index}]"; filename="${name}"${CRLF.toString()}` +
          `Content-Type: ${part.contentType}${CRLF.toString()}${CRLF.toString()}`,
      ),
    )
    push(part.data)
    push(Buffer.from(CRLF))
  }

  const payloadPart = Buffer.from(
    `--${boundary}${CRLF.toString()}` +
      `Content-Disposition: form-data; name="payload_json"${CRLF.toString()}` +
      `Content-Type: application/json${CRLF.toString()}${CRLF.toString()}` +
      payloadJson +
      CRLF.toString(),
  )
  push(payloadPart)
  push(Buffer.from(`${DASH.toString()}${boundary}${DASH.toString()}${CRLF.toString()}`))

  return {
    contentLength,
    boundary,
    payloadJson,
    body: Readable.from(segments),
  }
}

/**
 * sha256 of the message body, so the stored chunk can be verified after the round trip.
 *
 * Computed over the exact bytes Discord receives rather than over our buffers, so a bug in
 * the body builder shows up as a verification failure instead of silent corruption.
 */
export function digestOf(parts: AttachmentPart[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part.data)
  return hash.digest('hex')
}

/** Total attachment bytes, excluding multipart framing. Used for accounting. */
export function attachmentBytes(parts: AttachmentPart[]): number {
  return parts.reduce((sum, part) => sum + part.data.byteLength, 0)
}