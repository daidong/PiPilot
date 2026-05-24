/**
 * Per-author dot colors for the Library attribution indicator (RFC-013).
 *
 * Design constraint (.impeccable.md): the app runs on ONE accent (teal) plus a
 * secondary (indigo), and the status palette (success/error/warning/info) is a
 * separate vocabulary that must never be borrowed for decoration. So this
 * categorical palette is deliberately carved OUT of those hues — no teal (~180),
 * green (~145), amber (~75), red (~25), indigo (~275), info-blue (~245). What's
 * left is a muted cool-to-magenta arc plus one warm orange and a gold.
 *
 * Each entry is theme-aware via CSS `light-dark()`: a DARKER tone on the
 * warm-paper light ground, a LIGHTER tone on the warm-dark ground. A single
 * lightness can't clear contrast on both (gold is luminous, violet is dark), so
 * the two tones are tuned per theme. Every entry verified ≥4.3:1 on light and
 * ≥5.7:1 on dark against the respective bg-base — well past the 3:1 floor for a
 * 6px graphical object (WCAG 1.4.11), with margin for the maintainer's
 * astigmatism. (`color-scheme` is set per theme in global.css, so light-dark()
 * resolves correctly inside the inline style.)
 *
 * The local user ("you") is NOT colored from here — see EntityTabs.
 */
export const AUTHOR_PALETTE = [
  'light-dark(oklch(0.52 0.17 300), oklch(0.72 0.17 300))', // violet
  'light-dark(oklch(0.53 0.18 332), oklch(0.72 0.18 332))', // magenta
  'light-dark(oklch(0.54 0.18 356), oklch(0.72 0.18 356))', // rose
  'light-dark(oklch(0.52 0.13 52),  oklch(0.75 0.13 52))',  // orange
  'light-dark(oklch(0.51 0.15 262), oklch(0.72 0.15 262))', // periwinkle
  'light-dark(oklch(0.53 0.11 210), oklch(0.74 0.11 210))', // cyan
  'light-dark(oklch(0.49 0.16 318), oklch(0.70 0.16 318))', // plum
  'light-dark(oklch(0.55 0.12 92),  oklch(0.78 0.12 92))',  // gold
] as const

/**
 * Deterministic actorId → palette color. Stable across sessions and machines
 * (same id always maps to the same hue), so a collaborator keeps one color
 * everywhere their work appears.
 */
export function authorColor(actorId: string): string {
  let hash = 0
  for (let i = 0; i < actorId.length; i++) {
    hash = (hash * 31 + actorId.charCodeAt(i)) >>> 0
  }
  return AUTHOR_PALETTE[hash % AUTHOR_PALETTE.length]
}
