/**
 * Scheduled / recurring compute runs — types (RFC-016 §4.5).
 *
 * A cron task is a thin recurrence *trigger*: every due tick it submits its
 * command as an ordinary §4.1/§4.2 run. The app owns recurrence ONLY — per
 * tick experiment logic (which prefix to probe, which offsets are due) lives
 * in the user's script, which reads its own state file. Tasks are
 * home-scoped (`~/.research-pilot/cron/<id>.json`) — standing tasks, not
 * tied to a single project.
 */

export interface CronTask {
  id: string
  /** Optional friendly label; falls back to the command in the UI. */
  name?: string
  /** Interval ("1h", "15m") or a 5-field cron expression. See schedule.ts. */
  schedule: string
  /** Shell command to run each tick. */
  command: string
  /** Absolute working directory; folded into the run as `cd <dir> && …`. */
  workDir?: string
  /** Backend id the tick submits to: 'local' | 'modal' | 'aws-ec2' | … */
  backend: string
  /** Optional script path passed to the planner (Modal requires it). */
  scriptPath?: string
  /** JSON-encoded backend plan input (remote backends; e.g. EC2 instanceSpec). */
  backendData?: string
  /** Whether the scanner fires this task. */
  enabled: boolean
  createdAt: string
  /** ISO of the last fired tick (drift baseline + lastRun display). */
  lastRun?: string
  /** Run id of the last fired tick (lineage / campaign grouping). */
  lastRunId?: string
  /**
   * Fire ONE catch-up tick on reopen if ticks were missed while closed
   * (RFC-016 §4.5 optional per-task behavior). Default: skip (false).
   */
  catchUpOnReopen?: boolean
  /** Stamped on every tick's run so the Compute tab groups them as one campaign. */
  campaignId: string
}

/** Scanner → renderer notifications (separate channel from run events). */
export type CronEvent =
  | { kind: 'cron-tasks'; tasks: CronTaskStatus[] }
  | { kind: 'cron-fired'; taskId: string; runId?: string; error?: string; at: string }

/** A CronTask plus computed, app-open-relative scheduling facts for the UI. */
export interface CronTaskStatus extends CronTask {
  /** ISO of the next due tick (best-effort; undefined if schedule invalid). */
  nextDue?: string
  /**
   * Ticks that fell between lastRun and app-open — skipped, NOT backfilled
   * (RFC-016 §4.5 best-effort, app-open-only). Surfaced so gaps are visible.
   */
  missedSinceLastOpen: number
  /** False when the schedule string fails to parse. */
  scheduleValid: boolean
}
