import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

export type SessionUser = {
  id: string
  email: string
  displayName: string
  role: 'ADMIN' | 'USER'
  status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED'
  approved: boolean
  onboardingComplete: boolean
}

export interface CurrentUserState {
  user: SessionUser | null
  loading: boolean
  refresh: () => Promise<void>
}

async function fetchCurrentUser(): Promise<SessionUser | null> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' })
    if (res.status === 401) return null
    if (!res.ok) return null
    const data = (await res.json()) as { user: SessionUser }
    return data.user
  } catch {
    return null
  }
}

function useCurrentUserLoader(): CurrentUserState {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setUser(await fetchCurrentUser())
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { user, loading, refresh }
}

/**
 * Private session copy for callers mounted outside `CurrentUserProvider`.
 * `enabled` depends only on whether a provider exists, which never changes over a
 * component's life, so every hook below is called unconditionally — that is what
 * keeps this fallback rules-of-hooks compliant while still skipping the fetch.
 */
function useFallbackCurrentUser(enabled: boolean): CurrentUserState {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(enabled)
  const refresh = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    try {
      setUser(await fetchCurrentUser())
    } finally {
      setLoading(false)
    }
  }, [enabled])
  useEffect(() => {
    if (enabled) void refresh()
  }, [refresh, enabled])
  return { user, loading, refresh }
}

const CurrentUserContext = createContext<CurrentUserState | null>(null)

export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const state = useCurrentUserLoader()
  return <CurrentUserContext.Provider value={state}>{children}</CurrentUserContext.Provider>
}

/** Reads the shell-level session; falls back to a private fetch when used outside a provider. */
export function useCurrentUser(): CurrentUserState {
  const ctx = useContext(CurrentUserContext)
  const fallback = useFallbackCurrentUser(ctx === null)
  return ctx ?? fallback
}
