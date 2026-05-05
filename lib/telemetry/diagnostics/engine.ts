/**
 * Diagnostic engine — runs a set of rules against a trace and produces
 * `Finding` records (P3.1).
 *
 * Pure functions all the way down: input is a list of `LiveSpanSummary`
 * objects (same shape used by the renderer trace-store and the snapshot
 * reader), output is `Finding[]`. No I/O. This means the engine works in
 * the CLI, in notebooks, in unit tests, and (eventually) in a renderer
 * inspector view — without changing surface.
 *
 * Rule design:
 *   - Each rule is a pure function `(spans, ctx) => Finding[]`.
 *   - Rules MUST NOT mutate inputs.
 *   - Rules SHOULD return at most a handful of findings per trace; they're
 *     for human consumption, not exhaustive diff lists.
 *   - Severity is descriptive, not actionable: "info" = noteworthy,
 *     "warn" = likely a bug or perf issue, "error" = definitely broken.
 *
 * What this engine is NOT:
 *   - Not a SLO checker. No alerting, no thresholds wired to dashboards.
 *   - Not a Layer-3 annotator. It does not classify "anchor facts" or
 *     "repair turns" — that's a separate research codebase (spec §0).
 *   - Not real-time. Diagnostics run on completed traces; the live UI uses
 *     the trace-store directly.
 */

import type { LiveSpanSummary } from '../live-processor.js'

export type Severity = 'info' | 'warn' | 'error'

export interface Finding {
  /** Stable rule id; used for filtering and de-duplication. */
  ruleId: string
  /** Short human-readable summary, < 120 chars. */
  summary: string
  severity: Severity
  /** SpanIds the finding implicates — the UI / CLI links from these. */
  spanIds: string[]
  /** Free-form context. Stable across same trace + same rule version. */
  context?: Record<string, unknown>
}

export interface RuleContext {
  traceId: string
  /** Optional baseline aggregates supplied by the engine for cross-trace rules. */
  baseline?: TraceBaseline
}

/**
 * Cross-trace baseline aggregates. Computed by the engine before running
 * rules so any rule can read p50/p95 without each one re-scanning history.
 *
 * Optional: rules MUST tolerate `baseline` being absent (single-trace mode).
 */
export interface TraceBaseline {
  /** Per-tool-category duration percentiles (ms). */
  toolCategoryDurationP95: Record<string, number>
  toolCategoryDurationMedian: Record<string, number>
}

export type Rule = (spans: LiveSpanSummary[], ctx: RuleContext) => Finding[]

export interface RegisteredRule {
  id: string
  description: string
  rule: Rule
}

/**
 * Run a list of rules against a trace's spans. Rules execute sequentially —
 * sequential ordering is fine because rules are tiny and we run on a small
 * set of spans (typically 5-100). If a rule throws, the engine swallows the
 * error and emits a synthetic `engine.rule_failed` finding so the failure
 * is surfaced rather than silently dropped.
 */
export function runDiagnostics(
  spans: LiveSpanSummary[],
  rules: RegisteredRule[],
  ctx: RuleContext
): Finding[] {
  const out: Finding[] = []
  for (const r of rules) {
    try {
      out.push(...r.rule(spans, ctx))
    } catch (err) {
      out.push({
        ruleId: 'engine.rule_failed',
        severity: 'error',
        summary: `Rule "${r.id}" threw: ${(err as Error).message}`,
        spanIds: [],
        context: { failingRule: r.id, error: (err as Error).message }
      })
    }
  }
  return out
}

/**
 * Quantile helper used by baseline construction. Returns the q-th percentile
 * of `xs` (q in [0,1]). Linear interpolation. Returns NaN on empty input.
 */
export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return Number.NaN
  const sorted = [...xs].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

/**
 * Build a TraceBaseline by walking many traces' spans. Caller supplies all
 * spans across the corpus they want to baseline against — this is typically
 * "the last 24h" or "the last 30 traces".
 */
export function buildBaseline(allSpans: LiveSpanSummary[]): TraceBaseline {
  const byCategory = new Map<string, number[]>()
  for (const s of allSpans) {
    const op = s.attributes['gen_ai.operation.name']
    if (op !== 'execute_tool') continue
    const cat = String(s.attributes['pipilot.tool.category'] ?? 'unknown')
    let bucket = byCategory.get(cat)
    if (!bucket) {
      bucket = []
      byCategory.set(cat, bucket)
    }
    bucket.push(s.durationMs)
  }
  const p95: Record<string, number> = {}
  const median: Record<string, number> = {}
  for (const [cat, durations] of byCategory) {
    p95[cat] = quantile(durations, 0.95)
    median[cat] = quantile(durations, 0.5)
  }
  return { toolCategoryDurationP95: p95, toolCategoryDurationMedian: median }
}

/** Group spans by traceId. Useful when running rules across many traces. */
export function groupByTrace(spans: LiveSpanSummary[]): Map<string, LiveSpanSummary[]> {
  const out = new Map<string, LiveSpanSummary[]>()
  for (const s of spans) {
    let bucket = out.get(s.traceId)
    if (!bucket) {
      bucket = []
      out.set(s.traceId, bucket)
    }
    bucket.push(s)
  }
  return out
}
