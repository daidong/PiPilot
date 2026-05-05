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

interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean; arrayValue?: { values: Array<{ stringValue?: string }> } } }>
  events: Array<{ timeUnixNano: string; name: string; attributes: unknown[] }>
  status: { code: number; message?: string }
}

interface OtlpEnvelope {
  resource?: unknown
  scopeSpans: Array<{ scope?: unknown; schemaUrl?: string; spans: OtlpSpan[] }>
}

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

function dateStampUtc(d: Date): string {
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function nanoToIso(nanoStr: string): string {
  // OTLP emits unix nanos as decimal strings. Convert to ms for Date().
  const nano = BigInt(nanoStr)
  const ms = Number(nano / 1_000_000n)
  return new Date(ms).toISOString()
}

function attrsToObject(attrs: OtlpSpan['attributes']): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const { key, value } of attrs ?? []) {
    if (typeof value.stringValue === 'string') out[key] = value.stringValue
    else if (typeof value.intValue === 'string') out[key] = Number(value.intValue)
    else if (typeof value.doubleValue === 'number') out[key] = value.doubleValue
    else if (typeof value.boolValue === 'boolean') out[key] = value.boolValue
    else if (value.arrayValue) {
      // Stringify simple string arrays (matched_skills etc.).
      const arr = value.arrayValue.values.map((v) => v.stringValue ?? '').filter(Boolean)
      out[key] = JSON.stringify(arr)
    }
  }
  return out
}

function spanToSummary(s: OtlpSpan): LiveSpanSummary {
  const startMs = Number(BigInt(s.startTimeUnixNano) / 1_000_000n)
  const endMs = Number(BigInt(s.endTimeUnixNano) / 1_000_000n)
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId,
    name: s.name,
    kind: s.kind,
    startTime: nanoToIso(s.startTimeUnixNano),
    endTime: nanoToIso(s.endTimeUnixNano),
    durationMs: endMs - startMs,
    statusCode: s.status?.code ?? 0,
    statusMessage: s.status?.message,
    attributes: attrsToObject(s.attributes),
    events: (s.events ?? []).map((e) => ({ name: e.name, timestamp: nanoToIso(e.timeUnixNano) }))
  }
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
