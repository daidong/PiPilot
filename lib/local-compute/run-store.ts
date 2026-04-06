/**
 * Run Store — JSONL persistence for compute run records.
 *
 * Storage: .research-pilot/compute-runs/runs.jsonl
 * Pattern: in-memory Map is source of truth. Disk flush is debounced:
 * - Dirty flag + periodic flush every FLUSH_INTERVAL_MS (30s)
 * - Immediate flush on terminal state transitions (completed/failed/cancelled)
 * - Immediate flush on createRun (ensure new records survive crash)
 * - Explicit flushNow() for shutdown
 *
 * Atomic writes via temp file + rename.
 * Auto-evicts completed runs older than 7 days.
 */

import fs from 'node:fs'
import path from 'node:path'
import { type RunRecord, isTerminal } from './types.js'

const RUNS_FILE = 'runs.jsonl'
const EVICT_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const FLUSH_INTERVAL_MS = 30_000               // Debounced flush interval

export class RunStore {
  private readonly dir: string
  private readonly filePath: string
  private records: Map<string, RunRecord> = new Map()
  private loaded = false
  private dirty = false
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(projectPath: string) {
    this.dir = path.join(projectPath, '.research-pilot', 'compute-runs')
    this.filePath = path.join(this.dir, RUNS_FILE)
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true })
    }
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!fs.existsSync(this.filePath)) return

    const content = fs.readFileSync(this.filePath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const record = JSON.parse(trimmed) as RunRecord
        this.records.set(record.runId, record)
      } catch {
        // Skip malformed lines
      }
    }
  }

  private writeToDisk(): void {
    this.ensureDir()
    const lines = Array.from(this.records.values())
      .map(r => JSON.stringify(r))
      .join('\n')
    const tmpPath = this.filePath + '.tmp.' + process.pid + '.' + Date.now()
    fs.writeFileSync(tmpPath, lines + '\n', 'utf-8')
    fs.renameSync(tmpPath, this.filePath)
    this.dirty = false
  }

  /**
   * Mark store as dirty. Starts the periodic flush timer if not running.
   */
  private markDirty(): void {
    this.dirty = true
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => {
        if (this.dirty) this.writeToDisk()
      }, FLUSH_INTERVAL_MS)
      if (this.flushTimer.unref) this.flushTimer.unref()
    }
  }

  /**
   * Flush immediately (synchronous). Called on critical events:
   * - createRun (new record must survive crash)
   * - Terminal state transition (completed/failed/cancelled/timed_out)
   * - Shutdown (destroy)
   */
  flushNow(): void {
    if (this.dirty) this.writeToDisk()
  }

  /**
   * Stop the periodic flush timer. Called on destroy.
   */
  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  getRun(runId: string): RunRecord | undefined {
    this.load()
    return this.records.get(runId)
  }

  getAllRuns(): RunRecord[] {
    this.load()
    return Array.from(this.records.values())
  }

  getActiveRuns(): RunRecord[] {
    this.load()
    return Array.from(this.records.values()).filter(r => !isTerminal(r.status))
  }

  createRun(record: RunRecord): void {
    this.load()
    this.records.set(record.runId, record)
    this.writeToDisk() // Immediate — new records must survive crash
  }

  updateRun(runId: string, patch: Partial<RunRecord>): RunRecord | undefined {
    this.load()
    const existing = this.records.get(runId)
    if (!existing) return undefined
    const updated = { ...existing, ...patch }
    this.records.set(runId, updated)

    // Flush immediately on terminal transitions; debounce for progress updates
    if (patch.status && isTerminal(patch.status)) {
      this.writeToDisk()
    } else {
      this.markDirty()
    }
    return updated
  }

  /**
   * Remove completed runs older than maxAgeMs.
   */
  evictOld(maxAgeMs: number = EVICT_AGE_MS): number {
    this.load()
    const cutoff = Date.now() - maxAgeMs
    let evicted = 0
    for (const [id, record] of this.records) {
      if (isTerminal(record.status) && record.completedAt) {
        const completedTime = new Date(record.completedAt).getTime()
        if (completedTime < cutoff) {
          this.records.delete(id)
          // Clean up output directory
          const runDir = this.getRunDir(id)
          try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* ignore */ }
          evicted++
        }
      }
    }
    if (evicted > 0) this.writeToDisk()
    return evicted
  }

  getRunDir(runId: string): string {
    return path.join(this.dir, runId)
  }

  getOutputPath(runId: string): string {
    return path.join(this.dir, runId, 'output.log')
  }

  getStderrPath(runId: string): string {
    return path.join(this.dir, runId, 'output.log.stderr')
  }
}
