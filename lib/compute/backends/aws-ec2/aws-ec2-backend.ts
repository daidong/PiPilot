/**
 * AwsEc2Backend — wraps AwsEc2Runner behind the unified ComputeBackend
 * interface. Mirrors ModalBackend's shape (RFC-008 + RFC-009 §4.1).
 *
 * Phase 1 contract:
 *   • plan() expects the caller to supply an InstanceSpec via the
 *     PlanInput.scriptContent JSON (see plan-input shape below). We do
 *     NOT yet have an LLM-driven plan agent for EC2 — that's a Phase 2
 *     refinement. The plan_compute tool surfaces this requirement to the
 *     coordinator, which can prompt the user to supply the spec.
 *   • submit() returns once instanceId is persisted in the ledger; SSH
 *     and execution continue in the background.
 *   • supportsStreaming = false (UI polls outputTail; same as Modal).
 *
 * Amendments honored:
 *   A1 — capabilities.requiresApproval = true; cost is non-trivial.
 *   A2 — cost-killing lives inside the runner; we just wire onCostKilled
 *        to ctx.emit({ kind: 'cost-killed', ... }).
 *   A3 — hydrate() returns Array<{ run, status }> by reading the store.
 *   A4 — identity { id: 'aws-ec2', toolPrefix: 'aws_ec2' } — toolPrefix
 *        replaces the hyphen with underscore to satisfy the regex.
 *   A5 — backendData is JSON-only; backendDataVersion = 1.
 */

import crypto from 'node:crypto'
import { AwsEc2Runner } from '../../../aws-ec2-compute/ec2-runner.js'
import { estimateEc2Cost } from '../../../aws-ec2-compute/cost-estimator.js'
import type {
  AwsEc2RunRecord,
  AwsEc2RunStatusResult,
  AwsEc2InstanceSpec,
  AwsEc2CostEstimate,
  AwsEc2TaskProfile,
} from '../../../aws-ec2-compute/types.js'
import { extractResult } from '../../../local-compute/progress.js'
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
import { toSdkCredentials, type AwsCredentialProvider } from '../../../aws/credentials.js'

export interface AwsEc2BackendPlanData {
  instanceSpec: AwsEc2InstanceSpec
  cost: AwsEc2CostEstimate
}

export interface AwsEc2BackendRunData {
  instanceSpec: AwsEc2InstanceSpec
  cost: AwsEc2CostEstimate
  instanceId?: string
  publicDnsName?: string
  costThresholdUsd: number
}

export interface AwsEc2BackendStatusData {
  instanceSpec?: AwsEc2InstanceSpec
  cost?: AwsEc2CostEstimate
  instanceId?: string
  publicDnsName?: string
  costThresholdUsd?: number
}

export const AWS_EC2_BACKEND_DATA_VERSION = 1

const IDENTITY: BackendIdentity = {
  id: 'aws-ec2',
  displayName: 'AWS EC2',
  toolPrefix: 'aws_ec2',
}

const CAPABILITIES: BackendCapabilities = {
  requiresApproval: true,
  hasCost: true,
  supportsGpu: true,
  supportsStop: true,
  supportsStreaming: false,
}

function nextPlanId(): string {
  return 'ep-' + crypto.randomBytes(4).toString('hex')
}

function ec2RunToComputeRun(record: AwsEc2RunRecord, threshold: number): ComputeRun {
  const data: AwsEc2BackendRunData = {
    instanceSpec: record.instanceSpec,
    cost: record.costEstimate,
    instanceId: record.instanceId,
    publicDnsName: record.publicDnsName,
    costThresholdUsd: threshold,
  }
  return {
    runId: record.runId,
    backend: IDENTITY.id,
    planId: record.planId,
    status: record.status as RunState,
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
    backendDataVersion: AWS_EC2_BACKEND_DATA_VERSION,
  }
}

