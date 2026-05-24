/**
 * YAML front-matter read/write for Markdown-backed artifacts (RFC-014 §4.1).
 *
 * Format:
 *   ---
 *   <yaml>
 *   ---
 *   <body>
 *
 * Uses the `yaml` package (already present via pi-coding-agent). We deliberately
 * keep this tiny and dependency-light — a `gray-matter` equivalent scoped to our
 * needs (RFC-014 §9).
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export interface ParsedFrontMatter {
  /** Parsed front-matter object ({} when absent or malformed). */
  data: Record<string, unknown>
  /** Everything after the closing `---` fence (the document body). */
  body: string
}

// Front-matter must start at byte 0. Capture the YAML block, then the body.
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/

/**
 * Split a Markdown document into its front-matter object and body. When there is
 * no valid front-matter, returns `{ data: {}, body: <whole text> }` — a plain
 * `.md` with no `rp` block is just a file, not a managed artifact (RFC-014 §4.2).
 */
export function parseFrontMatter(text: string): ParsedFrontMatter {
  const m = FRONT_MATTER_RE.exec(text)
  if (!m) return { data: {}, body: text }
  let data: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(m[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>
    }
  } catch {
    data = {}
  }
  return { data, body: m[2] ?? '' }
}

/**
 * Serialize a front-matter object + body back into a Markdown document.
 * The body is emitted verbatim after a blank line.
 */
export function serializeFrontMatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(data, { lineWidth: 0 }).replace(/\s+$/, '')
  const safeBody = body ?? ''
  // Exactly one newline after the closing fence so parseFrontMatter is an exact
  // inverse (no leading-newline drift in the body across save cycles).
  return `---\n${yaml}\n---\n${safeBody}`
}

/** True when the text begins with a YAML front-matter fence. */
export function hasFrontMatter(text: string): boolean {
  return FRONT_MATTER_RE.test(text)
}

/** Drop keys whose value is `undefined` so they don't serialize as `null`. */
export function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as Partial<T>
}
