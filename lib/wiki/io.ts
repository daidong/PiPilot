/**
 * Wiki IO — file I/O for wiki structure.
 *
 * All writes go through withWikiLock for in-process safety.
 * Uses atomic writes (tmp + rename) so readers never see partial files.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { getWikiRoot, type ProcessedEntry, type ProvenanceEntry } from './types.js'

// ── Directory structure ────────────────────────────────────────────────────

export function ensureWikiStructure(): void {
  const root = getWikiRoot()
  const dirs = [
    root,
    join(root, 'papers'),
    join(root, 'concepts'),
    join(root, 'raw', 'arxiv'),
    join(root, 'converted'),
    join(root, '.state'),
  ]
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  // Write SCHEMA.md if missing (LLM reference doc)
  const schemaPath = join(root, 'SCHEMA.md')
  if (!existsSync(schemaPath)) {
    safeWriteFile(schemaPath, SCHEMA_CONTENT)
  }
}

const SCHEMA_CONTENT = `# Paper Wiki Schema

## Directory Layout
- \`papers/\` — One Markdown page per paper, keyed by canonical slug
- \`concepts/\` — Cross-paper synthesis pages, keyed by LLM-assigned slug
- \`index.md\` — Content catalog
- \`log.md\` — Chronological operation log (append-only)

## Paper Pages
Each paper page includes: title, authors, year, venue, tier (fulltext/abstract),
summary, key contributions, methodology, relevance, and wiki-links to concept pages.

## Concept Pages
Each concept page aggregates contributions from multiple papers.
Paper contributions are wrapped in HTML comment markers for idempotent updates:
\`\`\`
<!-- paper:slug -->
### From "Paper Title"
Content here...
<!-- /paper:slug -->
\`\`\`

## Wiki-Links
Cross-references use \`[[concept-slug]]\` syntax within paper pages.
`

// ── Atomic file writes ─────────────────────────────────────────────────────

export function safeWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmpPath = filePath + '.tmp.' + randomUUID().slice(0, 8)
  writeFileSync(tmpPath, content, 'utf-8')
  renameSync(tmpPath, filePath)
}

export function safeReadFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

// ── Watermark: processed.jsonl ─────────────────────────────────────────────

function processedPath(): string {
  return join(getWikiRoot(), '.state', 'processed.jsonl')
}

export function readProcessedWatermark(): Map<string, ProcessedEntry> {
  const map = new Map<string, ProcessedEntry>()
  const content = safeReadFile(processedPath())
  if (!content) return map

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry = JSON.parse(trimmed) as ProcessedEntry
      map.set(entry.canonicalKey, entry)
    } catch { /* skip corrupt lines */ }
  }
  return map
}

export function markPaperProcessed(entry: ProcessedEntry): void {
  const path = processedPath()
  const existing = readProcessedWatermark()
  existing.set(entry.canonicalKey, entry)
  // Rewrite the full file to handle updates
  const content = Array.from(existing.values())
    .map(e => JSON.stringify(e))
    .join('\n') + '\n'
  safeWriteFile(path, content)
}

// ── Provenance: provenance.jsonl ───────────────────────────────────────────

function provenancePath(): string {
  return join(getWikiRoot(), '.state', 'provenance.jsonl')
}

export function readProvenance(): ProvenanceEntry[] {
  const content = safeReadFile(provenancePath())
  if (!content) return []
  const entries: ProvenanceEntry[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { entries.push(JSON.parse(trimmed)) } catch { /* skip */ }
  }
  return entries
}

export function addProvenance(entry: ProvenanceEntry): void {
  const existing = readProvenance()
  // Don't add duplicate (same canonicalKey + projectPath + paperId)
  const isDup = existing.some(
    e => e.canonicalKey === entry.canonicalKey &&
         e.projectPath === entry.projectPath &&
         e.paperId === entry.paperId
  )
  if (isDup) return
  const path = provenancePath()
  const content = safeReadFile(path) || ''
  safeWriteFile(path, content + JSON.stringify(entry) + '\n')
}

// ── Index: index.md ────────────────────────────────────────────────────────

