import type { FileRow } from '@/lib/files/api'
import { cn } from '@/lib/utils'

/**
 * Link-health truth for a file row, straight from the backend's list response. The backend
 * computes `linkHealthy` with the download path's definition (every chunk re-armed and
 * unexpired), so this badge never argues with whether a download would actually succeed.
 *
 * Approximation in the price tier is deliberate: a "likely expiring soon" state (within the
 * refresh-lead window) gets its own amber treatment so an admin of a webhook without a bot
 * token sees it coming, while the backend stays the authority on the binary call.
 */
export function LinkHealthBadge({ file }: { file: FileRow }) {
  if (file.status !== 'COMPLETE') return null

  const href = file.linkExpiresAt ? new Date(file.linkExpiresAt).getTime() : null
  const now = Date.now()
  const expiringSoon = href !== null && href <= now + 24 * 60 * 60 * 1000

  return (
    <span
      className={cn(
        'inline-flex h-5 w-fit items-center gap-1.5 rounded-full border bg-transparent px-2 text-xs font-medium',
        file.linkHealthy
          ? 'border-positive/30 text-positive'
          : expiringSoon
            ? 'border-amber-400/30 text-amber-400'
            : 'border-destructive/30 text-destructive',
      )}
      title={
        file.linkHealthy
          ? 'Storage links are fresh'
          : expiringSoon
            ? 'Attachment links expire soon'
            : 'Storage links have expired'
      }
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          file.linkHealthy ? 'bg-positive' : expiringSoon ? 'bg-amber-400' : 'bg-destructive',
        )}
        aria-hidden
      />
      {file.linkHealthy ? 'Healthy' : expiringSoon ? 'Expiring' : 'Expired'}
    </span>
  )
}