/**
 * CronScanner — the app-lifetime trigger layer for RFC-016 §4.5 scheduled
 * runs. While the app is open it ticks ~once a minute; each due task is
 * submitted as an ordinary compute run via the injected `submit` callback.
 *
 * Honest, best-effort, app-open-only (RFC-016 §4.5): ticks due during
 * downtime are SKIPPED, not backfilled. The scanner snapshots
 * `missedSinceLastOpen` at start so gaps are visible, and optionally fires a
 * single catch-up tick per task on reopen. The app owns recurrence only —
 * per-tick logic lives in the user's script.
 */

import { CronStore } from './cron-store.js'
import { isDue, nextDue, countMissed, isValidSchedule } from './schedule.js'
import type { CronTask, CronTaskStatus, CronEvent } from './types.js'

const DEFAULT_TICK_MS = 60_000

export interface CronScannerOpts {
  store: CronStore
  /**
   * Submit one tick as a real compute run. Resolves with the run id (or an
   * error string). The scanner stamps lastRun/lastRunId from the result and
   * never throws on submit failure — a bad tick must not stop the cadence.
   * Return `{ skipped: true }` for a transient no-op (e.g. no project open):
   * the scanner then does NOT advance lastRun, so the still-due tick re-fires
   * on the next pass once a target exists, rather than being silently consumed.
   */
  submit: (task: CronTask) => Promise<{ runId?: string; error?: string; skipped?: boolean }>
  /** Fan cron notifications to the renderer. */
  onEvent?: (event: CronEvent) => void
  /** Tick cadence; default 60s. Tests pass a small value + call tickOnce(). */
  tickIntervalMs?: number
}

export class CronScanner {
  private readonly store: CronStore
  private readonly submitFn: CronScannerOpts['submit']
  private readonly onEvent: (event: CronEvent) => void
  private readonly tickIntervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private openedAt = 0
  /** Frozen snapshot of missed-while-closed counts, keyed by task id. */
  private missedAtOpen = new Map<string, number>()
  /** Guards against overlapping async ticks. */
  private ticking = false

  constructor(opts: CronScannerOpts) {
    this.store = opts.store
    this.submitFn = opts.submit
    this.onEvent = opts.onEvent ?? (() => {})
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS
  }

  /** Begin scanning. Snapshots missed counts, fires an initial tick, then runs on an interval. */
  start(): void {
    if (this.timer) return
    this.openedAt = Date.now()
    for (const task of this.store.list()) {
      if (!task.enabled) continue
      const baseline = this.baselineOf(task)
      this.missedAtOpen.set(task.id, countMissed(task.schedule, baseline, this.openedAt))
    }
    void this.tick(true)
    this.timer = setInterval(() => { void this.tick(false) }, this.tickIntervalMs)
    if (this.timer.unref) this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private baselineOf(task: CronTask): number {
    const ref = task.lastRun ?? task.createdAt
    const ms = Date.parse(ref)
    return Number.isFinite(ms) ? ms : Date.now()
  }

  /**
   * One scan pass. `initial` true ⇒ also honor per-task catchUpOnReopen for
   * tasks that missed ticks while the app was closed. Public for tests.
   */
  async tick(initial = false): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      for (const task of this.store.list()) {
        if (!task.enabled || !isValidSchedule(task.schedule)) continue
        const baseline = this.baselineOf(task)
        const due = isDue(task.schedule, baseline, now)
        const catchUp = initial && !!task.catchUpOnReopen && (this.missedAtOpen.get(task.id) ?? 0) > 0 && !due
        if (due || catchUp) {
          await this.fire(task)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  /** Fire a single task immediately (also used by the UI's "run now"). */
  async runNow(taskId: string): Promise<{ success: boolean; runId?: string; error?: string }> {
    const task = this.store.get(taskId)
    if (!task) return { success: false, error: `No cron task ${taskId}` }
    const result = await this.fire(task)
    return { success: !result.error, runId: result.runId, error: result.error }
  }

  private async fire(task: CronTask): Promise<{ runId?: string; error?: string; skipped?: boolean }> {
    const at = new Date().toISOString()
    let result: { runId?: string; error?: string; skipped?: boolean }
    try {
      result = await this.submitFn(task)
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) }
    }
    // A transient skip (no target available) must NOT consume the tick —
    // leave lastRun untouched so it re-fires once a target exists.
    if (result.skipped) {
      this.onEvent({ kind: 'cron-fired', taskId: task.id, error: result.error, at })
      return result
    }
    // Advance the cadence baseline regardless of run success so a persistently
    // failing task doesn't hammer the backend every tick.
    this.store.update(task.id, { lastRun: at, lastRunId: result.runId })
    // The missed-on-open snapshot is consumed once we've fired.
    this.missedAtOpen.set(task.id, 0)
    this.onEvent({ kind: 'cron-fired', taskId: task.id, runId: result.runId, error: result.error, at })
    this.emitTasks()
    return result
  }

  /** Build the UI-facing status list (computed nextDue + missed). */
  listStatuses(): CronTaskStatus[] {
    const ref = this.openedAt || Date.now()
    return this.store.list().map((task) => this.toStatus(task, ref))
  }

  private toStatus(task: CronTask, openedAt: number): CronTaskStatus {
    const valid = isValidSchedule(task.schedule)
    const baseline = this.baselineOf(task)
    const next = valid ? nextDue(task.schedule, baseline, Date.now()) : undefined
    const missed = this.missedAtOpen.has(task.id)
      ? this.missedAtOpen.get(task.id)!
      : (valid ? countMissed(task.schedule, baseline, openedAt) : 0)
    return {
      ...task,
      scheduleValid: valid,
      nextDue: next ? new Date(next).toISOString() : undefined,
      missedSinceLastOpen: missed,
    }
  }

  /** Push the current task list to the renderer. */
  emitTasks(): void {
    this.onEvent({ kind: 'cron-tasks', tasks: this.listStatuses() })
  }
}
