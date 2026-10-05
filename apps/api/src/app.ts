import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'
import { loadEnv } from './config/env.js'
import { logger } from './config/logger.js'
import { errorHandler, notFoundHandler } from './http/error-handler.js'
import { createAuthRouter } from './modules/auth/auth.routes.js'

export function createApp(): Express {
  const env = loadEnv()

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)

  app.use(
    helmet({
      // The SPA is served by nginx, which already sets a strict CSP for HTML documents.
      // This instance only serves JSON, so a CSP here would only get in the way.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  )

  const origins = env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  if (origins.length > 0) {
    app.use(cors({ origin: origins, credentials: true }))
  }

  app.use(pinoHttp({ logger, genReqId: (req) => req.headers['x-request-id'] ?? crypto.randomUUID() }))
  app.use(cookieParser())

  // NOTE: no body parser is mounted globally. Chunk uploads arrive as a raw
  // `application/octet-stream` stream and must never be buffered by the framework.
  // Routes that need JSON mount `express.json()` on themselves with a tight limit.

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'discorddrive-api', uptimeSeconds: Math.round(process.uptime()) })
  })

  // A tight JSON limit: the auth routes only ever receive credentials, so anything
  // larger is either a bug or an attempt to make the process buffer.
  app.use('/api/auth', express.json({ limit: '16kb' }), createAuthRouter())

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
