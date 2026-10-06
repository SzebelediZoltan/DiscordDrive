import { cn } from '@/lib/utils'

interface ScreenshotPlaceholderProps {
  /** Label rendered inside the frame, e.g. `[SCREENSHOT: File manager — file rows]`. */
  caption: string
  className?: string
  aspect?: string
}

/**
 * Dashed neon frame that marks where a brand screenshot or artwork will live.
 * Drop real assets in later without touching layout code.
 */
export function ScreenshotPlaceholder({
  caption,
  className,
  aspect = 'aspect-[16/9]',
}: ScreenshotPlaceholderProps) {
  return (
    <div className={cn('card-surface p-1.5', className)}>
      <div
        className={cn(
          'flex size-full items-center justify-center overflow-hidden rounded-(--radius-card) border border-dashed border-blurple/40 bg-canvas/50 px-4',
          aspect,
        )}
      >
        <span className="max-w-full break-words text-center font-mono text-[0.8rem] leading-relaxed text-faint">
          {caption}
        </span>
      </div>
    </div>
  )
}