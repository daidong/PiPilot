/**
 * Artifact ↔ workspace-file (de)serialization (RFC-014 §4).
 *
 * Files are the source of truth; the derived index (indexer.ts) reconstructs
 * `Artifact` objects from these. This module is the single place that knows the
 * on-disk shapes:
 *   - note / web-content / tool-output → one `.md` with YAML front-matter
 *   - data                            → the data file + `<datafile>.rp.yaml` sidecar
 *   - paper                           → an entry in a per-actor `references.bib`
 *                                       + a keyed block in `references.rp.yaml`
 *
 * No dependency on `lib/importers` (that would be circular: importers → commands
 * → memory-v2). We parse `.bib` with the external `@retorquere/bibtex-parser`
 * and emit `.bib` with a small self-contained writer here.
 */

import { readFileSync } from 'fs'
import { parse as parseBibtex, type Entry, type Creator } from '@retorquere/bibtex-parser'
import type {
  Artifact,
  ArtifactType,
  NoteArtifact,
  PaperArtifact,
  DataArtifact,
  WebContentArtifact,
  ToolOutputArtifact,
  Provenance,
  DataSchema
} from '../types.js'
import { parseFrontMatter, serializeFrontMatter, omitUndefined } from './front-matter.js'

// ─────────────────────────────────────────────────────────────────────────────
// Legacy JSON reader + normalization (lives here so both store.ts and indexer.ts
// can use it without a circular import).
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeArtifactType(type: string): ArtifactType {
  if (type === 'literature') return 'paper'
  if (type === 'note' || type === 'paper' || type === 'data' || type === 'web-content' || type === 'tool-output') {
    return type
  }
  return 'note'
}

export function normalizeArtifact(raw: Artifact): Artifact {
  const normalizedType = normalizeArtifactType(raw.type)
  if (normalizedType === raw.type) return raw
  return { ...raw, type: normalizedType } as Artifact
}

/** Read a legacy `<uuid>.json` artifact file. Returns null on any error. */
export function readArtifactFromFile(filePath: string): Artifact | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Artifact
    return normalizeArtifact(raw)
  } catch {
    return null
  }
}

/** Paper = one `<citeKey>.bib` per paper (RFC-014 §4.3, one-file-per-paper). */
export const PAPER_BIB_EXT = '.bib'
/**
 * Sidecar suffix for app-specific metadata — used by BOTH a paper
 * (`<citeKey>.rp.yaml`) and a data artifact (`<datafile>.rp.yaml`). The two are
 * disambiguated by the `type` field inside the YAML (and, for papers, a sibling
 * `<citeKey>.bib`).
 */
export const RP_SIDECAR_SUFFIX = '.rp.yaml'

/** Default file extension a Markdown-backed artifact type is written as. */
export function mdArtifactExtension(_type: 'note' | 'web-content' | 'tool-output'): string {
  return '.md'
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared front-matter helpers (note / web-content / tool-output)
// ─────────────────────────────────────────────────────────────────────────────

/** The field whose value becomes the Markdown body for a given type. */
function bodyFieldFor(type: ArtifactType): 'content' | 'outputText' {
  return type === 'tool-output' ? 'outputText' : 'content'
}

const FM_TOP_LEVEL = new Set(['title', 'tags', 'summary'])

/** True when a `.md`'s front-matter marks it as a managed artifact (RFC-014 §4.2). */
export function isManagedMarkdown(data: Record<string, unknown>): boolean {
  const rp = data.rp as Record<string, unknown> | undefined
  return !!rp && typeof rp.id === 'string' && typeof rp.type === 'string'
}

/**
 * Serialize a Markdown-backed artifact (note / tool-output) to a `.md` document.
 * LOSSLESS: the body is the content/outputText field; the nested `rp:` block holds
 * EVERY other field (including any non-schema / unknown fields), so nothing is
 * dropped on round-trip. Top-level `title/tags/summary` are surfaced for human edit.
 */
export function markdownArtifactToText(a: NoteArtifact | WebContentArtifact | ToolOutputArtifact): string {
  const bodyField = bodyFieldFor(a.type)
  const body = String((a as Record<string, unknown>)[bodyField] ?? '')
  const rp: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(a)) {
    if (FM_TOP_LEVEL.has(k) || k === bodyField) continue
    if (v !== undefined) rp[k] = v
  }
  const fm = omitUndefined({
    title: a.title,
    tags: a.tags,
    summary: a.summary,
    rp
  })
  return serializeFrontMatter(fm as Record<string, unknown>, body)
}

