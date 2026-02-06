import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { KernelV2ResolvedConfig, V2MemoryFact } from './types.js'
import { KernelV2Storage } from './storage.js'

interface LifecycleMeta {
  lastRunAt?: string
}

export interface LifecycleReport {
  mode: 'weekly' | 'on-demand'
  startedAt: string
  finishedAt: string
  consolidated: number
  deprecated: number
  archived: number
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000))
}

export class MemoryLifecycleManager {
  private readonly metaPath: string

  constructor(
    projectPath: string,
    private readonly storage: KernelV2Storage,
    private readonly config: KernelV2ResolvedConfig,
    private readonly emit: (event: { event: string; payload: Record<string, unknown>; message: string }) => void
  ) {
    this.metaPath = path.join(projectPath, '.agent-foundry-v2', 'maintenance', 'lifecycle-meta.json')
  }

  private async readMeta(): Promise<LifecycleMeta> {
    try {
      const raw = await fs.readFile(this.metaPath, 'utf-8')
      return JSON.parse(raw) as LifecycleMeta
    } catch {
      return {}
    }
  }

  private async writeMeta(meta: LifecycleMeta): Promise<void> {
    await fs.mkdir(path.dirname(this.metaPath), { recursive: true })
    await fs.writeFile(this.metaPath, JSON.stringify(meta, null, 2), 'utf-8')
  }

  async maybeRunWeekly(): Promise<LifecycleReport | null> {
    if (!this.config.lifecycle.autoWeekly) return null

    const meta = await this.readMeta()
    const now = new Date()
    if (meta.lastRunAt) {
      const last = new Date(meta.lastRunAt)
      if (!Number.isNaN(last.getTime()) && daysBetween(now, last) < 7) {
        return null
      }
    }

    const report = await this.run('weekly')
    await this.writeMeta({ lastRunAt: report.finishedAt })
    return report
  }

  async run(mode: 'weekly' | 'on-demand'): Promise<LifecycleReport> {
    const startedAt = new Date().toISOString()
    let consolidated = 0
    let deprecated = 0
    let archived = 0

    const facts = await this.storage.listMemoryFacts()

    const byKey = new Map<string, V2MemoryFact[]>()
    for (const fact of facts) {
      const k = `${fact.namespace}:${fact.key}`
      const list = byKey.get(k) ?? []
      list.push(fact)
      byKey.set(k, list)
    }

    for (const list of byKey.values()) {
      list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      const latest = list[0]
      if (!latest) continue
      for (const old of list.slice(1)) {
        if (old.status === 'superseded') continue
        await this.storage.supersedeMemoryFact(old)
        consolidated += 1
      }
    }

    const decayThreshold = this.config.lifecycle.decayThresholdDays
    const now = new Date()
    const latestFacts = await this.storage.listLatestMemoryFactsByKey()

    for (const fact of latestFacts) {
      if (fact.status !== 'active' && fact.status !== 'proposed') continue
      const updatedAt = new Date(fact.updatedAt)
      if (Number.isNaN(updatedAt.getTime())) continue
      if (daysBetween(now, updatedAt) >= decayThreshold) {
        const dep = await this.storage.deprecateMemoryFact(fact)
        await this.storage.appendMemoryArchive(dep)
        deprecated += 1
        archived += 1
      }
    }

    const finishedAt = new Date().toISOString()
    const report: LifecycleReport = {
      mode,
      startedAt,
      finishedAt,
      consolidated,
      deprecated,
      archived
    }

    this.emit({
      event: 'memory.lifecycle.completed',
      payload: report as unknown as Record<string, unknown>,
      message: `memory lifecycle mode=${mode} consolidated=${consolidated} deprecated=${deprecated} archived=${archived}`
    })

    return report
  }
}
