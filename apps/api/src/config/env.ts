import { z } from 'zod'

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1')

/** Accepts a MiB value, validates it in MiB, and exposes it as bytes. */
const mib = (defaultValue: number, min: number, max: number) =>
  z.coerce
    .number({ error: 'must be a number' })
    .min(min, `must be at least ${min} MiB`)
    .max(max, `must be at most ${max} MiB`)
    .default(defaultValue)
    .transform((v) => Math.trunc(v * 1024 * 1024))

const int = (defaultValue: number, min: number, max: number) =>
  z.coerce
    .number({ error: 'must be a number' })
    .int('must be a whole number')
    .min(min)
    .max(max)
    .default(defaultValue)

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_TTL_SECONDS: int(60 * 60 * 24 * 7, 300, 60 * 60 * 24 * 30),
  COOKIE_NAME: z.string().default('dd_session'),
  COOKIE_SECURE: bool,
  /** Origins allowed to call the API with credentials. Same-origin via nginx needs none. */
  CORS_ORIGINS: z.string().default(''),

  /** AES-256-GCM key for webhook URLs and bot tokens, hex encoded (64 chars). */
  APP_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'APP_ENCRYPTION_KEY must be 64 hex characters'),

  ADMIN_EMAIL: z.string().email().default('szebe99@gmail.com'),
  ADMIN_PASSWORD: z.string().min(8).default('Harkaly88'),

  /** Size of one chunk of a file. Capped by the per-webhook probed limit. */
  CHUNK_SIZE_MIB: mib(8, 1, 25),
  /** Chunks packed into a single Discord message. Discord allows 10 attachments. */
  CHUNKS_PER_MESSAGE: int(10, 1, 10),
  /** Upper bound on the logical size of a single uploaded file. */
  MAX_FILE_SIZE_MIB: mib(1024 * 512, 1, 1024 * 512 * 8),

  /** Per-webhook in-flight webhook POSTs. Discord allows 5 requests / 2 s per webhook. */
  DISCORD_CONCURRENCY: int(3, 1, 10),
  /** Across all webhooks, to protect the API process. */
  DISCORD_GLOBAL_CONCURRENCY: int(16, 1, 64),
  /** Minimum gap between two webhook POSTs on the same webhook. */
  DISCORD_MIN_INTERVAL_MS: int(250, 0, 2000),
  DISCORD_MAX_ATTEMPTS: int(5, 1, 10),

  /**
   * When 0, chunks are streamed straight through to Discord with no per-request buffer.
   * Above 0, each in-flight request may buffer this many bytes, which buys retry-ability
   * after a mid-body 429 and sha256 verification of the exact bytes we stored.
   */
  CHUNK_BUFFER_MIB: mib(9, 0, 64),

  /** Directory for optional persisted chunks. Always swept by the janitor. */
  UPLOAD_TMP_DIR: z.string().default('/tmp/discorddrive'),

  /**
   * Base URL for the Discord API. Point this at the bundled fake Discord server to run
   * the whole stack without a real webhook.
   */
  DISCORD_API_BASE: z.string().url().default('https://discord.com/api/v10'),

  /** Runs the in-process fake Discord server alongside the API (dev/demo). */
  FAKE_DISCORD: bool,
  FAKE_DISCORD_PORT: int(4001, 1, 65535),
  /** Simulated CDN link lifetime in seconds. 0 means links are born expired, for tests. */
  FAKE_DISCORD_LINK_TTL_S: int(3600, 0, 60 * 60 * 24 * 30),
  /** Token the fake Discord server demands on the bot-authenticated read route. */
  FAKE_DISCORD_BOT_TOKEN: z.string().default('test-bot-token'),
})

export type Env = z.infer<typeof schema>

let cached: Env | null = null

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${detail}\n\nRun scripts/setup-env.sh to generate a .env file.`)
  }
  cached = parsed.data
  return cached
}

export function resetEnvCache(): void {
  cached = null
}

export const isProduction = (): boolean => loadEnv().NODE_ENV === 'production'
