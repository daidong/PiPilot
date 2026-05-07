/**
 * Trace snapshot reader (P2.2).
 *
 * Reads traces from `.research-pilot/traces/spans.{date}.jsonl` and returns
 * the spans for a given traceId in `LiveSpanSummary` shape — same shape the
 * renderer's trace-store consumes from the `trace:live` channel. This means
 * remount recovery and live updates are interchangeable: the renderer can
 * unify them into a single timeline keyed by traceId+spanId.
 *
 * Implementation notes:
 *   - Looks at today + yesterday in UTC. Spans crossing midnight are rare;
 *     traces older than that are best read via the digest scan path.
 *   - Tombstones (`traces/tombstones.{date}.jsonl`) are honored: a traceId
 *     present in tombstones is reported with `dropped: true` and an empty
 *     spans array.
 *   - Skips malformed JSONL lines silently (append-only writes can rarely
 *     leave partial lines on crash; analysis tools dedupe).
 *   - Returns plain JSON — no OTel SDK types — so it can cross the IPC
 *     boundary and be JSON-stringified for the renderer.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from '../types.js'
import type { LiveSpanSummary } from './live-processor.js'
import { spanToSummary, dateStampUtc, type OtlpEnvelope } from './otlp-decode.js'

interface TombstoneRow {
  traceId: string
  kind: 'trace_dropped'
  reason?: string
  droppedAtSpanCount?: number
  timestamp?: string
}

export interface TraceSnapshot {
  traceId: string
  spans: LiveSpanSummary[]
  /** True when the trace was dropped via tombstone (queue overflow). */
  dropped?: boolean
  dropReason?: string
}

function readSpansFile(filePath: string, traceId: string): LiveSpanSummary[] {
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
            if (span.traceId === traceId) {
              out.push(spanToSummary(span))
            }
          }
        }
      } catch {
        // Skip malformed line.
      }
    }
  } catch {
    // File unreadable; return what we have.
  }
  return out
}

function readTombstones(filePath: string, traceId: string): TombstoneRow | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = JSON.parse(trimmed) as TombstoneRow
        if (row.traceId === traceId) return row
      } catch {
        // Skip malformed line.
      }
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Build a snapshot for `traceId` by scanning today + yesterday's spans files.
 * Returns spans sorted by startTime so the renderer can reconstruct order.
 */
export function loadTraceSnapshot(projectPath: string, traceId: string, now: Date = new Date()): TraceSnapshot {
  const today = dateStampUtc(now)
  const yesterday = dateStampUtc(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  const dates = today === yesterday ? [today] : [yesterday, today]

  // Tombstone check first — short-circuit if dropped.
  for (const date of dates) {
    const tomb = readTombstones(join(projectPath, PATHS.traces, `tombstones.${date}.jsonl`), traceId)
    if (tomb) {
      return { traceId, spans: [], dropped: true, dropReason: tomb.reason }
    }
  }

  const spans: LiveSpanSummary[] = []
  for (const date of dates) {
    spans.push(...readSpansFile(join(projectPath, PATHS.traces, `spans.${date}.jsonl`), traceId))
  }
  spans.sort((a, b) => a.startTime.localeCompare(b.startTime))
  return { traceId, spans }
}
