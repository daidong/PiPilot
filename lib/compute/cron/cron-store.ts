/**
 * CronStore — home-scoped persistence for scheduled compute tasks
 * (RFC-016 §4.5). One JSON file per task under `~/.research-pilot/cron/`,
 * so tasks are standing (survive project switches), not project-local.
 *
 * Small volume (a handful of tasks); each write is atomic (tmp + rename).
 * The directory root is injectable so tests don't touch the real home.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { CronTask } from './types.js'

function defaultDir(): string {
  return path.join(os.homedir(), '.research-pilot', 'cron')
}

export function newCronId(): string {
  return 'cron-' + crypto.randomBytes(5).toString('hex')
}

export function newCampaignId(): string {
  return 'camp-' + crypto.randomBytes(5).toString('hex')
}

export class CronStore {
  private readonly dir: string

  constructor(opts?: { dir?: string }) {
    this.dir = opts?.dir ?? defaultDir()
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true })
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`)
  }

  list(): CronTask[] {
    let names: string[]
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return []
    }
    const out: CronTask[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = fs.readFileSync(path.join(this.dir, name), 'utf-8')
        const task = JSON.parse(raw) as CronTask
        if (task && typeof task.id === 'string') out.push(task)
      } catch {
        /* skip corrupt file */
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  get(id: string): CronTask | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.filePath(id), 'utf-8')) as CronTask
    } catch {
      return undefined
    }
  }

  private writeAtomic(task: CronTask): void {
    this.ensureDir()
    const file = this.filePath(task.id)
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf-8')
    fs.renameSync(tmp, file)
  }

  create(input: Omit<CronTask, 'id' | 'createdAt' | 'campaignId'> & Partial<Pick<CronTask, 'id' | 'createdAt' | 'campaignId'>>): CronTask {
    const task: CronTask = {
      ...input,
      id: input.id ?? newCronId(),
      createdAt: input.createdAt ?? new Date().toISOString(),
      campaignId: input.campaignId ?? newCampaignId(),
    }
    this.writeAtomic(task)
    return task
  }

  /** Merge a patch into an existing task. Returns the updated task or undefined. */
  update(id: string, patch: Partial<CronTask>): CronTask | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const updated: CronTask = { ...existing, ...patch, id: existing.id }
    this.writeAtomic(updated)
    return updated
  }

  delete(id: string): boolean {
    try {
      fs.rmSync(this.filePath(id), { force: true })
      return true
    } catch {
      return false
    }
  }
}
