import { Link } from 'react-router'

interface LogoProps {
  to?: string
}

/**
 * Brand lockup. The asset (public/brand/logo.png) already contains the wordmark,
 * so it is rendered alone — no text span next to it.
 */
export function Logo({ to = '/' }: LogoProps) {
  return (
    <Link
      to={to}
      className="inline-flex items-center rounded-(--radius-control) outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      aria-label="DiscordDrive home"
    >
      <img src="/brand/logo.png" alt="" className="size-9 shrink-0 object-contain" />
    </Link>
  )
}