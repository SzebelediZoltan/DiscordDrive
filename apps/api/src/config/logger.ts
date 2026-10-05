import pino from 'pino'
import { loadEnv } from '../config/env.js'

export const logger = pino({
  level: loadEnv().LOG_LEVEL,
  base: { service: 'discorddrive-api' },
  // Webhook URLs and bot tokens must never reach the log, in any form.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.webhookUrl',
      '*.botToken',
      '*.webhookUrlEnc',
      '*.botTokenEnc',
      '*.passwordHash',
    ],
    censor: '[redacted]',
  },
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
})
