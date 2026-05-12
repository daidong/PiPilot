/**
 * Paper Pack Report — top-level orchestrator (RFC-007 PR-B).
 *
 * Wires together input-builder, aggregate, ranker, synthesizer, both
 * renderers, hash, and state. Writes `rp-paper-pack-report.md` and
 * `.html` to the project root, plus `.research-pilot/report-state.json`
 * for persistence.
 *
 * Single LLM call (the theme synthesis); everything else is
 * deterministic. Emits progress events at six discrete steps —
 * deliberately coarse, since the LLM call itself is the longest leg
 * (~30s) and a smooth-looking percent bar would be a lie.
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  CallLlm,
  ReportInput,
  ProgressCallback,
  AssembledReport,
} from './types.js'
import { buildReportInput } from './input-builder.js'
import { aggregateReport } from './aggregate.js'
import { rankOnboardingPath } from './ranker.js'
import { synthesizeThemes } from './synthesize.js'
import { renderMarkdown } from './render-markdown.js'
import { renderHtml } from './render-html.js'
import { computeReportInputHash } from './hash.js'
import {
  readReportState,
  writeReportState,
  REPORT_STATE_SCHEMA_VERSION,
} from './state.js'

export interface GenerateReportOptions {
  projectPath: string
  callLlm: CallLlm
  onProgress?: ProgressCallback
  /**
   * Optional: skip the LLM call entirely. Used by smoke tests that
   * want to assert markdown shape against a fixed input without
   * paying for synthesis.
   */
  skipSynthesis?: boolean
  /**
   * Optional: skip the existing-hash cache check and force regeneration.
   * The button's "Regenerate" affordance (PR-C confirm modal) passes this.
   */
  force?: boolean
}

export interface GenerateReportResult {
  success: boolean
  /** Absolute paths to the artifact files when success === true. */
  markdownPath?: string
  htmlPath?: string
  /** Hash of the input that was just consumed. */
  inputHash?: string
  /** Set when success === false. */
  error?: string
  /**
   * True when the call returned the cached file without re-running.
   * UI uses this to decide whether to bump generatedAt timestamp.
   */
  cacheHit?: boolean
  stats?: AssembledReport['stats']
}

const MARKDOWN_FILENAME = 'rp-paper-pack-report.md'
const HTML_FILENAME = 'rp-paper-pack-report.html'

export async function generatePaperPackReport(
  opts: GenerateReportOptions
): Promise<GenerateReportResult> {
  const { projectPath, callLlm, onProgress, skipSynthesis, force } = opts

  try {
    // Persisted state at top of run so we can mark 'running' and have
    // the UI pick it up across restarts.
    writeReportState(projectPath, {
      schemaVersion: REPORT_STATE_SCHEMA_VERSION,
      status: 'running',
    })

    // ── Step 1: build input ────────────────────────────────────
    onProgress?.({ step: 'building-input', percent: 5 })
    const input = buildReportInput(projectPath)
    if (input.papers.length === 0) {
      throw new Error('No paper artifacts in this project — nothing to synthesize.')
    }

    // ── Cache check ────────────────────────────────────────────
    const inputHash = computeReportInputHash(input)
    if (!force) {
      const prior = readReportState(projectPath)
      if (
        prior &&
        prior.status === 'done' &&
        prior.inputHash === inputHash &&
        prior.markdownPath &&
        prior.htmlPath &&
        existsSync(prior.markdownPath) &&
        existsSync(prior.htmlPath)
      ) {
        // Cache hit — report is up to date, no work needed.
        onProgress?.({ step: 'writing-files', percent: 100 })
        return {
          success: true,
          cacheHit: true,
          markdownPath: prior.markdownPath,
          htmlPath: prior.htmlPath,
          inputHash,
          stats: prior.stats,
        }
      }
    }

    // ── Step 2: deterministic aggregate ────────────────────────
    onProgress?.({ step: 'aggregating', percent: 15 })
    const agg = aggregateReport(input)

    // ── Step 3: onboarding ranker ──────────────────────────────
    onProgress?.({ step: 'ranking-onboarding', percent: 25 })
    const ranking = rankOnboardingPath(input)

    // ── Step 4: LLM synthesis (the only expensive step) ────────
    onProgress?.({ step: 'synthesizing-themes', percent: 35, detail: 'one LLM call, ~20-60s' })
    const synthesis = skipSynthesis
      ? { themes: [], talkingPoints: [] }
      : await synthesizeThemes(input, callLlm)

    // ── Step 5: render markdown ────────────────────────────────
    onProgress?.({ step: 'rendering-markdown', percent: 85 })
    const markdown = renderMarkdown(input, agg, synthesis, ranking)

    // ── Step 6: render HTML ────────────────────────────────────
    onProgress?.({ step: 'rendering-html', percent: 92 })
    const html = renderHtml(input, agg, synthesis, ranking)

    // ── Step 7: write files ────────────────────────────────────
    onProgress?.({ step: 'writing-files', percent: 98 })
    const markdownPath = join(projectPath, MARKDOWN_FILENAME)
    const htmlPath = join(projectPath, HTML_FILENAME)
    // Ensure project root exists (it does, but defensive).
    const parent = dirname(markdownPath)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    writeFileSync(markdownPath, markdown, 'utf-8')
    writeFileSync(htmlPath, html, 'utf-8')

    const stats: AssembledReport['stats'] = {
      paperCount: input.papers.length,
      themeCount: synthesis.themes.length,
      talkingPointCount: synthesis.talkingPoints.length,
      onboardingCount: ranking.entries.length,
      fulltextCount: agg.fulltextCount,
      abstractOnlyCount: agg.abstractOnlyCount,
    }

    // Persist final state.
    writeReportState(projectPath, {
      schemaVersion: REPORT_STATE_SCHEMA_VERSION,
      status: 'done',
      inputHash,
      generatedAt: new Date().toISOString(),
      markdownPath,
      htmlPath,
      stats,
    })

    onProgress?.({ step: 'writing-files', percent: 100 })
    return { success: true, markdownPath, htmlPath, inputHash, stats }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    writeReportState(projectPath, {
      schemaVersion: REPORT_STATE_SCHEMA_VERSION,
      status: 'error',
      error: message,
    })
    return { success: false, error: message }
  }
}

// ─── Re-exports ──────────────────────────────────────────────────────────

export { readReportState } from './state.js'
export type { ReportPersistedState } from './state.js'
export type {
  ReportInput,
  ReportPaperEntry,
  AggregateSummary,
  SynthesisOutput,
  ThemeBlock,
  TalkingPoint,
  OnboardingPath,
  OnboardingPaperEntry,
  CallLlm,
  ProgressCallback,
  ReportProgressEvent,
} from './types.js'
