import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void | Promise<void>
}

/**
 * Generic destructive confirmation (file delete, folder delete). Every destructive action
 * in the explorer goes through here so a stray click can never remove metadata.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  destructive = true,
  onConfirm,
}: ConfirmDialogProps) {
  async function confirm() {
    await onConfirm()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="size-4.5" aria-hidden />
            </span>
            <div className="space-y-1">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant={destructive ? 'destructive' : 'default'} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}