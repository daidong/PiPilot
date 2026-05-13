import fs from 'node:fs'
import path from 'node:path'
import { type ModalRunRecord, isModalTerminal } from './types.js'

const RUNS_FILE = 'modal-runs.jsonl'
const EVICT_AGE_MS = 7 * 24 * 60 * 60 * 1000
const FLUSH_INTERVAL_MS = 30_000

export class ModalRunStore {
  private readonly dir: string
  private readonly filePath: string
  private records: Map<string, ModalRunRecord> = new Map()
  private loaded = false
  private dirty = false
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(projectPath: string) {
    this.dir = path.join(projectPath, '.research-pilot', 'compute-runs')
    this.filePath = path.join(this.dir, RUNS_FILE)
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true })
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
        const record = JSON.parse(trimmed) as ModalRunRecord
        this.records.set(record.runId, record)
      } catch { /* skip malformed */ }
    }
  }

  private writeToDisk(): void {
    this.ensureDir()
    const lines = Array.from(this.records.values()).map(r => JSON.stringify(r)).join('\n')
    const tmpPath = this.filePath + '.tmp.' + process.pid + '.' + Date.now()
    fs.writeFileSync(tmpPath, lines + '\n', 'utf-8')
    fs.renameSync(tmpPath, this.filePath)
    this.dirty = false
  }

  private markDirty(): void {
    this.dirty = true
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => {
        if (this.dirty) this.writeToDisk()
      }, FLUSH_INTERVAL_MS)
      if (this.flushTimer.unref) this.flushTimer.unref()
    }
  }

  flushNow(): void {
    if (this.dirty) this.writeToDisk()
  }

  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  getRun(runId: string): ModalRunRecord | undefined {
    this.load()
    return this.records.get(runId)
  }

  getAllRuns(): ModalRunRecord[] {
    this.load()
    return Array.from(this.records.values())
  }

  getActiveRuns(): ModalRunRecord[] {
    this.load()
    return Array.from(this.records.values()).filter(r => !isModalTerminal(r.status))
  }

  createRun(record: ModalRunRecord): void {
    this.load()
    this.records.set(record.runId, record)
    this.writeToDisk()
  }

  updateRun(runId: string, patch: Partial<ModalRunRecord>): ModalRunRecord | undefined {
    this.load()
    const existing = this.records.get(runId)
    if (!existing) return undefined
    const updated = { ...existing, ...patch }
    this.records.set(runId, updated)
    if (patch.status && isModalTerminal(patch.status)) this.writeToDisk()
    else this.markDirty()
    return updated
  }

  evictOld(maxAgeMs: number = EVICT_AGE_MS): number {
    this.load()
    const cutoff = Date.now() - maxAgeMs
    let evicted = 0
    for (const [id, record] of this.records) {
      if (isModalTerminal(record.status) && record.completedAt) {
        const completedTime = new Date(record.completedAt).getTime()
        if (completedTime < cutoff) {
          this.records.delete(id)
          try { fs.rmSync(this.getRunDir(id), { recursive: true, force: true }) } catch { /* ignore */ }
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
    return path.join(this.dir, runId, 'modal-output.log')
  }
}
