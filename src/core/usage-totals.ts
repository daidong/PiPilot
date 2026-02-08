/**
 * Usage Totals - Aggregate token usage across runs (persisted to disk).
 *
 * Stored in: <project>/.agentfoundry/usage.json
 */

import { mkdir, open, readFile, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'path'
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

const LOCK_RETRY_LIMIT = 80
const LOCK_RETRY_DELAY_MS = 25
const LOCK_STALE_MS = 30_000

export function getUsageTotalsPath(baseDir: string): string {
  return join(baseDir, 'usage.json')
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function acquireLock(lockPath: string): Promise<FileHandle> {
  await mkdir(dirname(lockPath), { recursive: true })

  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf-8')
      } catch {
        // Best effort metadata.
      }
      return handle
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        throw error
      }

      try {
        const lockStat = await stat(lockPath)
        if ((Date.now() - lockStat.mtimeMs) > LOCK_STALE_MS) {
          await unlink(lockPath)
          continue
        }
      } catch {
        // Lock can disappear between retries.
      }

      if (attempt === LOCK_RETRY_LIMIT - 1) {
        throw new Error(`USAGE_E_LOCK_TIMEOUT:${lockPath}`)
      }
      await sleep(LOCK_RETRY_DELAY_MS)
    }
  }

  throw new Error(`USAGE_E_LOCK_TIMEOUT:${lockPath}`)
}

async function releaseLock(lockPath: string, handle: FileHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    // Ignore close errors.
  }
  try {
    await unlink(lockPath)
  } catch {
    // Ignore unlink errors.
  }
}

async function withUsageLock<T>(baseDir: string, op: () => Promise<T>): Promise<T> {
  const lockPath = `${getUsageTotalsPath(baseDir)}.lock`
  const handle = await acquireLock(lockPath)
  try {
    return await op()
  } finally {
    await releaseLock(lockPath, handle)
  }
}

async function readUsageTotals(baseDir: string): Promise<UsageTotalsFile> {
  try {
    const filePath = getUsageTotalsPath(baseDir)
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as UsageTotalsFile
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_TOTALS }
    if (!parsed.totals) return { ...EMPTY_TOTALS }
    return parsed
  } catch (error) {
    if (!isNotFoundError(error)) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[usage-totals] failed to read usage totals:', message)
    }
    return { ...EMPTY_TOTALS }
  }
}

async function writeUsageTotals(baseDir: string, data: UsageTotalsFile): Promise<void> {
  await mkdir(baseDir, { recursive: true })
  const filePath = getUsageTotalsPath(baseDir)
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`
  await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8')
  try {
    await rename(tempPath, filePath)
  } catch (error: any) {
    if (error?.code === 'EEXIST' || error?.code === 'EPERM') {
      await unlink(filePath).catch(() => {})
      await rename(tempPath, filePath)
    } else {
      throw error
    }
  } finally {
    await unlink(tempPath).catch(() => {})
  }
}

export async function updateUsageTotals(
  baseDir: string,
  runId: string,
  summary: UsageSummary
): Promise<UsageTotalsFile> {
  return withUsageLock(baseDir, async () => {
    const existing = await readUsageTotals(baseDir)
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

    await writeUsageTotals(baseDir, next)
    return next
  })
}

export async function resetUsageTotals(baseDir: string): Promise<UsageTotalsFile> {
  return withUsageLock(baseDir, async () => {
    const cleared: UsageTotalsFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      totals: { ...EMPTY_TOTALS.totals },
      runIds: []
    }
    await writeUsageTotals(baseDir, cleared)
    return cleared
  })
}

export async function loadUsageTotals(baseDir: string): Promise<UsageTotalsFile> {
  return readUsageTotals(baseDir)
}
