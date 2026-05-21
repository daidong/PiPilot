import React from 'react'
import { useUIStore } from '../../stores/ui-store'
import { useRecapStore } from '../../stores/recap-store'
import { SegmentedControl, type SegmentOption } from './SegmentedControl'
import type { ThemePref, ReadingSize } from '../../theme-boot'

const THEME_OPTIONS: SegmentOption<ThemePref>[] = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'High Contrast', value: 'high-contrast' },
  { label: 'System', value: 'system' },
]

const READING_OPTIONS: SegmentOption<ReadingSize>[] = [
  { label: 'Compact', value: 'compact' },
  { label: 'Comfortable', value: 'comfortable' },
  { label: 'Large', value: 'large' },
]

const THEME_HINT: Record<ThemePref, string> = {
  light: 'Warm-paper light theme. Most eye-friendly for long reading and astigmatism.',
  dark: 'Gentle dark (~8:1) — minimizes the halation/afterimage of bright text on a near-black ground.',
  'high-contrast': 'The original crisp high-contrast dark. Sharpest, but most prone to halation.',
  system: 'Follows your OS appearance and switches automatically.',
}

const READING_HINT: Record<ReadingSize, string> = {
  compact: 'Densest. Matches the rest of the interface.',
  comfortable: 'A touch larger for easier sustained reading.',
  large: 'Largest. Best for long reading sessions.',
}

/**
 * Appearance settings. Unlike the other tabs these talk directly to the
 * ui-store (theme/reading size are global localStorage preferences, not the
 * disk-persisted AppSettings), so changes apply instantly with no save step.
 * Layout mirrors the sibling settings panels (ResearchSettings et al.): a
 * section heading, a static description, the control, then a dynamic hint.
 */
export function AppearanceSettings() {
  const themePref = useUIStore((s) => s.themePref)
  const setThemePref = useUIStore((s) => s.setThemePref)
  const readingSize = useUIStore((s) => s.readingSize)
  const setReadingSize = useUIStore((s) => s.setReadingSize)
  const recapEnabled = useRecapStore((s) => s.enabled)
  const setRecapEnabled = useRecapStore((s) => s.setEnabled)

  return (
    <div className="space-y-7">
      {/* Theme */}
      <div>
        <h4 className="text-sm font-semibold t-text mb-2">Theme</h4>
        <p className="text-[12px] t-text-muted mb-3 leading-relaxed">
          The app's appearance. Dim lowers contrast for long reading; System follows your OS.
        </p>
        <SegmentedControl options={THEME_OPTIONS} value={themePref} onChange={setThemePref} />
        <p className="text-[11px] t-text-muted mt-2 leading-relaxed">{THEME_HINT[themePref]}</p>
      </div>

      {/* Reading Size */}
      <div>
        <h4 className="text-sm font-semibold t-text mb-2">Reading Size</h4>
        <p className="text-[12px] t-text-muted mb-3 leading-relaxed">
          Scales answer text and the Wiki Reader for comfortable long reading. Interface chrome keeps its density.
        </p>
        <SegmentedControl options={READING_OPTIONS} value={readingSize} onChange={setReadingSize} />
        <p className="text-[11px] t-text-muted mt-2 leading-relaxed">{READING_HINT[readingSize]}</p>
        {/* Live preview — rendered as .md-prose so it reflects the current
            --reading-scale exactly, the same surface answers are read on. */}
        <div className="mt-3 rounded-lg border t-border t-bg-base px-4 py-3">
          <div className="md-prose" style={{ color: 'var(--color-text)' }}>
            <p>The quick brown fox reads research papers for hours — comfortably.</p>
          </div>
        </div>
      </div>

      {/* Session recap */}
      <div>
        <h4 className="text-sm font-semibold t-text mb-2">Session recap</h4>
        <p className="text-[12px] t-text-muted mb-3 leading-relaxed">
          When you step away and come back, show a short "welcome back" briefing of what you
          were doing and what's next. Generated in the background while you're away.
        </p>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={recapEnabled}
            onChange={(e) => setRecapEnabled(e.target.checked)}
            className="mt-0.5 accent-[var(--color-accent)]"
          />
          <span className="text-[13px] t-text">
            Show a recap when I return after being away
          </span>
        </label>
      </div>
    </div>
  )
}
