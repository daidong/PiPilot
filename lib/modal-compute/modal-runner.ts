import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { ModalRunStore } from './modal-run-store.js'
import { ExperienceStore, inferTaskKind } from '../local-compute/experience.js'
import { computeElapsedCost } from './cost-estimator.js'
import { extractProgress } from '../local-compute/progress.js'
import {
  type ModalRunRecord,
  type ModalRunState,
  type ModalRunStatusResult,
  type ModalSubmitConfig,
  isModalTerminal,
} from './types.js'

const POLL_INTERVAL_MS = 5_000
const OUTPUT_TAIL_BYTES = 8_192
const DEFAULT_TIMEOUT_MS = 60 * 60_000
const DEFAULT_STALL_THRESHOLD_MS = 5 * 60_000
const MAX_TIMEOUT_MS = 24 * 60 * 60_000

function nextRunId(): string {
  return 'mr-' + crypto.randomBytes(4).toString('hex')
}

function readFileTail(filePath: string, maxBytes: number): string {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size === 0) return ''
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes))
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    return buf.toString('utf-8')
  } catch {
    return ''
  }
}

function getFileSize(filePath: string): number {
  try { return fs.statSync(filePath).size } catch { return 0 }
}

function estimateLines(bytes: number, tail: string): number {
  if (bytes === 0 || tail.length === 0) return 0
  const tailLines = tail.split('\n').length
  if (tail.length >= bytes) return tailLines
  return Math.max(tailLines, Math.round((bytes / tail.length) * tailLines))
}

