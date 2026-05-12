/**
 * Stable content hash of the report input (RFC-007 PR-B).
 *
 * The button's `done` state matches `reportInputHash === currentInputHash`.
 * Hash inputs are intentionally narrow: paper IDs + citeKeys +
 * enrichedAt + wiki sidecar identity. Re-running the report when none
 * of those changed is a guaranteed no-op, so we cache; any change
 * invalidates and the button falls through to `ready`.
 *
 * PR-A used a lightweight FNV; PR-B upgrades to SHA-256 to make the
 * cache key resistant to accidental collisions in larger libraries.
 */

import { createHash } from 'node:crypto'
import type { ReportInput } from './types.js'

export function computeReportInputHash(input: ReportInput): string {
  const parts: string[] = []
  // Order-independent: sort lines before hashing.
  const lines: string[] = []
  for (const entry of input.papers) {
    const p = entry.paper
    const wiki = entry.wiki
    // Wiki identity: schema-version + canonicalKey + generated_at.
    // generated_at changes whenever the wiki page is regenerated, which
    // is exactly what should bust the cache.
    const wikiKey = wiki
      ? `${wiki.schemaVersion}|${wiki.canonicalKey}|${wiki.generated_at}|${wiki.source_tier}`
      : 'no-wiki'
    lines.push(`${p.id}|${p.citeKey ?? ''}|${p.enrichedAt ?? ''}|${wikiKey}`)
  }
  lines.sort()
  parts.push(`schema=1`)
  parts.push(`count=${lines.length}`)
  parts.push(lines.join('\n'))
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)
}
