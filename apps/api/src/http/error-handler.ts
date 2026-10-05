import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { logger } from '../config/logger.js'
import { AppError } from './errors.js'

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } })
}

/**
 * Single error funnel. `AppError` exposes its own message; anything else is treated as
 * a bug and logged in full while the client receives a generic 500.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies error handlers by arity.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, code: err.code }, 'request failed')
    else logger.debug({ code: err.code, status: err.status }, 'request rejected')

    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
      },
    })
    return
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    })
    return
  }

  // Body parser failures arrive as plain errors with a status attached.
  const status = typeof (err as { status?: number })?.status === 'number' ? (err as { status: number }).status : 500
  if (status === 413) {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload exceeds the allowed size' } })
    return
  }
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return
  }

  logger.error({ err }, 'unhandled error')
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } })
}
