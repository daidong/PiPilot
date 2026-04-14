/**
 * Wiki Types — canonical identity, pacing, agent config, status.
 *
 * This is the leaf module: no imports from other lib/wiki/ files.
 */

import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { normalizeDoi } from '../memory-v2/store.js'
import type { PaperArtifact } from '../types.js'

// ── Wiki root ──────────────────────────────────────────────────────────────

export function getWikiRoot(): string {
  return join(homedir(), '.research-pilot', 'paper-wiki')
}

// ── Generator version — bump when wiki prompts change ──────────────────────
// V3 = RFC-005: adds embedded <!-- WIKI-META --> memory sidecar block.
// Existing RFC-003 pages (no meta block) stay valid as body-only memory
// until the repair pass regenerates them. See lib/docs/rfc/005-wiki-sidecar-and-retrieval.md.

export const GENERATOR_VERSION = 3

// ── Hash schema version — bump when computeSemanticHash projection changes ──
// V1 = pre-hotfix: hash mixed canonical fields with per-project lens fields
//      (relevanceJustification, subTopic, keyFindings) and fulltextPath. This
//      caused false "semantic-change" reprocesses whenever a new project
//      saved the same paper with a different justification.
// V2 = hotfix: canonical-only projection. Lens fields live in the sidecar
//      (via lens-deriver), not in the content hash. fulltextPath moved out
//      because it's not part of the generation input — the explicit
//      fulltextStatus state machine in scanner handles abstract→fulltext
//      upgrades and is decoupled from the hash.
//
// IMPORTANT: bumping this is "stop the bleeding", not "retroactively fix
// polluted page bodies". Existing pages generated under V1 still contain
// lens contamination in the body prose. Cleaning those requires a separate
// controlled regen pass (follow-up work), not this hotfix. scanner.ts
// re-stamps old-schema watermarks on first post-hotfix scan so the fix
// does NOT trigger a 211x reprocess avalanche.

export const HASH_SCHEMA_VERSION = 2

// ── Canonical paper identity ───────────────────────────────────────────────

export interface CanonicalPaperIdentity {
  canonicalKey: string
  keySource: 'doi' | 'arxivId' | 'title+year'
}

/**
 * Validate that an arXiv ID looks genuine.
 * Real formats: "2301.12345", "hep-th/0401001", or URL forms.
 * Rejects bogus IDs like "803" or "912" (truncated conference paper IDs).
 */
export function isValidArxivId(arxivId: string): boolean {
  const bare = arxivId
    .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    .replace(/v\d+$/, '')
  // New format: YYMM.NNNNN (4+ digit suffix)
  if (/^\d{4}\.\d{4,}$/.test(bare)) return true
  // Old format: category/NNNNNNN
  if (/^[a-z-]+\/\d{5,}$/.test(bare)) return true
  return false
}

/**
 * Compute a globally-unique canonical key for a paper artifact.
 * Priority: DOI > arxivId > normalized(title+year).
 *
 * This deliberately diverges from project-level dedup (which uses citeKey)
 * because citeKey is not globally unique across projects.
 */
export function computeCanonicalKey(artifact: PaperArtifact): CanonicalPaperIdentity {
  // Priority 1: DOI (most authoritative)
  if (artifact.doi && !artifact.doi.startsWith('unknown:')) {
    return { canonicalKey: `doi:${normalizeDoi(artifact.doi)}`, keySource: 'doi' }
  }
  // Priority 2: arXiv ID (stable external identifier) — must look genuine
  if (artifact.arxivId && isValidArxivId(artifact.arxivId)) {
    const bareId = artifact.arxivId
      .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
      .replace(/v\d+$/, '')
    return { canonicalKey: `arxiv:${bareId}`, keySource: 'arxivId' }
  }
  // Priority 3: normalized title + year (fallback)
  const title = artifact.title.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { canonicalKey: `title:${title}:${artifact.year ?? 'nd'}`, keySource: 'title+year' }
}

