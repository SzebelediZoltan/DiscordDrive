import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScreenshotPlaceholder } from '@/components/brand/ScreenshotPlaceholder'
import { cn } from '@/lib/utils'

const STORAGE_KEY = 'ddrive:tutorial:v1'

interface TutorialStep {
  title: string
  body: string
  caption: string
}

const STEPS: TutorialStep[] = [
  {
    title: 'Create a Discord server',
    body: 'Open Discord and click the + icon in the left server list. Choose “Create My Own Server”, give it a name, and you are done — that server becomes your storage.',
    caption: '[SCREENSHOT: Discord — creating a server]',
  },
  {
    title: 'Connect a webhook',
    body: 'In that server, go to Settings → Integrations → Webhooks, create a new webhook and copy the URL. Paste it under Settings in DiscordDrive and your files live in that channel.',
    caption: '[SCREENSHOT: Discord ... Webhooks — copying the webhook URL]',
  },
  {
    title: 'Drop your files',
    body: 'Upload happens right here. Drop files anywhere on the dashed zone and the full-screen progress overlay tracks every chunk on its way to your Discord webhook.',
    caption: '[SCREENSHOT: Upload in progress — dropzone with full-screen progress]',
  },
]

function dismissTutorial(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // Private mode: the re-show on refresh is acceptable.
  }
}

/** One-shot onboarding shown over the dashboard after the first sign-in. */
export function TutorialOverlay() {
  const hasSeen = () => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      return false
    }
  }

  const [dismissed, setDismissed] = useState(false)
  const [step, setStep] = useState(0)
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (hasSeen()) return
    const timer = setTimeout(() => setShow(true), 600)
    return () => clearTimeout(timer)
  }, [])

  function close() {
    setShow(false)
    setDismissed(true)
    dismissTutorial()
  }

  const current = STEPS[step]
  const isLast = step === STEPS.length - 1

  return (
    <AnimatePresence>
      {show && !dismissed && (
        <motion.div
          key="tutorial-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/80 backdrop-blur-xl sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label="Welcome to DiscordDrive"
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ ease: [0.22, 1, 0.36, 1], duration: 0.25 }}
            className="card-surface m-4 w-full max-w-lg"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <p className="text-sm font-semibold text-ink">Welcome to DiscordDrive</p>
              <Button size="icon-sm" variant="ghost" aria-label="Skip tutorial" onClick={close}>
                <X className="size-4" aria-hidden />
              </Button>
            </div>

            <div className="p-5 pt-4">
              <div className="flex items-center gap-2" aria-hidden>
                {STEPS.map((_, i) => (
                  <span
                    key={i}
                    className={cn(
                      'h-1.5 flex-1 rounded-full transition-colors',
                      i <= step ? 'bg-blurple' : 'bg-line',
                    )}
                  />
                ))}
              </div>

              <div className="mt-5 overflow-hidden" key={step}>
                <motion.div
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, ease: 'easeOut' }}
                >
                  <p className="text-xs font-medium uppercase tracking-wide text-blurple-soft">
                    Step {step + 1} of {STEPS.length}
                  </p>
                  <h2 className="mt-1 text-xl font-semibold tracking-tight text-ink">
                    {current.title}
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{current.body}</p>
                  <div className="mt-4">
                    <ScreenshotPlaceholder caption={current.caption} aspect="aspect-[16/9]" />
                  </div>
                </motion.div>
              </div>

              <div className="mt-5 flex items-center justify-between">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={step === 0}
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                >
                  <ChevronLeft className="size-4" aria-hidden />
                  Back
                </Button>

                {isLast ? (
                  <Button size="sm" onClick={close}>
                    Let&apos;s go
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>
                    Next
                    <ChevronRight className="size-4" aria-hidden />
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}