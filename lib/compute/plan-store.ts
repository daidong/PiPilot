/**
 * PlanStore — persistent home of PlanRecord.
 *
 * Amendment A1 (RFC-008): every plan is written here regardless of
 * whether approval is required, because Registry.submit() needs to
 * look up the plan by id later. `effectiveRequiresApproval` is captured
 * at plan() time and immutable for the record's lifetime — settings
 * changes between plan and submit do NOT affect in-flight plans.
 *
 * Backed by a single JSON file at .research-pilot/compute-plans.json
 * (volume is small — handful of plans at most). In-memory cache for
 * fast reads; writes flush atomically via tmp + rename.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { PlanRecord } from './types.js'

const FILE_NAME = 'compute-plans.json'

type StoreMap = Record<string, PlanRecord>

export class PlanStore {
  private readonly dir: string
  private readonly filePath: string
  private cache: StoreMap | null = null

  constructor(projectPath: string) {
    this.dir = path.join(projectPath, '.research-pilot')
    this.filePath = path.join(this.dir, FILE_NAME)
  }

  private load(): StoreMap {
    if (this.cache) return this.cache
    try {
      if (!fs.existsSync(this.filePath)) {
        this.cache = {}
        return this.cache
      }
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      this.cache = parsed && typeof parsed === 'object' ? parsed as StoreMap : {}
      return this.cache
    } catch {
      this.cache = {}
      return this.cache
    }
  }

  private flush(): void {
    if (!this.cache) return
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf-8')
    fs.renameSync(tmp, this.filePath)
  }

  private key(backendId: string, planId: string): string {
    return `${backendId}::${planId}`
  }

  read(backendId: string, planId: string): PlanRecord | undefined {
    return this.load()[this.key(backendId, planId)]
  }

  write(backendId: string, planId: string, record: PlanRecord): void {
    const cache = this.load()
    cache[this.key(backendId, planId)] = record
    this.flush()
  }

  clear(backendId: string, planId: string): void {
    const cache = this.load()
    delete cache[this.key(backendId, planId)]
    this.flush()
  }

  /**
   * Pending approval entries that survived a crash. Used by
   * Registry.hydrate() to repopulate the approval UI on app boot.
   */
  listPending(): Array<{ backend: string; planId: string; record: PlanRecord }> {
    const result: Array<{ backend: string; planId: string; record: PlanRecord }> = []
    for (const [k, record] of Object.entries(this.load())) {
      if (record.effectiveRequiresApproval && !record.approved && !record.rejectedAt) {
        const idx = k.indexOf('::')
        if (idx < 0) continue
        result.push({
          backend: k.slice(0, idx),
          planId: k.slice(idx + 2),
          record,
        })
      }
    }
    return result
  }

  /** All non-cleared entries — useful for debugging / tests. */
  listAll(): Array<{ backend: string; planId: string; record: PlanRecord }> {
    const result: Array<{ backend: string; planId: string; record: PlanRecord }> = []
    for (const [k, record] of Object.entries(this.load())) {
      const idx = k.indexOf('::')
      if (idx < 0) continue
      result.push({
        backend: k.slice(0, idx),
        planId: k.slice(idx + 2),
        record,
      })
    }
    return result
  }
}
