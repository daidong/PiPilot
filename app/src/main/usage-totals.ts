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
    cachedTokens: number
    cost: number
    calls: number
  }
}

const EMPTY: UsageTotals = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  totals: { tokens: 0, promptTokens: 0, cachedTokens: 0, cost: 0, calls: 0 }
}

function usagePath(baseDir: string): string {
  return join(baseDir, 'usage.json')
}

export function loadUsageTotals(baseDir: string): UsageTotals {
  try {
    const raw = readFileSync(usagePath(baseDir), 'utf-8')
    const parsed = JSON.parse(raw) as UsageTotals
    if (!parsed?.totals) return { ...EMPTY }
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
  cost: number
): UsageTotals {
  const existing = loadUsageTotals(baseDir)
  const next: UsageTotals = {
    version: 1,
    updatedAt: new Date().toISOString(),
    totals: {
      tokens: existing.totals.tokens + promptTokens + completionTokens,
      promptTokens: existing.totals.promptTokens + promptTokens,
      cachedTokens: existing.totals.cachedTokens + cachedTokens,
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
    totals: { tokens: 0, promptTokens: 0, cachedTokens: 0, cost: 0, calls: 0 }
  }
  writeAtomically(usagePath(baseDir), JSON.stringify(cleared, null, 2))
  return cleared
}
