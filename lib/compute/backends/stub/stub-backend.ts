/**
 * StubBackend — reference implementation of ComputeBackend.
 *
 * Two purposes:
 *
 *  1. **Reference for RFC §19** (docs/spec/compute.md). Anyone adding a
 *     new backend can read this file end-to-end in 5 minutes and see
 *     every method's contract demonstrated against a trivial
 *     in-memory state machine. It deliberately uses no shell,
 *     no network, no subprocess — only setTimeout + Map.
 *
 *  2. **Diagnostic tool.** When the Compute tab seems broken, register
 *     this backend (ENABLE_COMPUTE_STUB=1) and run a stub plan +
 *     execute. If those work but the local/modal backends don't, the
 *     bug is backend-internal, not in the registry / IPC / store
 *     plumbing.
 *
 * The "task" the stub simulates is: wait `delayMs` then "complete".
 * If the command contains "FAIL" the stub exits with code 1 instead.
 * If the command contains "SLOW" the stub uses a 5s delay (handy for
 * exercising stop()).
 *
 * Amendments honored:
 *   A4: identity.id and identity.toolPrefix are both 'stub'.
 *   A5: backendData is JSON-only; STUB_BACKEND_DATA_VERSION = 1.
 *   A3: hydrate() returns Array<{ run, status }> (always empty here
 *       because the stub keeps no on-disk state — appropriate for a
 *       diagnostic backend; production backends with real state
 *       would persist + restore here).
 */

import crypto from 'node:crypto'
import type { ComputeBackend } from '../../backend.js'
import type { ComputeContext } from '../../context.js'
import type {
  BackendAvailability,
  BackendCapabilities,
  BackendIdentity,
  ComputePlan,
  ComputeRun,
  PlanInput,
  RunStatus,
  SubmitOpts,
} from '../../types.js'

export interface StubBackendPlanData {
  delayMs: number
  simulateFailure: boolean
}

export interface StubBackendRunData {
  delayMs: number
  simulateFailure: boolean
}

export const STUB_BACKEND_DATA_VERSION = 1

const IDENTITY: BackendIdentity = {
  id: 'stub',
  displayName: 'Stub (diagnostic)',
  toolPrefix: 'stub',
}

const CAPABILITIES: BackendCapabilities = {
  requiresApproval: false,
  hasCost: false,
  supportsGpu: false,
  supportsStop: true,
  supportsStreaming: false,
  livenessModel: 'ephemeral-local',   // in-memory simulator — auto-run eligible
}

function nextPlanId(): string {
  return 'sp-' + crypto.randomBytes(4).toString('hex')
}

function nextRunId(): string {
  return 'sr-' + crypto.randomBytes(4).toString('hex')
}

interface StubRunEntry {
  run: ComputeRun
  status: RunStatus
  timer: ReturnType<typeof setTimeout> | null
  startedAt: number
}

export class StubBackend implements ComputeBackend {
  readonly identity = IDENTITY
  readonly capabilities = CAPABILITIES

  private readonly ctx: ComputeContext
  private readonly runs = new Map<string, StubRunEntry>()

  constructor(ctx: ComputeContext) {
    this.ctx = ctx
  }

  async probeAvailability(): Promise<BackendAvailability> {
    return {
      available: true,
      missingRequirements: [],
      hints: ['Diagnostic backend — always available. Use to verify the compute pipeline end-to-end without invoking real shells or APIs.'],
    }
  }

  async plan(input: PlanInput): Promise<ComputePlan> {
    const lower = input.command.toLowerCase()
    const data: StubBackendPlanData = {
      delayMs: lower.includes('slow') ? 5_000 : 100,
      simulateFailure: lower.includes('fail'),
    }
    return {
      planId: nextPlanId(),
      backend: IDENTITY.id,
      createdAt: new Date().toISOString(),
      taskDescription: input.taskDescription,
      command: input.command,
      scriptPath: input.scriptPath,
      taskProfile: {
        cpuDensity: 'low',
        gpuDensity: 'none',
        memoryPattern: 'constant',
        ioPattern: 'minimal',
        chunkable: false,
        resumable: false,
        idempotent: true,
        hasExternalSideEffects: false,
        networkRequired: false,
        expectedDurationClass: data.delayMs > 1000 ? 'seconds' : 'seconds',
        reasoning: `Stub backend; simulates ${data.delayMs}ms of work, ${data.simulateFailure ? 'exits with code 1' : 'succeeds'}.`,
      },
      // No costEstimate — capabilities.hasCost is false.
      backendData: data,
      backendDataVersion: STUB_BACKEND_DATA_VERSION,
    }
  }

