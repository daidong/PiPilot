/**
 * Theme boot — read the persisted theme preference and apply it to <html>
 * synchronously, BEFORE React renders. Without this, the first frame paints
 * with no `html.dark` / `html.light` class, so CSS custom properties aren't
 * resolved and `body { background: var(--color-bg-base) }` falls back to
 * the browser default white — a visible flash.
 *
 * Priority order:
 *   1. window.localStorage['rp-theme']  — explicit user choice
 *   2. 'dark' — matches .impeccable.md dark-first baseline
 *
 * We deliberately DO NOT fall back to `prefers-color-scheme`. The app is
 * dark-first by design; users who want light mode click the toggle once
 * and their choice persists globally. Respecting an OS-level "light"
 * preference would put the welcome screen at odds with the main app's
 * signature palette on every fresh install.
 */

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'rp-theme'

export function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch { /* localStorage may be unavailable in some contexts */ }
  return 'dark'
}

export function persistTheme(theme: Theme): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(STORAGE_KEY, theme) } catch { /* ignore */ }
}

/**
 * Apply a theme class to <html> immediately. Safe to call at module init
 * time because it doesn't depend on React. Idempotent: removes any
 * existing theme class first.
 */
export function applyThemeClass(theme: Theme): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.remove('dark', 'light')
  document.documentElement.classList.add(theme)
}

/** One-shot init: resolve + apply. Returns the resolved theme. */
export function bootTheme(): Theme {
  const theme = getInitialTheme()
  applyThemeClass(theme)
  return theme
}