/**
 * Parse a Markdown document into an artifact. Returns null when the file is not
 * a managed artifact (no `rp.id`). LOSSLESS inverse of markdownArtifactToText:
 * reconstructs all `rp` fields + the body + top-level title/tags/summary.
 */
export function parseMarkdownArtifact(text: string): Artifact | null {
  const { data, body } = parseFrontMatter(text)
  if (!isManagedMarkdown(data)) return null
  const rp = data.rp as Record<string, unknown>
  const type = rp.type as ArtifactType
  const bodyField = bodyFieldFor(type)
  const merged: Record<string, unknown> = { ...rp }
  if (typeof data.title === 'string') merged.title = data.title
  if (Array.isArray(data.tags)) merged.tags = data.tags
  if (typeof data.summary === 'string') merged.summary = data.summary
  merged[bodyField] = body
  return omitUndefined(merged) as unknown as Artifact
}

// ─────────────────────────────────────────────────────────────────────────────
// Data sidecar
// ─────────────────────────────────────────────────────────────────────────────

/** The machine record stored next to a data file as `<datafile>.rp.yaml`. */
export function dataArtifactToSidecar(a: DataArtifact): Record<string, unknown> {
  return omitUndefined({
    id: a.id,
    type: 'data',
    title: a.title,
    tags: a.tags ?? [],
    summary: a.summary,
    provenance: a.provenance,
    actor: (a as { actor?: unknown }).actor,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    mimeType: a.mimeType,
    schema: a.schema as unknown,
    runId: a.runId,
    runLabel: a.runLabel
  })
}

/**
 * Reconstruct a DataArtifact from a parsed sidecar object + the data file's
 * workspace-relative path.
 */
export function dataArtifactFromSidecar(sidecar: Record<string, unknown>, dataFileRelPath: string): DataArtifact | null {
  if (typeof sidecar.id !== 'string') return null
  const actor = sidecar.actor as { id: string; displayName: string } | undefined
  return omitUndefined({
    id: sidecar.id,
    type: 'data',
    title: typeof sidecar.title === 'string' ? sidecar.title : dataFileRelPath,
    tags: Array.isArray(sidecar.tags) ? (sidecar.tags as string[]) : [],
    summary: typeof sidecar.summary === 'string' ? sidecar.summary : undefined,
    provenance: (sidecar.provenance as Provenance) ?? { source: 'user', sessionId: 'unknown' },
    createdAt: typeof sidecar.createdAt === 'string' ? sidecar.createdAt : new Date().toISOString(),
    updatedAt: typeof sidecar.updatedAt === 'string' ? sidecar.updatedAt : new Date().toISOString(),
    filePath: dataFileRelPath,
    mimeType: typeof sidecar.mimeType === 'string' ? sidecar.mimeType : undefined,
    schema: (sidecar.schema as DataSchema) ?? undefined,
    runId: typeof sidecar.runId === 'string' ? sidecar.runId : undefined,
    runLabel: typeof sidecar.runLabel === 'string' ? sidecar.runLabel : undefined,
    ...(actor ? { actor } : {})
  }) as unknown as DataArtifact
}

// ─────────────────────────────────────────────────────────────────────────────
// Paper: references.bib entry + references.rp.yaml sidecar block
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The paper sidecar holds the **complete** paper record (lossless YAML) — it is
 * the authoritative source on read. The `.bib` is a derived LaTeX view that may
 * lose exotic characters / URL-form ids through BibTeX escaping, so we never
 * reconstruct the artifact's fields from it when a sidecar exists (smoke-tested
 * against real data: §-in-citeKey, curly-quote abstracts, URL arxivIds all
 * survive via the sidecar). RFC-014 §4.3.
 */
export function paperToSidecarEntry(p: PaperArtifact): Record<string, unknown> {
  return omitUndefined({ ...p }) as Record<string, unknown>
}

