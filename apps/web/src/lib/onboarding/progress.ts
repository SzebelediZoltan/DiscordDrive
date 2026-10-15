/**
 * Wizard progress survives a refresh, as the acceptance criteria demand. Only
 * non-secrets are stored: the current step and the id of a saved webhook. A bot token is
 * never written to localStorage — the backend keeps that encrypted, and `hasBotToken`
 * already tells the resume flow whether one was attached.
 */

export interface OnboardingProgress {
  step: number
  webhookId?: string
  webhookName?: string
  testedOk?: boolean
}

const keyFor = (userId: string) => `ddrive:onboarding:v1:${userId}`

export function readProgress(userId: string): OnboardingProgress | null {
  try {
    const raw = localStorage.getItem(keyFor(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<OnboardingProgress>
    if (typeof parsed.step !== 'number') return null
    return {
      step: Math.min(3, Math.max(0, parsed.step)),
      webhookId: typeof parsed.webhookId === 'string' ? parsed.webhookId : undefined,
      webhookName: typeof parsed.webhookName === 'string' ? parsed.webhookName : undefined,
      testedOk: parsed.testedOk === true,
    }
  } catch {
    return null
  }
}

export function writeProgress(userId: string, progress: OnboardingProgress): void {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(progress))
  } catch {
    /* private mode or quota — the wizard still works, just without resume */
  }
}

export function clearProgress(userId: string): void {
  try {
    localStorage.removeItem(keyFor(userId))
  } catch {
    /* ignore */
  }
}