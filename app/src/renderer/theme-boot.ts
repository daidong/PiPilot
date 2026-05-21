/**
 * Theme boot — read the persisted appearance preferences and apply them to
 * <html> synchronously, BEFORE React renders. Without this, the first frame
 * paints with no `html.dark` / `html.light` class, so CSS custom properties
 * aren't resolved and `body { background: var(--color-bg-base) }` falls back
 * to the browser default white — a visible flash.
 *
 * Two orthogonal axes:
 *   1. Theme preference — what the user picked: light, dark (gentle, the
 *      default dark), high-contrast (the original crisp dark), or system.
 *   2. Reading size — a multiplier applied only to prose surfaces.
 *
 * `Theme` stays the resolved binary appearance (light | dark) so every
 * `theme === 'dark'` check in the app (CodeMirror, audit colors) keeps working
 * unchanged — `high-contrast` resolves to `dark` plus an extra `.contrast`
 * class that a CSS layer (`html.dark.contrast`) consumes.
 *
 * Priority for the preference:
 *   1. localStorage['rp-theme'] — explicit user choice (incl. 'system')
 *   2. 'light' — the warm-paper theme is the most eye-friendly default
 *      (a light field constricts the pupil, which sharpens focus for
 *      astigmatic eyes and avoids the dark-mode halation problem).
 *
 * 'high-contrast' resolves to dark + a `.contrast` class (the original crisp
 * palette). The legacy 'dim' preference is migrated to the now-gentle 'dark'.
 */

export type Theme = 'light' | 'dark'
export type ThemePref = 'light' | 'dark' | 'high-contrast' | 'system'
export type ReadingSize = 'compact' | 'comfortable' | 'large'

const THEME_KEY = 'rp-theme'
const READING_KEY = 'rp-reading-size'

// 13px base × scale: compact=13, comfortable=14, large=16.
const READING_SCALE: Record<ReadingSize, string> = {
  compact: '1',
  comfortable: '1.077',
  large: '1.231',
}

function isThemePref(v: unknown): v is ThemePref {
  return v === 'light' || v === 'dark' || v === 'high-contrast' || v === 'system'
}

function isReadingSize(v: unknown): v is ReadingSize {
  return v === 'compact' || v === 'comfortable' || v === 'large'
}

export function getInitialThemePref(): ThemePref {
  if (typeof window === 'undefined') return 'light'
  try {
    const stored = window.localStorage.getItem(THEME_KEY)
    if (stored === 'dim') return 'dark'  // legacy: folded into the now-gentle dark
    if (isThemePref(stored)) return stored
  } catch { /* localStorage may be unavailable in some contexts */ }
  return 'light'
}

export function prefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Resolve a preference to the concrete appearance + high-contrast flag. */
export function resolveThemePref(pref: ThemePref): { theme: Theme; contrast: boolean } {
  if (pref === 'system') return { theme: prefersDark() ? 'dark' : 'light', contrast: false }
  if (pref === 'high-contrast') return { theme: 'dark', contrast: true }
  return { theme: pref, contrast: false }
}

export function persistThemePref(pref: ThemePref): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(THEME_KEY, pref) } catch { /* ignore */ }
}

/**
 * Apply a theme preference to <html> immediately. Safe to call at module
 * init time. Idempotent: clears prior theme classes first. Returns the
 * resolved binary appearance so callers can sync their state.
 */
export function applyThemePref(pref: ThemePref): Theme {
  if (typeof document === 'undefined') return resolveThemePref(pref).theme
  const { theme, contrast } = resolveThemePref(pref)
  const el = document.documentElement
  el.classList.remove('dark', 'light')
  el.classList.add(theme)
  el.classList.toggle('contrast', contrast)
  return theme
}

export function getInitialReadingSize(): ReadingSize {
  if (typeof window === 'undefined') return 'comfortable'
  try {
    const stored = window.localStorage.getItem(READING_KEY)
    if (isReadingSize(stored)) return stored
  } catch { /* ignore */ }
  return 'comfortable'  // 14px base — easier on the eyes than the old 13px default
}

export function persistReadingSize(size: ReadingSize): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(READING_KEY, size) } catch { /* ignore */ }
}

export function applyReadingSize(size: ReadingSize): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--reading-scale', READING_SCALE[size])
}

/** One-shot init: resolve + apply theme and reading size. Returns the
 *  resolved appearance. */
export function bootTheme(): Theme {
  const theme = applyThemePref(getInitialThemePref())
  applyReadingSize(getInitialReadingSize())
  return theme
}