/** Wrap a value for a BibTeX `{...}` field, neutralizing unbalanced braces. */
function escapeBib(value: string): string {
  let depth = 0
  let out = ''
  for (const ch of value) {
    if (ch === '{') depth++
    else if (ch === '}') {
      if (depth === 0) {
        out += ' '
        continue
      }
      depth--
    }
    out += ch
  }
  if (depth > 0) out += '}'.repeat(depth)
  return out
}

/** Render authors as brace-literals so they round-trip exactly (RFC-014 §13). */
function renderAuthors(authors: string[]): string {
  return authors
    .map(a => a.trim())
    .filter(Boolean)
    .map(a => `{${escapeBib(a)}}`)
    .join(' and ')
}

function bibEntryTypeOf(p: PaperArtifact): string {
  // Reuse the entry type embedded in the stored bibtex when present; else infer.
  const m = /^@(\w+)\s*\{/.exec((p.bibtex ?? '').trim())
  if (m) return m[1].toLowerCase()
  if (p.venue && /proc|conf|symp|workshop/i.test(p.venue)) return 'inproceedings'
  return p.venue ? 'article' : 'misc'
}

/**
 * True when `text` is a single, cleanly-parseable BibTeX entry that carries a
 * title. The title check is a pragmatic "is this real BibTeX" guard — the parser
 * tolerates junk like `@article{k, ...}` without flagging an error, but such an
 * entry has no usable fields, so we must NOT echo it verbatim (it would lose the
 * paper's data on read). Such inputs fall back to field-based emit.
 */
function bibParsesCleanly(text: string): boolean {
  let hadError = false
  let parsed: { entries?: Entry[] }
  try {
    parsed = parseBibtex(text, { sentenceCase: false, errorHandler: () => { hadError = true } }) as unknown as {
      entries?: Entry[]
    }
  } catch {
    return false
  }
  if (hadError || !Array.isArray(parsed.entries) || parsed.entries.length !== 1) return false
  const title = (parsed.entries[0].fields as Record<string, unknown>).title
  const t = Array.isArray(title) ? title.join('') : title ?? ''
  return String(t).trim().length > 0
}

/** A BibTeX-safe entry key (strip chars that break the parser, e.g. `§`, spaces). */
function sanitizeBibKey(citeKey: string): string {
  const k = (citeKey ?? '').trim().replace(/[^A-Za-z0-9_:.-]/g, '')
  return k || 'key'
}

/** Rewrite a standalone entry's citation key (first `@type{KEY,` occurrence). */
function setEntryKey(entry: string, citeKey: string): string {
  return entry.replace(/^(\s*@\w+\s*\{)\s*[^,\s}]+\s*,/, `$1${citeKey},`)
}

/** Insert/replace the `rp_id` identity anchor in a standalone `.bib` entry. */
function injectRpId(entry: string, id: string): string {
  const stripped = entry.replace(/\n?[ \t]*rp_id[ \t]*=[ \t]*\{[^}]*\}[ \t]*,?/gi, '')
  const idx = stripped.lastIndexOf('}')
  if (idx === -1) return `${stripped.trim()}\n  rp_id = {${id}},`
  const body = stripped.slice(0, idx).replace(/\s*,?\s*$/, '')
  return `${body},\n  rp_id = {${id}}\n}`
}

/**
 * Emit a single standalone `.bib` entry for a paper, with the `rp_id` identity
 * anchor.
 *
 * - If `p.bibtex` is a curated entry that parses cleanly, it is used VERBATIM
 *   (key normalized to the artifact's citeKey + rp_id injected) so all of its
 *   fields (pages, publisher, editor, …) reach the `.bib` for LaTeX use.
 * - Otherwise (missing / auto-generated / malformed) the entry is built from the
 *   artifact's structured fields, so a bad `bibtex` string can never make the
 *   paper unreadable. The curated string is also kept verbatim in the sidecar.
 */
