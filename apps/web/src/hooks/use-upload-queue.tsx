import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { UploadQueue, type UploadTask } from '@/lib/upload/queue'

interface UploadQueueState {
  queue: UploadQueue
  tasks: UploadTask[]
}

const UploadQueueContext = createContext<UploadQueueState | null>(null)

export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const [queue] = useState(() => new UploadQueue())

  const subscribe = useCallback((callback: () => void) => queue.subscribe(callback), [queue])
  const getSnapshot = useCallback(() => queue.getSnapshot(), [queue])
  const tasks = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    queue.onEvent = (event) => {
      switch (event.type) {
        case 'queued':
          toast(`${event.fileName} queued`)
          break
        case 'completed':
          toast.success(`${event.fileName} uploaded`)
          break
        case 'failed':
          toast.error(`${event.fileName} failed`, {
            description: event.reason,
            action: event.retriable
              ? {
                  label: 'Retry',
                  onClick: () => queue.retry(event.taskId),
                }
              : undefined,
          })
          break
        case 'replanned':
          toast.info('Re-planning upload', {
            description: 'The server reset the chunk size; this upload resumes on its own.',
          })
          break
        default:
          break
      }
    }
    return () => {
      queue.onEvent = null
    }
  }, [queue])

  return <UploadQueueContext.Provider value={{ queue, tasks }}>{children}</UploadQueueContext.Provider>
}

export function useUploadQueue(): UploadQueueState {
  const ctx = useContext(UploadQueueContext)
  if (!ctx) throw new Error('useUploadQueue must be used inside <UploadQueueProvider>')
  return ctx
}