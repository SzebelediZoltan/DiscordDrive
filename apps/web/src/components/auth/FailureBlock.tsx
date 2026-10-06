import { failureTitle, retryAfterHint, type AuthApiError } from '@/lib/auth/api'

/** Inline alert for a failed submit. The account-state headings come from the error code. */
export function FailureBlock({ error }: { error: AuthApiError }) {
  const title = failureTitle(error)
  return (
    <div
      className="space-y-1 rounded-(--radius-control) bg-critical/10 px-3 py-2 text-sm text-critical"
      role="alert"
    >
      {title && <p className="font-medium">{title}</p>}
      <p>{error.message}</p>
      {retryAfterHint(error) && <p className="text-xs opacity-80">{retryAfterHint(error)}</p>}
    </div>
  )
}