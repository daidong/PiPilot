import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from '../types.js'
import type { LiveSpanSummary } from './live-processor.js'
import { spanToSummary, type OtlpEnvelope } from './otlp-decode.js'

export interface TraceTombstoneRow {
  traceId: string
  kind?: string
  reason?: string
  droppedAtSpanCount?: number
  timestamp?: string
}

export function traceFilesDir(projectPath: string): string {
  return join(projectPath, PATHS.traces)
}

export function listTraceSpanFiles(tracesDir: string, newestFirst = false): string[] {
  return listTraceFiles(tracesDir, /^spans\.\d{4}-\d{2}-\d{2}\.jsonl$/, newestFirst)
}

export function listTraceTombstoneFiles(tracesDir: string): string[] {
  return listTraceFiles(tracesDir, /^tombstones\.\d{4}-\d{2}-\d{2}\.jsonl$/)
}

export function readTraceSpansFile(filePath: string, traceId?: string): LiveSpanSummary[] {
  if (!existsSync(filePath)) return []
  const out: LiveSpanSummary[] = []
  try {
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const env = JSON.parse(trimmed) as OtlpEnvelope
        for (const scope of env.scopeSpans ?? []) {
          for (const span of scope.spans ?? []) {
            if (traceId && span.traceId !== traceId) continue
            out.push(spanToSummary(span))
          }
        }
      } catch {
        // Skip malformed lines. Append-only JSONL can contain a partial line
        // after a crash or interrupted write.
      }
    }
  } catch {
    // File unreadable; callers treat missing data as an empty trace segment.
  }
  return out
}

export function readTraceTombstone(filePath: string, traceId: string): TraceTombstoneRow | null {
  for (const row of readTraceTombstonesFile(filePath)) {
    if (row.traceId === traceId) return row
  }
  return null
}

export function readTraceTombstoneIds(filePath: string): Set<string> {
  const out = new Set<string>()
  for (const row of readTraceTombstonesFile(filePath)) {
    if (row.traceId) out.add(row.traceId)
  }
  return out
}

function readTraceTombstonesFile(filePath: string): TraceTombstoneRow[] {
  if (!existsSync(filePath)) return []
  const out: TraceTombstoneRow[] = []
  try {
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed) as TraceTombstoneRow)
      } catch {
        // Skip malformed line.
      }
    }
  } catch {
    // ignore
  }
  return out
}

function listTraceFiles(tracesDir: string, pattern: RegExp, newestFirst = false): string[] {
  if (!existsSync(tracesDir)) return []
  try {
    const files = readdirSync(tracesDir).filter((f) => pattern.test(f)).sort()
    return newestFirst ? files.reverse() : files
  } catch {
    return []
  }
}
