/**
 * AwsEc2Runner — the runtime that submits / polls / terminates EC2
 * instances and streams their stdout to a local log file.
 *
 * Mirrors ModalRunner's shape so the ComputeBackend adapter on top can
 * stay slim. Key invariants:
 *
 *   • submit() returns ONLY after the instanceId has been persisted to
 *     the ledger. If launch succeeds but persistence fails, the runner
 *     attempts an immediate TerminateInstances before throwing. Net
 *     effect: an instance running in AWS without a corresponding ledger
 *     row is a bug worth paging on, not a normal failure mode.
 *
 *   • Polling loop owns three timers: cost-kill, run-timeout, stall
 *     detection. All three share one 5-second tick. On any of them
 *     firing we transition to a terminal state and call
 *     TerminateInstances; the ledger row is updated AFTER the AWS call
 *     resolves so a transient network error doesn't leave us thinking
 *     an instance is gone when it isn't.
 *
 *   • Output streaming: an SSH connection is opened to the instance via
 *     `ssh2`, the user's script is uploaded over SFTP into /tmp, and a
 *     remote `bash $REMOTE_SCRIPT` is exec'd. Stdout+stderr stream into
 *     `<runDir>/output.log` interleaved. On script exit the SSH
 *     channel's 'close' event drives the terminal-state transition.
 *
 * SSH library choice: `ssh2` is the canonical pure-JS SSH client for
 * Node — used by VS Code Remote-SSH, GitHub CLI, npm's git-over-ssh
 * paths, etc. No native deps required at install.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { WriteStream } from 'node:fs'
import { expandHome, resolveUserPath } from '../utils/path-utils.js'
import { computeEc2ElapsedCost } from './cost-estimator.js'
import { extractProgress } from '../local-compute/progress.js'
import { AwsEc2RunStore } from './ec2-run-store.js'
import {
  type AwsEc2RunRecord,
  type AwsEc2RunState,
  type AwsEc2RunStatusResult,
  type AwsEc2SubmitConfig,
  isEc2Terminal,
} from './types.js'
import type { AwsCredentialProvider } from '../aws/credentials.js'
import { toSdkCredentials } from '../aws/credentials.js'

const POLL_INTERVAL_MS = 5_000
const OUTPUT_TAIL_BYTES = 8_192
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000
const DEFAULT_STALL_THRESHOLD_MS = 10 * 60_000
const MAX_TIMEOUT_MS = 24 * 60 * 60_000
const SSH_CONNECT_RETRY_INTERVAL_MS = 10_000
const SSH_CONNECT_MAX_ATTEMPTS = 30 // 5 min boot-window cap (waits for AWS state=running + publicDns)

// Second wait window — AWS state=running just means kernel up + network
// attached. sshd typically takes another 15-90 s to bind port 22 (Ubuntu
// 24.04 ≈ 30 s, AL2023 ≈ 60 s, hardened AMIs longer). Retry SSH handshake
// on network-class errors during this window.
const SSH_HANDSHAKE_RETRY_INTERVAL_MS = 10_000
const SSH_HANDSHAKE_MAX_ATTEMPTS = 18 // 3 min cap — comfortably covers most AMIs

/**
 * Network-class SSH errors that mean "instance is still booting" — retry.
 * Anything else (auth-publickey-failed, host-key-mismatch, etc.) is a
 * real misconfiguration and should fail fast.
 *
 * Exported for tests. ssh2 surfaces network errors via two paths:
 *   • Node net errors with `.code` (ECONNREFUSED, ETIMEDOUT, etc.)
 *   • ssh2's own readyTimeout, which rejects with message "Timed out
 *     while waiting for handshake"
 * Both kinds count as retryable.
 */
export function isRetryableSshHandshakeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = String((err as { code?: unknown }).code ?? '')
  if (
    code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EAI_AGAIN'
  ) return true
  const message = String((err as { message?: unknown }).message ?? '').toLowerCase()
  if (message.includes('timed out while waiting for handshake')) return true
  // 'connect ECONNREFUSED 1.2.3.4:22' — code field sometimes absent on
  // wrapped errors; match on the message text too.
  if (message.includes('econnrefused') || message.includes('etimedout') ||
      message.includes('econnreset') || message.includes('ehostunreach') ||
      message.includes('enetunreach')) return true
  return false
}

