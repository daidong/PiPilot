/**
 * AWS EC2 compute — internal types for the runner + run store.
 *
 * Mirrors the shape of modal-compute/types.ts so the ComputeBackend
 * adapter (aws-ec2-backend.ts) only needs to translate field names, not
 * invent semantics. The unified `RunState` in lib/compute/types.ts is a
 * superset of this state machine, so mapping is one-to-one.
 *
 * Phase 1 contract (RFC-009 §0.2):
 *   • Backend boots one instance per submit, streams stdout to a local
 *     log file via SSH, then terminates the instance on script exit.
 *   • Artifacts go to S3 (the user script does `aws s3 cp ...`); the
 *     runner does NOT SCP files back.
 *   • Instance ledger persists `instanceId` BEFORE submit returns so a
 *     crash can never orphan an instance.
 */

import type { FailureSignal, StructuredProgress } from '../local-compute/types.js'

export type AwsEc2RunState =
  | 'pending_approval'
  | 'launching'      // RunInstances issued, instance booting
  | 'connecting'     // instance running, SSH not yet established
  | 'running'        // SSH stream live
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'cost_killed'

export function isEc2Terminal(state: AwsEc2RunState): boolean {
  return (
    state === 'completed' ||
    state === 'failed' ||
    state === 'timed_out' ||
    state === 'cancelled' ||
    state === 'cost_killed'
  )
}

export interface AwsEc2TaskProfile {
  cpuDensity: 'low' | 'medium' | 'high'
  gpuDensity: 'none' | 'light' | 'heavy'
  memoryPattern: 'constant' | 'growing' | 'spike'
  ioPattern: 'read_heavy' | 'write_heavy' | 'balanced' | 'minimal'
  chunkable: boolean
  resumable: boolean
  idempotent: boolean
  hasExternalSideEffects: boolean
  networkRequired: boolean
  expectedDurationClass: 'seconds' | 'minutes' | 'hours'
  reasoning: string
}

/**
 * EC2 plan-input: what the planner decides before submit. Keeps the
 * decisions in JSON-serializable form so the unified ComputePlan can
 * carry it through approval / persistence / IPC.
 */
export interface AwsEc2InstanceSpec {
  instanceType: string        // e.g. 't3.medium', 'g5.xlarge'
  region: string              // AWS region; may differ from credentials' default
  amiId: string               // user-supplied OR planner-resolved AMI
  keyName: string             // SSH key pair name (must exist in AWS account)
  /** PEM private-key file path on the user's machine matching keyName. */
  privateKeyPath: string
  securityGroupIds?: string[]
  subnetId?: string
  /** Username for SSH. ec2-user / ubuntu / root depending on AMI. */
  sshUser: string
  /** Optional IAM instance profile name (so the script can `aws s3 cp` without keys baked in). */
  iamInstanceProfile?: string
  /** Workspace-relative path to the script copied via SSH and executed. */
  scriptPath: string
  /** Bash command issued after the script is uploaded. Defaults to `bash $REMOTE_SCRIPT`. */
  remoteCommand?: string
  /** Optional list of additional files to upload before run. Workspace-relative. */
  uploadPaths?: string[]
  /** EBS root volume size in GiB. Default 30. */
  rootVolumeGiB?: number
  /** Spot instance toggle. Off by default (Phase 1: stub only). */
  useSpot?: boolean
}

export interface AwsEc2CostEstimate {
  instanceType: string
  hourlyRateUsd: number
  expectedDurationMinutes: number
  estimatedTotalUsd: number
  notes: string
}

export interface AwsEc2RunRecord {
  runId: string
  planId: string
  taskDescription?: string
  status: AwsEc2RunState
  command: string
  scriptPath: string
  instanceSpec: AwsEc2InstanceSpec
  costEstimate: AwsEc2CostEstimate
  createdAt: string
  startedAt?: string
  /** When SSH connection became live and the script began executing. */
  sshConnectedAt?: string
  completedAt?: string
  exitCode?: number
  error?: string

  /**
   * AWS-side instance state captured at submit time. CRITICAL for
   * crash recovery — if the app dies, this is how `hydrate()` knows
   * which instance to terminate.
   */
  instanceId?: string
  publicDnsName?: string
  /** When `true`, the AWS-side termination call has succeeded or is in flight. */
  terminating?: boolean

  outputPath: string
  outputBytes: number
  outputLines: number
  lastOutputAt?: string
  timeoutMs: number
  stallThresholdMs: number
  stalled: boolean
  retryCount: number
  parentRunId?: string
  campaignId?: string
  estimatedCostSoFar?: number
}

export interface AwsEc2SubmitConfig {
  plan: {
    planId: string
    createdAt: string
    approved: boolean
    taskDescription?: string
    command: string
    scriptPath: string
    instanceSpec: AwsEc2InstanceSpec
    costEstimate: AwsEc2CostEstimate
    taskProfile: AwsEc2TaskProfile
  }
  timeoutMinutes?: number
  stallThresholdMinutes?: number
  parentRunId?: string
  campaignId?: string
}

export interface AwsEc2RunStatusResult {
  status: AwsEc2RunState
  planId?: string
  taskDescription?: string
  command?: string
  scriptPath?: string
  instanceSpec?: AwsEc2InstanceSpec
  costEstimate?: AwsEc2CostEstimate
  costThresholdUsd?: number
  exitCode?: number
  outputTail: string
  outputBytes: number
  outputLines: number
  lastOutputAt?: string
  timeoutMs?: number
  stallThresholdMs?: number
  startedAt?: string
  sshConnectedAt?: string
  elapsedSeconds: number
  stalled: boolean
  estimatedCostUsd?: number
  progress?: StructuredProgress
  failure?: FailureSignal
  instanceId?: string
  publicDnsName?: string
}
