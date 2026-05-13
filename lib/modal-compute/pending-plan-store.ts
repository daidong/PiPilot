import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ModalPendingPlan } from './types.js'

const PENDING_PLAN_FILE = 'modal-pending-plan.json'

export class PendingPlanStore {
  private readonly dir: string
  private readonly filePath: string

  constructor(projectPath: string) {
    this.dir = path.join(projectPath, '.research-pilot', 'compute-runs')
    this.filePath = path.join(this.dir, PENDING_PLAN_FILE)
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true })
  }

  write(plan: ModalPendingPlan): void {
    this.ensureDir()
    const tmpPath = this.filePath + '.tmp.' + process.pid + '.' + Date.now()
    fs.writeFileSync(tmpPath, JSON.stringify(plan, null, 2), 'utf-8')
    fs.renameSync(tmpPath, this.filePath)
  }

  read(): ModalPendingPlan | null {
    try {
      if (!fs.existsSync(this.filePath)) return null
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as ModalPendingPlan
    } catch {
      return null
    }
  }

  approve(): boolean {
    const plan = this.read()
    if (!plan) return false
    this.write({
      ...plan,
      approved: true,
      approvedAt: new Date().toISOString(),
      rejectedAt: undefined,
      rejectionComments: undefined,
    })
    return true
  }

  reject(comments: string): { success: boolean; error?: string; plan?: ModalPendingPlan } {
    const trimmed = comments.trim()
    if (!trimmed) return { success: false, error: 'Rejection comments are required.' }
    const plan = this.read()
    if (!plan) return { success: false, error: 'No pending Modal plan found.' }
    const rejectedPlan = {
      ...plan,
      approved: false,
      rejectedAt: new Date().toISOString(),
      rejectionComments: trimmed,
    }
    this.write(rejectedPlan)
    return { success: true, plan: rejectedPlan }
  }

  clear(): void {
    try { fs.rmSync(this.filePath, { force: true }) } catch { /* ignore */ }
  }

  nextPlanId(): string {
    return 'mp-' + crypto.randomBytes(4).toString('hex')
  }
}