export function rebuildIndex(): void {
  const root = getWikiRoot()
  const papersDir = join(root, 'papers')
  const conceptsDir = join(root, 'concepts')
  const lines: string[] = ['# Paper Wiki Index\n']

  // Papers section
  lines.push('## Papers\n')
  if (existsSync(papersDir)) {
    const files = readdirSync(papersDir).filter(f => f.endsWith('.md')).sort()
    for (const file of files) {
      const content = safeReadFile(join(papersDir, file))
      if (!content) continue
      const titleMatch = content.match(/^#\s+(.+)$/m)
      const title = titleMatch ? titleMatch[1] : file.replace('.md', '')
      lines.push(`- [${title}](papers/${file})`)
    }
  }
  if (lines[lines.length - 1] === '## Papers\n') lines.push('_(empty)_')

  // Concepts section
  lines.push('\n## Concepts\n')
  if (existsSync(conceptsDir)) {
    const files = readdirSync(conceptsDir).filter(f => f.endsWith('.md')).sort()
    for (const file of files) {
      const content = safeReadFile(join(conceptsDir, file))
      if (!content) continue
      const titleMatch = content.match(/^#\s+(.+)$/m)
      const title = titleMatch ? titleMatch[1] : file.replace('.md', '')
      lines.push(`- [${title}](concepts/${file})`)
    }
  }
  if (lines[lines.length - 1] === '## Concepts\n') lines.push('_(empty)_')

  safeWriteFile(join(root, 'index.md'), lines.join('\n') + '\n')
}

// ── Log: log.md ────────────────────────────────────────────────────────────

export function appendLog(message: string): void {
  const root = getWikiRoot()
  const logPath = join(root, 'log.md')
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
  const entry = `${timestamp}  ${message}\n`

  const existing = safeReadFile(logPath) || '# Wiki Log\n\n'
  // Insert new entry after header (newest first)
  const headerEnd = existing.indexOf('\n\n')
  if (headerEnd >= 0) {
    const header = existing.slice(0, headerEnd + 2)
    const body = existing.slice(headerEnd + 2)
    safeWriteFile(logPath, header + entry + body)
  } else {
    safeWriteFile(logPath, existing + '\n' + entry)
  }
}

export function readRecentLog(n: number = 20): string[] {
  const logPath = join(getWikiRoot(), 'log.md')
  const content = safeReadFile(logPath)
  if (!content) return []

  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'))
  return lines.slice(0, n)
}

// ── Page count helpers ─────────────────────────────────────────────────────

export function countPaperPages(): number {
  const dir = join(getWikiRoot(), 'papers')
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter(f => f.endsWith('.md')).length
}

export function countConceptPages(): number {
  const dir = join(getWikiRoot(), 'concepts')
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter(f => f.endsWith('.md')).length
}

// ── Page listing + reading (for UI) ───────────────────────────────────────

export interface WikiPageEntry {
  slug: string
  title: string
  kind: 'paper' | 'concept'
}

/** List all wiki pages (papers + concepts) with titles extracted from markdown. */
export function listWikiPages(): { papers: WikiPageEntry[]; concepts: WikiPageEntry[] } {
  const root = getWikiRoot()
  const readEntries = (subdir: string, kind: 'paper' | 'concept'): WikiPageEntry[] => {
    const dir = join(root, subdir)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const slug = f.replace('.md', '')
        const content = safeReadFile(join(dir, f))
        const titleMatch = content?.match(/^#\s+(.+)$/m)
        const title = titleMatch ? titleMatch[1] : slug
        return { slug, title, kind }
      })
      .sort((a, b) => a.title.localeCompare(b.title))
  }
  return {
    papers: readEntries('papers', 'paper'),
    concepts: readEntries('concepts', 'concept'),
  }
}

/** Read a single wiki page by slug. Returns markdown content or null. */
export function readWikiPage(slug: string): string | null {
  const root = getWikiRoot()
  // Try papers/ first, then concepts/
  for (const subdir of ['papers', 'concepts']) {
    const content = safeReadFile(join(root, subdir, `${slug}.md`))
    if (content) return content
  }
  return null
}

/** Find the wiki slug for a paper artifact by matching canonical key in the watermark. */
export function wikiSlugForPaperArtifact(artifactId: string, projectPath: string): string | null {
  const provenance = readProvenance()
  const match = provenance.find(e => e.paperId === artifactId && e.projectPath === projectPath)
  if (!match) return null
  const processed = readProcessedWatermark()
  const entry = processed.get(match.canonicalKey)
  return entry?.slug ?? null
}

/**
 * Build a mapping of paperId → wiki slug for all known papers.
 * Matches provenance entries against processed watermark and verifies the page file exists.
 */
export function buildPaperSlugMap(): Record<string, string> {
  const provenance = readProvenance()
  const processed = readProcessedWatermark()
  const root = getWikiRoot()
  const map: Record<string, string> = {}

  for (const entry of provenance) {
    if (map[entry.paperId]) continue  // already mapped
    const watermark = processed.get(entry.canonicalKey)
    if (!watermark?.slug) continue
    // Verify the wiki page file actually exists
    if (existsSync(join(root, 'papers', `${watermark.slug}.md`))) {
      map[entry.paperId] = watermark.slug
    }
  }
  return map
}

/** Count papers by fulltext status from watermark */
export function countByFulltextStatus(): { fulltext: number; abstractOnly: number; abstractFallback: number } {
  const processed = readProcessedWatermark()
  let fulltext = 0, abstractOnly = 0, abstractFallback = 0
  for (const entry of processed.values()) {
    if (entry.fulltextStatus === 'fulltext') fulltext++
    else if (entry.fulltextStatus === 'abstract-only') abstractOnly++
    else abstractFallback++
  }
  return { fulltext, abstractOnly, abstractFallback }
}
