import { useSearchParams } from 'react-router'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { FileExplorer } from '@/components/files/FileExplorer'
import { TutorialOverlay } from '@/components/onboarding/TutorialOverlay'
import { ResumeCard } from '@/components/uploads/ResumeCard'
import { UploadZone } from '@/components/uploads/UploadZone'
import { useCurrentUser } from '@/hooks/use-current-user'
import { useUploadQueue } from '@/hooks/use-upload-queue'

export function DashboardPage() {
  const { user } = useCurrentUser()
  const { queue } = useUploadQueue()
  const [searchParams] = useSearchParams()
  const folderId = searchParams.get('folder') === 'root' ? null : searchParams.get('folder')

  return (
    <div className="space-y-8">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Your files</h1>
        <p className="text-sm text-muted-foreground">
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
            <p className="text-sm text-muted-foreground">
              Your storage is private to your account. Once you sign in, files you upload appear here.
            </p>
          </div>
          <Button asChild size="lg">
            <a href="/login">Sign in</a>
          </Button>
        </motion.div>
      )}

      {user ? (
        <>
          <section className="space-y-4">
            <UploadZone
              label="Drop files here to upload"
              onFiles={(files) => queue.enqueue(files, folderId)}
            />
            <ResumeCard />
          </section>

          <FileExplorer />

          <TutorialOverlay />
        </>
      ) : (
        <section className="space-y-4">
          <UploadZone disabled onFiles={() => undefined} />
        </section>
      )}
    </div>
  )
}