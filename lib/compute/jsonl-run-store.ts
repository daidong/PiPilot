/**
 * Generic JSONL persistence for compute run records.
 *
 * Backs LocalBackend's RunStore, ModalRunStore, and AwsEc2RunStore — three
 * stores that were byte-for-byte the same Map + lazy-load + debounced-flush +
 * atomic-rename machine, drifting only in incidental details (one forgot to
 * delete the run directory on eviction; one had an extra flush trigger). This
 * base unifies the machine; each backend subclasses it with its own paths and
 * terminal predicate.
 *
 * Pattern: the in-memory Map is the source of truth. Disk flush is debounced —
 * a dirty flag drives a periodic flush, and we flush synchronously on the
 * events that must survive a crash (createRun, terminal transitions, and any
 * backend-specific trigger via `flushImmediatelyOn`). Writes are atomic
 * (temp file + rename). Terminal runs older than `evictAgeMs` are evicted
 * along with their on-disk run directory.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Minimum shape every run record must satisfy to be stored. */
export interface RunRecordBase<S extends string> {
  runId: string
  status: S
  createdAt: string
  completedAt?: string
}

export interface JsonlRunStoreOptions<S extends string, T extends RunRecordBase<S>> {
  /** Directory holding the JSONL file and per-run subdirectories. */
  dir: string
  /** JSONL filename, e.g. 'runs.jsonl'. */
  fileName: string
  /** Per-run stdout log filename, e.g. 'output.log'. */
  outputFileName: string
  /** Per-run stderr log filename (only LocalBackend keeps stderr separate). */
  stderrFileName?: string
  /** True when a status is terminal (the run has finished). */
  isTerminal: (status: S) => boolean
  /** Eviction age in ms (default 7 days). */
  evictAgeMs?: number
  /** Debounced flush interval in ms (default 30s). */
  flushIntervalMs?: number
  /**
   * Extra synchronous-flush trigger beyond terminal transitions. EC2 uses
   * this to flush the moment an instanceId is assigned — losing that write
   * could orphan an instance. Return true to force an immediate write.
   */
  flushImmediatelyOn?: (patch: Partial<T>, existing: T) => boolean
}

const DEFAULT_EVICT_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_FLUSH_INTERVAL_MS = 30_000

export class JsonlRunStore<S extends string, T extends RunRecordBase<S>> {
  protected readonly dir: string
  protected readonly filePath: string
  private readonly opts: Required<Pick<JsonlRunStoreOptions<S, T>, 'isTerminal' | 'outputFileName'>> &
    JsonlRunStoreOptions<S, T>
  private readonly evictAgeMs: number
  private readonly flushIntervalMs: number
  private records = new Map<string, T>()
  private loaded = false
  private dirty = false
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: JsonlRunStoreOptions<S, T>) {
    this.opts = opts
    this.dir = opts.dir
    this.filePath = path.join(opts.dir, opts.fileName)
    this.evictAgeMs = opts.evictAgeMs ?? DEFAULT_EVICT_AGE_MS
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
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
        const record = JSON.parse(trimmed) as T
        this.records.set(record.runId, record)
      } catch {
        /* skip malformed lines */
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
      }, this.flushIntervalMs)
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

  getRun(runId: string): T | undefined {
    this.load()
    return this.records.get(runId)
  }

  getAllRuns(): T[] {
    this.load()
    return Array.from(this.records.values())
  }

  getActiveRuns(): T[] {
    this.load()
    return Array.from(this.records.values()).filter((r) => !this.opts.isTerminal(r.status))
  }

  /** Write a freshly created record. Synchronous flush so it survives a crash. */
  createRun(record: T): void {
    this.load()
    this.records.set(record.runId, record)
    this.writeToDisk()
  }

  updateRun(runId: string, patch: Partial<T>): T | undefined {
    this.load()
    const existing = this.records.get(runId)
    if (!existing) return undefined
    const updated = { ...existing, ...patch }
    this.records.set(runId, updated)
    const terminal = patch.status !== undefined && this.opts.isTerminal(patch.status)
    const extra = this.opts.flushImmediatelyOn?.(patch, existing) ?? false
    if (terminal || extra) {
      this.writeToDisk()
    } else {
      this.markDirty()
    }
    return updated
  }

  /**
   * Remove terminal runs older than maxAgeMs, deleting their on-disk run
   * directory too. Returns the number of records evicted.
   */
  evictOld(maxAgeMs: number = this.evictAgeMs): number {
    this.load()
    const cutoff = Date.now() - maxAgeMs
    let evicted = 0
    for (const [id, record] of this.records) {
      if (!this.opts.isTerminal(record.status)) continue
      const at = record.completedAt ? Date.parse(record.completedAt) : Date.parse(record.createdAt)
      if (Number.isFinite(at) && at < cutoff) {
        this.records.delete(id)
        try {
          fs.rmSync(this.getRunDir(id), { recursive: true, force: true })
        } catch {
          /* best-effort cleanup */
        }
        evicted++
      }
    }
    if (evicted > 0) this.writeToDisk()
    return evicted
  }

  getRunDir(runId: string): string {
    return path.join(this.dir, runId)
  }

  getOutputPath(runId: string): string {
    return path.join(this.dir, runId, this.opts.outputFileName)
  }

  getStderrPath(runId: string): string {
    if (!this.opts.stderrFileName) {
      throw new Error('JsonlRunStore: stderrFileName is not configured for this store')
    }
    return path.join(this.dir, runId, this.opts.stderrFileName)
  }
}
