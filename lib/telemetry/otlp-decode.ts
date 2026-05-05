/**
 * OTLP/JSON → LiveSpanSummary decoder. Shared between:
 *   - snapshot.ts (per-trace lookup)
 *   - diagnostics/load.ts (corpus reads for baselines)
 *   - any future analysis tooling that reads our JSONL files
 *
 * Read-side authority for the on-disk format (`spans.{date}.jsonl`).
 */

import type { LiveSpanSummary } from './live-processor.js'

export interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Array<{
    key: string
    value: {
      stringValue?: string
      intValue?: string
      doubleValue?: number
      boolValue?: boolean
      arrayValue?: { values: Array<{ stringValue?: string }> }
    }
  }>
  events: Array<{ timeUnixNano: string; name: string; attributes: unknown[] }>
  status: { code: number; message?: string }
}

export interface OtlpEnvelope {
  resource?: unknown
  scopeSpans: Array<{ scope?: unknown; schemaUrl?: string; spans: OtlpSpan[] }>
}

export function dateStampUtc(d: Date): string {
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function nanoToIso(nanoStr: string): string {
  const nano = BigInt(nanoStr)
  const ms = Number(nano / 1_000_000n)
  return new Date(ms).toISOString()
}

export function attrsToObject(attrs: OtlpSpan['attributes']): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const { key, value } of attrs ?? []) {
    if (typeof value.stringValue === 'string') out[key] = value.stringValue
    else if (typeof value.intValue === 'string') out[key] = Number(value.intValue)
    else if (typeof value.doubleValue === 'number') out[key] = value.doubleValue
    else if (typeof value.boolValue === 'boolean') out[key] = value.boolValue
    else if (value.arrayValue) {
      const arr = value.arrayValue.values.map((v) => v.stringValue ?? '').filter(Boolean)
      out[key] = JSON.stringify(arr)
    }
  }
  return out
}

export function spanToSummary(s: OtlpSpan): LiveSpanSummary {
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
