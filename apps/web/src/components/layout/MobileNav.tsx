import { useState } from 'react'
import { Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Logo } from '@/components/brand/Logo'
import { SidebarNav } from '@/components/layout/SidebarNav'
import type { SessionUser } from '@/hooks/use-current-user'

interface MobileNavProps {
  user: SessionUser | null
}

export function MobileNav({ user }: MobileNavProps) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open navigation">
          <Menu className="size-5" aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0 p-0">
        <div className="flex h-14 items-center border-b border-border px-5">
          <SheetTitle asChild>
            <Logo />
          </SheetTitle>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SidebarNav user={user} onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}