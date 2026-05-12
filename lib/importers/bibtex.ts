/**
 * BibTeX importer — parse a `.bib` file into Paper artifacts.
 *
 * Behavior reference: RFC-006 (Design Note 006). This module is the
 * implementation slice; the design lives at
 * `lib/docs/rfc/006-bibtex-import-mapping.md`.
 *
 * Flow:
 *   1. Read the .bib file as UTF-8. Reject non-UTF-8 with a clear error.
 *   2. Parse with @retorquere/bibtex-parser (with sentence-casing OFF
 *      so academic title case is preserved).
 *   3. Detect same-citekey duplicates within the file; keep first, skip later.
 *   4. For each surviving entry: map fields, reconstruct a standalone
 *      BibTeX entry (with @string macros and crossref resolved), call
 *      upsertPaperArtifact with `provenance.source: 'import'`.
 *   5. Report per-entry progress; collect failure details; return result.
 *
 * What this module deliberately does NOT do:
 *   - No HTTP. CrossRef / Semantic Scholar enrichment is the caller's job
 *     (pass `result.importedPaperIds` to `enrichPaperArtifacts`).
 *   - No PDF I/O. The `file = {...}` field is ignored (RFC-006 §8).
 *   - No Wiki manipulation. The Paper Wiki scanner picks up new artifacts
 *     on its next idle tick.
 */

import { readFileSync, existsSync } from 'node:fs'
import { parse as parseBibtex, type Entry, type Creator } from '@retorquere/bibtex-parser'
import { upsertPaperArtifact } from '../commands/paper-artifact.js'
import { normalizeDoi } from '../memory-v2/store.js'
import { isValidArxivId } from '../wiki/types.js'
import type { CLIContext } from '../types.js'

// ─── Public types ─────────────────────────────────────────────────────────

export type BibImportEntryStatus =
  | 'added'             // new paper created
  | 'merged'            // matched existing paper via dedup; merged fill-only
  | 'merged-no-change'  // dedup hit but nothing to fill
  | 'duplicate-in-file' // skipped — same citekey appeared earlier in this file
  | 'failed'            // entry could not be imported (missing title, etc.)

export interface BibImportProgressEvent {
  /** Index of the entry in the parsed file (0-based). */
  index: number
  /** Total count of entries the parser surfaced. Stable for the run. */
  total: number
  citeKey: string
  status: BibImportEntryStatus
  reason?: string  // populated on 'failed' / 'duplicate-in-file'
}

export interface BibImportFailure {
  citeKey: string
  reason: string
}

export interface BibImportResult {
  /** New artifacts created. */
  added: number
  /** Existing artifacts that gained at least one new field via fill-only. */
  merged: number
  /** Existing artifacts that already had everything — dedup hit but no write. */
  mergedNoChange: number
  /** Entries skipped because their citekey appeared earlier in the same file. */
  duplicateInFile: number
  /** Entries that could not be imported (missing title, parser error, etc.). */
  failed: number
  /** Per-failure detail for UI reporting. */
  failureDetails: BibImportFailure[]
  /**
   * Paper artifact IDs touched (created or merged) by this import. Caller
   * passes these to `enrichPaperArtifacts` to fill missing metadata via
   * CrossRef / Semantic Scholar.
   */
  importedPaperIds: string[]
  /**
   * Soft warnings from the parser itself — file may still have imported
   * successfully. Surfaced for diagnostic UI.
   */
  parserWarnings: string[]
}

export interface BibImportOptions {
  /** CLI context (session, project path). Required for upsert. */
  ctx: CLIContext
  /** Progress callback invoked once per parsed entry. */
  onProgress?: (event: BibImportProgressEvent) => void
}

// ─── Public entry points ──────────────────────────────────────────────────

/**
 * Import a `.bib` file by absolute path.
 *
 * Throws (only) when the file is fundamentally unusable: not found, not
 * UTF-8, or contains zero recognizable BibTeX entries. Per-entry failures
 * are soft — they show up in `result.failureDetails` and the import
 * continues with the surviving entries.
 */
export async function importBibtexFile(
  bibPath: string,
  options: BibImportOptions,
): Promise<BibImportResult> {
  if (!existsSync(bibPath)) {
    throw new Error(`BibTeX file not found: ${bibPath}`)
  }

  const raw = readFileSync(bibPath, 'utf-8')
  return importBibtexString(raw, options)
}

/**
 * Import a `.bib` file's contents from a string. Exposed for tests and
 * for renderer paths that already have the file content in memory.
 */
