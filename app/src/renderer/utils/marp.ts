// Detects Marp (Markdown Presentation Ecosystem) slide decks and splits
// their source into individual slides.
//
// Marp files carry a YAML frontmatter with `marp: true`; slides are then
// separated by horizontal-rule lines (`^---$`). We treat the `marp: true`
// directive as the gating signal — a plain markdown file with `---`
// separators is NOT a slide deck. This keeps detection conservative so
// we never accidentally shred a normal document into slides.

export interface MarpDoc {
  /** True when the frontmatter contains `marp: true`. */
  isMarp: boolean
  /** Parsed frontmatter key/value pairs (string values only, no YAML
   *  nesting). Empty when no frontmatter is present. */
  frontmatter: Record<string, string>
  /** Slide source chunks (markdown), in document order. Empty unless
   *  isMarp is true. */
  slides: string[]
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function parseMarp(markdown: string | null | undefined): MarpDoc {
  if (!markdown) return { isMarp: false, frontmatter: {}, slides: [] }

  const match = markdown.match(FRONTMATTER_RE)
  if (!match) return { isMarp: false, frontmatter: {}, slides: [] }

  const frontmatter: Record<string, string> = {}
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx < 0) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key) frontmatter[key] = value
  }

  const isMarp = /^(?:true|yes|on)$/i.test(frontmatter.marp || '')
  if (!isMarp) return { isMarp: false, frontmatter, slides: [] }

  // Strip the frontmatter block, then split on `^---$` lines. Filter out
  // empty chunks so a trailing separator doesn't produce a blank slide.
  const body = markdown.slice(match[0].length)
  const slides = body
    .split(/^---[ \t]*\r?$/m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)

  return { isMarp: true, frontmatter, slides }
}
