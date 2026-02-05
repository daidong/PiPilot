/**
 * Usage Totals - Aggregate token usage across runs (persisted to disk).
 *
 * Stored in: <project>/.agentfoundry/usage.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { UsageSummary } from '../llm/provider.types.js'

export interface UsageTotalsFile {
  version: 1
  updatedAt: string
  totals: {
    tokens: number
    promptTokens: number
    cachedTokens: number
    cost: number
    calls: number
  }
  runIds: string[]
}

const EMPTY_TOTALS: UsageTotalsFile = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  totals: {
    tokens: 0,
    promptTokens: 0,
    cachedTokens: 0,
    cost: 0,
    calls: 0
  },
  runIds: []
}

export function getUsageTotalsPath(baseDir: string): string {
  return join(baseDir, 'usage.json')
}

function readUsageTotals(baseDir: string): UsageTotalsFile {
  try {
    const path = getUsageTotalsPath(baseDir)
    if (!existsSync(path)) return { ...EMPTY_TOTALS }
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as UsageTotalsFile
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_TOTALS }
    if (!parsed.totals) return { ...EMPTY_TOTALS }
    return parsed
  } catch {
    return { ...EMPTY_TOTALS }
  }
}

function writeUsageTotals(baseDir: string, data: UsageTotalsFile): void {
  mkdirSync(baseDir, { recursive: true })
  const path = getUsageTotalsPath(baseDir)
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
}

export function updateUsageTotals(
  baseDir: string,
  runId: string,
  summary: UsageSummary
): UsageTotalsFile {
  const existing = readUsageTotals(baseDir)
  if (existing.runIds.includes(runId)) {
    return existing
  }

  const promptTokens = summary.tokens.promptTokens ?? 0
  const completionTokens = summary.tokens.completionTokens ?? 0
  const cachedTokens = summary.tokens.cacheReadInputTokens ?? 0
  const totalTokens = summary.tokens.totalTokens ?? (promptTokens + completionTokens)
  const cost = summary.cost?.totalCost ?? 0
  const calls = summary.callCount ?? 0

  const next: UsageTotalsFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    totals: {
      tokens: existing.totals.tokens + totalTokens,
      promptTokens: existing.totals.promptTokens + promptTokens,
      cachedTokens: existing.totals.cachedTokens + cachedTokens,
      cost: existing.totals.cost + cost,
      calls: existing.totals.calls + calls
    },
    runIds: [...existing.runIds, runId]
  }

  writeUsageTotals(baseDir, next)
  return next
}

export function resetUsageTotals(baseDir: string): UsageTotalsFile {
  const cleared: UsageTotalsFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    totals: { ...EMPTY_TOTALS.totals },
    runIds: []
  }
  writeUsageTotals(baseDir, cleared)
  return cleared
}

export function loadUsageTotals(baseDir: string): UsageTotalsFile {
  return readUsageTotals(baseDir)
}