export async function importBibtexString(
  contents: string,
  options: BibImportOptions,
): Promise<BibImportResult> {
  // D5 — refuse if the input contains UTF-8 replacement characters
  // (typically because the source file was latin-1 / gbk and got
  // mis-decoded). We do NOT try to auto-detect alternative encodings;
  // a wrong guess silently corrupts every accented character.
  if (contents.includes('\uFFFD')) {
    throw new Error(
      'BibTeX content is not valid UTF-8. Please re-export from your reference ' +
      'manager (Zotero / EndNote / Mendeley) as UTF-8 and try again.'
    )
  }

  // D8 — if the file contains NO `@xxx{...}` block at all, fail loudly
  // rather than report `added: 0`. Users picking the wrong file is a
  // far more common error than an empty .bib.
  if (!/@\w+\s*[{(]/.test(contents)) {
    throw new Error(
      'No BibTeX entries found in this file. Make sure you selected a ' +
      'valid `.bib` file exported from your reference manager.'
    )
  }

  // sentenceCase: false — preserve "Attention Is All You Need" instead of
  //   producing "Attention is all you need". Academic users expect the
  //   capitalization of their .bib to be respected, not Zotero-style
  //   sentence-cased.
  // english: false — same intent; do not classify any entries as English
  //   for the sentence-case heuristic.
  const lib = parseBibtex(contents, { sentenceCase: false, english: false })

  const result: BibImportResult = {
    added: 0,
    merged: 0,
    mergedNoChange: 0,
    duplicateInFile: 0,
    failed: 0,
    failureDetails: [],
    importedPaperIds: [],
    parserWarnings: lib.errors.map(e => e.error),
  }

  const seenCiteKeys = new Set<string>()
  const total = lib.entries.length

  for (let index = 0; index < lib.entries.length; index++) {
    const entry = lib.entries[index]
    const citeKey = entry.key

    // A1 — same citekey appeared earlier in this file. Keep first; skip
    // this one, record a warning. The parser does NOT dedupe these for us.
    if (seenCiteKeys.has(citeKey)) {
      result.duplicateInFile++
      result.failureDetails.push({
        citeKey,
        reason: 'duplicate-citekey-in-file: kept the first occurrence',
      })
      options.onProgress?.({
        index, total, citeKey,
        status: 'duplicate-in-file',
        reason: 'duplicate-citekey-in-file',
      })
      continue
    }
    seenCiteKeys.add(citeKey)

    // F10 — parser may surface a malformed entry with no fields. Title
    // is the one required field; everything else can be backfilled.
    const title = pickStringField(entry, 'title')
    if (!title) {
      result.failed++
      result.failureDetails.push({
        citeKey: citeKey || `(entry #${index + 1})`,
        reason: 'missing-title-field',
      })
      options.onProgress?.({
        index, total, citeKey,
        status: 'failed',
        reason: 'missing-title',
      })
      continue
    }

    try {
      const outcome = importOneEntry(entry, title, options.ctx)
      if (outcome.kind === 'failed') {
        result.failed++
        result.failureDetails.push({ citeKey, reason: outcome.reason })
        options.onProgress?.({ index, total, citeKey, status: 'failed', reason: outcome.reason })
        continue
      }

      result.importedPaperIds.push(outcome.paperId)
      if (outcome.kind === 'added') {
        result.added++
        options.onProgress?.({ index, total, citeKey, status: 'added' })
      } else if (outcome.kind === 'merged') {
        result.merged++
        options.onProgress?.({ index, total, citeKey, status: 'merged' })
      } else {
        result.mergedNoChange++
        options.onProgress?.({ index, total, citeKey, status: 'merged-no-change' })
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      result.failed++
      result.failureDetails.push({ citeKey, reason })
      options.onProgress?.({ index, total, citeKey, status: 'failed', reason })
    }
  }

  return result
}

// ─── Per-entry import ─────────────────────────────────────────────────────

type EntryOutcome =
  | { kind: 'added'; paperId: string }
  | { kind: 'merged'; paperId: string }
  | { kind: 'merged-no-change'; paperId: string }
  | { kind: 'failed'; reason: string }

function importOneEntry(entry: Entry, title: string, ctx: CLIContext): EntryOutcome {
  const authors = parseAuthorList(entry.fields.author as Creator[] | undefined)
  const year = parseYear(
    pickStringField(entry, 'year'),
    pickStringField(entry, 'date'),
  )
  const doi = extractDoi(
    pickStringField(entry, 'doi'),
    pickStringField(entry, 'url'),
  )
  const arxivId = extractArxivId(entry)
  const venue = pickVenue(entry)
  const url = pickStringField(entry, 'url')
  const abstract = pickStringField(entry, 'abstract') ?? ''
  const tags = parseKeywords(entry.fields.keywords as string[] | undefined)

  const reconstructedBibtex = reconstructStandaloneBibtex(entry)

  // RFC-006 §6: identityConfidence policy.
  //   - DOI → 'high' (world-unique, hard to typo accidentally)
  //   - arXivId only → 'medium' (stable but may split preprint vs. published)
  //   - neither → 'low' (only title+year — title is very easy to mis-type)
  const identityConfidence: 'high' | 'medium' | 'low' =
    doi ? 'high' : (arxivId ? 'medium' : 'low')

  // pdfUrl: heuristic only. Do NOT synthesize from the Zotero `file = ...`
  // field — see RFC-006 §8. A path on user-A's machine is meaningless
  // when the project opens on user-B's machine.
  const pdfUrl = url && /\.pdf(\?|$)/i.test(url) ? url : undefined

  const result = upsertPaperArtifact(
    title,
    {
      authors: authors.length > 0 ? authors : undefined,
      year,
      abstract,
      venue,
      url,
      pdfUrl,
      citeKey: entry.key,
      doi,
      arxivId,
      bibtex: reconstructedBibtex,
      tags,
      externalSource: 'bibtex-import',
      identityConfidence,
      // RFC-006 review #1 — without this override, the existing upsert
      // auto-derivation would label imported papers `source: 'agent'`.
      provenance: {
        source: 'import',
        extractedFrom: 'file-import',
      },
      // Deliberately undefined per RFC-006 §6:
      //   relevanceScore, relevanceJustification, subTopic, keyFindings,
      //   addedInRound, addedByTask, searchKeywords, citationCount,
      //   fulltextPath, pubmedId, pmcId, semanticScholarId,
      //   enrichmentSource, enrichedAt.
    },
    ctx,
  )

  if (!result.success || !result.paper) {
    return { kind: 'failed', reason: result.error ?? 'upsert-failed' }
  }

  if (!result.wasDeduped) {
    return { kind: 'added', paperId: result.paper.id }
  }

  // For dedup hits, distinguish "actually filled at least one field" vs.
  // "no-op merge". upsertPaperArtifact returns no `filePath` when the
  // patch was empty (no fields differed) — see paper-artifact.ts.
  return result.filePath
    ? { kind: 'merged', paperId: result.paper.id }
    : { kind: 'merged-no-change', paperId: result.paper.id }
}

// ─── Field extractors ─────────────────────────────────────────────────────

/**
 * Read a string field from a parsed Entry. The parser puts most fields in
 * `entry.fields` as strings, but a handful (author, editor, keywords,
 * institution, publisher, location, organization) are structured arrays.
 * For string-or-string-array fields we join into a single human-readable
 * line so downstream callers (venue, abstract, etc.) get a uniform shape.
 *
 * Output is normalized to Unicode NFC so string comparisons across the
 * codebase (test fixtures, dedup matching, user input) don't depend on
 * whether `é` is one codepoint (NFC) or two (NFD).
 */
function pickStringField(entry: Entry, name: string): string | undefined {
  const value = entry.fields[name]
  let str: string | undefined
  if (typeof value === 'string') {
    str = value
  } else if (Array.isArray(value)) {
    // string[] (publisher, location, institution, …) — join. Skip Creator[]
    // which is an array of objects.
    if (value.length === 0) return undefined
    if (typeof value[0] === 'string') {
      str = (value as string[]).map(v => v.trim()).filter(Boolean).join('; ')
    } else {
      return undefined
    }
  } else {
    return undefined
  }
  if (!str) return undefined
  const trimmed = str.trim().normalize('NFC')
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Convert the parser's structured `Creator[]` form into the flat
 * `"First Last"` strings PaperArtifact uses.
 *
 * Drops the `"others"` token (BibTeX convention for "et al."). When a
 * `Creator` has only `name` (corporate / "Anonymous Researcher"), pass
 * it through as-is. For person names, compose
 * `[firstName] [prefix] lastName[, suffix]`.
 */
function parseAuthorList(creators: Creator[] | undefined): string[] {
  if (!creators || creators.length === 0) return []

  const out: string[] = []
  for (const c of creators) {
    // Corporate / single-token names — pass through. The "others" literal
    // is BibTeX's et-al marker; drop it.
    if (c.name) {
      const trimmed = c.name.trim()
      if (trimmed.toLowerCase() === 'others') continue
      out.push(trimmed.normalize('NFC'))
      continue
    }

    const last = (c.lastName ?? '').trim()
    if (!last) continue
    if (last.toLowerCase() === 'others') continue

    const parts: string[] = []
    if (c.firstName) parts.push(c.firstName.trim())
    if (c.prefix) parts.push(c.prefix.trim())
    parts.push(last)
    let composed = parts.join(' ').replace(/\s+/g, ' ').trim()
    if (c.suffix) composed = `${composed}, ${c.suffix.trim()}`
    out.push(composed.normalize('NFC'))
  }
  return out
}

/**
 * Parse a year from either the `year` field or a BibLaTeX `date` field
 * (the latter may carry `2024-03-15`). Returns undefined for non-numeric
 * inputs like `"to appear"` / `"in press"` — those legitimately exist
 * in academic .bib files and must not throw.
 */
function parseYear(yearField: string | undefined, dateField: string | undefined): number | undefined {
  const source = yearField ?? dateField
  if (!source) return undefined
  const match = source.match(/\b(1[89]\d{2}|20\d{2}|21\d{2})\b/)
  if (!match) return undefined
  const value = parseInt(match[1], 10)
  if (!Number.isFinite(value) || value < 1900 || value > 2100) return undefined
  return value
}

/**
 * Extract a normalized DOI from the dedicated `doi` field or, as a
 * fallback, from a `url` that points at doi.org.
 */
function extractDoi(doiField: string | undefined, urlField: string | undefined): string | undefined {
  if (doiField) return normalizeDoi(doiField)
  if (urlField) {
    const match = urlField.match(/doi\.org\/(.+)$/i)
    if (match) return normalizeDoi(match[1])
  }
  return undefined
}

/**
 * Extract an arXiv identifier from BibLaTeX `eprint`+`eprinttype`, a
 * DOI of the form `10.48550/arXiv.<id>`, or a URL pointing at
 * arxiv.org/abs/<id>. Strips trailing version suffixes (`v2`).
 */
function extractArxivId(entry: Entry): string | undefined {
  const eprint = pickStringField(entry, 'eprint')
  const eprintType = pickStringField(entry, 'eprinttype')
  if (eprint && eprintType && eprintType.toLowerCase() === 'arxiv') {
    const stripped = eprint.replace(/v\d+$/i, '')
    if (isValidArxivId(stripped)) return stripped
  }

  const doi = pickStringField(entry, 'doi')
  if (doi) {
    const match = doi.match(/^10\.48550\/arXiv\.(.+)$/i)
    if (match) {
      const stripped = match[1].replace(/v\d+$/i, '')
      if (isValidArxivId(stripped)) return stripped
    }
  }

  const url = pickStringField(entry, 'url')
  if (url) {
    const match = url.match(/arxiv\.org\/abs\/([^?#]+)/i)
    if (match) {
      const stripped = match[1].replace(/v\d+$/i, '')
      if (isValidArxivId(stripped)) return stripped
    }
  }

  return undefined
}

/**
 * Pick the most semantically appropriate "venue" field for this entry
 * type, in priority order:
 *   article         → journal
 *   inproceedings/incollection/conference → booktitle
 *   misc            → howpublished
 *   book/phdthesis/mastersthesis → publisher
 * Falls back to whichever of those fields is non-empty if the entry
 * type uses an unconventional schema.
 */
function pickVenue(entry: Entry): string | undefined {
  const order: string[] = (() => {
    switch (entry.type.toLowerCase()) {
      case 'article': return ['journal', 'booktitle', 'howpublished', 'publisher']
      case 'inproceedings':
      case 'incollection':
      case 'conference': return ['booktitle', 'journal', 'publisher', 'howpublished']
      case 'misc':
      case 'online': return ['howpublished', 'journal', 'booktitle', 'publisher']
      case 'book':
      case 'phdthesis':
      case 'mastersthesis':
      case 'techreport': return ['publisher', 'institution', 'school', 'journal']
      default: return ['journal', 'booktitle', 'howpublished', 'publisher']
    }
  })()

  for (const key of order) {
    const value = pickStringField(entry, key)
    if (value) return value
  }
  return undefined
}

/**
 * Convert the parser's `keywords` array (or a comma/semicolon-split
 * string if some weird input fell through) into a flat, deduped,
 * lowercased tag list.
 */
function parseKeywords(field: string[] | undefined): string[] {
  if (!field || field.length === 0) return []
  const out = new Set<string>()
  for (const raw of field) {
    for (const piece of String(raw).split(/[,;]/)) {
      const cleaned = piece.trim().toLowerCase()
      if (cleaned) out.add(cleaned)
    }
  }
  return Array.from(out)
}

// ─── Standalone-entry reconstruction (RFC-006 §9) ────────────────────────

/**
 * Re-serialize a parsed Entry back to standalone BibTeX. Used for the
 * `bibtex` field of the resulting PaperArtifact.
 *
 * Why we don't just store `entry.input` verbatim: the parser has already
 * resolved `@string` macros and crossref inheritance in `entry.fields`,
 * but `entry.input` still references them. A standalone `references.bib`
 * built from the verbatim text would contain unresolved tokens like
 * `booktitle = NIPS`. See RFC-006 §9.
 *
 * Why we don't re-encode UTF-8 back to LaTeX escapes (`Möller` → `M{\"o}ller`):
 * modern BibTeX toolchains (biber, used by all current LaTeX distributions)
 * handle UTF-8 natively. Re-encoding would require shipping a unicode-to-
 * LaTeX table and adds a lossy round-trip. If a user is on classic
 * `bibtex8` and wants escaped output, that's a follow-up — the data is
 * still preserved.
 */
export function reconstructStandaloneBibtex(entry: Entry): string {
  const lines: string[] = [`@${entry.type}{${entry.key},`]

  // Preserve the source's field ordering so the user's curation choices
  // (e.g. title first, doi last) survive the round trip. `Object.keys`
  // on the parsed fields keeps insertion order for string keys.
  for (const key of Object.keys(entry.fields)) {
    const value = entry.fields[key]
    if (value === undefined || value === null) continue

    let rendered: string | undefined

    if (Array.isArray(value)) {
      // Creator[] (author/editor/etc.) or string[] (keywords/...).
      if (value.length === 0) continue
      if (looksLikeCreators(value)) {
        rendered = renderCreators(value as Creator[])
      } else {
        rendered = (value as unknown as string[]).map(v => String(v).trim()).filter(Boolean).join(', ')
        if (!rendered) continue
      }
    } else if (typeof value === 'string') {
      rendered = value.trim()
      if (!rendered) continue
    } else {
      // Unknown field shape — skip rather than throw. We can revisit
      // if a real .bib in the wild produces a field shape we haven't
      // seen.
      continue
    }

    lines.push(`  ${key} = {${escapeBibtexValue(rendered)}},`)
  }

  lines.push('}')
  return lines.join('\n')
}

function looksLikeCreators(values: unknown[]): boolean {
  return values.every(v =>
    v && typeof v === 'object' && !Array.isArray(v) &&
    ('lastName' in (v as object) || 'firstName' in (v as object) || 'name' in (v as object))
  )
}

function renderCreators(creators: Creator[]): string {
  return creators.map(c => {
    if (c.name) return c.name.trim()
    const last = (c.lastName ?? '').trim()
    const first = (c.firstName ?? '').trim()
    const prefix = (c.prefix ?? '').trim()
    const suffix = (c.suffix ?? '').trim()
    if (!last) return first
    let head = prefix ? `${prefix} ${last}` : last
    if (suffix) head = `${head}, ${suffix}`
    return first ? `${head}, ${first}` : head
  }).filter(Boolean).join(' and ')
}

/**
 * Minimal escaping for BibTeX values wrapped in `{...}`. BibTeX is
 * forgiving — the main hazard is unbalanced braces inside the value
 * that would confuse a re-parser. We escape stray closing braces but
 * leave LaTeX commands alone (the parser already decoded `{\'e}` to
 * `é`, so we don't need to re-emit either form).
 */
function escapeBibtexValue(value: string): string {
  // Balance check: ensure outer { ... } can re-parse. If the field
  // contains unbalanced braces, neutralize the lone ones.
  let depth = 0
  let result = ''
  for (const ch of value) {
    if (ch === '{') depth++
    if (ch === '}') {
      if (depth === 0) {
        // Lone closing brace — escape it.
        result += '\\}'
        continue
      }
      depth--
    }
    result += ch
  }
  // Any unbalanced openers? Add closers at the end.
  if (depth > 0) result += '}'.repeat(depth)
  return result
}