export function paperToBibEntry(p: PaperArtifact): string {
  const key = sanitizeBibKey(p.citeKey)
  const raw = (p.bibtex ?? '').trim()
  if (raw.startsWith('@') && p.bibtexIsAutoGenerated !== true && bibParsesCleanly(raw)) {
    return injectRpId(setEntryKey(raw, key), p.id)
  }
  const entryType = bibEntryTypeOf(p)
  const isProc = entryType === 'inproceedings' || entryType === 'conference'
  const lines: string[] = [`@${entryType}{${key},`]
  const field = (k: string, v: string | undefined) => {
    if (v === undefined) return
    const t = String(v).trim()
    if (!t) return
    lines.push(`  ${k} = {${escapeBib(t)}},`)
  }
  field('title', p.title)
  if (p.authors && p.authors.length > 0) lines.push(`  author = {${renderAuthors(p.authors)}},`)
  field('year', p.year !== undefined ? String(p.year) : undefined)
  field(isProc ? 'booktitle' : 'journal', p.venue)
  field('doi', p.doi)
  field('url', p.url)
  field('abstract', p.abstract)
  if (p.arxivId) {
    field('eprint', p.arxivId)
    lines.push(`  archivePrefix = {arXiv},`)
  }
  lines.push(`  rp_id = {${p.id}},`)
  lines.push('}')
  return lines.join('\n')
}

function creatorToName(c: Creator): string {
  if (c.name) return c.name.trim()
  const first = (c.firstName ?? '').trim()
  const prefix = ((c as { prefix?: string }).prefix ?? '').trim()
  const last = (c.lastName ?? '').trim()
  const suffix = ((c as { suffix?: string }).suffix ?? '').trim()
  let name = [first, prefix, last].filter(Boolean).join(' ')
  if (suffix) name = name ? `${name}, ${suffix}` : suffix
  return name.trim()
}

/**
 * Reconstruct a PaperArtifact from a parsed `.bib` entry + its sidecar block.
 * Standard fields come from the `.bib` (so hand-edits win); app fields from the
 * sidecar; identity from `rp_id` (falling back to the sidecar `id`).
 */
export function paperFromBibEntry(entry: Entry, sidecar: Record<string, unknown> | undefined): PaperArtifact | null {
  const f = entry.fields as Record<string, unknown>
  const str = (v: unknown): string => {
    if (Array.isArray(v)) return v.map(x => String(x)).join(', ')
    return v === undefined || v === null ? '' : String(v)
  }
  const rpId = str(f.rp_id).trim()
  const id = rpId || (typeof sidecar?.id === 'string' ? sidecar.id : '')
  if (!id) return null

  const authorsRaw = f.author as unknown
  const authors: string[] = Array.isArray(authorsRaw)
    ? (authorsRaw as Creator[]).map(creatorToName).filter(Boolean)
    : str(authorsRaw)
        .split(/\s+and\s+/)
        .map(s => s.trim())
        .filter(Boolean)

  const yearStr = str(f.year).trim()
  const year = yearStr && /^\d{4}$/.test(yearStr) ? Number(yearStr) : undefined
  const venue = str(f.journal).trim() || str(f.booktitle).trim() || str(f.howpublished).trim() || undefined
  const arxivId = str(f.eprint).trim() || undefined

  const sc = sidecar ?? {}
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  const arr = (v: unknown): string[] | undefined => (Array.isArray(v) ? (v as string[]) : undefined)
  const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const actor = sc.actor as { id: string; displayName: string } | undefined

  return omitUndefined({
    id,
    type: 'paper',
    title: str(f.title).trim(),
    tags: arr(sc.tags) ?? [],
    summary: s(sc.summary),
    provenance: (sc.provenance as Provenance) ?? { source: 'import', sessionId: 'unknown' },
    createdAt: s(sc.createdAt) ?? new Date().toISOString(),
    updatedAt: s(sc.updatedAt) ?? new Date().toISOString(),
    citeKey: entry.key,
    // Prefer the verbatim curated bibtex stored in the sidecar; otherwise
    // reconstruct a canonical entry from the parsed .bib.
    bibtex: typeof sc.bibtex === 'string' && sc.bibtex.trim() ? sc.bibtex : reEmitEntry(entry),
    bibtexIsAutoGenerated: typeof sc.bibtexIsAutoGenerated === 'boolean' ? sc.bibtexIsAutoGenerated : undefined,
    doi: str(f.doi).trim(),
    authors,
    abstract: str(f.abstract).trim(),
    year,
    venue,
    url: str(f.url).trim() || undefined,
    pdfUrl: s(sc.pdfUrl),
    searchKeywords: arr(sc.searchKeywords),
    externalSource: s(sc.externalSource),
    relevanceScore: num(sc.relevanceScore),
    citationCount: num(sc.citationCount),
    enrichmentSource: s(sc.enrichmentSource),
    enrichedAt: s(sc.enrichedAt),
    subTopic: s(sc.subTopic),
    keyFindings: arr(sc.keyFindings),
    relevanceJustification: s(sc.relevanceJustification),
    addedInRound: s(sc.addedInRound),
    addedByTask: s(sc.addedByTask),
    fulltextPath: s(sc.fulltextPath),
    identityConfidence: sc.identityConfidence as 'high' | 'medium' | 'low' | undefined,
    arxivId,
    pubmedId: s(sc.pubmedId),
    pmcId: s(sc.pmcId),
    semanticScholarId: s(sc.semanticScholarId),
    ...(actor ? { actor } : {})
  }) as unknown as PaperArtifact
}

