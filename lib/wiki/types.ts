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

// ── Semantic hash — only hashes fields that affect wiki content quality ─────

export function computeSemanticHash(artifact: PaperArtifact): string {
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
}
