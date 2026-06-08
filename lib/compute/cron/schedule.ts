/**
 * Schedule parsing + evaluation for RFC-016 §4.5 scheduled runs.
 *
 * Two schedule forms are accepted:
 *   - INTERVAL: a duration string — `30s`, `15m`, `1h`, `6h`, `1d`. The task
 *     fires every <duration> from its last run (or creation).
 *   - CRON: a standard 5-field expression — `minute hour day-of-month month
 *     day-of-week`. Each field supports a wildcard, step (slash-n), single
 *     values, ranges (a-b), and comma lists. Evaluated at minute granularity
 *     (the scanner ticks ~once a minute), so the smallest meaningful cadence
 *     is one minute.
 *
 * The app owns recurrence only; per-tick experiment logic lives in the
 * user's script (RFC-016 §4.5). These helpers answer three questions:
 * "is it due now?", "when is it next due?", and "how many ticks were missed
 * while the app was closed?" — the last drives the visible (not silent) gap
 * surfacing the RFC requires.
 */

const INTERVAL_RE = /^\s*(\d+)\s*(s|m|h|d)\s*$/i
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

const MINUTE_MS = 60_000
/** Bound forward scans (nextDue / countMissed) to ~1 year of minutes. */
const MAX_SCAN_MINUTES = 366 * 24 * 60

export type ParsedSchedule =
  | { kind: 'interval'; ms: number }
  | { kind: 'cron'; fields: CronFields }
  | { kind: 'invalid'; error: string }

interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>      // 1-31
  month: Set<number>    // 1-12
  dow: Set<number>      // 0-6 (Sun=0)
}

function expandField(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const token = part.trim()
    if (!token) return null
    let range = token
    let step = 1
    const slash = token.indexOf('/')
    if (slash >= 0) {
      range = token.slice(0, slash)
      step = parseInt(token.slice(slash + 1), 10)
      if (!Number.isFinite(step) || step <= 0) return null
    }
    let lo = min
    let hi = max
    if (range !== '*') {
      const dash = range.indexOf('-')
      if (dash >= 0) {
        lo = parseInt(range.slice(0, dash), 10)
        hi = parseInt(range.slice(dash + 1), 10)
      } else {
        lo = hi = parseInt(range, 10)
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
      if (lo < min || hi > max || lo > hi) return null
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size > 0 ? out : null
}

/** Parse a schedule string into a normalized form. Never throws. */
export function parseSchedule(schedule: string): ParsedSchedule {
  if (typeof schedule !== 'string' || !schedule.trim()) {
    return { kind: 'invalid', error: 'Schedule is empty.' }
  }
  const interval = INTERVAL_RE.exec(schedule)
  if (interval) {
    const n = parseInt(interval[1], 10)
    const unit = interval[2].toLowerCase()
    if (n <= 0) return { kind: 'invalid', error: 'Interval must be > 0.' }
    return { kind: 'interval', ms: n * UNIT_MS[unit] }
  }
  const parts = schedule.trim().split(/\s+/)
  if (parts.length === 5) {
    const minute = expandField(parts[0], 0, 59)
    const hour = expandField(parts[1], 0, 23)
    const dom = expandField(parts[2], 1, 31)
    const month = expandField(parts[3], 1, 12)
    const dow = expandField(parts[4], 0, 6)
    if (!minute || !hour || !dom || !month || !dow) {
      return { kind: 'invalid', error: `Invalid cron expression: "${schedule}".` }
    }
    return { kind: 'cron', fields: { minute, hour, dom, month, dow } }
  }
  return {
    kind: 'invalid',
    error: `Unrecognized schedule "${schedule}". Use an interval (e.g. "1h", "15m") or a 5-field cron expression.`,
  }
}

export function isValidSchedule(schedule: string): boolean {
  return parseSchedule(schedule).kind !== 'invalid'
}

/** Does this minute (local time) match the cron fields? DOM/DOW use cron's OR semantics. */
function cronMatchesMinute(fields: CronFields, d: Date): boolean {
  if (!fields.minute.has(d.getMinutes())) return false
  if (!fields.hour.has(d.getHours())) return false
  if (!fields.month.has(d.getMonth() + 1)) return false
  // Standard cron: when both DOM and DOW are restricted, a match on EITHER
  // fires. When one is '*' it doesn't constrain.
  const domRestricted = fields.dom.size < 31
  const dowRestricted = fields.dow.size < 7
  const domHit = fields.dom.has(d.getDate())
  const dowHit = fields.dow.has(d.getDay())
  if (domRestricted && dowRestricted) return domHit || dowHit
  if (domRestricted) return domHit
  if (dowRestricted) return dowHit
  return true
}

/**
 * Is the task due to fire at `now`, given when it last ran (or was created)?
 */
export function isDue(schedule: string, baseline: number, now: number = Date.now()): boolean {
  const parsed = parseSchedule(schedule)
  if (parsed.kind === 'invalid') return false
  if (parsed.kind === 'interval') return now - baseline >= parsed.ms
  // cron: due if the current minute matches AND we didn't already fire in
  // this same minute (baseline floored to the minute differs from now's).
  const nowMin = Math.floor(now / MINUTE_MS)
  const baseMin = Math.floor(baseline / MINUTE_MS)
  if (nowMin === baseMin) return false
  return cronMatchesMinute(parsed.fields, new Date(now))
}

/** The next time the task is due, scanning forward from `from`. */
export function nextDue(schedule: string, baseline: number, from: number = Date.now()): number | undefined {
  const parsed = parseSchedule(schedule)
  if (parsed.kind === 'invalid') return undefined
  if (parsed.kind === 'interval') {
    const next = baseline + parsed.ms
    return next > from ? next : from + parsed.ms - ((from - baseline) % parsed.ms)
  }
  // cron: scan minute by minute from the next whole minute.
  let t = (Math.floor(from / MINUTE_MS) + 1) * MINUTE_MS
  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    if (cronMatchesMinute(parsed.fields, new Date(t))) return t
    t += MINUTE_MS
  }
  return undefined
}

/**
 * How many scheduled ticks fell between `baseline` (last run / creation) and
 * `now` — i.e. ticks skipped while the app was closed. Bounded so a long
 * downtime with a 1-minute cron doesn't return an absurd number.
 */
export function countMissed(schedule: string, baseline: number, now: number = Date.now()): number {
  const parsed = parseSchedule(schedule)
  if (parsed.kind === 'invalid') return 0
  if (parsed.kind === 'interval') {
    if (now <= baseline) return 0
    const ticks = Math.floor((now - baseline) / parsed.ms)
    // The most recent due tick is "due now", not "missed"; count the ones before it.
    return Math.max(0, Math.min(ticks - 1, 100_000))
  }
  let count = 0
  let t = (Math.floor(baseline / MINUTE_MS) + 1) * MINUTE_MS
  const end = Math.floor(now / MINUTE_MS) * MINUTE_MS   // exclude the current minute ("due now")
  for (let i = 0; i < MAX_SCAN_MINUTES && t < end; i++, t += MINUTE_MS) {
    if (cronMatchesMinute(parsed.fields, new Date(t))) count++
  }
  return count
}
