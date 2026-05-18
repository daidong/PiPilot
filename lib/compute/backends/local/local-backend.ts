/**
 * LocalBackend — wraps the existing lib/local-compute/ runner + planner
 * stack behind the ComputeBackend interface defined in RFC-008.
 *
 * Internals (ComputeRunner, RunStore, task-profiler, strategy,
 * experience, environment-model) are reused unchanged. This file
 * provides the adapter: it maps PlanInput → existing planner calls,
 * ComputeRunner output → ComputeRun / RunStatus, and SubmitOpts →
 * ComputeRunner SubmitConfig.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import { ComputeRunner } from '../../../local-compute/runner.js'
import { profileTask } from '../../../local-compute/task-profiler.js'
import { probeStaticProfile, type StaticProfile } from '../../../local-compute/environment-model.js'
import { assessRisk } from '../../../local-compute/strategy.js'
import { inferTaskKind } from '../../../local-compute/experience.js'
import type { RunRecord, RunStatusResult } from '../../../local-compute/types.js'
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
} from '../../types.js'

/**
 * Local backend's plan-time backendData payload.
 *
 * Captures everything the existing local_compute_plan tool returned that
 * doesn't fit the unified TaskProfile + CostEstimate shape: risk
 * assessment, recommendations (sandbox/timeout/etc.), experience
 * summary, current resource snapshot, and detected env summary. Also
 * carries the local-only `smokeSupported` flag (Modal doesn't have
 * smoke tests, so it stayed out of the unified TaskProfile).
 *
 * Versioned via backendDataVersion = LOCAL_BACKEND_DATA_VERSION.
 * Bump on breaking shape changes.
 */
export interface LocalBackendPlanData {
  smokeSupported: boolean
  risk: {
    feasible: boolean
    risks: Array<{ severity: string; category: string; message: string; mitigation?: string }>
    warnings: string[]
  }
  recommendations: {
    sandbox: 'docker' | 'process'
    timeoutMinutes: number
    stallThresholdMinutes: number
    agentGuidance: string[]
  }
  experience?: {
    taskKind: string
    totalRuns: number
    successes: number
    failures: number
    avgDurationSeconds: number
    commonFailures: string[]
  }
  resourceSnapshot: {
    freeMemoryMb: number
    cpuLoadPercent: number
    freeDiskMb: number
    activeRuns: number
  }
  envSummary: {
    os: string
    arch: string
    cpuCores: number
    totalMemoryMb: number
    gpu: string | null
    mlxAvailable: boolean
    dockerAvailable: boolean
  }
}

export interface LocalBackendRunData {
  workDir: string
  sandboxWorkDir: string
  sandbox: 'docker' | 'process'
  weight: 'heavy' | 'light'
  currentPhase: 'preflight' | 'smoke' | 'full'
  smokeCommand?: string
  exitSignal?: string
  stderrTail?: string
  pid?: number
}

export interface LocalBackendStatusData {
  currentPhase: string
}

export const LOCAL_BACKEND_DATA_VERSION = 1

const IDENTITY: BackendIdentity = {
  id: 'local',
  displayName: 'Local',
  toolPrefix: 'local',
}

const CAPABILITIES: BackendCapabilities = {
  requiresApproval: false,
  hasCost: false,
  supportsGpu: false,           // refined at probeAvailability time
  supportsStop: true,
  supportsStreaming: false,
}

/**
 * Cache the static profile probe — it does shell-outs (e.g. detecting
 * docker / mlx / GPU) so we don't want to re-run it on every plan().
 */
let envProbeCache: { profile: StaticProfile; at: number } | null = null
const ENV_PROBE_TTL_MS = 60_000

async function getStaticProfile(opts?: { force?: boolean }): Promise<StaticProfile> {
  const now = Date.now()
  if (!opts?.force && envProbeCache && now - envProbeCache.at < ENV_PROBE_TTL_MS) {
    return envProbeCache.profile
  }
  const profile = await probeStaticProfile()
  envProbeCache = { profile, at: now }
  return profile
}

function nextPlanId(): string {
  return 'lp-' + crypto.randomBytes(4).toString('hex')
}

function readScriptContent(workspacePath: string, scriptPath: string | undefined): string | undefined {
  if (!scriptPath) return undefined
  const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(workspacePath, scriptPath)
  try {
    return fs.readFileSync(resolved, 'utf-8')
  } catch {
    return undefined
  }
}

function freeDiskMb(workspacePath: string): number {
  try {
    const out = execSync('df -m .', { cwd: workspacePath, encoding: 'utf-8', timeout: 3000 })
    const row = out.trim().split('\n')[1]?.split(/\s+/)
    const avail = parseInt(row?.[3] ?? '', 10)
    if (!isNaN(avail)) return avail
  } catch {
    /* fall through */
  }
  return 10_000
}

