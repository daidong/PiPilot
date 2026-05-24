/**
 * Per-author dot colors for the Library attribution indicator (RFC-013).
 *
 * Design constraint (.impeccable.md): the app runs on ONE accent (teal) plus a
 * secondary (indigo), and the status palette (success/error/warning/info) is a
 * separate vocabulary that must never be borrowed for decoration. So this
 * categorical palette is deliberately carved OUT of those hues — no teal (~180),
 * green (~145), amber (~75), red (~25), indigo (~275), info-blue (~245). What's
 * left is a muted cool-to-magenta arc plus one warm orange, all at a single
 * mid-lightness so a 6px dot reads on both the warm-paper light ground and the
 * warm-dark ground without per-theme variants.
 *
 * The local user ("you") is NOT colored from here — they get the teal accent
 * (t-bg-accent) so collaborators' dots are what pops when scanning the list.
 */
export const AUTHOR_PALETTE = [
  'oklch(0.62 0.15 300)', // violet
  'oklch(0.60 0.17 332)', // magenta
  'oklch(0.64 0.15 356)', // rose
  'oklch(0.67 0.14 52)',  // orange
  'oklch(0.58 0.13 262)', // periwinkle
  'oklch(0.65 0.12 210)', // cyan
  'oklch(0.55 0.15 318)', // plum
  'oklch(0.68 0.12 92)',  // gold
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
