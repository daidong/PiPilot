import React from 'react'
import { useUIStore } from '../../stores/ui-store'
import { SegmentedControl, type SegmentOption } from './SegmentedControl'
import type { ThemePref, ReadingSize } from '../../theme-boot'

const THEME_OPTIONS: SegmentOption<ThemePref>[] = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'Dim', value: 'dim' },
  { label: 'System', value: 'system' },
]

const READING_OPTIONS: SegmentOption<ReadingSize>[] = [
  { label: 'Compact', value: 'compact' },
  { label: 'Comfortable', value: 'comfortable' },
  { label: 'Large', value: 'large' },
]

const THEME_HINT: Record<ThemePref, string> = {
  light: 'Warm-paper light theme, tuned for daylight reading.',
  dark: 'The signature high-contrast dark theme.',
  dim: 'Lower-contrast dark — eases halation and brightness fatigue over long reading sessions.',
  system: 'Follows your OS appearance and switches automatically.',
}

/**
 * Appearance settings. Unlike the other tabs these talk directly to the
 * ui-store (theme/reading size are global localStorage preferences, not the
 * disk-persisted AppSettings), so changes apply instantly with no save step.
 */
export function AppearanceSettings() {
  const themePref = useUIStore((s) => s.themePref)
  const setThemePref = useUIStore((s) => s.setThemePref)
  const readingSize = useUIStore((s) => s.readingSize)
  const setReadingSize = useUIStore((s) => s.setReadingSize)

  return (
    <div className="space-y-7 max-w-xl">
      <section>
        <h3 className="text-[13px] font-semibold t-text mb-1">Theme</h3>
        <p className="text-[12px] t-text-secondary mb-3">{THEME_HINT[themePref]}</p>
        <SegmentedControl options={THEME_OPTIONS} value={themePref} onChange={setThemePref} />
      </section>

      <section>
        <h3 className="text-[13px] font-semibold t-text mb-1">Reading size</h3>
        <p className="text-[12px] t-text-secondary mb-3">
          Scales answer text and the Wiki Reader for comfortable long reading. Interface chrome keeps its density.
        </p>
        <SegmentedControl options={READING_OPTIONS} value={readingSize} onChange={setReadingSize} />
        {/* Live preview — rendered as .md-prose so it reflects the current
            --reading-scale exactly, the same surface answers are read on. */}
        <div className="mt-3 rounded-lg border t-border t-bg-base px-4 py-3">
          <div className="md-prose" style={{ color: 'var(--color-text)' }}>
            <p>The quick brown fox reads research papers for hours — comfortably.</p>
          </div>
        </div>
      </section>
    </div>
  )
}
