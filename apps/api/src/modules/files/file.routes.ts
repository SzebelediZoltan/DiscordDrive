import { Router, type Request, type Response } from 'express'
import { AppError } from '../../http/errors.js'
import { requireAuth, requireOnboarded } from '../../http/auth-middleware.js'
import { z } from 'zod'
import { abortUpload, completeUpload, initUpload, receiveChunk } from './upload.service.js'
import { downloadFile, presentFileMetadata, verifyFile } from './download.service.js'
import { initUploadSchema } from './upload.schemas.js'

/**
 * Upload and read routes.
 *
 * The JSON routes (`init`, `complete`, `abort`, metadata, verify) carry nothing larger than
 * a name and a size, so they are happy behind the parser `app.ts` mounts for this router.
 * The chunk route is deliberately written against the raw stream: `express.json()` never
 * touches it because the content type is `application/octet-stream`, which is the whole
 * reason a global body parser must not be introduced later. The download route streams too,
 * but out of this process — its response body is chunked Discord CDN bytes piped straight
 * to the client, and nothing in the request path buffers it.
 */

// File ids are cuid()s; anything else is not a file we could have handed out.
const fileIdSchema = z.string().cuid()

export function createFileRouter(): Router {
  const router = Router()
  router.use(requireAuth, requireOnboarded)

  router.post('/init', async (req: Request, res: Response): Promise<void> => {
    const parsed = initUploadSchema.safeParse(req.body)
    if (!parsed.success) {
      throw AppError.badRequest('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request')
    }

    const upload = await initUpload({ userId: req.user!.id, ip: req.ip, body: parsed.data })
    res.status(201).json({ upload })
  })

  router.post('/:id/chunks/:index', async (req: Request, res: Response): Promise<void> => {
    const fileId = fileIdSchema.safeParse(req.params.id)
    if (!fileId.success) throw AppError.notFound('File not found')

    const receipt = await receiveChunk({
      userId: req.user!.id,
      fileId: fileId.data,
      indexParam: String(req.params.index),
      req,
    })
    res.json(receipt)
  })

  router.post('/:id/complete', async (req: Request, res: Response): Promise<void> => {
    const fileId = fileIdSchema.safeParse(req.params.id)
    if (!fileId.success) throw AppError.notFound('File not found')

    const upload = await completeUpload({ userId: req.user!.id, fileId: fileId.data, ip: req.ip })
    res.json({ upload })
  })

  router.post('/:id/abort', async (req: Request, res: Response): Promise<void> => {
    const fileId = fileIdSchema.safeParse(req.params.id)
    if (!fileId.success) throw AppError.notFound('File not found')

    await abortUpload({ userId: req.user!.id, fileId: fileId.data, ip: req.ip })
    res.status(204).end()
  })

  // -- Read routes. All three are GETs, so they take no body and never allocate one. --

  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const fileId = fileIdSchema.safeParse(req.params.id)
    if (!fileId.success) throw AppError.notFound('File not found')

    res.json({ file: await presentFileMetadata({ userId: req.user!.id, fileId: fileId.data }) })
  })

  router.get('/:id/download', async (req: Request, res: Response): Promise<void> => {
    const fileId = fileIdSchema.safeParse(req.params.id)
    if (!fileId.success) throw AppError.notFound('File not found')

    // Never returns a JSON body; it either streams the file or throws before the first byte.
    await downloadFile({ userId: req.user!.id, fileId: fileId.data, res })
  })

  router.get('/:id/verify', async (req: Request, res: Response): Promise<void> => {
    const fileId = fileIdSchema.safeParse(req.params.id)
    if (!fileId.success) throw AppError.notFound('File not found')

    res.json({ result: await verifyFile({ userId: req.user!.id, fileId: fileId.data }) })
  })

  return router
}