function ec2StatusToRunStatus(result: AwsEc2RunStatusResult): RunStatus {
  const data: AwsEc2BackendStatusData = {
    instanceSpec: result.instanceSpec,
    cost: result.costEstimate,
    instanceId: result.instanceId,
    publicDnsName: result.publicDnsName,
    costThresholdUsd: result.costThresholdUsd,
  }
  return {
    status: result.status as RunState,
    exitCode: result.exitCode,
    elapsedSeconds: result.elapsedSeconds,
    outputBytes: result.outputBytes,
    outputLines: result.outputLines,
    outputTail: result.outputTail,
    stderrTail: undefined,           // EC2 interleaves stdout+stderr like Modal
    lastOutputAt: result.lastOutputAt,
    stalled: result.stalled,
    progress: result.progress,
    failure: result.failure,
    result: extractResult(result.outputTail),
    estimatedCostUsd: result.estimatedCostUsd,
    backendData: data,
    backendDataVersion: AWS_EC2_BACKEND_DATA_VERSION,
  }
}

function ec2CostToUnified(shape: AwsEc2CostEstimate): CostEstimate {
  return {
    estimatedTotalUsd: shape.estimatedTotalUsd,
    hourlyRateUsd: shape.hourlyRateUsd,
    expectedDurationMinutes: shape.expectedDurationMinutes,
    notes: shape.notes,
    // We model the dominant cost component (compute hours); EBS and
    // network egress are not included. Same calibration logic as
    // Modal — be explicit so the UI shows the right caveat.
    coverage: 'lower_bound',
  }
}

/**
 * Parse the plan input. Phase 1 expects the caller to supply a fully
 * specified InstanceSpec via PlanInput.backendData (forwarded from the
 * `compute_plan` tool's `backend_data` JSON parameter — see RFC-009
 * §0.2 design note + docs/spec/aws-setup.md). This stays in place until
 * an LLM-driven plan agent lands in Phase 2; the error message guides
 * the caller to the right field so agents self-correct.
 */
function parsePlanInput(input: PlanInput): {
  spec: AwsEc2InstanceSpec
  taskProfile: AwsEc2TaskProfile
} {
  if (input.backendData == null || typeof input.backendData !== 'object') {
    throw new Error(
      'aws-ec2 plan requires the `backend_data` parameter on compute_plan ' +
        'to be a JSON object with shape { instanceSpec: {...}, taskProfile: {...} }. ' +
        'Example: compute_plan(backend="aws-ec2", command="bash run.sh", ' +
        'backend_data=\'{"instanceSpec":{"instanceType":"t3.small","region":"us-east-1","amiId":"ami-...","keyName":"...","privateKeyPath":"/path/to/key.pem","sshUser":"ubuntu","scriptPath":"run.sh"},"taskProfile":{"expectedDurationClass":"minutes"}}\'). ' +
        'See docs/spec/aws-setup.md §3 for the full field list.',
    )
  }
  const parsed = input.backendData as { instanceSpec?: AwsEc2InstanceSpec; taskProfile?: Partial<AwsEc2TaskProfile> }
  if (!parsed.instanceSpec || typeof parsed.instanceSpec !== 'object') {
    throw new Error('aws-ec2 backend_data is missing the `instanceSpec` object.')
  }

  const spec = parsed.instanceSpec
  for (const required of ['instanceType', 'region', 'amiId', 'keyName', 'privateKeyPath', 'sshUser', 'scriptPath'] as const) {
    if (!spec[required] || typeof spec[required] !== 'string') {
      throw new Error(`aws-ec2 instanceSpec is missing required string field "${required}".`)
    }
  }

  const taskProfile: AwsEc2TaskProfile = {
    cpuDensity: parsed.taskProfile?.cpuDensity ?? 'medium',
    gpuDensity: parsed.taskProfile?.gpuDensity ?? 'none',
    memoryPattern: parsed.taskProfile?.memoryPattern ?? 'constant',
    ioPattern: parsed.taskProfile?.ioPattern ?? 'balanced',
    chunkable: parsed.taskProfile?.chunkable ?? false,
    resumable: parsed.taskProfile?.resumable ?? false,
    idempotent: parsed.taskProfile?.idempotent ?? false,
    hasExternalSideEffects: parsed.taskProfile?.hasExternalSideEffects ?? true,
    networkRequired: parsed.taskProfile?.networkRequired ?? true,
    expectedDurationClass: parsed.taskProfile?.expectedDurationClass ?? 'minutes',
    reasoning: parsed.taskProfile?.reasoning ?? 'Caller-supplied EC2 plan (Phase 1).',
  }
  return { spec, taskProfile }
}

