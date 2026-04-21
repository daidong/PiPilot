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

// Split a markdown document into its leading YAML frontmatter block and
// the body. `frontmatterBlock`, if present, is returned verbatim
// (including its closing `---` and any trailing newline) so callers can
// round-trip it by simple concatenation: `frontmatterBlock + body` is
// byte-equivalent to the original input.
//
// Motivation: bare `remark` (what Milkdown's transformer uses) has no
// frontmatter plugin and will parse the leading `---` as a thematic
// break and the rest as a setext heading — destroying the block on the
// first save. Stripping before the editor sees it and re-prepending on
// save keeps the frontmatter safe without teaching Milkdown new tricks.
export function splitFrontmatter(markdown: string | null | undefined): {
  frontmatterBlock: string | null
  body: string
} {
  if (!markdown) return { frontmatterBlock: null, body: markdown ?? '' }
  const match = markdown.match(FRONTMATTER_RE)
  if (!match) return { frontmatterBlock: null, body: markdown }
  return { frontmatterBlock: match[0], body: markdown.slice(match[0].length) }
}

function parseFrontmatterPairs(block: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!block) return out
  const inner = block.match(FRONTMATTER_RE)?.[1] ?? ''
  for (const rawLine of inner.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx < 0) continue
    const key = line.slice(0, colonIdx).trim()
    if (key) out[key] = line.slice(colonIdx + 1).trim()
  }
  return out
}

// Returns true iff the given frontmatter block declares `marp: true`
// (also accepts `yes` / `on`). Null / absent block returns false.
export function isMarpFrontmatter(block: string | null): boolean {
  const pairs = parseFrontmatterPairs(block)
  return /^(?:true|yes|on)$/i.test(pairs.marp || '')
}

// Splits a Marp deck's body (frontmatter already removed) into slide
// chunks on `^---$` lines. Empty chunks (e.g. from a trailing separator)
// are filtered out so the deck doesn't end with a blank card.
export function splitSlides(body: string): string[] {
  return body
    .split(/^---[ \t]*\r?$/m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
}

export function parseMarp(markdown: string | null | undefined): MarpDoc {
  const { frontmatterBlock, body } = splitFrontmatter(markdown)
  const isMarp = isMarpFrontmatter(frontmatterBlock)
  const frontmatter = parseFrontmatterPairs(frontmatterBlock)
  return { isMarp, frontmatter, slides: isMarp ? splitSlides(body) : [] }
}
