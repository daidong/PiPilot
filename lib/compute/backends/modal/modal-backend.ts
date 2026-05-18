/**
 * ModalBackend — wraps lib/modal-compute/ ModalRunner behind the
 * ComputeBackend interface.
 *
 * Amendments honored:
 *   A1 — capabilities.requiresApproval = true; Registry captures
 *        effectiveRequiresApproval at plan() time.
 *   A2 — cost-killing stays inside ModalRunner; runner's onCostKilled
 *        callback is wired into ctx.emit({ kind: 'cost-killed', ... }).
 *        Registry has zero kill-timer logic.
 *   A3 — hydrate() returns Array<{ run, status }> by reading
 *        ModalRunStore.listAllRuns() and pairing each with getStatus().
 *   A4 — identity.toolPrefix = 'modal' (regex-safe, matches id).
 *   A5 — backendData fields are JSON-only (no Date/Map/Set/function);
 *        backendDataVersion = MODAL_BACKEND_DATA_VERSION.
 */

import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import { ModalRunner } from '../../../modal-compute/modal-runner.js'
import { estimateCost } from '../../../modal-compute/cost-estimator.js'
import type {
  ModalImageInspection,
  ModalCostEstimate as ModalCostShape,
  ModalRunRecord,
  ModalRunStatusResult,
  ModalTaskProfile,
} from '../../../modal-compute/types.js'
import { runPlanAgent } from './plan-agent.js'
import type { ComputeBackend } from '../../backend.js'
import type { ComputeContext } from '../../context.js'
import type {
  BackendCapabilities,
  BackendIdentity,
  BackendAvailability,
  ComputePlan,
  ComputeRun,
  RunStatus,
  PlanInput,
  SubmitOpts,
  RunState,
  CostEstimate,
} from '../../types.js'

export interface ModalBackendPlanData {
  image: ModalImageInspection
}

export interface ModalBackendRunData {
  image: ModalImageInspection
  costThresholdUsd: number
}

export interface ModalBackendStatusData {
  image?: ModalImageInspection
  costEstimate?: ModalCostShape
  costThresholdUsd?: number
}

export const MODAL_BACKEND_DATA_VERSION = 1

const IDENTITY: BackendIdentity = {
  id: 'modal',
  displayName: 'Modal',
  toolPrefix: 'modal',
}

const CAPABILITIES: BackendCapabilities = {
  requiresApproval: true,
  hasCost: true,
  supportsGpu: true,
  supportsStop: true,
  supportsStreaming: false,
}

function nextPlanId(): string {
  return 'mp-' + crypto.randomBytes(4).toString('hex')
}

/**
 * Map ModalRunner's status union to the unified RunState. Modal's
 * states are already a superset-compatible match for compute's RunState
 * (both have 'completed', 'failed', 'timed_out', 'cancelled',
 * 'cost_killed', 'running', 'pending_approval'). Cast through string.
 */
function mapModalState(state: ModalRunRecord['status']): RunState {
  return state as RunState
}

function modalRecordToComputeRun(record: ModalRunRecord, costThresholdUsd: number): ComputeRun {
  const data: ModalBackendRunData = {
    image: record.image,
    costThresholdUsd,
  }
  return {
    runId: record.runId,
    backend: IDENTITY.id,
    planId: record.planId,
    status: mapModalState(record.status),
    command: record.command,
    scriptPath: record.scriptPath,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    exitCode: record.exitCode,
    outputPath: record.outputPath,
    parentRunId: record.parentRunId,
    retryCount: record.retryCount,
    estimatedCostUsd: record.estimatedCostSoFar,
    backendData: data,
    backendDataVersion: MODAL_BACKEND_DATA_VERSION,
  }
}

function modalStatusToRunStatus(result: ModalRunStatusResult): RunStatus {
  const data: ModalBackendStatusData = {
    image: result.image,
    costEstimate: result.costEstimate,
    costThresholdUsd: result.costThresholdUsd,
  }
  return {
    status: mapModalState(result.status),
    exitCode: result.exitCode,
    elapsedSeconds: result.elapsedSeconds,
    outputBytes: result.outputBytes,
    outputLines: result.outputLines,
    outputTail: result.outputTail,
    lastOutputAt: result.lastOutputAt,
    stalled: result.stalled,
    progress: result.progress,
    failure: result.failure,
    estimatedCostUsd: result.estimatedCostUsd,
    backendData: data,
    backendDataVersion: MODAL_BACKEND_DATA_VERSION,
  }
}