export class AwsEc2Backend implements ComputeBackend {
  readonly identity = IDENTITY
  readonly capabilities = CAPABILITIES

  private readonly runner: AwsEc2Runner
  private readonly ctx: ComputeContext
  private readonly credentialProvider: AwsCredentialProvider

  constructor(ctx: ComputeContext, credentialProvider: AwsCredentialProvider) {
    this.ctx = ctx
    this.credentialProvider = credentialProvider
    this.runner = new AwsEc2Runner({
      projectPath: ctx.projectPath,
      workspacePath: ctx.workspacePath,
      credentialProvider,
      getCostThreshold: () => ctx.getCostThresholdUsd(),
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
        const mapped = ec2StatusToRunStatus(status)
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
          planId: status.planId ?? '',
          status: mapped,
        })
      },
    })
  }

  async probeAvailability(): Promise<BackendAvailability> {
    // Cheap probe: try to resolve credentials (no network). If that
    // succeeds, do a single STS GetCallerIdentity to confirm they're
    // valid. STS is cached for 5 min by the provider, so repeated
    // probes during a session are free after the first.
    let resolution: ReturnType<AwsCredentialProvider['resolve']>
    try {
      resolution = this.credentialProvider.resolve()
    } catch (err) {
      return {
        available: false,
        missingRequirements: [err instanceof Error ? err.message : String(err)],
        hints: ['Open Settings → Compute → AWS and provide credentials, or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION.'],
      }
    }
    const validation = await this.credentialProvider.validate(resolution.credentials)
    if (!validation.valid) {
      return {
        available: false,
        missingRequirements: [`AWS credentials failed STS validation: ${validation.error ?? 'unknown error'}`],
        hints: ['Verify the access key has not been rotated or disabled in IAM.'],
      }
    }
    return {
      available: true,
      missingRequirements: [],
      hints: [
        `Authenticated as ${validation.arn ?? validation.accountId ?? 'AWS principal'} (source: ${resolution.source}).`,
      ],
    }
  }

  async plan(input: PlanInput): Promise<ComputePlan> {
    const { spec, taskProfile } = parsePlanInput(input)
    const threshold = this.ctx.getCostThresholdUsd()
    const cost = estimateEc2Cost(spec, taskProfile, threshold)
    const planData: AwsEc2BackendPlanData = { instanceSpec: spec, cost }
    return {
      planId: nextPlanId(),
      backend: IDENTITY.id,
      createdAt: new Date().toISOString(),
      taskDescription: input.taskDescription,
      command: input.command,
      scriptPath: spec.scriptPath,
      taskProfile,
      costEstimate: ec2CostToUnified(cost),
      backendData: planData,
      backendDataVersion: AWS_EC2_BACKEND_DATA_VERSION,
    }
  }

  async submit(plan: ComputePlan, opts: SubmitOpts): Promise<ComputeRun> {
    const data = plan.backendData as AwsEc2BackendPlanData
    if (!data?.instanceSpec || !data?.cost) {
      throw new Error('aws-ec2 plan is missing backendData.instanceSpec / cost')
    }
    const record = await this.runner.submit({
      plan: {
        planId: plan.planId,
        createdAt: plan.createdAt,
        approved: true,             // Registry verified this
        taskDescription: plan.taskDescription,
        command: plan.command,
        scriptPath: data.instanceSpec.scriptPath,
        instanceSpec: data.instanceSpec,
        costEstimate: data.cost,
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
          reasoning: plan.taskProfile.reasoning,
        },
      },
      timeoutMinutes: opts.timeoutMinutes,
      stallThresholdMinutes: opts.stallThresholdMinutes,
      parentRunId: opts.parentRunId,
    })
    const run = ec2RunToComputeRun(record, this.ctx.getCostThresholdUsd())
    const status = this.getStatus(run.runId)
    if (status) {
      this.ctx.emit({
        kind: 'run-update',
        backend: IDENTITY.id,
        runId: run.runId,
        planId: run.planId,
        status,
      })
    }
    return run
  }

  getStatus(runId: string): RunStatus | undefined {
    const result = this.runner.getStatus(runId)
    return result ? ec2StatusToRunStatus(result) : undefined
  }

  async waitForCompletion(runId: string, timeoutMs: number): Promise<RunStatus | undefined> {
    const result = await this.runner.waitForCompletion(runId, timeoutMs)
    return result ? ec2StatusToRunStatus(result) : undefined
  }

  async stop(runId: string): Promise<void> {
    await this.runner.stop(runId)
  }

  async destroy(): Promise<void> {
    await this.runner.destroy()
  }

  async hydrate(): Promise<Array<{ run: ComputeRun; status: RunStatus }>> {
    // Crash-recovery path (RFC-009 §0.2 AC #5). For each persisted run:
    //   • If terminal in our ledger: surface as-is (UI restoration).
    //   • If still 'launching' / 'connecting' / 'running' here, query
    //     AWS for the current instance state. If AWS says terminated /
    //     shutting-down, mark our ledger row accordingly. If AWS still
    //     says running but the SSH stream is dead (we crashed), we
    //     terminate the instance and mark cancelled — better to lose
    //     the run than to keep paying for an orphan.
    const records = this.runner.getStore().getAllRuns()
    const threshold = this.ctx.getCostThresholdUsd()
    const out: Array<{ run: ComputeRun; status: RunStatus }> = []

    for (const record of records) {
      if (!isAwsTerminal(record.status) && record.instanceId) {
        try {
          await this.reconcileOrphan(record)
        } catch {
          /* non-fatal: leave the row as-is and let the next probe try */
        }
      }
      const status = this.getStatus(record.runId)
      if (!status) continue
      out.push({ run: ec2RunToComputeRun(record, threshold), status })
    }
    return out
  }

  /**
   * Hydrate-time orphan reconciliation. Called for every non-terminal
   * record that has an instanceId. The runner instance is fresh — it
   * has no in-memory state for this run — so we must rebuild reality
   * from AWS.
   */
  private async reconcileOrphan(record: AwsEc2RunRecord): Promise<void> {
    const region = record.instanceSpec.region
    const instanceId = record.instanceId!
    const { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } = await import('@aws-sdk/client-ec2')
    const creds = this.credentialProvider.resolve({ region })
    const client = new EC2Client({
      region,
      credentials: toSdkCredentials(creds.credentials),
    })

    const resp = await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
    const instState = resp.Reservations?.[0]?.Instances?.[0]?.State?.Name

    if (!instState || instState === 'terminated' || instState === 'shutting-down') {
      // AWS already cleaned up — just mark the ledger.
      this.runner.getStore().updateRun(record.runId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'Recovered after app crash: instance was already terminated.',
        stalled: false,
      })
      return
    }

    // Instance still alive but we lost the SSH session — terminate to
    // prevent runaway cost, then mark cancelled. The user can rerun.
    try {
      await client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }))
    } catch {
      /* if terminate fails the row stays running; next hydrate will retry */
    }
    this.runner.getStore().updateRun(record.runId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      error: 'Recovered after app crash: SSH stream lost, instance terminated to avoid orphan cost.',
      stalled: false,
      terminating: true,
    })
  }
}

function isAwsTerminal(state: AwsEc2RunRecord['status']): boolean {
  return (
    state === 'completed' ||
    state === 'failed' ||
    state === 'timed_out' ||
    state === 'cancelled' ||
    state === 'cost_killed'
  )
}