/** Re-emit a parsed entry to a canonical standalone `.bib` string. */
function reEmitEntry(entry: Entry): string {
  const f = entry.fields as Record<string, unknown>
  const lines: string[] = [`@${entry.type}{${entry.key},`]
  for (const key of Object.keys(f)) {
    if (key.toLowerCase() === 'rp_id') continue
    const v = f[key]
    if (v === undefined || v === null) continue
    let rendered: string
    if (Array.isArray(v)) {
      if (v.length === 0) continue
      if (v.every(x => x && typeof x === 'object')) {
        rendered = (v as Creator[]).map(c => `{${escapeBib(creatorToName(c))}}`).join(' and ')
      } else {
        rendered = (v as unknown[]).map(x => String(x).trim()).filter(Boolean).join(', ')
      }
    } else {
      rendered = String(v).trim()
    }
    if (!rendered) continue
    lines.push(`  ${key} = {${escapeBib(rendered)}},`)
  }
  lines.push('}')
  return lines.join('\n')
}

/**
 * Parse a single-paper `<citeKey>.bib` + its flat `<citeKey>.rp.yaml` sidecar.
 * (One-file-per-paper, RFC-014 §4.3.) Uses the first entry if several exist.
 */
export function parsePaperFile(bibText: string, sidecar: Record<string, unknown> | undefined): PaperArtifact | null {
  // Sidecar is authoritative (lossless YAML). When present, reconstruct entirely
  // from it — never re-parse the lossy `.bib`.
  if (sidecar && typeof sidecar.id === 'string') {
    return omitUndefined({ ...sidecar, type: 'paper' }) as unknown as PaperArtifact
  }
  // Fallback: a raw `.bib` with no sidecar — best-effort parse (needs an rp_id).
  let parsed: { entries?: Entry[] }
  try {
    parsed = parseBibtex(bibText, { sentenceCase: false, errorHandler: () => {} }) as unknown as {
      entries?: Entry[]
    }
  } catch {
    return null
  }
  const entry = parsed.entries?.[0]
  if (!entry) return null
  return paperFromBibEntry(entry, undefined)
}

/**
 * Parse a multi-entry `.bib` + its sidecar map into PaperArtifacts. Retained for
 * a future combined-`references.bib` export/import; the per-file path uses
 * `parsePaperFile`. The sidecar is `{ [citeKey]: { ...app fields } }`.
 */
export function parsePaperLibrary(bibText: string, sidecarMap: Record<string, unknown>): PaperArtifact[] {
  let parsed: { entries: Entry[] }
  try {
    // sentenceCase:false preserves the user's title capitalization (matches the
    // BibTeX importer); errorHandler swallows malformed-entry warnings.
    parsed = parseBibtex(bibText, { sentenceCase: false, errorHandler: () => {} }) as unknown as {
      entries: Entry[]
    }
  } catch {
    return []
  }
  const out: PaperArtifact[] = []
  for (const entry of parsed.entries ?? []) {
    const sidecar = sidecarMap[entry.key] as Record<string, unknown> | undefined
    const paper = paperFromBibEntry(entry, sidecar)
    if (paper) out.push(paper)
  }
  return out
}
