import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { ResumeCard } from '@/components/uploads/ResumeCard'
import { UploadZone } from '@/components/uploads/UploadZone'
import { useCurrentUser } from '@/hooks/use-current-user'
import { useUploadQueue } from '@/hooks/use-upload-queue'

const stats = [
  { label: 'Files', hint: 'Stored in your webhook' },
  { label: 'Used space', hint: 'Across all chunks' },
  { label: 'Webhooks', hint: 'Connected to Discord' },
]

export function DashboardPage() {
  const { user } = useCurrentUser()
  const { queue } = useUploadQueue()

  return (
    <div className="space-y-8">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Your files</h1>
        <p className="text-sm text-muted">
          Files live in your Discord webhook, sliced into durable chunks and indexed here.
        </p>
      </header>

      {!user && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="card-surface flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="space-y-1">
            <h2 className="font-medium text-ink">Sign in to see your files</h2>
            <p className="text-sm text-muted">
              Your storage is private to your account. Once you sign in, files you upload appear here.
            </p>
          </div>
          <Button asChild size="lg">
            <a href="/login">Sign in</a>
          </Button>
        </motion.div>
      )}

      <section className="space-y-4">
        {!user ? (
          <UploadZone disabled onFiles={() => undefined} />
        ) : (
          <>
            <UploadZone onFiles={(files) => queue.enqueue(files)} />
            <ResumeCard />
          </>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <div key={stat.label} className="card-surface p-5">
            <p className="text-2xl font-semibold text-faint">—</p>
            <p className="mt-1 text-sm font-medium text-ink">{stat.label}</p>
            <p className="text-xs text-muted">{stat.hint}</p>
          </div>
        ))}
      </div>
    </div>
  )
}