function recordToComputeRun(record: RunRecord, backendId: string): ComputeRun {
  const data: LocalBackendRunData = {
    workDir: record.workDir,
    sandboxWorkDir: record.sandboxWorkDir,
    sandbox: record.sandbox,
    weight: record.weight,
    currentPhase: record.currentPhase,
    smokeCommand: record.smokeCommand,
    exitSignal: record.exitSignal,
    stderrTail: record.stderrTail,
    pid: record.pid,
  }
  return {
    runId: record.runId,
    backend: backendId,
    planId: record.runId,                   // local has no plan persistence; runId acts as planId
    status: mapRunState(record.status),
    command: record.command,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    exitCode: record.exitCode,
    outputPath: record.outputPath,
    parentRunId: record.parentRunId,
    retryCount: record.retryCount,
    backendData: data,
    backendDataVersion: LOCAL_BACKEND_DATA_VERSION,
  }
}

function statusResultToRunStatus(result: RunStatusResult): RunStatus {
  const data: LocalBackendStatusData = { currentPhase: result.currentPhase }
  return {
    status: mapRunState(result.status),
    exitCode: result.exitCode,
    elapsedSeconds: result.elapsedSeconds,
    outputBytes: result.outputBytes,
    outputLines: result.outputLines,
    outputTail: result.outputTail,
    stderrTail: result.stderrTail,
    stalled: result.stalled,
    progress: result.progress,
    failure: result.failure,
    result: result.result,
    backendData: data,
    backendDataVersion: LOCAL_BACKEND_DATA_VERSION,
  }
}

/**
 * Local-compute uses 'stalled' as a status string, the new union uses
 * 'running' + stalled boolean separately. Map the legacy stalled
 * status to running (the stalled boolean is carried separately on
 * RunStatus).
 */
function mapRunState(legacy: RunRecord['status']): RunState {
  if (legacy === 'stalled') return 'running'
  return legacy as RunState
}

export class LocalBackend implements ComputeBackend {
  readonly identity = IDENTITY
  readonly capabilities = CAPABILITIES

  private readonly runner: ComputeRunner
  private readonly ctx: ComputeContext

  constructor(ctx: ComputeContext) {
    this.ctx = ctx
    this.runner = new ComputeRunner({
      projectPath: ctx.projectPath,
      workspacePath: ctx.workspacePath,
    })
  }

  async probeAvailability(opts?: { force?: boolean }): Promise<BackendAvailability> {
    try {
      const profile = await getStaticProfile(opts)
      const missing: string[] = []
      if (!profile.dockerAvailable) {
        missing.push('Docker not detected — sandbox will fall back to host process')
      }
      // Local backend is always "available" — at worst we fall back to
      // host process sandbox. The missingRequirements list is advisory.
      return {
        available: true,
        missingRequirements: missing,
        hints: missing.length > 0
          ? ['Install Docker Desktop to get full sandbox isolation; current scripts will run as host process.']
          : undefined,
      }
    } catch (err) {
      return {
        available: true,
        missingRequirements: [`Environment probe failed: ${err instanceof Error ? err.message : String(err)}`],
      }
    }
  }

