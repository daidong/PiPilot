/**
 * Trace loader for diagnostics (P3.2).
 *
 * Reads trace data off disk for the diagnostic engine. Two functions:
 *   - `loadTraceForDiagnostics(projectPath, traceId)` — single trace,
 *     deduped, sorted by startTime, parent map built.
 *   - `loadTraceCorpus(projectPath, days)` — last N days of traces, used
 *     to build cross-trace baselines (p50/p95 by tool category).
 *
 * Tombstoned traces are skipped — diagnostics on a partial trace produce
 * misleading findings.
 */

import { join } from 'node:path'
import type { LiveSpanSummary } from '../live-processor.js'
import { dateStampUtc } from '../otlp-decode.js'
import {
  listTraceSpanFiles,
  listTraceTombstoneFiles,
  readTraceSpansFile,
  readTraceTombstoneIds,
  traceFilesDir
} from '../trace-files.js'

export interface LoadedTrace {
  traceId: string
  spans: LiveSpanSummary[]
  /** spanId → span (fast lookup). */
  bySpanId: Map<string, LiveSpanSummary>
  /** parentSpanId → list of children. Root spans are listed under `'__root__'`. */
  children: Map<string, LiveSpanSummary[]>
}

function dedupAndSort(spans: LiveSpanSummary[]): LiveSpanSummary[] {
  const seen = new Map<string, LiveSpanSummary>()
  for (const s of spans) {
    const existing = seen.get(s.spanId)
    // Keep the latest version of each spanId — re-emitted spans (degraded
    // recovery) win over earlier writes.
    if (!existing || s.endTime > existing.endTime) {
      seen.set(s.spanId, s)
    }
  }
  return [...seen.values()].sort((a, b) => a.startTime.localeCompare(b.startTime))
}

function buildChildrenMap(spans: LiveSpanSummary[]): Map<string, LiveSpanSummary[]> {
  const out = new Map<string, LiveSpanSummary[]>()
  for (const s of spans) {
    const key = s.parentSpanId ?? '__root__'
    let bucket = out.get(key)
    if (!bucket) {
      bucket = []
      out.set(key, bucket)
    }
    bucket.push(s)
  }
  return out
}

/**
 * Load one trace for diagnostics. Scans the most recent `lookbackDays`
 * (default 7) of spans files. Returns `null` if the traceId is tombstoned
 * or has no spans on disk.
 */
export function loadTraceForDiagnostics(
  projectPath: string,
  traceId: string,
  lookbackDays = 7
): LoadedTrace | null {
  const tracesDir = traceFilesDir(projectPath)
  const tombs = new Set<string>()
  for (const f of listTraceTombstoneFiles(tracesDir)) {
    for (const tid of readTraceTombstoneIds(join(tracesDir, f))) tombs.add(tid)
  }
  if (tombs.has(traceId)) return null

  const all: LiveSpanSummary[] = []
  const files = listTraceSpanFiles(tracesDir, true).slice(0, lookbackDays)
  for (const f of files) {
    all.push(...readTraceSpansFile(join(tracesDir, f), traceId))
  }
  if (all.length === 0) return null
  const spans = dedupAndSort(all)
  return {
    traceId,
    spans,
    bySpanId: new Map(spans.map((s) => [s.spanId, s])),
    children: buildChildrenMap(spans)
  }
}

/**
 * Load a corpus of traces for baseline construction. Skips tombstoned traces.
 * Returns spans grouped by traceId — the engine's `buildBaseline` flattens them
 * for percentile work.
 */
export function loadTraceCorpus(
  projectPath: string,
  lookbackDays = 1
): { spansByTrace: Map<string, LiveSpanSummary[]>; allSpans: LiveSpanSummary[] } {
  const tracesDir = traceFilesDir(projectPath)
  const tombs = new Set<string>()
  for (const f of listTraceTombstoneFiles(tracesDir)) {
    for (const tid of readTraceTombstoneIds(join(tracesDir, f))) tombs.add(tid)
  }
  const spansByTrace = new Map<string, LiveSpanSummary[]>()
  const allSpans: LiveSpanSummary[] = []
  const files = listTraceSpanFiles(tracesDir, true).slice(0, lookbackDays)
  for (const f of files) {
    for (const s of readTraceSpansFile(join(tracesDir, f))) {
      if (tombs.has(s.traceId)) continue
      let bucket = spansByTrace.get(s.traceId)
      if (!bucket) {
        bucket = []
        spansByTrace.set(s.traceId, bucket)
      }
      bucket.push(s)
      allSpans.push(s)
    }
  }
  // Dedup per trace.
  for (const [tid, spans] of spansByTrace) {
    spansByTrace.set(tid, dedupAndSort(spans))
  }
  return { spansByTrace, allSpans }
}

/** Suppress unused-import warning for callers who only want types. */
export type { LiveSpanSummary }
export { dateStampUtc }
