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

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from '../../types.js'
import type { LiveSpanSummary } from '../live-processor.js'
import { spanToSummary, dateStampUtc, type OtlpEnvelope } from '../otlp-decode.js'

interface TombstoneRow {
  traceId: string
  kind: 'trace_dropped'
  reason?: string
}

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

function readSpansFile(filePath: string): LiveSpanSummary[] {
  if (!existsSync(filePath)) return []
  const out: LiveSpanSummary[] = []
  try {
    const raw = readFileSync(filePath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const env = JSON.parse(trimmed) as OtlpEnvelope
        for (const scope of env.scopeSpans ?? []) {
          for (const span of scope.spans ?? []) {
            out.push(spanToSummary(span))
          }
        }
      } catch {
        // Skip malformed lines (writer crash mid-line is theoretically possible).
      }
    }
  } catch {
    // File unreadable.
  }
  return out
}

function readTombstones(filePath: string): Set<string> {
  if (!existsSync(filePath)) return new Set()
  const out = new Set<string>()
  try {
    const raw = readFileSync(filePath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = JSON.parse(trimmed) as TombstoneRow
        if (row.traceId) out.add(row.traceId)
      } catch {
        // skip
      }
    }
  } catch {
    // ignore
  }
  return out
}

function listSpanFiles(tracesDir: string): string[] {
  if (!existsSync(tracesDir)) return []
  try {
    return readdirSync(tracesDir)
      .filter((f) => /^spans\.\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse() // newest first
  } catch {
    return []
  }
}

function listTombstoneFiles(tracesDir: string): string[] {
  if (!existsSync(tracesDir)) return []
  try {
    return readdirSync(tracesDir)
      .filter((f) => /^tombstones\.\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
  } catch {
    return []
  }
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
  const tracesDir = join(projectPath, PATHS.traces)
  const tombs = new Set<string>()
  for (const f of listTombstoneFiles(tracesDir)) {
    for (const tid of readTombstones(join(tracesDir, f))) tombs.add(tid)
  }
  if (tombs.has(traceId)) return null

  const all: LiveSpanSummary[] = []
  const files = listSpanFiles(tracesDir).slice(0, lookbackDays)
  for (const f of files) {
    for (const s of readSpansFile(join(tracesDir, f))) {
      if (s.traceId === traceId) all.push(s)
    }
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
  const tracesDir = join(projectPath, PATHS.traces)
  const tombs = new Set<string>()
  for (const f of listTombstoneFiles(tracesDir)) {
    for (const tid of readTombstones(join(tracesDir, f))) tombs.add(tid)
  }
  const spansByTrace = new Map<string, LiveSpanSummary[]>()
  const allSpans: LiveSpanSummary[] = []
  const files = listSpanFiles(tracesDir).slice(0, lookbackDays)
  for (const f of files) {
    for (const s of readSpansFile(join(tracesDir, f))) {
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