// ── Semantic hash — canonical paper content only (HASH_SCHEMA_VERSION=2) ────
//
// Only fields that describe the PAPER ITSELF belong here. Fields that
// describe "how a particular project used the paper" (relevanceJustification,
// subTopic, keyFindings) are project lenses and live in the sidecar, NOT
// in the content hash — mixing them caused cross-project reprocess storms
// because two projects saving the same paper with different justifications
// would produce different hashes and trigger false "semantic-change" events.
//
// fulltextPath is also excluded: the generator consumes the DOWNLOADED
// fulltext string (via agent.downloadAndConvertArxiv), not the artifact's
// fulltextPath field. Abstract→fulltext transitions are handled by the
// explicit fulltextStatus state machine in scanner.ts (fulltext-upgrade
// reason), which is decoupled from the hash. Including fulltextPath here
// would create "hash changed but generation input is identical" false
// positives.
//
// When editing this function, bump HASH_SCHEMA_VERSION so scanner.ts can
// re-stamp existing watermarks in place without triggering reprocess.

export function computeSemanticHash(artifact: PaperArtifact): string {
  const projection = {
    title: artifact.title,
    authors: artifact.authors,
    abstract: artifact.abstract,
    year: artifact.year,
    venue: artifact.venue,
    doi: artifact.doi,
    arxivId: artifact.arxivId,
  }
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex').slice(0, 16)
}

// ── Legacy V1 hash — migration use ONLY ─────────────────────────────────────
//
// Frozen copy of the pre-hotfix (HASH_SCHEMA_VERSION=1) projection. Field
// order is byte-for-byte identical to what lived at types.ts HEAD~1, so
// JSON.stringify produces the same key sequence and therefore the same
// digest. DO NOT change this function for any reason — it exists so the
// scanner can re-derive the V1 hash for an artifact currently on disk and
// ask "does this match what V1 would have stored?". If yes, the stored V1
// hash is a valid record of unchanged canonical content and we can silently
// re-stamp with the V2 hash. If no, something changed since the last V1
// processing — either canonical content or a lens field — and we MUST
// fall through to the normal diff path so the scanner reprocesses the
// paper. See scanner.ts "Hash schema migration" block for the guard.
//
// This function is the ONLY place where lens fields and fulltextPath are
// still allowed to influence a hash. It is NOT exported for general use;
// only scanner.ts imports it. Downstream code that wants "current semantic
// hash" must use computeSemanticHash.

export function computeSemanticHashV1(artifact: PaperArtifact): string {
  const projection = {
    title: artifact.title,
    authors: artifact.authors,
    abstract: artifact.abstract,
    year: artifact.year,
    venue: artifact.venue,
    doi: artifact.doi,
    arxivId: artifact.arxivId,
    keyFindings: artifact.keyFindings,
    relevanceJustification: artifact.relevanceJustification,
    subTopic: artifact.subTopic,
    fulltextPath: artifact.fulltextPath,
  }
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex').slice(0, 16)
}

/**
 * Migration predicate: may the scanner silently re-stamp a pre-hotfix
 * watermark entry with the new V2 hash, without triggering a reprocess?
 *
 * Only YES when:
 *   1. the entry is at an older HASH_SCHEMA_VERSION, AND
 *   2. the stored (V1) hash exactly matches what V1 would compute from
 *      the current artifact.
 *
 * Condition (2) is the critical guard: if the canonical content changed
 * since the last V1 processing, the V1-predicted hash will differ from
 * what's stored, and we return false — letting the normal diff path
 * (watermark.semanticHash !== semanticHash) fire a 'semantic-change'
 * reprocess. This preserves the "paper changed → reprocess" invariant
 * across the schema bump.
 *
 * Pure function. Extracted here (rather than inlined in scanner.ts) so
 * the hotfix regression test can pin its behavior without mocking the
 * whole scanner pipeline. Do not consult this predicate from outside
 * the migration path.
 */
