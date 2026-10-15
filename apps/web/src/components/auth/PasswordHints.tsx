import { Check } from 'lucide-react'
import { passwordChecks } from '@/lib/auth/api'
import { cn } from '@/lib/utils'

export function PasswordHints({ password }: { password: string }) {
  const checks = passwordChecks(password)
  const rows: { key: keyof typeof checks; label: string }[] = [
    { key: 'length', label: 'At least 10 characters' },
    { key: 'lower', label: 'A lowercase letter' },
    { key: 'upper', label: 'An uppercase letter' },
    { key: 'digit', label: 'A number' },
  ]
  return (
    <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1" aria-label="Password requirements">
      {rows.map((row) => (
        <li
          key={row.key}
          className={cn(
            'flex items-center gap-1.5 text-xs',
            checks[row.key] ? 'text-positive' : 'text-faint',
          )}
        >
          <Check className={cn('size-3', !checks[row.key] && 'opacity-30')} aria-hidden />
          {row.label}
        </li>
      ))}
    </ul>
  )
}