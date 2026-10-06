import { Router, type Request, type Response } from 'express'
import { AppError } from '../../http/errors.js'
import { requireAuth, requireOnboarded } from '../../http/auth-middleware.js'
import { z } from 'zod'
import { createFolder, deleteFolder, renameFolder } from './files.service.js'

/**
 * Folder CRUD for the file manager. Bodies are small (a name, an optional parent), so they
 * sit happily behind the tight JSON parser `app.ts` mounts for this router.
 */

const folderIdSchema = z.string().cuid()
const folderBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  parentId: z.string().cuid().nullish(),
})

const routeParam = (raw: string | string[] | undefined): string | undefined =>
  Array.isArray(raw) ? raw[raw.length - 1] : raw

export function createFolderRouter(): Router {
  const router = Router()
  router.use(requireAuth, requireOnboarded)

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const parsed = folderBodySchema.safeParse(req.body)
    if (!parsed.success) {
      throw AppError.badRequest('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request')
    }
    const folder = await createFolder({
      userId: req.user!.id,
      name: parsed.data.name,
      parentId: parsed.data.parentId ?? undefined,
    })
    res.status(201).json({ folder })
  })

  router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = routeParam(req.params.id)
    const folderId = z.string().cuid().safeParse(id)
    if (!folderId.success) throw AppError.badRequest('VALIDATION_ERROR', 'A valid folder id is required')

    const parsed = z.object({ name: z.string().trim().min(1).max(255) }).safeParse(req.body)
    if (!parsed.success) {
      throw AppError.badRequest('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request')
    }

    const folder = await renameFolder({ userId: req.user!.id, folderId: folderId.data, name: parsed.data.name })
    res.json({ folder })
  })

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = routeParam(req.params.id)
    const folderId = z.string().cuid().safeParse(id)
    if (!folderId.success) throw AppError.badRequest('VALIDATION_ERROR', 'A valid folder id is required')

    const result = await deleteFolder({ userId: req.user!.id, folderId: folderId.data })
    res.json({ deleted: result })
  })

  return router
}