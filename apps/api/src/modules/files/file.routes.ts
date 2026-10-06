import { Router, type Request, type Response } from 'express'
import { AppError } from '../../http/errors.js'
import { requireAuth, requireOnboarded } from '../../http/auth-middleware.js'
import { z } from 'zod'
import { abortUpload, completeUpload, initUpload, receiveChunk } from './upload.service.js'
import { initUploadSchema } from './upload.schemas.js'

/**
 * Upload routes.
 *
 * The JSON routes (`init`, `complete`, `abort`) carry nothing larger than a name and a
 * size, so they are happy behind the parser `app.ts` mounts for this router. The chunk
 * route is deliberately written against the raw stream: `express.json()` never touches it
 * because the content type is `application/octet-stream`, which is the whole reason a
 * global body parser must not be introduced later.
 */

const fileIdSchema = z.string().min(1)

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

  return router
}