export class ModalRunner {
  private readonly store: ModalRunStore
  private readonly experience: ExperienceStore
  private readonly workspacePath: string
  private readonly getCostThreshold: () => number
  private readonly onCostKilled: (runId: string, costUsd: number) => void
  private readonly onRunUpdate: (runId: string, status: ModalRunStatusResult) => void
  private readonly credentials?: { tokenId?: string; tokenSecret?: string }
  private readonly processes = new Map<string, ChildProcess>()
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: {
    projectPath: string
    workspacePath: string
    getCostThreshold: () => number
    onCostKilled: (runId: string, costUsd: number) => void
    onRunUpdate?: (runId: string, status: ModalRunStatusResult) => void
    modalCredentials?: { tokenId?: string; tokenSecret?: string }
  }) {
    this.store = new ModalRunStore(opts.projectPath)
    this.experience = new ExperienceStore(opts.projectPath, 'modal-experience.jsonl')
    this.workspacePath = opts.workspacePath
    this.getCostThreshold = opts.getCostThreshold
    this.onCostKilled = opts.onCostKilled
    this.onRunUpdate = opts.onRunUpdate ?? (() => {})
    this.credentials = opts.modalCredentials
    this.store.evictOld()
  }

  async submit(config: ModalSubmitConfig): Promise<ModalRunRecord> {
    const timeoutMs = Math.min((config.timeoutMinutes ?? 60) * 60_000, MAX_TIMEOUT_MS)
    const stallThresholdMs = (config.stallThresholdMinutes ?? 5) * 60_000
    const runId = nextRunId()
    const runDir = this.store.getRunDir(runId)
    const outputPath = this.store.getOutputPath(runId)
    fs.mkdirSync(runDir, { recursive: true })

    const now = new Date().toISOString()
    const record: ModalRunRecord = {
      runId,
      planId: config.plan.planId,
      taskDescription: config.plan.taskDescription,
      status: 'running',
      command: config.plan.command,
      scriptPath: config.plan.scriptPath,
      image: config.plan.image,
      costEstimate: config.plan.costEstimate,
      createdAt: now,
      startedAt: now,
      outputPath,
      outputBytes: 0,
      outputLines: 0,
      lastOutputAt: now,
      timeoutMs,
      stallThresholdMs,
      stalled: false,
      retryCount: config.parentRunId ? ((this.store.getRun(config.parentRunId)?.retryCount ?? 0) + 1) : 0,
      parentRunId: config.parentRunId,
      estimatedCostSoFar: 0,
    }
    this.store.createRun(record)

    const scriptPath = path.isAbsolute(config.plan.scriptPath)
      ? config.plan.scriptPath
      : path.resolve(this.workspacePath, config.plan.scriptPath)

    const env = {
      ...process.env,
      MODAL_TOKEN_ID: this.credentials?.tokenId ?? process.env.MODAL_TOKEN_ID,
      MODAL_TOKEN_SECRET: this.credentials?.tokenSecret ?? process.env.MODAL_TOKEN_SECRET,
    }
    const out = fs.createWriteStream(outputPath, { flags: 'a' })
    const child = spawn(`modal run ${JSON.stringify(scriptPath)}`, {
      cwd: this.workspacePath,
      env,
      shell: true,
      detached: false,
    })
    child.stdout?.pipe(out, { end: false })
    child.stderr?.pipe(out, { end: false })
    this.processes.set(runId, child)
    if (child.pid) this.store.updateRun(runId, { pid: child.pid })
    this.ensurePolling()

    child.on('close', (code) => {
      out.end()
      this.handleExit(runId, code ?? 1).catch(() => {})
    })
    child.on('error', (err) => {
      out.end()
      this.store.updateRun(runId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: err.message,
        stalled: false,
      })
      this.emitRunUpdate(runId)
      this.processes.delete(runId)
      this.stopPollingIfIdle()
    })

    return record
  }

  private async handleExit(runId: string, exitCode: number): Promise<void> {
    const run = this.store.getRun(runId)
    if (!run || isModalTerminal(run.status)) return
    const status: ModalRunState = exitCode === 0 ? 'completed' : 'failed'
    const completedAt = new Date().toISOString()
    const updated = this.store.updateRun(runId, {
      status,
      exitCode,
      completedAt,
      stalled: false,
      estimatedCostSoFar: run.startedAt ? computeElapsedCost(run.startedAt, run.costEstimate.gpuRateUsdPerHour) : run.estimatedCostSoFar,
    })
    if (updated) {
      try {
        const durationSeconds = updated.startedAt
          ? Math.round((Date.now() - new Date(updated.startedAt).getTime()) / 1000)
          : 0
        this.experience.record({
          runId,
          taskKind: inferTaskKind(updated.command),
          sandbox: 'modal',
          outcome: status === 'completed' ? 'success' : 'failed',
          durationSeconds,
          retryCount: updated.retryCount,
          timestamp: completedAt,
        })
      } catch { /* non-fatal */ }
    }
    this.emitRunUpdate(runId)
    this.processes.delete(runId)
    this.stopPollingIfIdle()
  }

  getStatus(runId: string): ModalRunStatusResult | undefined {
    const run = this.store.getRun(runId)
    if (!run) return undefined
    const outputTail = readFileTail(run.outputPath, OUTPUT_TAIL_BYTES)
    const structured = extractProgress(outputTail)
    const elapsed = run.startedAt ? (Date.now() - new Date(run.startedAt).getTime()) / 1000 : 0
    const estimatedCostUsd = run.startedAt
      ? computeElapsedCost(run.startedAt, run.costEstimate.gpuRateUsdPerHour)
      : run.estimatedCostSoFar
    return {
      status: run.status,
      planId: run.planId,
      taskDescription: run.taskDescription,
      command: run.command,
      scriptPath: run.scriptPath,
      image: run.image,
      costEstimate: run.costEstimate,
      costThresholdUsd: this.getCostThreshold(),
      exitCode: run.exitCode,
      outputTail,
      outputBytes: run.outputBytes,
      outputLines: run.outputLines,
      lastOutputAt: run.lastOutputAt,
      timeoutMs: run.timeoutMs,
      stallThresholdMs: run.stallThresholdMs,
      startedAt: run.startedAt,
      elapsedSeconds: Math.round(elapsed),
      stalled: run.stalled,
      estimatedCostUsd,
      progress: structured,
      failure: isModalTerminal(run.status) && run.status !== 'completed' ? {
        code: run.status === 'timed_out' ? 'TIMEOUT' : run.status === 'cost_killed' ? 'COMMAND_FAILED' : 'COMMAND_FAILED',
        retryable: run.status !== 'cancelled',
        message: run.error ?? `Modal run ended with status ${run.status}.`,
        suggestions: ['Inspect the output tail and Modal script, then retry after fixing the issue.'],
      } : undefined,
    }
  }

  async waitForCompletion(runId: string, timeoutMs: number): Promise<ModalRunStatusResult | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const status = this.getStatus(runId)
      if (!status) return undefined
      this.onRunUpdate(runId, status)
      if (isModalTerminal(status.status) || status.stalled) return status
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, deadline - Date.now())))
    }
    const status = this.getStatus(runId)
    if (status) this.onRunUpdate(runId, status)
    return status
  }

  async stop(runId: string): Promise<void> {
    const run = this.store.getRun(runId)
    if (!run || isModalTerminal(run.status)) return
    const child = this.processes.get(runId)
    if (child && !child.killed) {
      child.kill('SIGTERM')
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, 3000)
    }
    this.store.updateRun(runId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      stalled: false,
      estimatedCostSoFar: run.startedAt ? computeElapsedCost(run.startedAt, run.costEstimate.gpuRateUsdPerHour) : run.estimatedCostSoFar,
    })
    this.emitRunUpdate(runId)
    this.processes.delete(runId)
    this.stopPollingIfIdle()
  }

  async destroy(): Promise<void> {
    for (const runId of Array.from(this.processes.keys())) {
      await this.stop(runId).catch(() => {})
    }
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.store.flushNow()
    this.store.stopFlushTimer()
  }

  getStore(): ModalRunStore {
    return this.store
  }

  getExperience(): ExperienceStore {
    return this.experience
  }

  private ensurePolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => this.pollAll(), POLL_INTERVAL_MS)
    if (this.pollTimer.unref) this.pollTimer.unref()
  }

  private stopPollingIfIdle(): void {
    if (this.store.getActiveRuns().length === 0 && this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private pollAll(): void {
    for (const run of this.store.getActiveRuns()) this.pollOnce(run.runId)
    this.stopPollingIfIdle()
  }

  private pollOnce(runId: string): void {
    const run = this.store.getRun(runId)
    if (!run || isModalTerminal(run.status)) return
    const now = new Date().toISOString()
    const currentBytes = getFileSize(run.outputPath)
    const tail = readFileTail(run.outputPath, OUTPUT_TAIL_BYTES)
    const outputGrew = currentBytes > run.outputBytes
    const patch: Partial<ModalRunRecord> = {
      outputBytes: currentBytes,
      outputLines: estimateLines(currentBytes, tail),
    }
    if (outputGrew) {
      patch.lastOutputAt = now
      if (run.stalled) {
        patch.stalled = false
        patch.status = 'running'
      }
    }
    if (!outputGrew && run.lastOutputAt) {
      const silentMs = Date.now() - new Date(run.lastOutputAt).getTime()
      if (silentMs > run.stallThresholdMs && !run.stalled) {
        patch.stalled = true
      }
    }
    if (run.startedAt) {
      const elapsedCost = computeElapsedCost(run.startedAt, run.costEstimate.gpuRateUsdPerHour)
      patch.estimatedCostSoFar = elapsedCost
      if (elapsedCost > this.getCostThreshold()) {
        const child = this.processes.get(runId)
        if (child && !child.killed) child.kill('SIGTERM')
        this.processes.delete(runId)
        this.store.updateRun(runId, {
          ...patch,
          status: 'cost_killed',
          completedAt: now,
          stalled: false,
          error: `Estimated cost $${elapsedCost.toFixed(4)} exceeded configured threshold.`,
        })
        this.emitRunUpdate(runId)
        this.onCostKilled(runId, elapsedCost)
        return
      }
      const elapsedMs = Date.now() - new Date(run.startedAt).getTime()
      if (elapsedMs > run.timeoutMs) {
        const child = this.processes.get(runId)
        if (child && !child.killed) child.kill('SIGTERM')
        this.processes.delete(runId)
        this.store.updateRun(runId, {
          ...patch,
          status: 'timed_out',
          completedAt: now,
          stalled: false,
        })
        this.emitRunUpdate(runId)
        return
      }
    }
    this.store.updateRun(runId, patch)
    this.emitRunUpdate(runId)
  }

  private emitRunUpdate(runId: string): void {
    const status = this.getStatus(runId)
    if (status) this.onRunUpdate(runId, status)
  }
}