function modalCostToUnified(shape: ModalCostShape): CostEstimate {
  return {
    estimatedTotalUsd: shape.estimatedTotalUsd,
    hourlyRateUsd: shape.gpuRateUsdPerHour,
    expectedDurationMinutes: shape.expectedDurationMinutes,
    notes: shape.notes,
    // Modal currently only models GPU; CPU/RAM/idle-container are
    // missing per RFC §6.3 amendment A2 follow-up. Mark explicitly.
    coverage: 'lower_bound',
  }
}

function hasCredentials(ctx: ComputeContext): boolean {
  const c = ctx.getCredentials()
  return !!(c.tokenId && c.tokenSecret)
}

function modalCliInstalled(): boolean {
  try {
    execSync('modal --version', { timeout: 3000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export class ModalBackend implements ComputeBackend {
  readonly identity = IDENTITY
  readonly capabilities = CAPABILITIES

  private readonly runner: ModalRunner
  private readonly ctx: ComputeContext

  constructor(ctx: ComputeContext) {
    this.ctx = ctx
    const creds = ctx.getCredentials()
    this.runner = new ModalRunner({
      projectPath: ctx.projectPath,
      workspacePath: ctx.workspacePath,
      modalCredentials: { tokenId: creds.tokenId, tokenSecret: creds.tokenSecret },
      getCostThreshold: () => ctx.getCostThresholdUsd(),
      // Amendment A2: backend (runner) owns cost-killing; events go to
      // Registry via ctx.emit instead of dedicated CoordinatorConfig
      // callbacks.
      onCostKilled: (runId, costUsd) => {
        ctx.emit({
          kind: 'cost-killed',
          backend: IDENTITY.id,
          runId,
          estimatedCostUsd: costUsd,
          thresholdUsd: ctx.getCostThresholdUsd(),
        })
      },
      onRunUpdate: (runId, status) => {
        const mapped = modalStatusToRunStatus(status)
        const terminal =
          mapped.status === 'completed' ||
          mapped.status === 'failed' ||
          mapped.status === 'timed_out' ||
          mapped.status === 'cancelled' ||
          mapped.status === 'cost_killed'
        ctx.emit({
          kind: terminal ? 'run-complete' : 'run-update',
          backend: IDENTITY.id,
          runId,
          status: mapped,
        })
      },
    })
  }

  async probeAvailability(): Promise<BackendAvailability> {
    const cli = modalCliInstalled()
    const creds = hasCredentials(this.ctx)
    const missing: string[] = []
    if (!cli) missing.push('Modal CLI not installed (`pip install modal`)')
    if (!creds) missing.push('Modal credentials missing (MODAL_TOKEN_ID + MODAL_TOKEN_SECRET; set via Settings → Compute → Modal or `modal token new`)')
    const hints: string[] = []
    if (!cli) hints.push('pip install modal')
    if (!creds && cli) hints.push('modal token new')
    return {
      available: cli && creds,
      missingRequirements: missing,
      hints: hints.length > 0 ? hints : undefined,
    }
  }

  async plan(input: PlanInput): Promise<ComputePlan> {
    if (!input.scriptPath) {
      throw new Error('script_path is required for Modal compute planning')
    }
    if (!this.ctx.createSubAgent) {
      throw new Error('createSubAgent is not available — Modal plan-agent cannot run')
    }
    const absoluteScriptPath = path.isAbsolute(input.scriptPath)
      ? input.scriptPath
      : path.resolve(this.ctx.workspacePath, input.scriptPath)

    const { taskProfile, image } = await runPlanAgent({
      scriptPath: absoluteScriptPath,
      command: input.command,
      taskDescription: input.taskDescription,
      createSubAgent: this.ctx.createSubAgent,
    })

    const threshold = this.ctx.getCostThresholdUsd()
    const modalCost = estimateCost(image, taskProfile, threshold)

    const planData: ModalBackendPlanData = { image }

    return {
      planId: nextPlanId(),
      backend: IDENTITY.id,
      createdAt: new Date().toISOString(),
      taskDescription: input.taskDescription,
      command: input.command,
      scriptPath: input.scriptPath,
      taskProfile: {
        cpuDensity: taskProfile.cpuDensity,
        gpuDensity: taskProfile.gpuDensity,
        memoryPattern: taskProfile.memoryPattern,
        ioPattern: taskProfile.ioPattern,
        chunkable: taskProfile.chunkable,
        resumable: taskProfile.resumable,
        idempotent: taskProfile.idempotent,
        hasExternalSideEffects: taskProfile.hasExternalSideEffects,
        networkRequired: taskProfile.networkRequired,
        expectedDurationClass: taskProfile.expectedDurationClass,
        reasoning: taskProfile.reasoning,
      },
      costEstimate: modalCostToUnified(modalCost),
      backendData: planData,
      backendDataVersion: MODAL_BACKEND_DATA_VERSION,
    }
  }

  async submit(plan: ComputePlan, opts: SubmitOpts): Promise<ComputeRun> {
    if (!plan.scriptPath) throw new Error('Modal plan is missing scriptPath')
    if (!plan.costEstimate) throw new Error('Modal plan is missing costEstimate')
    const data = plan.backendData as ModalBackendPlanData

    // Translate unified plan → ModalRunner's plan shape. Modal's
    // PendingPlan structure carries planId, command, scriptPath,
    // image, costEstimate; we synthesize one from our ComputePlan.
    // Approval state was already enforced by Registry — by the time
    // we reach here, Registry knows the plan is approved.
    const modalCost: ModalCostShape = {
      estimatedTotalUsd: plan.costEstimate.estimatedTotalUsd,
      gpuRateUsdPerHour: plan.costEstimate.hourlyRateUsd,
      expectedDurationMinutes: plan.costEstimate.expectedDurationMinutes,
      notes: plan.costEstimate.notes,
    }
    const record = await this.runner.submit({
      plan: {
        planId: plan.planId,
        createdAt: plan.createdAt,
        approved: true,             // Registry verified this
        taskDescription: plan.taskDescription,
        command: plan.command,
        scriptPath: plan.scriptPath,
        image: data.image,
        costEstimate: modalCost,
        // ModalRunner doesn't read these on submit, but the field
        // shape requires it. Pass through a minimal placeholder.
        taskProfile: {
          cpuDensity: plan.taskProfile.cpuDensity,
          gpuDensity: plan.taskProfile.gpuDensity,
          memoryPattern: plan.taskProfile.memoryPattern,
          ioPattern: plan.taskProfile.ioPattern,
          chunkable: plan.taskProfile.chunkable,
          resumable: plan.taskProfile.resumable,
          idempotent: plan.taskProfile.idempotent,
          hasExternalSideEffects: plan.taskProfile.hasExternalSideEffects,
          networkRequired: plan.taskProfile.networkRequired,
          expectedDurationClass: plan.taskProfile.expectedDurationClass,
          durationReasoning: plan.taskProfile.reasoning,
          reasoning: plan.taskProfile.reasoning,
        } satisfies ModalTaskProfile,
      },
      timeoutMinutes: opts.timeoutMinutes,
      stallThresholdMinutes: opts.stallThresholdMinutes,
      parentRunId: opts.parentRunId,
    })
    const run = modalRecordToComputeRun(record, this.ctx.getCostThresholdUsd())
    // Emit initial run-update so subscribers see the new run before
    // the runner's first poll cycle.
    const status = this.getStatus(run.runId)
    if (status) {
      this.ctx.emit({ kind: 'run-update', backend: IDENTITY.id, runId: run.runId, status })
    }
    return run
  }

  getStatus(runId: string): RunStatus | undefined {
    const result = this.runner.getStatus(runId)
    return result ? modalStatusToRunStatus(result) : undefined
  }

  async waitForCompletion(runId: string, timeoutMs: number): Promise<RunStatus | undefined> {
    const result = await this.runner.waitForCompletion(runId, timeoutMs)
    return result ? modalStatusToRunStatus(result) : undefined
  }

  async stop(runId: string): Promise<void> {
    await this.runner.stop(runId)
  }

  async destroy(): Promise<void> {
    await this.runner.destroy()
  }

  async hydrate(): Promise<Array<{ run: ComputeRun; status: RunStatus }>> {
    // Hydrate all persisted runs (active + recently completed) so the
    // Compute tab restores to roughly its pre-crash state. ModalRunStore
    // already evicts truly old records on startup, so the volume here
    // is small.
    const records = this.runner.getStore().getAllRuns()
    const threshold = this.ctx.getCostThresholdUsd()
    const out: Array<{ run: ComputeRun; status: RunStatus }> = []
    for (const record of records) {
      const status = this.getStatus(record.runId)
      if (!status) continue
      out.push({ run: modalRecordToComputeRun(record, threshold), status })
    }
    return out
  }
}