export function canSilentRestampLegacyWatermark(
  priorWatermark: ProcessedEntry,
  artifact: PaperArtifact,
): boolean {
  if ((priorWatermark.hashSchemaVersion ?? 1) >= HASH_SCHEMA_VERSION) return false
  return priorWatermark.semanticHash === computeSemanticHashV1(artifact)
}

// ── Slug rules — deterministic filename from canonical key ─────────────────

export function canonicalKeyToSlug(canonicalKey: string): string {
  return canonicalKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
}

// ── Fulltext status ────────────────────────────────────────────────────────

export type FulltextStatus = 'fulltext' | 'abstract-only' | 'abstract-fallback'

// ── Watermark types (JSONL records) ────────────────────────────────────────

export interface ProcessedEntry {
  canonicalKey: string
  slug: string
  semanticHash: string
  fulltextStatus: FulltextStatus
  generatorVersion: number
  processedAt: string  // ISO timestamp

  // Which version of computeSemanticHash produced `semanticHash`. Absent
  // for legacy entries — treat as 1 (pre-hotfix schema). See
  // HASH_SCHEMA_VERSION comment for migration semantics.
  hashSchemaVersion?: number

  // Fulltext retry backoff (set when fulltextStatus='abstract-fallback').
  // Absent for legacy entries — treat as 0.
  fulltextFailures?: number
  lastFulltextTryAt?: string  // ISO timestamp
}

export interface ProvenanceEntry {
  canonicalKey: string
  projectPath: string
  paperId: string
  addedAt: string  // ISO timestamp
}

// ── Pacing configuration ───────────────────────────────────────────────────

export interface WikiPacingConfig {
  papersPerCycle: number
  cycleCooldownMs: number
  interCallDelayMs: number
  idleScanIntervalMs: number
  startupDelayMs: number
}

// ── Wiki agent config ──────────────────────────────────────────────────────

export interface WikiAgentConfig {
  /** callLlm function configured for the wiki model (from settings) */
  callLlm: (systemPrompt: string, userContent: string) => Promise<string>
  /** Returns current active project paths */
  projectPaths: () => string[]
  /** Pacing from resolved speed preset */
  pacing: WikiPacingConfig
  /** Status callback for Settings dashboard */
  onStatus?: (status: WikiStatus) => void
  debug?: boolean
}

// ── Wiki agent status ──────────────────────────────────────────────────────

export interface WikiStatus {
  state: 'processing' | 'idle' | 'paused' | 'disabled'
  processed: number     // papers processed this session
  pending: number       // papers pending in current scan
  totalInWiki: number   // total paper pages in wiki
  lastRunAt?: string    // ISO timestamp
}

// ── Wiki agent interface ───────────────────────────────────────────────────

export interface WikiAgent {
  start(): void
  pause(): void
  resume(): void
  destroy(): void
  runOnce(): Promise<{ processed: number; errors: number }>
  readonly isActive: boolean
}

// ── Scan result categories ─────────────────────────────────────────────────

export type ScanReason = 'new' | 'semantic-change' | 'fulltext-upgrade' | 'generator-bump' | 'provenance-only' | 'repair'

export interface ScanResult {
  canonicalKey: string
  keySource: 'doi' | 'arxivId' | 'title+year'
  slug: string
  reason: ScanReason
  artifact: PaperArtifact
  projectPath: string
  semanticHash: string

  /**
   * Additional (projectPath, artifact) pairs sharing the same canonicalKey.
   * Used after processPaper writes the page to merge project lenses for all
   * projects that already contributed this paper — fixes the "multi-project
   * new paper lens loss" where the provenance-only branch would no-op
   * because the page didn't exist yet.
   */
  siblings?: { projectPath: string; artifact: PaperArtifact }[]
}
