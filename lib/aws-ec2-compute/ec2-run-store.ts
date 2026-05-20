/**
 * EC2 instance ledger (RFC-009 §0.2 Phase 1 acceptance criterion #5).
 *
 * Persists every EC2 run so a mid-run app crash can rediscover the live
 * instance and either reattach or terminate it. Mirrors ModalRunStore's
 * shape for consistency; the central invariant is:
 *
 *   ────────────────────────────────────────────────────────────────────
 *   ZERO orphan instances. EVER. The store is the authoritative record
 *   of which AWS instances this app started — terminate decisions read
 *   from here on hydrate(), and the runner writes here BEFORE returning
 *   from submit() so a crash between RunInstances and a successful
 *   write cannot lose track of an instance.
 *   ────────────────────────────────────────────────────────────────────
 *
 * Storage: JSONL at
 *   <projectPath>/.research-pilot/compute-runs/aws-ec2-runs.jsonl
 * Eviction: same 7-day window as Modal.
 */

import fs from 'node:fs'
import path from 'node:path'
import { type AwsEc2RunRecord, isEc2Terminal } from './types.js'

const RUNS_FILE = 'aws-ec2-runs.jsonl'
const EVICT_AGE_MS = 7 * 24 * 60 * 60 * 1000
const FLUSH_INTERVAL_MS = 30_000

export class AwsEc2RunStore {
  private readonly dir: string
  private readonly filePath: string
  private records = new Map<string, AwsEc2RunRecord>()
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
        const record = JSON.parse(trimmed) as AwsEc2RunRecord
        this.records.set(record.runId, record)
      } catch {
        /* skip malformed */
      }
    }
  }

  private writeToDisk(): void {
    this.ensureDir()
    const lines = Array.from(this.records.values()).map((r) => JSON.stringify(r)).join('\n')
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`
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

  getRun(runId: string): AwsEc2RunRecord | undefined {
    this.load()
    return this.records.get(runId)
  }

  getAllRuns(): AwsEc2RunRecord[] {
    this.load()
    return Array.from(this.records.values())
  }

  getActiveRuns(): AwsEc2RunRecord[] {
    this.load()
    return Array.from(this.records.values()).filter((r) => !isEc2Terminal(r.status))
  }

  /** Write a freshly created record. Synchronous flush so the instance ledger never lags behind reality. */
  createRun(record: AwsEc2RunRecord): void {
    this.load()
    this.records.set(record.runId, record)
    this.writeToDisk()
  }

  updateRun(runId: string, patch: Partial<AwsEc2RunRecord>): AwsEc2RunRecord | undefined {
    this.load()
    const existing = this.records.get(runId)
    if (!existing) return undefined
    const updated = { ...existing, ...patch }
    this.records.set(runId, updated)
    // Flush immediately when crossing into a terminal state OR when the
    // instanceId field changes — both events are crash-recovery-critical.
    const terminal = patch.status && isEc2Terminal(patch.status)
    const idChanged = patch.instanceId !== undefined && patch.instanceId !== existing.instanceId
    if (terminal || idChanged) {
      this.writeToDisk()
    } else {
      this.markDirty()
    }
    return updated
  }

  getRunDir(runId: string): string {
    return path.join(this.dir, runId)
  }

  getOutputPath(runId: string): string {
    return path.join(this.getRunDir(runId), 'output.log')
  }

  evictOld(): void {
    this.load()
    const cutoff = Date.now() - EVICT_AGE_MS
    let mutated = false
    for (const [id, rec] of this.records) {
      if (!isEc2Terminal(rec.status)) continue
      const at = rec.completedAt ? Date.parse(rec.completedAt) : Date.parse(rec.createdAt)
      if (Number.isFinite(at) && at < cutoff) {
        this.records.delete(id)
        mutated = true
      }
    }
    if (mutated) this.writeToDisk()
  }
}
