/**
 * JsonlSpanExporter — writes ReadableSpan batches to `.research-pilot/traces/spans.{date}.jsonl`
 * in OTLP/JSON wire format (§5.1, §3.2).
 *
 * One `ResourceSpans` envelope per JSONL line. Pure OTLP/JSON — directly readable by any
 * OTel-compatible tool. PiPilot-specific control records (tombstones) live in a separate
 * sidecar file (§5.2).
 *
 * Cross-platform:
 *   - Forces `\n` EOL (NOT os.EOL) so files are byte-identical across darwin/linux/win32.
 *   - Uses `O_APPEND` via fs.appendFile so concurrent writers cannot interleave lines.
 *   - Path joining via `path.join` (no hard-coded `/`).
 *
 * Failure model:
 *   - Single export() call returning ExportResultCode.FAILED on I/O error; the caller
 *     (BatchSpanProcessor / TraceStore) decides retry policy.
 */

import { join } from 'node:path'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { hrTimeToTimeStamp } from '@opentelemetry/core'
import { PATHS } from '../../types.js'
import { appendJsonlBatch } from '../jsonl-writer.js'
import { SCHEMA_URL } from '../semantic-registry.js'

export interface JsonlSpanExporterOptions {
  /** Project root path; spans are written under `<projectPath>/.research-pilot/traces/`. */
  projectPath: string
  /** Override clock for testing. */
  now?: () => Date
  /** Called on append errors. Defaults to no-op. */
  onError?: (err: unknown) => void
}

/**
 * UTC YYYY-MM-DD date stamp for daily file rotation. Forced UTC for stability across
 * timezone changes within a single project.
 */
function dateStampUtc(d: Date): string {
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Convert a ReadableSpan to OTLP/JSON proto-compatible shape. */
function spanToOtlp(span: ReadableSpan): unknown {
  const ctx = span.spanContext()
  // OTLP proto wants nanos string; @opentelemetry/core hrTimeToTimeStamp gives RFC3339.
  // For OTLP/JSON we emit unixNano as a string per OTLP spec.
  const hrToNano = (hr: [number, number]): string => {
    return (BigInt(hr[0]) * 1_000_000_000n + BigInt(hr[1])).toString()
  }

  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanId,
    traceState: ctx.traceState?.serialize() || undefined,
    flags: ctx.traceFlags,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: hrToNano(span.startTime),
    endTimeUnixNano: hrToNano(span.endTime),
    attributes: attrsToOtlp(span.attributes),
    droppedAttributesCount: span.droppedAttributesCount,
    events: span.events.map((ev) => ({
      timeUnixNano: hrToNano(ev.time),
      name: ev.name,
      attributes: ev.attributes ? attrsToOtlp(ev.attributes) : [],
      droppedAttributesCount: 0
    })),
    droppedEventsCount: span.droppedEventsCount,
    links: span.links.map((lk) => ({
      traceId: lk.context.traceId,
      spanId: lk.context.spanId,
      traceState: lk.context.traceState?.serialize() || undefined,
      attributes: lk.attributes ? attrsToOtlp(lk.attributes) : [],
      droppedAttributesCount: 0
    })),
    droppedLinksCount: span.droppedLinksCount,
    status: {
      code: span.status.code,
      message: span.status.message
    },
    // RFC3339 ISO timestamps as a convenience for grep-with-date workflows.
    _humanStartTime: hrTimeToTimeStamp(span.startTime),
    _humanEndTime: hrTimeToTimeStamp(span.endTime)
  }
}

function attrsToOtlp(attrs: Record<string, unknown>): Array<{ key: string; value: unknown }> {
  const out: Array<{ key: string; value: unknown }> = []
  for (const [key, val] of Object.entries(attrs)) {
    out.push({ key, value: anyValue(val) })
  }
  return out
}

function anyValue(v: unknown): { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean; arrayValue?: { values: unknown[] } } {
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { boolValue: v }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
  }
  if (typeof v === 'bigint') return { intValue: v.toString() }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } }
  // Fallback: stringify
  return { stringValue: JSON.stringify(v) }
}

export class JsonlSpanExporter implements SpanExporter {
  private readonly projectPath: string
  private readonly now: () => Date
  private readonly onError: (err: unknown) => void
  private shuttingDown = false

  constructor(opts: JsonlSpanExporterOptions) {
    this.projectPath = opts.projectPath
    this.now = opts.now ?? (() => new Date())
    this.onError = opts.onError ?? (() => {})
  }

  /** Resolve target spans file for a given timestamp. */
  spansFilePathFor(d: Date): string {
    return join(this.projectPath, PATHS.traces, `spans.${dateStampUtc(d)}.jsonl`)
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.shuttingDown) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error('exporter shutting down') })
      return
    }
    if (spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS })
      return
    }

    // Group spans by date so a long-running batch crossing midnight goes to two files.
    const byDate = new Map<string, ReadableSpan[]>()
    for (const span of spans) {
      const ts = new Date(hrTimeToTimeStamp(span.startTime))
      const key = dateStampUtc(ts)
      let bucket = byDate.get(key)
      if (!bucket) {
        bucket = []
        byDate.set(key, bucket)
      }
      bucket.push(span)
    }

    void (async () => {
      let allOk = true
      for (const [dateKey, bucket] of byDate) {
        const filePath = join(this.projectPath, PATHS.traces, `spans.${dateKey}.jsonl`)
        // One ResourceSpans envelope per line. Each batch becomes a single envelope
        // grouping all spans with the same Resource (which they share by construction
        // — they all came from the same TracerProvider in this process).
        const envelope = {
          resource: resourceToOtlp(bucket[0]!),
          scopeSpans: groupByScope(bucket).map((g) => ({
            scope: { name: g.scopeName, version: g.scopeVersion },
            schemaUrl: SCHEMA_URL,
            spans: g.spans.map(spanToOtlp)
          })),
          schemaUrl: SCHEMA_URL
        }
        const ok = await appendJsonlBatch(filePath, [envelope], { onError: this.onError })
        if (!ok) allOk = false
      }
      resultCallback({
        code: allOk ? ExportResultCode.SUCCESS : ExportResultCode.FAILED,
        error: allOk ? undefined : new Error('jsonl-exporter: append failed')
      })
    })()
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
  }

  async forceFlush(): Promise<void> {
    // appendJsonl is fire-and-forget but completes before its promise resolves;
    // the BatchSpanProcessor awaits export() so there's nothing further to flush here.
  }
}

function resourceToOtlp(span: ReadableSpan): unknown {
  const attrs = span.resource?.attributes ?? {}
  return {
    attributes: attrsToOtlp(attrs as Record<string, unknown>),
    droppedAttributesCount: 0
  }
}

function groupByScope(spans: ReadableSpan[]): Array<{ scopeName: string; scopeVersion?: string; spans: ReadableSpan[] }> {
  const groups = new Map<string, { scopeName: string; scopeVersion?: string; spans: ReadableSpan[] }>()
  for (const s of spans) {
    const lib = (s as unknown as { instrumentationLibrary?: { name: string; version?: string } }).instrumentationLibrary
    const name = lib?.name ?? 'pipilot'
    const version = lib?.version
    const key = `${name}@${version ?? ''}`
    let g = groups.get(key)
    if (!g) {
      g = { scopeName: name, scopeVersion: version, spans: [] }
      groups.set(key, g)
    }
    g.spans.push(s)
  }
  return [...groups.values()]
}
