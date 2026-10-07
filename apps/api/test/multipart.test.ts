import { describe, expect, it } from 'vitest'
import { attachmentBytes, buildChunkMessage, digestOf } from '../src/modules/dispatch/multipart.js'

/**
 * The multipart body is where bytes get shaped for Discord, so these tests check the framing
 * against what an independent parser reads back — not against our own strings. Asserting the
 * builder against itself would pass even if both were wrong in the same way.
 */

const part = (bytes: number, marker = 'a') => ({
  filename: `chunk-${marker}.bin`,
  contentType: 'application/octet-stream',
  data: Buffer.alloc(bytes, marker),
})

async function readAll(body: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Minimal multipart parser, written independently of the builder. */
function parse(raw: Buffer, boundary: string) {
  const parts: Array<{ name: string; filename: string | null; contentType: string | null; body: Buffer }> = []
  const chunks = raw.toString('binary').split(`--${boundary}`)
  for (const chunk of chunks.slice(1)) {
    if (chunk.startsWith('--')) break
    const split = chunk.indexOf('\r\n\r\n')
    if (split === -1) continue
    const headerBlock = chunk.slice(0, split)
    // Trailing CRLF belongs to the delimiter, not the content.
    const body = Buffer.from(chunk.slice(split + 4, chunk.length - 2), 'binary')

    const name = /name="([^"]*)"/.exec(headerBlock)?.[1] ?? ''
    const filename = /filename="([^"]*)"/.exec(headerBlock)?.[1] ?? null
    const contentType = /Content-Type: (.+)/.exec(headerBlock)?.[1] ?? null
    parts.push({ name, filename, contentType, body })
  }
  return parts
}

describe('buildChunkMessage', () => {
  it('declares exactly the bytes it sends', async () => {
    const built = buildChunkMessage({ parts: [part(1024), part(2048)], filenamePrefix: 'file1' })
    const raw = await readAll(built.body)

    // A wrong Content-Length is worse than none: Discord would truncate or hang waiting for
    // bytes that never arrive.
    expect(raw.byteLength).toBe(built.contentLength)
    expect(built.contentLength).toBe(raw.byteLength)
  })

  it('round-trips through an independent parser', async () => {
    const parts = [part(100, 'x'), part(200, 'y'), part(300, 'z')]
    const built = buildChunkMessage({ parts, filenamePrefix: 'movie' })
    const parsed = parse(await readAll(built.body), built.boundary)

    const files = parsed.filter((p) => p.name.startsWith('files['))
    expect(files).toHaveLength(3)
    expect(files.map((f) => f.body.byteLength)).toEqual([100, 200, 300])
    // Index-ordered field names are how the download side finds each chunk.
    expect(files.map((f) => f.name)).toEqual(['files[0]', 'files[1]', 'files[2]'])
    expect(files.map((f) => f.filename)).toEqual(['movie-00000.bin', 'movie-00001.bin', 'movie-00002.bin'])
  })

  it('preserves bytes exactly, including values that look like framing', async () => {
    // A chunk containing CRLF and boundary-looking text must survive untouched. This is the
    // classic multipart corruption case, and it would only show up as a hash mismatch after
    // a 1 GB upload.
    const hostile = Buffer.concat([
      Buffer.from('--nope\r\n\r\n'),
      Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x1a]),
      Buffer.alloc(64, 0xcc),
    ])
    const built = buildChunkMessage({ parts: [{ filename: 'x.bin', contentType: 'application/octet-stream', data: hostile }] })
    const parsed = parse(await readAll(built.body), built.boundary)
    const file = parsed.find((p) => p.name === 'files[0]')!

    expect(file.body).toEqual(hostile)
    expect(digestOf([{ filename: 'x.bin', contentType: 'application/octet-stream', data: hostile }])).toBe(
      (await import('node:crypto')).createHash('sha256').update(hostile).digest('hex'),
    )
  })

  it('includes payload_json so the message is not empty to Discord', async () => {
    const built = buildChunkMessage({ parts: [part(10)], filenamePrefix: 'doc' })
    const parsed = parse(await readAll(built.body), built.boundary)
    const payload = parsed.find((p) => p.name === 'payload_json')

    expect(payload).toBeDefined()
    expect(payload!.contentType).toBe('application/json')
    const decoded = JSON.parse(payload!.body.toString('utf8'))
    expect(decoded.embeds[0].description).toContain('1 chunk')
  })

  it('carries no username override, which real Discord rejects with 50035', async () => {
    const built = buildChunkMessage({ parts: [part(10)], filenamePrefix: 'doc' })
    const parsed = parse(await readAll(built.body), built.boundary)
    const payload = parsed.find((p) => p.name === 'payload_json')!

    // Discord forbids the substrings "discord" and "clyde" (case-insensitive) in a webhook
    // username, so the chunk posts under the webhook's own name instead of a branded one.
    expect(JSON.parse(payload.body.toString('utf8'))).not.toHaveProperty('username')
  })

  it('carries the batch prefix so a message can be traced back to its file', async () => {
    const built = buildChunkMessage({ parts: [part(10)], filenamePrefix: 'invoice-42' })
    const raw = (await readAll(built.body)).toString('utf8')
    expect(raw).toContain('invoice-42-00000.bin')
  })

  it('accepts Discord’s maximum of 10 attachments', async () => {
    const parts = Array.from({ length: 10 }, (_, i) => part(64, String(i)))
    const built = buildChunkMessage({ parts })
    const parsed = parse(await readAll(built.body), built.boundary)
    expect(parsed.filter((p) => p.name.startsWith('files['))).toHaveLength(10)
  })

  it('refuses an empty or oversized batch rather than sending something Discord rejects', () => {
    // An empty message is a silent data loss: the request succeeds and stores nothing.
    expect(() => buildChunkMessage({ parts: [] })).toThrow()

    const eleven = Array.from({ length: 11 }, () => part(8))
    expect(() => buildChunkMessage({ parts: eleven })).toThrow(/10/)
  })

  it('grows content length with data, so a caller can budget before sending', () => {
    const small = buildChunkMessage({ parts: [part(1024)] })
    const large = buildChunkMessage({ parts: [part(8 * 1024 * 1024)] })
    expect(large.contentLength).toBeGreaterThan(small.contentLength)
    expect(attachmentBytes([{ filename: 'a', contentType: 'x', data: Buffer.alloc(8 * 1024 * 1024) }])).toBe(
      8 * 1024 * 1024,
    )
  })

  it('produces a distinct boundary per seed so concurrent messages cannot interleave', async () => {
    const a = buildChunkMessage({ parts: [part(16)], boundarySeed: 1 })
    const b = buildChunkMessage({ parts: [part(16)], boundarySeed: 2 })
    expect(a.boundary).not.toBe(b.boundary)
  })
})