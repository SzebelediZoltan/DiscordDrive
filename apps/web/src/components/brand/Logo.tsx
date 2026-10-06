import { Link } from 'react-router'

interface LogoProps {
  withWordmark?: boolean
  to?: string
}

/** Static brand lockup. The asset lives under public/brand so it is served as-is. */
export function Logo({ withWordmark = true, to = '/' }: LogoProps) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-2.5 rounded-(--radius-control) outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      aria-label="DiscordDrive home"
    >
      <img src="/brand/logo.png" alt="" className="size-8 shrink-0 object-contain" />
      {withWordmark && (
        <span className="text-lg font-semibold tracking-tight text-ink">DiscordDrive</span>
      )}
    </Link>
  )
}