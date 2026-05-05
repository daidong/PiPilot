/**
 * Usage Totals — Per-project persistent token/cost tracking.
 *
 * Stored in: <project>/.research-pilot/usage.json
 *
 * Simplified from AgentFoundry's implementation (no file locking — single
 * Electron main process is the only writer).
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'

export interface UsageTotals {
  version: 1
  updatedAt: string
  totals: {
    tokens: number
    promptTokens: number
    completionTokens: number
    cachedTokens: number
    cacheWriteTokens: number
    cost: number
    calls: number
  }
  /**
   * Snapshot of accumulated totals at the moment the project was first loaded
   * under v0.7+ (telemetry-trace spec §14.3). Set once, never updated.
   *
   * Used by the dual-write window: trace-aggregated totals start at 0 for old
   * projects, so the renderer/UI can present "pre-cutoff" history honestly
   * without pretending old data has full trace fidelity.
   */
  preTraceCutoffTotals?: {
    tokens: number
    cost: number
    cutoffTimestamp: string
  }
}

const EMPTY: UsageTotals = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  totals: { tokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, cost: 0, calls: 0 }
}

function usagePath(baseDir: string): string {
  return join(baseDir, 'usage.json')
}

export function loadUsageTotals(baseDir: string): UsageTotals {
  try {
    const raw = readFileSync(usagePath(baseDir), 'utf-8')
    const parsed = JSON.parse(raw) as UsageTotals
    if (!parsed?.totals) return { ...EMPTY }
    // Backfill fields added after initial release
    const t = parsed.totals
    t.completionTokens ??= 0
    t.cacheWriteTokens ??= 0
    return parsed
  } catch {
    return { ...EMPTY }
  }
}

function writeAtomically(filePath: string, data: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, data, 'utf-8')
  try {
    renameSync(tmp, filePath)
  } catch (err: any) {
    if (err?.code === 'EEXIST' || err?.code === 'EPERM') {
      try { unlinkSync(filePath) } catch {}
      renameSync(tmp, filePath)
    } else {
      throw err
    }
  } finally {
    try { unlinkSync(tmp) } catch {}
  }
}

/**
 * Accumulate a single LLM call's usage into the persisted totals.
 */
export function accumulateUsage(
  baseDir: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  cacheWriteTokens: number,
  cost: number
): UsageTotals {
  const existing = loadUsageTotals(baseDir)
  const next: UsageTotals = {
    version: 1,
    updatedAt: new Date().toISOString(),
    totals: {
      tokens: existing.totals.tokens + promptTokens + completionTokens + cachedTokens,
      promptTokens: existing.totals.promptTokens + promptTokens,
      completionTokens: existing.totals.completionTokens + completionTokens,
      cachedTokens: existing.totals.cachedTokens + cachedTokens,
      cacheWriteTokens: existing.totals.cacheWriteTokens + cacheWriteTokens,
      cost: existing.totals.cost + cost,
      calls: existing.totals.calls + 1
    }
  }
  writeAtomically(usagePath(baseDir), JSON.stringify(next, null, 2))
  return next
}

export function resetUsageTotals(baseDir: string): UsageTotals {
  const cleared: UsageTotals = {
    version: 1,
    updatedAt: new Date().toISOString(),
    totals: { tokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, cost: 0, calls: 0 }
  }
  writeAtomically(usagePath(baseDir), JSON.stringify(cleared, null, 2))
  return cleared
}

/**
 * Set `preTraceCutoffTotals` on first telemetry-aware load if absent (§14.3).
 * Idempotent; the cutoff snapshot is set ONCE and never updated again.
 */
export function ensurePreTraceCutoff(baseDir: string): UsageTotals {
  const cur = loadUsageTotals(baseDir)
  if (cur.preTraceCutoffTotals) return cur
  const updated: UsageTotals = {
    ...cur,
    preTraceCutoffTotals: {
      tokens: cur.totals.tokens,
      cost: cur.totals.cost,
      cutoffTimestamp: new Date().toISOString()
    }
  }
  writeAtomically(usagePath(baseDir), JSON.stringify(updated, null, 2))
  return updated
}

/**
 * Read trace-aggregated token totals by summing the trace-digest.jsonl rows.
 *
 * Returns the secondary "post-cutoff" totals — what the new path measures from
 * traces. Compared against `loadUsageTotals(...) - preTraceCutoffTotals` during
 * the P1 dual-write window. Acceptable delta is ≈ 0 for new chats.
 */
export function readTraceAggregatedTotals(projectPath: string): {
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number }
  digestRowCount: number
} {
  const digestPath = join(projectPath, '.research-pilot', 'trace-digest.jsonl')
  let totalIn = 0
  let totalOut = 0
  let totalCR = 0
  let totalCC = 0
  let rows = 0
  try {
    const raw = readFileSync(digestPath, 'utf-8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = JSON.parse(trimmed) as { tokens?: { input: number; output: number; cache_read: number; cache_creation: number } }
        if (row.tokens) {
          totalIn += row.tokens.input
          totalOut += row.tokens.output
          totalCR += row.tokens.cache_read
          totalCC += row.tokens.cache_creation
          rows++
        }
      } catch {
        // Skip malformed lines (digest writer is append-only; partial writes
        // are theoretically possible during crash recovery).
      }
    }
  } catch {
    // No digest file yet: trace-aggregated totals are zero.
  }
  return {
    tokens: { input: totalIn, output: totalOut, cacheRead: totalCR, cacheCreation: totalCC },
    digestRowCount: rows
  }
}