function nextRunId(): string {
  return 'er-' + crypto.randomBytes(4).toString('hex')
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

interface ActiveStream {
  /** ssh2 Client instance — keyed for cleanup on stop/destroy. */
  client: unknown
  outputStream: WriteStream
}

/**
 * Map AWS / SSH error strings to actionable suggestions.
 *
 * AWS's encoded-authorization-failure messages are technically complete
 * but bury the actionable keyword inside an opaque 400-char base64 blob.
 * Recognized patterns get a targeted fix; everything else falls back to
 * the generic "check output tail" pair.
 *
 * Exported for tests. Pure function — no I/O, deterministic.
 */
export function classifyEc2FailureSuggestions(error: string | undefined): string[] {
  const msg = (error ?? '').toLowerCase()

  // IAM gotchas — the three we hit on first green smoke test (RFC-009).
  if (msg.includes('iam:passrole')) {
    return [
      'Your IAM user is missing `iam:PassRole` permission on the instance-profile role. ' +
        'Add the `PassEc2InstanceRole` statement from docs/spec/aws-setup.md §1 to your user\'s inline policy.',
      'Note: AWS-managed policies like AmazonEC2FullAccess deliberately omit iam:PassRole — you must grant it explicitly.',
    ]
  }
  if (msg.includes('unauthorizedoperation')) {
    return [
      'The IAM user can authenticate but lacks permission for this RunInstances call. ' +
        'Decode the failure message with `aws sts decode-authorization-message --encoded-message <blob>` to see the exact action and resource.',
      'Cross-reference against the inline policy in docs/spec/aws-setup.md §1.',
    ]
  }

  // Resource-not-found cliffs — wrong region / wrong name.
  if (msg.includes('invalidamiid.notfound')) {
    return [
      'The AMI id does not exist in the requested region. AMI ids are region-scoped — ami-xxx for us-east-1 is different from us-west-2.',
      'Look up the right AMI for your region: `aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --region <region>`.',
    ]
  }
  if (msg.includes('invalidkeypair.notfound')) {
    return [
      'The EC2 key pair name does not exist in the launch region. Key pairs are region-scoped — recreate it in the target region or pick a region where it already exists.',
    ]
  }
  if (msg.includes('invalidgroup.notfound') || msg.includes('invalidsecuritygroup')) {
    return [
      'The security group id is invalid or in a different region. Security groups are region+VPC-scoped — use the id (`sg-xxx`), not the name, and confirm the region matches.',
    ]
  }
  if (msg.includes('invalidsubnetid.notfound')) {
    return [
      'The subnet id is invalid or in a different region. Drop the subnet id to let AWS pick the default subnet, or supply one from the launch region.',
    ]
  }
  if (msg.includes('invalid iam instance profile name')) {
    return [
      'The instance profile name does not exist in this account. Confirm with `aws iam list-instance-profiles`. ' +
        'A common cause: creating the IAM role but not the matching instance profile — see docs/spec/aws-setup.md §1 B3 for the fix.',
      'Also verify you are using the same AWS account as the one your `aws` CLI points to (account mismatch shows up as "Invalid" because the profile genuinely doesn\'t exist in the caller\'s account).',
    ]
  }

  // SSH / network cliffs (after instance is up).
  if (msg.includes('permission denied (publickey)')) {
    return [
      'SSH key auth failed. Verify the local `privateKeyPath` matches the EC2 `keyName` you launched with, and that file permissions are `chmod 400 <key>.pem`.',
      'Also confirm `sshUser` is correct for the AMI — Ubuntu AMIs use `ubuntu`, Amazon Linux uses `ec2-user`.',
    ]
  }
  if (msg.includes('ssh') && (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnrefused'))) {
    return [
      'SSH could not connect. The most common cause is a security group that blocks port 22 inbound from your IP. Re-check the SG rule\'s source CIDR (it expires when your public IP changes — e.g. after switching wifi networks).',
      'If the SG is correct, confirm the instance is in a public subnet with an auto-assigned public IP.',
    ]
  }

  // Capacity / quota cliffs.
  if (msg.includes('insufficientinstancecapacity')) {
    return [
      'AWS has no capacity for that instance type in the chosen region/AZ right now. Retry, switch to a sibling instance type, or change region.',
    ]
  }
  if (msg.includes('vcpu') && msg.includes('quota')) {
    return [
      'Your account\'s on-demand vCPU quota is exhausted. Request a quota increase from the AWS Service Quotas console (search "Running On-Demand Standard instances").',
    ]
  }

  // Default fallback — same as the old hardcoded message.
  return [
    'Inspect the output tail; the script may have failed before reaching the S3-upload step.',
    'If outputs are missing, the user script must `aws s3 cp` them — the backend never copies files back.',
  ]
}

export interface AwsEc2RunnerOpts {
  projectPath: string
  workspacePath: string
  credentialProvider: AwsCredentialProvider
  getCostThreshold: () => number
  onCostKilled: (runId: string, costUsd: number) => void
  onRunUpdate?: (runId: string, status: AwsEc2RunStatusResult) => void
}

export class AwsEc2Runner {
  private readonly store: AwsEc2RunStore
  private readonly workspacePath: string
  private readonly credentialProvider: AwsCredentialProvider
  private readonly getCostThreshold: () => number
  private readonly onCostKilled: (runId: string, costUsd: number) => void
  private readonly onRunUpdate: (runId: string, status: AwsEc2RunStatusResult) => void
  private readonly streams = new Map<string, ActiveStream>()
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: AwsEc2RunnerOpts) {
    this.store = new AwsEc2RunStore(opts.projectPath)
    this.workspacePath = opts.workspacePath
    this.credentialProvider = opts.credentialProvider
    this.getCostThreshold = opts.getCostThreshold
    this.onCostKilled = opts.onCostKilled
    this.onRunUpdate = opts.onRunUpdate ?? (() => {})
    this.store.evictOld()
  }

  getStore(): AwsEc2RunStore {
    return this.store
  }

  // ── Submit ──────────────────────────────────────────────────────────

  async submit(config: AwsEc2SubmitConfig): Promise<AwsEc2RunRecord> {
    const timeoutMs = Math.min((config.timeoutMinutes ?? 120) * 60_000, MAX_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
    const stallThresholdMs = (config.stallThresholdMinutes ?? 10) * 60_000 || DEFAULT_STALL_THRESHOLD_MS
    const runId = nextRunId()
    const runDir = this.store.getRunDir(runId)
    const outputPath = this.store.getOutputPath(runId)
    fs.mkdirSync(runDir, { recursive: true })

    const now = new Date().toISOString()
    const record: AwsEc2RunRecord = {
      runId,
      planId: config.plan.planId,
      taskDescription: config.plan.taskDescription,
      status: 'launching',
      command: config.plan.command,
      scriptPath: config.plan.scriptPath,
      instanceSpec: config.plan.instanceSpec,
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
    this.appendLog(outputPath, `[ec2] Provisioning ${config.plan.instanceSpec.instanceType} in ${config.plan.instanceSpec.region}\n`)

    // Launch the instance. We commit the instanceId to the ledger BEFORE
    // returning from submit — even if SSH later fails, the ledger guarantees
    // hydrate() can find and terminate the instance.
    let instanceId: string
    try {
      instanceId = await this.runInstances(config.plan.instanceSpec, runId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.appendLog(outputPath, `[ec2] Launch failed: ${message}\n`)
      this.store.updateRun(runId, {
        status: 'failed',
        error: `Launch failed: ${message}`,
        completedAt: new Date().toISOString(),
      })
      this.emitRunUpdate(runId)
      return record
    }

    this.store.updateRun(runId, { instanceId, status: 'connecting' })
    this.appendLog(outputPath, `[ec2] Instance ${instanceId} launching; waiting for SSH...\n`)
    this.ensurePolling()

    // Detach the SSH workflow to a background promise — submit() returns
    // immediately so the caller can poll status. Failures inside the
    // workflow update the ledger + emit; they do NOT throw back here.
    this.startSshWorkflow(runId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      this.appendLog(outputPath, `[ec2] SSH workflow failed: ${message}\n`)
      this.terminateAndMark(runId, 'failed', message).catch(() => {})
    })

    return record
  }

  private appendLog(outputPath: string, text: string): void {
    try { fs.appendFileSync(outputPath, text) } catch { /* non-fatal */ }
  }

  // ── EC2 SDK calls ───────────────────────────────────────────────────

  /**
   * Issue RunInstances. Returns the new instanceId. Caller MUST persist
   * the id before resolving submit().
   */
  private async runInstances(spec: import('./types.js').AwsEc2InstanceSpec, _runId: string): Promise<string> {
    const { EC2Client, RunInstancesCommand } = await import('@aws-sdk/client-ec2')
    const creds = this.credentialProvider.resolve({ region: spec.region })
    const client = new EC2Client({
      region: spec.region,
      credentials: toSdkCredentials(creds.credentials),
    })
    // The EC2 SDK types InstanceType / ResourceType as string-literal unions
    // pinned to the SDK version. Casting to the SDK's enum keeps user-supplied
    // instance types working without forcing the bundle to track every new
    // family (the API will reject unknown types at runtime, which is the
    // right place for that validation anyway).
    const resp = await client.send(new RunInstancesCommand({
      ImageId: spec.amiId,
      InstanceType: spec.instanceType as unknown as import('@aws-sdk/client-ec2')._InstanceType,
      MinCount: 1,
      MaxCount: 1,
      KeyName: spec.keyName,
      SecurityGroupIds: spec.securityGroupIds,
      SubnetId: spec.subnetId,
      IamInstanceProfile: spec.iamInstanceProfile ? { Name: spec.iamInstanceProfile } : undefined,
      BlockDeviceMappings: spec.rootVolumeGiB
        ? [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: spec.rootVolumeGiB, DeleteOnTermination: true } }]
        : undefined,
      TagSpecifications: [{
        ResourceType: 'instance' as import('@aws-sdk/client-ec2').ResourceType,
        Tags: [
          { Key: 'Name', Value: `research-copilot-${_runId}` },
          { Key: 'research-copilot:runId', Value: _runId },
        ],
      }],
    }))
    const id = resp.Instances?.[0]?.InstanceId
    if (!id) throw new Error('RunInstances returned no InstanceId')
    return id
  }

  private async describeInstance(instanceId: string, region: string): Promise<{
    state?: string
    publicDnsName?: string
  }> {
    const { EC2Client, DescribeInstancesCommand } = await import('@aws-sdk/client-ec2')
    const creds = this.credentialProvider.resolve({ region })
    const client = new EC2Client({
      region,
      credentials: toSdkCredentials(creds.credentials),
    })
    const resp = await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
    const inst = resp.Reservations?.[0]?.Instances?.[0]
    return { state: inst?.State?.Name, publicDnsName: inst?.PublicDnsName }
  }

  private async terminateInstance(instanceId: string, region: string): Promise<void> {
    const { EC2Client, TerminateInstancesCommand } = await import('@aws-sdk/client-ec2')
    const creds = this.credentialProvider.resolve({ region })
    const client = new EC2Client({
      region,
      credentials: toSdkCredentials(creds.credentials),
    })
    await client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }))
  }

  // ── SSH workflow ────────────────────────────────────────────────────

  private async startSshWorkflow(runId: string): Promise<void> {
    const record = this.store.getRun(runId)
    if (!record || !record.instanceId) throw new Error(`Run ${runId} missing instanceId`)

    // Wait for the instance to reach 'running' + acquire a public DNS.
    const region = record.instanceSpec.region
    let publicDnsName: string | undefined
    for (let attempt = 0; attempt < SSH_CONNECT_MAX_ATTEMPTS; attempt++) {
      // Re-read so a stop() request mid-boot still wins the race.
      const r = this.store.getRun(runId)
      if (!r || isEc2Terminal(r.status)) return
      const info: { state?: string; publicDnsName?: string } = await this.describeInstance(record.instanceId, region).catch(() => ({}))
      if (info.state === 'running' && info.publicDnsName) {
        publicDnsName = info.publicDnsName
        this.store.updateRun(runId, { publicDnsName })
        break
      }
      if (info.state === 'terminated' || info.state === 'shutting-down') {
        throw new Error(`Instance reached ${info.state} before SSH could connect`)
      }
      await new Promise((res) => setTimeout(res, SSH_CONNECT_RETRY_INTERVAL_MS))
    }
    if (!publicDnsName) throw new Error('Instance did not become reachable within SSH window')

    this.appendLog(record.outputPath, `[ec2] Instance reachable at ${publicDnsName}; connecting via SSH...\n`)

    // Establish SSH (with handshake retry), upload script, exec.
    const { Client } = await import('ssh2')
    const out = fs.createWriteStream(record.outputPath, { flags: 'a' })
    // Expand `~` in user-supplied paths via shared util — Node fs/path
    // don't do this themselves, so `privateKeyPath: "~/.ssh/key.pem"`
    // would otherwise ENOENT.
    const privateKey = fs.readFileSync(expandHome(record.instanceSpec.privateKeyPath))
    const remoteScriptPath = `/tmp/research-copilot-${runId}.sh`
    const localScriptPath = resolveUserPath(this.workspacePath, record.scriptPath)

    // SSH handshake retry loop. AWS state=running guarantees kernel +
    // network but NOT sshd-accepting-connections; on Ubuntu 24.04 sshd
    // typically binds ~30 s after state=running. Without this loop the
    // first connect raced sshd's boot and lost with ECONNREFUSED.
    //
    // We use a fresh ssh2 Client per attempt because ssh2's Client is
    // single-shot — once it surfaces an error event it cannot be
    // reused. Auth-class errors (not in isRetryableSshHandshakeError)
    // skip the retry and propagate, so a wrong private key fails fast
    // instead of looping for 3 minutes.
    let sshClient: import('ssh2').Client | null = null
    let lastError: unknown = null
    for (let attempt = 0; attempt < SSH_HANDSHAKE_MAX_ATTEMPTS; attempt++) {
      // Honor mid-retry stop() — user cancellation should not be ignored.
      const r = this.store.getRun(runId)
      if (!r || isEc2Terminal(r.status)) {
        try { out.end() } catch { /* ignore */ }
        return
      }
      const candidate = new Client()
      try {
        await new Promise<void>((resolve, reject) => {
          candidate.on('ready', resolve)
          candidate.on('error', reject)
          // ssh2's HostKey verification is off by default; we accept the
          // remote key on first connection. The instance is one we just
          // launched into our own account, so the trust boundary is the
          // AWS API call that returned the public DNS — not the SSH
          // host-key fingerprint, which the user couldn't pre-pin anyway.
          candidate.connect({
            host: publicDnsName,
            username: record.instanceSpec.sshUser,
            privateKey,
            readyTimeout: 20_000,
            keepaliveInterval: 30_000,
          })
        })
        sshClient = candidate
        break
      } catch (err) {
        lastError = err
        try { candidate.end() } catch { /* ignore */ }
        if (!isRetryableSshHandshakeError(err)) {
          // Auth failure / host-key mismatch / other non-network error.
          // Propagate immediately so the caller (terminateAndMark) gets
          // an actionable message instead of waiting 3 minutes for a
          // problem retrying won't fix.
          try { out.end() } catch { /* ignore */ }
          throw err
        }
        const message = err instanceof Error ? err.message : String(err)
        this.appendLog(
          record.outputPath,
          `[ec2] SSH handshake attempt ${attempt + 1}/${SSH_HANDSHAKE_MAX_ATTEMPTS} got "${message}"; sshd may still be booting — retrying in ${SSH_HANDSHAKE_RETRY_INTERVAL_MS / 1000}s\n`,
        )
        await new Promise((res) => setTimeout(res, SSH_HANDSHAKE_RETRY_INTERVAL_MS))
      }
    }
    if (!sshClient) {
      try { out.end() } catch { /* ignore */ }
      throw new Error(
        `SSH did not become reachable after ${SSH_HANDSHAKE_MAX_ATTEMPTS} attempts ` +
          `(~${Math.round(SSH_HANDSHAKE_MAX_ATTEMPTS * SSH_HANDSHAKE_RETRY_INTERVAL_MS / 60_000)} min). ` +
          `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      )
    }

    // Register only AFTER successful handshake — premature registration
    // during the retry loop would let stop() try to .end() a still-
    // connecting client.
    this.streams.set(runId, { client: sshClient, outputStream: out })

    // SFTP-upload the script.
    await new Promise<void>((resolve, reject) => {
      ;(sshClient as any).sftp((err: Error | undefined, sftp: any) => {
        if (err || !sftp) return reject(err ?? new Error('sftp() returned undefined'))
        sftp.fastPut(localScriptPath, remoteScriptPath, (uploadErr: Error | undefined) => {
          if (uploadErr) reject(uploadErr); else resolve()
        })
      })
    })

    // Mark running and execute the script.
    this.store.updateRun(runId, {
      status: 'running',
      sshConnectedAt: new Date().toISOString(),
    })
    this.emitRunUpdate(runId)

    const command = record.instanceSpec.remoteCommand ?? `bash ${remoteScriptPath}`
    this.appendLog(record.outputPath, `[ec2] Exec: ${command}\n`)

    ;(sshClient as any).exec(command, (err: Error | undefined, stream: any) => {
      if (err) {
        this.terminateAndMark(runId, 'failed', `SSH exec failed: ${err.message}`).catch(() => {})
        return
      }
      stream.on('data', (chunk: Buffer) => out.write(chunk))
      stream.stderr?.on('data', (chunk: Buffer) => out.write(chunk))
      stream.on('close', (code: number | null) => {
        const exitCode = typeof code === 'number' ? code : 1
        out.end()
        try { (sshClient as any).end() } catch { /* ignore */ }
        this.streams.delete(runId)
        const targetState: AwsEc2RunState = exitCode === 0 ? 'completed' : 'failed'
        this.terminateAndMark(runId, targetState, exitCode === 0 ? undefined : `Remote exit code ${exitCode}`, exitCode).catch(() => {})
      })
      stream.on('error', (streamErr: Error) => {
        out.end()
        try { (sshClient as any).end() } catch { /* ignore */ }
        this.streams.delete(runId)
        this.terminateAndMark(runId, 'failed', streamErr.message).catch(() => {})
      })
    })
  }

  /**
   * Terminal-state transition: call TerminateInstances and update the
   * ledger. Safe to call multiple times — re-entry on an already-
   * terminal run is a no-op. Always flushes the ledger.
   */
  private async terminateAndMark(
    runId: string,
    targetState: AwsEc2RunState,
    error?: string,
    exitCode?: number,
  ): Promise<void> {
    const record = this.store.getRun(runId)
    if (!record || isEc2Terminal(record.status)) return

    // Clean up any in-flight SSH session.
    const active = this.streams.get(runId)
    if (active) {
      try { active.outputStream.end() } catch { /* ignore */ }
      try { (active.client as any).end() } catch { /* ignore */ }
      this.streams.delete(runId)
    }

    // Best-effort terminate. The ledger reflects the attempt even when
    // the AWS call fails — a stuck instance is preferable to a stuck
    // ledger row, since the next hydrate() will retry.
    const completedAt = new Date().toISOString()
    let terminationError: string | undefined
    if (record.instanceId) {
      this.store.updateRun(runId, { terminating: true })
      try {
        await this.terminateInstance(record.instanceId, record.instanceSpec.region)
      } catch (err) {
        terminationError = err instanceof Error ? err.message : String(err)
        this.appendLog(record.outputPath, `[ec2] WARNING: terminate failed: ${terminationError}\n`)
      }
    }

    const finalCost = record.startedAt
      ? computeEc2ElapsedCost(record.startedAt, record.costEstimate.hourlyRateUsd)
      : record.estimatedCostSoFar

    this.store.updateRun(runId, {
      status: targetState,
      completedAt,
      exitCode,
      error: error ?? terminationError,
      stalled: false,
      estimatedCostSoFar: finalCost,
      terminating: false,
    })
    this.emitRunUpdate(runId)
    this.stopPollingIfIdle()
  }

  // ── Status / wait / stop ────────────────────────────────────────────

  getStatus(runId: string): AwsEc2RunStatusResult | undefined {
    const run = this.store.getRun(runId)
    if (!run) return undefined
    const outputTail = readFileTail(run.outputPath, OUTPUT_TAIL_BYTES)
    const structured = extractProgress(outputTail)
    const elapsed = run.startedAt ? (Date.now() - new Date(run.startedAt).getTime()) / 1000 : 0
    const estimatedCostUsd = run.startedAt
      ? computeEc2ElapsedCost(run.startedAt, run.costEstimate.hourlyRateUsd)
      : run.estimatedCostSoFar
    return {
      status: run.status,
      planId: run.planId,
      taskDescription: run.taskDescription,
      command: run.command,
      scriptPath: run.scriptPath,
      instanceSpec: run.instanceSpec,
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
      sshConnectedAt: run.sshConnectedAt,
      elapsedSeconds: Math.round(elapsed),
      stalled: run.stalled,
      estimatedCostUsd,
      progress: structured,
      failure: isEc2Terminal(run.status) && run.status !== 'completed'
        ? {
            code: run.status === 'timed_out' ? 'TIMEOUT'
              : run.status === 'cost_killed' ? 'COMMAND_FAILED'
              : 'COMMAND_FAILED',
            retryable: run.status !== 'cancelled',
            message: run.error ?? `EC2 run ended with status ${run.status}.`,
            suggestions: classifyEc2FailureSuggestions(run.error),
          }
        : undefined,
      instanceId: run.instanceId,
      publicDnsName: run.publicDnsName,
    }
  }

  async waitForCompletion(runId: string, timeoutMs: number): Promise<AwsEc2RunStatusResult | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const status = this.getStatus(runId)
      if (!status) return undefined
      this.onRunUpdate(runId, status)
      if (isEc2Terminal(status.status) || status.stalled) return status
      await new Promise((res) => setTimeout(res, Math.min(5000, deadline - Date.now())))
    }
    const status = this.getStatus(runId)
    if (status) this.onRunUpdate(runId, status)
    return status
  }

  async stop(runId: string): Promise<void> {
    const record = this.store.getRun(runId)
    if (!record || isEc2Terminal(record.status)) return
    await this.terminateAndMark(runId, 'cancelled', 'Cancelled by user')
  }

  async destroy(): Promise<void> {
    // Best-effort cleanup of in-flight SSH sessions only — do NOT
    // terminate instances here. Destroy means "the coordinator is going
    // away"; instances should keep running and a subsequent hydrate()
    // will pick them back up.
    for (const [_id, active] of this.streams) {
      try { active.outputStream.end() } catch { /* ignore */ }
      try { (active.client as any).end() } catch { /* ignore */ }
    }
    this.streams.clear()
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.store.flushNow()
    this.store.stopFlushTimer()
  }

  // ── Polling: cost-kill, timeout, stall ──────────────────────────────

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
    if (!run || isEc2Terminal(run.status)) return
    const now = new Date().toISOString()
    const currentBytes = getFileSize(run.outputPath)
    const tail = readFileTail(run.outputPath, OUTPUT_TAIL_BYTES)
    const outputGrew = currentBytes > run.outputBytes
    const patch: Partial<AwsEc2RunRecord> = {
      outputBytes: currentBytes,
      outputLines: estimateLines(currentBytes, tail),
    }
    if (outputGrew) {
      patch.lastOutputAt = now
      if (run.stalled) patch.stalled = false
    }
    if (!outputGrew && run.lastOutputAt && run.status === 'running') {
      const silentMs = Date.now() - new Date(run.lastOutputAt).getTime()
      if (silentMs > run.stallThresholdMs && !run.stalled) {
        patch.stalled = true
      }
    }
    if (run.startedAt) {
      const elapsedCost = computeEc2ElapsedCost(run.startedAt, run.costEstimate.hourlyRateUsd)
      patch.estimatedCostSoFar = elapsedCost
      const threshold = this.getCostThreshold()
      if (elapsedCost > threshold) {
        this.store.updateRun(runId, patch)
        void this.terminateAndMark(runId, 'cost_killed', `Estimated cost $${elapsedCost.toFixed(4)} exceeded threshold $${threshold.toFixed(2)}.`)
          .then(() => this.onCostKilled(runId, elapsedCost))
        return
      }
      const elapsedMs = Date.now() - new Date(run.startedAt).getTime()
      if (elapsedMs > run.timeoutMs) {
        this.store.updateRun(runId, patch)
        void this.terminateAndMark(runId, 'timed_out', `Elapsed ${(elapsedMs / 60_000).toFixed(1)} min exceeded timeout.`)
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
