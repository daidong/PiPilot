/**
 * Scheduler - Cron-based task scheduler with persistence
 *
 * Uses a simple built-in cron matcher (5-field: min hour dom month dow)
 * with a 60-second polling interval. No external dependencies.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { PATHS, type ScheduledTask } from '../types.js'

// ============================================================================
// Cron Matcher (5-field: minute hour day-of-month month day-of-week)
// ============================================================================

/**
 * Parse a single cron field into a set of matching values.
 * Supports: *, specific numbers, ranges (1-5), steps (e.g. star/2), comma-separated.
 */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>()

  for (const part of field.split(',')) {
    const trimmed = part.trim()

    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i)
      continue
    }

    // Step: */n or range/n
    const stepMatch = trimmed.match(/^(.+)\/(\d+)$/)
    if (stepMatch) {
      const step = parseInt(stepMatch[2], 10)
      let start = min
      let end = max
      if (stepMatch[1] !== '*') {
        const rangeMatch = stepMatch[1].match(/^(\d+)-(\d+)$/)
        if (rangeMatch) {
          start = parseInt(rangeMatch[1], 10)
          end = parseInt(rangeMatch[2], 10)
        }
      }
      for (let i = start; i <= end; i += step) values.add(i)
      continue
    }

    // Range: a-b
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10)
      const end = parseInt(rangeMatch[2], 10)
      for (let i = start; i <= end; i++) values.add(i)
      continue
    }

    // Single value
    const val = parseInt(trimmed, 10)
    if (!isNaN(val)) values.add(val)
  }

  return values
}

/**
 * Check if a Date matches a 5-field cron expression.
 */
function matchesCron(cron: string, date: Date): boolean {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return false

  const minute = parseCronField(fields[0], 0, 59)
  const hour = parseCronField(fields[1], 0, 23)
  const dom = parseCronField(fields[2], 1, 31)
  const month = parseCronField(fields[3], 1, 12)
  const dow = parseCronField(fields[4], 0, 6) // 0 = Sunday

  return (
    minute.has(date.getMinutes()) &&
    hour.has(date.getHours()) &&
    dom.has(date.getDate()) &&
    month.has(date.getMonth() + 1) &&
    dow.has(date.getDay())
  )
}

/**
 * Validate a cron expression (basic: 5 space-separated fields).
 */
export function isValidCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return false
  // Each field should contain only digits, *, -, /, and commas
  return fields.every(f => /^[\d*\-/,]+$/.test(f))
}

// ============================================================================
// Default Tasks
// ============================================================================

const DEFAULT_TASKS: Omit<ScheduledTask, 'createdAt'>[] = [
  {
    id: 'heartbeat',
    schedule: '0 2 * * *',
    instruction: 'Review recent sessions and artifacts. Create or update durable notes/todos only when reuse value is clear. Keep continuity concise in session summaries and avoid duplicate records.',
    enabled: true,
    createdBy: 'system'
  },
  {
    id: 'morning-briefing',
    schedule: '0 8 * * 1-5',
    instruction: 'Check email for urgent messages, summarize today\'s calendar, review pending todos.',
    enabled: true,
    createdBy: 'system'
  },
  {
    id: 'monday-review',
    schedule: '0 9 * * 1',
    instruction: 'Review the todo list and summarize pending items for the week.',
    enabled: true,
    createdBy: 'system'
  }
]

// ============================================================================
// Scheduler Class
// ============================================================================

export interface SchedulerOptions {
  projectPath: string
  /** Called when a scheduled task fires */
  onTrigger: (task: ScheduledTask) => Promise<void>
  /** Polling interval in ms (default: 60000) */
  intervalMs?: number
}

export class Scheduler {
  private tasks: ScheduledTask[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private projectPath: string
  private onTrigger: (task: ScheduledTask) => Promise<void>
  private intervalMs: number
  private running = new Set<string>()

  constructor(opts: SchedulerOptions) {
    this.projectPath = opts.projectPath
    this.onTrigger = opts.onTrigger
    this.intervalMs = opts.intervalMs ?? 60_000
  }

  private get filePath(): string {
    return join(this.projectPath, PATHS.scheduledTasks)
  }

  /** Load tasks from disk, seeding defaults on first init */
  private load(): void {
    if (existsSync(this.filePath)) {
      try {
        this.tasks = JSON.parse(readFileSync(this.filePath, 'utf-8'))
        return
      } catch {
        // Corrupted file, re-seed
      }
    }
    // Seed defaults
    const now = new Date().toISOString()
    this.tasks = DEFAULT_TASKS.map(t => ({ ...t, createdAt: now }))
    this.save()
  }

  private save(): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.tasks, null, 2))
  }

  /** Start the scheduler polling loop */
  start(): void {
    this.load()
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    // Also tick immediately on start to catch any overdue tasks
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    const now = new Date()
    for (const task of this.tasks) {
      if (!task.enabled) continue
      if (this.running.has(task.id)) continue
      if (!matchesCron(task.schedule, now)) continue

      // Prevent re-firing within the same minute
      if (task.lastRunAt) {
        const last = new Date(task.lastRunAt)
        if (
          last.getFullYear() === now.getFullYear() &&
          last.getMonth() === now.getMonth() &&
          last.getDate() === now.getDate() &&
          last.getHours() === now.getHours() &&
          last.getMinutes() === now.getMinutes()
        ) {
          continue
        }
      }

      this.running.add(task.id)
      task.lastRunAt = now.toISOString()
      this.save()

      this.onTrigger(task)
        .catch(err => console.error(`[Scheduler] Task ${task.id} failed:`, err))
        .finally(() => this.running.delete(task.id))
    }
  }

  /** Add a new task */
  addTask(task: Omit<ScheduledTask, 'createdAt'>): ScheduledTask {
    const full: ScheduledTask = { ...task, createdAt: new Date().toISOString() }
    // Replace existing task with same ID
    this.tasks = this.tasks.filter(t => t.id !== task.id)
    this.tasks.push(full)
    this.save()
    return full
  }

  /** Remove a task by ID */
  removeTask(id: string): boolean {
    const before = this.tasks.length
    this.tasks = this.tasks.filter(t => t.id !== id)
    if (this.tasks.length < before) {
      this.save()
      return true
    }
    return false
  }

  /** List all tasks */
  listTasks(): ScheduledTask[] {
    return [...this.tasks]
  }

  /** Get a single task by ID */
  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.find(t => t.id === id)
  }
}
