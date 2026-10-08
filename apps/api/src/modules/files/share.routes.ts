import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { AppError } from '../../http/errors.js'
import { requireAuth, requireOnboarded } from '../../http/auth-middleware.js'
import { prepareStream, writeFileStream } from './download.service.js'
import { resolvePublicShare, searchUsers } from './share.service.js'
import { shareTokenSchema } from './share.schemas.js'

/**
 * Two routers, one concern.
 *
 * `createShareLinkRouter` is the public side of a LINK share: it is intentionally mounted
 * without auth or a JSON body parser, because the only thing it reads is a token and the
 * only thing it writes is bytes. The token is the whole capability — mode validation and
 * the unguessable-token guarantee live in `resolvePublicShare`.
 *
 * `createUserSearchRouter` is the recipient autocomplete for the share dialog. It is auth
 * + onboarded gated like every other interactive endpoint, and only ever returns id, email
 * and display name for ACTIVE accounts while excluding the caller, so the owner cannot
 * accidentally share with their own parked or pending account.
 */

export function createShareLinkRouter(): Router {
  const router = Router()

  router.get('/:token', async (req: Request, res: Response): Promise<void> => {
    const token = shareTokenSchema.safeParse(req.params.token)
    if (!token.success) throw AppError.notFound('File not found')

    const file = await resolvePublicShare(token.data)
    const { chunks, hasToken } = await prepareStream(file)
    await writeFileStream({
      res,
      file,
      chunks,
      hasToken,
      range: null,
      disposition: 'attachment',
    })
  })

  return router
}

export function createUserSearchRouter(): Router {
  const router = Router()
  router.use(requireAuth, requireOnboarded)

  const querySchema = z.object({
    q: z.string().trim().min(1).max(100),
  })

  router.get('/search', async (req: Request, res: Response): Promise<void> => {
    const query = querySchema.safeParse(req.query)
    if (!query.success) {
      throw AppError.badRequest('VALIDATION_ERROR', query.error.issues[0]?.message ?? 'Invalid query')
    }

    res.json({ users: await searchUsers({ userId: req.user!.id, q: query.data.q }) })
  })

  return router
}