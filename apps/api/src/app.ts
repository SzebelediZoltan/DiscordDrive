import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'
import { loadEnv } from './config/env.js'
import { logger } from './config/logger.js'
import { errorHandler, notFoundHandler } from './http/error-handler.js'
import { sameOriginGuard } from './http/same-origin-guard.js'
import { createAuthRouter } from './modules/auth/auth.routes.js'
import { createFileRouter } from './modules/files/file.routes.js'
import { createFolderRouter } from './modules/files/folder.routes.js'
import { createAdminRouter, createMyWaitlistRouter, createWaitlistRouter } from './modules/waitlist/waitlist.routes.js'
import { createWebhookRouter } from './modules/webhooks/webhook.routes.js'

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

  // CSRF: reject a mutation whose browser-supplied Origin points somewhere other
  // than this host. Runs before any route so a forged POST never reaches a handler.
  app.use(sameOriginGuard)

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

  // Public counter: reachable without a session, because it has to render on the
  // registration page for someone who has not signed up yet.
  app.use('/api/waitlist', createWaitlistRouter())
  app.use('/api/me/waitlist', createMyWaitlistRouter())
  // Admin routes take a small JSON body (a role, nothing more), so they get the same
  // tight limit as auth rather than a global parser that would also touch chunk uploads.
  app.use('/api/admin', express.json({ limit: '16kb' }), createAdminRouter())

  // Webhook setup posts only small JSON. The upload routes that follow deliberately mount
  // their own raw stream handlers rather than relying on a global parser.
  app.use('/api/webhooks', express.json({ limit: '64kb' }), createWebhookRouter())

  // Chunk bodies are `application/octet-stream`, which `express.json()` skips without
  // reading, so the parser here only serves init/complete/abort.
  app.use('/api/files', express.json({ limit: '64kb' }), createFileRouter())
  app.use('/api/folders', express.json({ limit: '16kb' }), createFolderRouter())

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