  async submit(plan: ComputePlan, _opts: SubmitOpts): Promise<ComputeRun> {
    const data = plan.backendData as StubBackendPlanData
    const runId = nextRunId()
    const now = new Date().toISOString()
    const runData: StubBackendRunData = { delayMs: data.delayMs, simulateFailure: data.simulateFailure }
    const run: ComputeRun = {
      runId,
      backend: IDENTITY.id,
      planId: plan.planId,
      status: 'running',
      command: plan.command,
      scriptPath: plan.scriptPath,
      createdAt: now,
      startedAt: now,
      outputPath: `/tmp/stub/${runId}.out`,   // never actually written
      retryCount: 0,
      backendData: runData,
      backendDataVersion: STUB_BACKEND_DATA_VERSION,
    }
    const status: RunStatus = {
      status: 'running',
      elapsedSeconds: 0,
      outputBytes: 0,
      outputLines: 0,
      outputTail: `[stub] simulating ${data.delayMs}ms of work…\n`,
      stalled: false,
      backendData: runData,
      backendDataVersion: STUB_BACKEND_DATA_VERSION,
    }
    const entry: StubRunEntry = {
      run,
      status,
      timer: null,
      startedAt: Date.now(),
    }
    this.runs.set(runId, entry)

    // Emit initial run-update so the renderer sees the new run immediately.
    this.ctx.emit({ kind: 'run-update', backend: IDENTITY.id, runId, status: { ...status } })

    // Schedule the "completion" event.
    entry.timer = setTimeout(() => {
      const final = this.runs.get(runId)
      if (!final || final.status.status !== 'running') return  // stopped or already terminal
      const elapsed = Math.round((Date.now() - final.startedAt) / 1000)
      final.status = {
        ...final.status,
        status: data.simulateFailure ? 'failed' : 'completed',
        exitCode: data.simulateFailure ? 1 : 0,
        elapsedSeconds: elapsed,
        outputBytes: 64,
        outputLines: 2,
        outputTail: data.simulateFailure
          ? `[stub] simulated failure (exit 1)\n`
          : `[stub] simulated completion (exit 0)\n`,
        failure: data.simulateFailure
          ? { code: 'COMMAND_FAILED', retryable: false, message: 'Stub backend simulated failure (command contained "FAIL").', suggestions: [] }
          : undefined,
      }
      final.run.status = final.status.status
      final.run.completedAt = new Date().toISOString()
      final.run.exitCode = final.status.exitCode
      this.ctx.emit({ kind: 'run-complete', backend: IDENTITY.id, runId, status: { ...final.status } })
    }, data.delayMs)
    // Prevent the timer from keeping the process alive in tests.
    if (entry.timer && typeof (entry.timer as any).unref === 'function') {
      (entry.timer as any).unref()
    }

    return run
  }

  getStatus(runId: string): RunStatus | undefined {
    const entry = this.runs.get(runId)
    if (!entry) return undefined
    // Update elapsedSeconds live so polling consumers see time advance.
    return {
      ...entry.status,
      elapsedSeconds: Math.round((Date.now() - entry.startedAt) / 1000),
    }
  }

  async waitForCompletion(runId: string, timeoutMs: number): Promise<RunStatus | undefined> {
    const deadline = Date.now() + timeoutMs
    return new Promise(resolve => {
      const check = () => {
        const status = this.getStatus(runId)
        if (!status) return resolve(undefined)
        if (status.status !== 'running') return resolve(status)
        if (Date.now() >= deadline) return resolve(status)
        setTimeout(check, 50)
      }
      check()
    })
  }

  async stop(runId: string): Promise<void> {
    const entry = this.runs.get(runId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    if (entry.status.status === 'running') {
      entry.status = {
        ...entry.status,
        status: 'cancelled',
        elapsedSeconds: Math.round((Date.now() - entry.startedAt) / 1000),
        outputTail: entry.status.outputTail + '[stub] cancelled by stop()\n',
      }
      entry.run.status = 'cancelled'
      entry.run.completedAt = new Date().toISOString()
      this.ctx.emit({ kind: 'run-complete', backend: IDENTITY.id, runId, status: { ...entry.status } })
    }
  }

  async destroy(): Promise<void> {
    for (const entry of this.runs.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    this.runs.clear()
  }

  async hydrate(): Promise<Array<{ run: ComputeRun; status: RunStatus }>> {
    // In-memory only — nothing survives a process restart. Production
    // backends with persisted state would read from disk here.
    return []
  }
}
