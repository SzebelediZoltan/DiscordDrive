/**
 * Everything about a signed Discord CDN attachment URL that is knowable without
 * talking to Discord.
 *
 * Both the upload path (to persist `urlExpiresAt`) and the link refresher (to persist
 * the freshly signed URLs a bot read returns) need to decode the `ex` parameter. Two
 * implementations of that one parse would eventually disagree — one would start trusting
 * links the other still treats as expired — so it lives here, once.
 */

/** Reads Discord's signed `ex` (expiry) parameter, hex epoch seconds, out of an attachment URL. */
export function expiryFromUrl(url: string | undefined): Date | null {
  if (!url) return null
  try {
    const parsed = new URL(url, 'https://discord.com')
    const ex = parsed.searchParams.get('ex')
    if (ex === null) return null
    const seconds = Number.parseInt(ex, 16)
    if (!Number.isFinite(seconds) || seconds <= 0) return null
    return new Date(seconds * 1000)
  } catch {
    // Not a URL at all, or an unparseable value: callers treat null as "cannot know,
    // refresh to find out" rather than "valid forever".
    return null
  }
}