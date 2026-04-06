/**
 * Experience Store — structured metadata for compute run outcomes.
 *
 * Storage: .research-pilot/compute-runs/experience.jsonl
 * Each record has machine-readable fields for reliable retrieval,
 * plus optional LLM-generated summary text (added in v1.2).
 *
 * v1.1: structured metadata recording on completion (no LLM)
 * v1.2: LLM-generated summary + effectiveFix fields
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ExperienceRecord, FailureCode } from './types.js'

const EXPERIENCE_FILE = 'experience.jsonl'
const MAX_RECORDS = 200

export class ExperienceStore {
  private readonly filePath: string
  private records: ExperienceRecord[] | null = null

  constructor(projectPath: string) {
    const dir = path.join(projectPath, '.research-pilot', 'compute-runs')
    this.filePath = path.join(dir, EXPERIENCE_FILE)
  }

  private load(): ExperienceRecord[] {
    if (this.records !== null) return this.records
    this.records = []
    if (!fs.existsSync(this.filePath)) return this.records

    const content = fs.readFileSync(this.filePath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        this.records.push(JSON.parse(trimmed) as ExperienceRecord)
      } catch { /* skip malformed */ }
    }
    return this.records
  }

  private flush(): void {
    const dir = path.dirname(this.filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const records = this.load()
    // Trim to max records (keep most recent)
    const trimmed = records.slice(-MAX_RECORDS)
    const content = trimmed.map(r => JSON.stringify(r)).join('\n') + '\n'
    const tmpPath = this.filePath + '.tmp.' + process.pid
    fs.writeFileSync(tmpPath, content, 'utf-8')
    fs.renameSync(tmpPath, this.filePath)
    this.records = trimmed
  }

  /**
   * Record a completed run's experience.
   */
  record(entry: ExperienceRecord): void {
    this.load()
    this.records!.push(entry)
    this.flush()
  }

  /**
   * Find relevant past experience by taskKind.
   * Primary: exact match. Fallback: most recent regardless of kind.
   */
  findRelevant(taskKind: string, limit = 10): ExperienceRecord[] {
    const all = this.load()
    const exact = all.filter(r => r.taskKind === taskKind)
    if (exact.length > 0) return exact.slice(-limit)
    // Fallback: most recent
    return all.slice(-limit)
  }

  /**
   * Get all records (for UI display or export).
   */
  getAll(): ExperienceRecord[] {
    return [...this.load()]
  }

  /**
   * Compute summary statistics for a taskKind.
   */
  summarize(taskKind: string): ExperienceSummary | undefined {
    const records = this.findRelevant(taskKind)
    if (records.length === 0) return undefined

    const successes = records.filter(r => r.outcome === 'success')
    const failures = records.filter(r => r.outcome === 'failed')
    const durations = successes.map(r => r.durationSeconds)
    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : undefined

    // Count failure codes
    const failureCodes: Record<string, number> = {}
    for (const f of failures) {
      if (f.failureCode) {
        failureCodes[f.failureCode] = (failureCodes[f.failureCode] ?? 0) + 1
      }
    }

    return {
      taskKind,
      totalRuns: records.length,
      successes: successes.length,
      failures: failures.length,
      avgDurationSeconds: avgDuration,
      commonFailures: failureCodes,
      lastRun: records[records.length - 1],
    }
  }
}

export interface ExperienceSummary {
  taskKind: string
  totalRuns: number
  successes: number
  failures: number
  avgDurationSeconds?: number
  commonFailures: Record<string, number>
  lastRun?: ExperienceRecord
}

// ---------------------------------------------------------------------------
// Utility: derive taskKind from command / script
// ---------------------------------------------------------------------------

/**
 * Infer a taskKind string from the command and script content (if available).
 * Used as the primary matching key in experience records.
 *
 * Format: "{framework}-{action}" e.g., "pytorch-training", "pandas-etl", "matplotlib-viz"
 */
export function inferTaskKind(command: string, scriptContent?: string): string {
  const combined = (command + ' ' + (scriptContent ?? '')).toLowerCase()

  // Framework detection
  let framework = 'python'
  if (/\bimport\s+(?:torch|pytorch)\b|from\s+torch\b/.test(combined)) framework = 'pytorch'
  else if (/\bimport\s+tensorflow\b|from\s+tensorflow\b|import\s+keras\b/.test(combined)) framework = 'tensorflow'
  else if (/\bimport\s+mlx\b|from\s+mlx\b/.test(combined)) framework = 'mlx'
  else if (/\bimport\s+sklearn\b|from\s+sklearn\b/.test(combined)) framework = 'sklearn'
  else if (/\bimport\s+pandas\b|from\s+pandas\b/.test(combined)) framework = 'pandas'
  else if (/\bimport\s+(?:matplotlib|seaborn|plotly)\b/.test(combined)) framework = 'matplotlib'
  else if (/\bimport\s+(?:numpy|scipy)\b/.test(combined)) framework = 'numpy'

  // Action detection
  let action = 'script'
  if (/\.fit\(|\.train\(|train|epoch/i.test(combined)) action = 'training'
  else if (/\.predict\(|\.score\(|evaluat|test.*accuracy/i.test(combined)) action = 'evaluation'
  else if (/preprocess|clean|transform|etl|\.to_csv\(|\.to_parquet\(/i.test(combined)) action = 'etl'
  else if (/\.savefig\(|\.show\(|plot|chart|graph|viz/i.test(combined)) action = 'viz'
  else if (/download|fetch|scrape|request/i.test(combined)) action = 'download'
  else if (/statist|correlat|describe|summary/i.test(combined)) action = 'analysis'

  return `${framework}-${action}`
}
