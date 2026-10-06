/**
 * Application error carrying an HTTP status and a stable machine-readable code.
 * The `code` is what the frontend switches on, so it must never be reworded casually.
 */
export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown
  readonly expose: boolean

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
    this.expose = status < 500
  }

  static badRequest(code: string, message: string, details?: unknown): AppError {
    return new AppError(400, code, message, details)
  }

  static unauthorized(code = 'UNAUTHORIZED', message = 'Authentication required'): AppError {
    return new AppError(401, code, message)
  }

  static forbidden(code = 'FORBIDDEN', message = 'You do not have access to this resource'): AppError {
    return new AppError(403, code, message)
  }

  /**
   * Used for both "does not exist" and "belongs to someone else" so the API never
   * reveals whether a given id exists.
   */
  static notFound(message = 'Not found'): AppError {
    return new AppError(404, 'NOT_FOUND', message)
  }

  static conflict(code: string, message: string, details?: unknown): AppError {
    return new AppError(409, code, message, details)
  }

  /**
   * The resource used to exist and is still referenced, but its backing data is gone
   * (here: a Discord CDN link that expired with no bot token to refresh it). Distinct
   * from 404 because the caller knows it *should* be there and the fix is upstream.
   */
  static gone(code: string, message: string, details?: unknown): AppError {
    return new AppError(410, code, message, details)
  }

  static payloadTooLarge(code: string, message: string, details?: unknown): AppError {
    return new AppError(413, code, message, details)
  }

  static tooManyRequests(code: string, message: string, retryAfterSeconds?: number): AppError {
    return new AppError(429, code, message, { retryAfterSeconds })
  }

  static upstream(code: string, message: string, details?: unknown): AppError {
    return new AppError(502, code, message, details)
  }

  static unavailable(code: string, message: string, details?: unknown): AppError {
    return new AppError(503, code, message, details)
  }
}