  async plan(input: PlanInput): Promise<ComputePlan> {
    const scriptContent = input.scriptContent ?? readScriptContent(this.ctx.workspacePath, input.scriptPath)
    const profileCommand = input.taskDescription
      ? `${input.command}\n\nTask description: ${input.taskDescription}`
      : input.command

    // 1. Task profile via existing profiler (LLM-backed when configured)
    const callLlm = (this.ctx as any).callLlm as undefined | ((p: { systemPrompt: string; userMessage: string }) => Promise<string>)
    const legacyProfile = await profileTask(profileCommand, scriptContent, callLlm)

    // 2. Environment + snapshot
    const envProfile = await getStaticProfile()
    const activeRuns = this.runner.getStore().getActiveRuns().length
    const snapshot = {
      freeMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
      cpuLoadPercent: Math.round((os.loadavg()[0] / os.cpus().length) * 100),
      freeDiskMb: freeDiskMb(this.ctx.workspacePath),
      activeRuns: this.runner.getStore().getActiveRuns().map(r => ({ runId: r.runId, weight: r.weight })),
    }

    // 3. Experience summary
    const taskKind = inferTaskKind(input.command, scriptContent)
    const experience = this.runner.getExperience().summarize(taskKind)

    // 4. Risk assessment
    const riskAdvice = await assessRisk({
      taskProfile: legacyProfile,
      env: envProfile,
      snapshot,
      experience,
      command: profileCommand,
      callLlm,
    })

    const planData: LocalBackendPlanData = {
      smokeSupported: legacyProfile.smokeSupported,
      risk: {
        feasible: riskAdvice.feasible,
        risks: riskAdvice.risks.map(r => ({
          severity: r.severity,
          category: r.category,
          message: r.message,
          mitigation: r.mitigation,
        })),
        warnings: riskAdvice.warnings,
      },
      recommendations: {
        sandbox: riskAdvice.recommendedSandbox,
        timeoutMinutes: riskAdvice.recommendedTimeoutMinutes,
        stallThresholdMinutes: riskAdvice.recommendedStallThresholdMinutes,
        agentGuidance: riskAdvice.agentGuidance,
      },
      // Only set experience when defined — keeping it out of the
      // object entirely (vs. setting to undefined) makes backendData
      // round-trip cleanly through JSON for amendment A5.
      ...(experience ? {
        experience: {
          taskKind: experience.taskKind,
          totalRuns: experience.totalRuns,
          successes: experience.successes,
          failures: experience.failures,
          avgDurationSeconds: experience.avgDurationSeconds,
          commonFailures: experience.commonFailures,
        },
      } : {}),
      resourceSnapshot: {
        freeMemoryMb: snapshot.freeMemoryMb,
        cpuLoadPercent: snapshot.cpuLoadPercent,
        freeDiskMb: snapshot.freeDiskMb,
        activeRuns,
      },
      envSummary: {
        os: envProfile.os,
        arch: envProfile.arch,
        cpuCores: envProfile.cpuCores,
        totalMemoryMb: envProfile.totalMemoryMb,
        gpu: envProfile.gpu.model,
        mlxAvailable: envProfile.gpu.mlxAvailable,
        dockerAvailable: envProfile.dockerAvailable,
      },
    }

    return {
      planId: nextPlanId(),
      backend: IDENTITY.id,
      createdAt: new Date().toISOString(),
      taskDescription: input.taskDescription,
      command: input.command,
      scriptPath: input.scriptPath,
      taskProfile: {
        cpuDensity: legacyProfile.cpuDensity,
        gpuDensity: legacyProfile.gpuDensity,
        memoryPattern: legacyProfile.memoryPattern,
        ioPattern: legacyProfile.ioPattern,
        chunkable: legacyProfile.chunkable,
        resumable: legacyProfile.resumable,
        idempotent: legacyProfile.idempotent,
        hasExternalSideEffects: legacyProfile.hasExternalSideEffects,
        networkRequired: legacyProfile.networkRequired,
        expectedDurationClass: legacyProfile.expectedDurationClass,
        reasoning: legacyProfile.reasoning,
      },
      costEstimate: undefined,   // hasCost: false
      backendData: planData,
      backendDataVersion: LOCAL_BACKEND_DATA_VERSION,
    }
  }

  async submit(plan: ComputePlan, opts: SubmitOpts): Promise<ComputeRun> {
    const data = plan.backendData as LocalBackendPlanData
    const recommendations = data?.recommendations
    const record = await this.runner.submit({
      command: plan.command,
      sandbox: recommendations?.sandbox ?? 'auto',
      timeoutMinutes: opts.timeoutMinutes ?? recommendations?.timeoutMinutes,
      stallThresholdMinutes: opts.stallThresholdMinutes ?? recommendations?.stallThresholdMinutes,
      parentRunId: opts.parentRunId,
      smokeCommand: data?.smokeSupported ? `${plan.command} --smoke` : undefined,
    })
    const run = recordToComputeRun(record, IDENTITY.id)
    // Emit an initial run-update so subscribers see the new run without
    // waiting for the first poll cycle.
    this.ctx.emit({
      kind: 'run-update',
      backend: IDENTITY.id,
      runId: run.runId,
      planId: run.planId,
      status: this.getStatus(run.runId) ?? {
        status: run.status,
        elapsedSeconds: 0,
        outputBytes: 0,
        outputLines: 0,
        outputTail: '',
        stalled: false,
        backendData: { currentPhase: record.currentPhase },
        backendDataVersion: LOCAL_BACKEND_DATA_VERSION,
      },
    })
    return run
  }

  getStatus(runId: string): RunStatus | undefined {
    const result = this.runner.getStatus(runId)
    return result ? statusResultToRunStatus(result) : undefined
  }

  async waitForCompletion(runId: string, timeoutMs: number): Promise<RunStatus | undefined> {
    const result = await this.runner.waitForCompletion(runId, timeoutMs)
    return result ? statusResultToRunStatus(result) : undefined
  }

  async stop(runId: string): Promise<void> {
    await this.runner.stop(runId)
  }

  async destroy(): Promise<void> {
    await this.runner.destroy()
  }

  async hydrate(): Promise<Array<{ run: ComputeRun; status: RunStatus }>> {
    const records = this.runner.getStore().getAllRuns()
    const out: Array<{ run: ComputeRun; status: RunStatus }> = []
    for (const record of records) {
      const status = this.getStatus(record.runId)
      if (!status) continue   // run was evicted between getAllRuns and getStatus
      out.push({ run: recordToComputeRun(record, IDENTITY.id), status })
    }
    return out
  }
}
