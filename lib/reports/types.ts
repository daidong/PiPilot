/**
 * Shared types for the Paper Pack Report generator (RFC-007 PR-B).
 *
 * The report's "input" is the union of a project's paper artifacts and
 * whatever Paper Wiki has extracted for each. Aggregations + the LLM
 * synthesis all operate over this structured view.
 *
 * No imports from main-process / Electron / IPC code lives here — the
 * types stay pure so the lib is reusable from CLI tests.
 */

import type { PaperArtifact } from '../types.js'
import type { WikiPaperMemoryMeta } from '../wiki/memory-schema.js'

// ─── Per-paper entry ─────────────────────────────────────────────────────

/**
 * The joined view of a paper artifact and its wiki extraction.
 *
 * `wiki` is null when the wiki agent hasn't processed this paper yet —
 * the report generator is designed to tolerate this (just emit a thin
 * appendix entry for that paper). In practice the button's
 * `ready` gate (RFC-007 §4) means we only run when wiki has caught up,
 * but the lib defends against the rare case anyway.
 */
export interface ReportPaperEntry {
  paper: PaperArtifact
  wiki: WikiPaperMemoryMeta | null
  /** Wiki page slug, when found. Used for `[citeKey]` anchor targets. */
  wikiSlug?: string
}

// ─── Aggregations (deterministic) ────────────────────────────────────────

export interface YearBucket {
  year: number
  count: number
}

export interface TopCitedEntry {
  citeKey: string
  title: string
  authors: string[]
  year?: number
  citationCount: number
}

/**
 * A frequency histogram over a wiki sidecar field (e.g. methods, datasets).
 * Each entry is one normalized term plus the papers that use it.
 */
export interface HistogramEntry {
  term: string
  count: number
  /** citeKeys of papers that contributed this term, for citation. */
  citeKeys: string[]
}

export interface AggregateSummary {
  totalPapers: number
  /** Papers whose wiki page came from full text vs. abstract-only. */
  fulltextCount: number
  abstractOnlyCount: number
  /** Year span. Both null when no paper carries a year. */
  earliestYear: number | null
  latestYear: number | null
  yearDistribution: YearBucket[]
  topCited: TopCitedEntry[]
  methods: HistogramEntry[]
  datasets: HistogramEntry[]
  /** Open-question / limitation tags flattened across the pack. */
  limitations: Array<{ citeKey: string; text: string }>
  negativeResults: Array<{ citeKey: string; text: string }>
}

// ─── Onboarding path (deterministic ranker) ──────────────────────────────

export interface OnboardingPaperEntry {
  citeKey: string
  title: string
  oneLineWhy: string
  /** Score components for transparency / debugging. */
  scoreComponents: {
    isSurvey: boolean
    citationCount: number
    conceptCentrality: number
  }
}

export interface OnboardingPath {
  /** Up to 5 papers in suggested reading order. */
  entries: OnboardingPaperEntry[]
}

// ─── LLM synthesis output ────────────────────────────────────────────────

export interface ThemeBlock {
  /** Short human-readable name, e.g. "Retrieval-Augmented Generation". */
  name: string
  /** citeKeys assigned to this theme. */
  papers: string[]
  /**
   * 2-3 sentence synthesis. MUST embed `[citeKey]` inline for every
   * factual claim. Validated post-LLM via regex; cite-keys not in the
   * pack are stripped.
   */
  synthesis: string
}

export interface TalkingPoint {
  point: string
  citeKeys: string[]
}

export interface SynthesisOutput {
  themes: ThemeBlock[]
  talkingPoints: TalkingPoint[]
  /**
   * Captured for diagnostic UI. Null on parser failure (the rest of
   * the report still ships, the section just falls back to a stub).
   */
  rawResponse?: string
}

// ─── Top-level report input + rendered output ────────────────────────────

export interface ReportInput {
  /** Project root absolute path, for project-name extraction in headers. */
  projectPath: string
  /** Human-friendly project name for the report H1. */
  projectName: string
  /** Joined paper + wiki entries. */
  papers: ReportPaperEntry[]
  /** Timestamp the input snapshot was taken (used in report header). */
  capturedAt: string
}

export interface AssembledReport {
  markdown: string
  html: string
  inputHash: string
  generatedAt: string
  /** Per-section diagnostic info — surfaced to the renderer for UI. */
  stats: {
    paperCount: number
    themeCount: number
    talkingPointCount: number
    onboardingCount: number
    fulltextCount: number
    abstractOnlyCount: number
  }
}

// ─── LLM injection point ─────────────────────────────────────────────────

/**
 * Minimal LLM interface the report generator depends on. Same shape as
 * `WikiAgentConfig.callLlm` — string in, string out, callee handles
 * provider / auth / tracing. Tests inject a deterministic fake.
 */
export type CallLlm = (systemPrompt: string, userContent: string) => Promise<string>

// ─── Progress events ─────────────────────────────────────────────────────

/**
 * Emitted by `generatePaperPackReport` as it walks through steps.
 * Sparse on purpose — one event per discrete step, not per LLM token.
 * The UI ticker shows the `step` label; `percent` is for the progress
 * bar inside the button.
 */
export interface ReportProgressEvent {
  step:
    | 'building-input'
    | 'aggregating'
    | 'ranking-onboarding'
    | 'synthesizing-themes'
    | 'rendering-markdown'
    | 'rendering-html'
    | 'writing-files'
  percent: number
  /** Optional one-line detail, e.g. theme name being processed. */
  detail?: string
}

export type ProgressCallback = (event: ReportProgressEvent) => void
