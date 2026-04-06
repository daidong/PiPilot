/**
 * Compute Runner — main orchestrator for local compute runs.
 *
 * Pipeline: scheduler → preflight → smoke? → full → finalize (+ experience save)
 *
 * Key patterns (from Claude Code):
 * - Single shared setInterval for all active runs (5s poll)
 * - File-based output tracking (stat + tail read)
 * - Stall detection via output-growth monitoring
 * - Atomic state updates in RunStore
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import { RunStore } from './run-store.js'
import { getProvider } from './sandbox/detect.js'
import { deriveFailure } from './failure-signals.js'
import { extractProgress } from './progress.js'
import { classifyWeight, canAdmit } from './scheduler.js'
import { runPreflight, type PreflightResult } from './preflight.js'
import { ExperienceStore, inferTaskKind } from './experience.js'
import {
  type RunRecord,
  type RunState,
  type RunWeight,
  type SandboxHandle,
  type RunStatusResult,
  type PreRunSnapshot,
  type StructuredProgress,
  isTerminal,
} from './types.js'

const POLL_INTERVAL_MS = 5_000
const OUTPUT_TAIL_BYTES = 8_192
const STDERR_TAIL_BYTES = 4_096
const DEFAULT_TIMEOUT_MS = 60 * 60_000       // 60 min
const DEFAULT_STALL_THRESHOLD_MS = 5 * 60_000 // 5 min
const MAX_TIMEOUT_MS = 24 * 60 * 60_000      // 24 hours
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024  // 1 GB output cap
const DESTROY_KILL_TIMEOUT_MS = 5_000        // 5s grace before SIGKILL on destroy

// ---------------------------------------------------------------------------
// ID Generation
// ---------------------------------------------------------------------------

function nextRunId(): string {
  return 'cr-' + crypto.randomBytes(4).toString('hex')
}

// ---------------------------------------------------------------------------
// PID utilities — for crash recovery stale-run detection
// ---------------------------------------------------------------------------

/**
 * Get a process's start time (epoch ms) from the OS.
 * PID + starttime together uniquely identify a process — prevents PID reuse confusion.
 */
function getPidStartTime(pid: number): number | undefined {
  try {
    if (process.platform === 'darwin') {
      // macOS: ps -p <pid> -o lstart= returns "Thu Jan  2 15:04:05 2025"
      const raw = execSync(`ps -p ${pid} -o lstart=`, { encoding: 'utf-8', timeout: 3000 }).trim()
      if (!raw) return undefined
      return new Date(raw).getTime()
    } else {
      // Linux: /proc/<pid>/stat field 22 is starttime in clock ticks since boot
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const fields = stat.split(' ')
      const startTicks = parseInt(fields[21], 10)
      if (isNaN(startTicks)) return undefined
      // Convert to epoch ms: boot time + ticks / Hz
      const uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf-8').split(' ')[0])
      const hz = 100 // sysconf(_SC_CLK_TCK), typically 100 on Linux
      const bootTime = Date.now() - uptime * 1000
      return Math.round(bootTime + (startTicks / hz) * 1000)
    }
  } catch {
    return undefined
  }
}

/**
 * Check if a PID is alive (process exists, regardless of who owns it).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Determine if a non-terminal run record is stale (its process is gone or PID was reused).
 */
function isStaleRun(record: RunRecord): boolean {
  if (!record.pid) return true // No PID recorded — definitely stale
  if (!isPidAlive(record.pid)) return true // PID doesn't exist — dead
  // PID exists — check if it's the SAME process (prevent PID reuse confusion)
  if (record.pidStartTime) {
    const currentStartTime = getPidStartTime(record.pid)
    if (currentStartTime === undefined) return true // Can't verify — assume stale
    // Allow 2s tolerance for clock granularity
    if (Math.abs(currentStartTime - record.pidStartTime) > 2000) return true // Different process
  }
  return false // PID alive + starttime matches → process is genuinely running
}

// ---------------------------------------------------------------------------
// System Snapshot
// ---------------------------------------------------------------------------

function takeSnapshot(store: RunStore): PreRunSnapshot {
  const activeRuns = store.getActiveRuns().map(r => ({
    runId: r.runId,
    weight: r.weight,
  }))

  let freeDiskMb = 10_000 // Default high if detection fails
  try {
    const dfOutput = execSync('df -m .', { encoding: 'utf-8', timeout: 3000 })
    const lines = dfOutput.trim().split('\n')
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/)
      const available = parseInt(parts[3], 10)
      if (!isNaN(available)) freeDiskMb = available
    }
  } catch { /* use default */ }

  return {
    freeMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
    cpuLoadPercent: Math.round((os.loadavg()[0] / os.cpus().length) * 100),
    freeDiskMb,
    activeRuns,
  }
}

// ---------------------------------------------------------------------------
// Tail reading utility
// ---------------------------------------------------------------------------

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
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function estimateLines(bytes: number, tail: string): number {
  if (bytes === 0 || tail.length === 0) return 0
  const tailLines = tail.split('\n').length
  if (tail.length >= bytes) return tailLines
  return Math.max(tailLines, Math.round((bytes / tail.length) * tailLines))
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface SubmitConfig {
  command: string
  workDir?: string          // Relative to workspace root
  sandbox?: 'docker' | 'process' | 'auto'
  timeoutMinutes?: number
  stallThresholdMinutes?: number
  env?: Record<string, string>
  smokeCommand?: string
  parentRunId?: string
}

export class ComputeRunner {
  private readonly store: RunStore
  private readonly experience: ExperienceStore
  private readonly workspacePath: string
  private readonly projectPath: string
  private readonly handles = new Map<string, SandboxHandle>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private readonly pollInFlight = new Set<string>()

  constructor(opts: { projectPath: string; workspacePath: string }) {
    this.store = new RunStore(opts.projectPath)
    this.experience = new ExperienceStore(opts.projectPath)
    this.workspacePath = opts.workspacePath
    this.projectPath = opts.projectPath

    // Reconcile stale runs from a previous session (crash recovery)
    this.reconcileStaleRuns()

    // Resume polling for any genuinely active runs
    const active = this.store.getActiveRuns()
    if (active.length > 0) this.ensurePolling()

    // Evict old records on startup
    this.store.evictOld()
  }

  /**
   * On startup, detect and transition stale 'running'/'stalled' records whose
   * processes are gone (crashed app, killed process, PID reused).
   */
  private reconcileStaleRuns(): void {
    const active = this.store.getActiveRuns()
    for (const run of active) {
      if (isStaleRun(run)) {
        this.store.updateRun(run.runId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: 'Process no longer running (app crashed or process was killed).',
          stalled: false,
        })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  async submit(config: SubmitConfig): Promise<RunRecord & { preflight?: PreflightResult }> {
    const timeoutMs = Math.min(
      (config.timeoutMinutes ?? 60) * 60_000,
      MAX_TIMEOUT_MS,
    )
    const stallThresholdMs = (config.stallThresholdMinutes ?? 5) * 60_000
    const weight = classifyWeight((config.timeoutMinutes ?? 60), config.command)

    // Scheduler check
    const snapshot = takeSnapshot(this.store)
    const decision = canAdmit(snapshot, weight)
    if (!decision.allowed) {
      throw new Error(`Scheduler: ${decision.reason}`)
    }

    // Preflight checks
    const workDir = config.workDir
      ? path.resolve(this.workspacePath, config.workDir)
      : this.workspacePath

    const preflight = await runPreflight({
      command: config.command,
      workDir,
    })

    if (!preflight.passed) {
      throw new Error(`Preflight failed: ${preflight.blockingIssues.join('; ')}`)
    }

    // Resolve sandbox provider
    const provider = await getProvider(config.sandbox)
    const runId = nextRunId()
    const runDir = this.store.getRunDir(runId)
    const outputPath = this.store.getOutputPath(runId)

    // Create run record
    const now = new Date().toISOString()
    const record: RunRecord = {
      runId,
      status: 'running',
      weight,
      currentPhase: config.smokeCommand ? 'smoke' : 'full',
      command: config.command,
      smokeCommand: config.smokeCommand,
      workDir: config.workDir ?? '.',
      sandboxWorkDir: workDir,
      sandbox: provider.name,
      env: config.env,
      createdAt: now,
      startedAt: now,
      outputPath,
      outputBytes: 0,
      outputLines: 0,
      timeoutMs,
      stallThresholdMs,
      stalled: false,
      retryCount: config.parentRunId ? ((this.store.getRun(config.parentRunId)?.retryCount ?? 0) + 1) : 0,
      parentRunId: config.parentRunId,
    }

    this.store.createRun(record)

    // Spawn: smoke first if provided, otherwise full command
    const commandToRun = config.smokeCommand ?? config.command
    try {
      const handle = await provider.spawn({
        command: commandToRun,
        workDir,
        outputPath,
        env: config.env,
      })
      this.handles.set(runId, handle)
      this.ensurePolling()

      // Record PID + starttime for crash recovery
      const pid = typeof handle.pid === 'number' ? handle.pid : undefined
      const pidStartTime = pid ? getPidStartTime(pid) : undefined
      if (pid) {
        this.store.updateRun(runId, { pid, pidStartTime })
      }

      // Wait for completion asynchronously
      handle.wait().then(async (result) => {
        await this.handleExit(runId, result, config)
      }).catch(() => {
        // Spawn-level error already captured
      })
    } catch (err) {
      // Spawn failed
      this.store.updateRun(runId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    return Object.assign(record, { preflight })
  }

  // -------------------------------------------------------------------------
  // Exit handler
  // -------------------------------------------------------------------------

  private async handleExit(
    runId: string,
    result: { exitCode: number; exitSignal?: string },
    config: SubmitConfig,
  ): Promise<void> {
    const run = this.store.getRun(runId)
    if (!run || isTerminal(run.status)) return

    // Read stderr tail for failure analysis
    const stderrPath = this.store.getStderrPath(runId)
    const stderrTail = readFileTail(stderrPath, STDERR_TAIL_BYTES)

    // If smoke phase succeeded and full command is different, run full
    if (run.currentPhase === 'smoke' && result.exitCode === 0 && config.smokeCommand && config.command !== config.smokeCommand) {
      // Transition to full phase
      this.store.updateRun(runId, {
        currentPhase: 'full',
        stderrTail,
      })

      // Re-spawn with full command
      const provider = await getProvider(run.sandbox)
      try {
        const handle = await provider.spawn({
          command: config.command,
          workDir: run.sandboxWorkDir,
          outputPath: run.outputPath,
          env: config.env,
        })
        this.handles.set(runId, handle)
        handle.wait().then(async (fullResult) => {
          await this.handleExit(runId, fullResult, { ...config, smokeCommand: undefined })
        }).catch(() => {})
        return
      } catch (err) {
        this.store.updateRun(runId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
    }

    // Determine final status
    const status: RunState = result.exitCode === 0 ? 'completed' : 'failed'
    const completedAt = new Date().toISOString()
    const updated = this.store.updateRun(runId, {
      status,
      exitCode: result.exitCode,
      exitSignal: result.exitSignal,
      completedAt,
      stderrTail,
      stalled: false, // Clear stall flag on terminal transition
    })

    // Record experience
    if (updated) {
      try {
        const durationSeconds = updated.startedAt
          ? Math.round((Date.now() - new Date(updated.startedAt).getTime()) / 1000)
          : 0
        const taskKind = inferTaskKind(updated.command)
        const failure = status !== 'completed' ? deriveFailure(updated) : undefined
        this.experience.record({
          runId,
          taskKind,
          sandbox: updated.sandbox,
          outcome: status === 'completed' ? 'success' : 'failed',
          failureCode: failure?.code,
          durationSeconds,
          retryCount: updated.retryCount,
          timestamp: completedAt,
        })
      } catch { /* non-fatal: experience recording should never break the pipeline */ }
    }

    // Cleanup sandbox handle
    const handle = this.handles.get(runId)
    if (handle) {
      await handle.cleanup().catch(() => {})
      this.handles.delete(runId)
    }

    this.stopPollingIfIdle()
  }

  // -------------------------------------------------------------------------
  // Stop (cancel)
  // -------------------------------------------------------------------------

  async stop(runId: string): Promise<void> {
    const run = this.store.getRun(runId)
    if (!run || isTerminal(run.status)) return

    const handle = this.handles.get(runId)
    if (handle) {
      await handle.kill('SIGTERM')
      // Give process 3s to exit gracefully, then SIGKILL
      setTimeout(async () => {
        await handle.kill('SIGKILL').catch(() => {})
      }, 3000)
    }

    const stderrPath = this.store.getStderrPath(runId)
    const stderrTail = readFileTail(stderrPath, STDERR_TAIL_BYTES)
    this.store.updateRun(runId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      stderrTail,
    })
    this.handles.delete(runId)
    this.stopPollingIfIdle()
  }

  // -------------------------------------------------------------------------
  // Status queries
  // -------------------------------------------------------------------------

  getStatus(runId: string): RunStatusResult | undefined {
    const run = this.store.getRun(runId)
    if (!run) return undefined

    const outputTail = readFileTail(run.outputPath, OUTPUT_TAIL_BYTES)
    const structured = extractProgress(outputTail)
    const elapsed = run.startedAt
      ? (Date.now() - new Date(run.startedAt).getTime()) / 1000
      : 0
    const failure = isTerminal(run.status) ? deriveFailure(run) : undefined

    return {
      status: run.status,
      currentPhase: run.currentPhase,
      exitCode: run.exitCode,
      outputTail,
      outputBytes: run.outputBytes,
      outputLines: run.outputLines,
      elapsedSeconds: Math.round(elapsed),
      stalled: run.stalled,
      progress: structured,
      failure,
    }
  }

  /**
   * Block until the run reaches a terminal state, stalls, or timeout.
   */
  async waitForCompletion(runId: string, timeoutMs: number): Promise<RunStatusResult | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const status = this.getStatus(runId)
      if (!status) return undefined
      if (isTerminal(status.status)) return status
      if (status.stalled) return status // Return immediately on stall
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, deadline - Date.now())))
    }
    return this.getStatus(runId)
  }

  // -------------------------------------------------------------------------
  // Polling — shared interval for all active runs
  // -------------------------------------------------------------------------

  private ensurePolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      this.pollAll()
    }, POLL_INTERVAL_MS)
    // Don't keep process alive just for polling
    if (this.pollTimer.unref) this.pollTimer.unref()
  }

  private stopPollingIfIdle(): void {
    const active = this.store.getActiveRuns()
    if (active.length === 0 && this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private pollAll(): void {
    const active = this.store.getActiveRuns()
    for (const record of active) {
      if (this.pollInFlight.has(record.runId)) continue
      this.pollInFlight.add(record.runId)
      try {
        this.pollOnce(record.runId)
      } finally {
        this.pollInFlight.delete(record.runId)
      }
    }
    this.stopPollingIfIdle()
  }

  private pollOnce(runId: string): void {
    // Fresh read from store to avoid stale data after handleExit
    const run = this.store.getRun(runId)
    if (!run || isTerminal(run.status)) return

    const now = new Date().toISOString()
    const currentBytes = getFileSize(run.outputPath)
    const outputGrew = currentBytes > run.outputBytes

    // Update output tracking
    const tail = readFileTail(run.outputPath, OUTPUT_TAIL_BYTES)
    const lines = estimateLines(currentBytes, tail)

    const patch: Partial<RunRecord> = {
      outputBytes: currentBytes,
      outputLines: lines,
    }

    if (outputGrew) {
      patch.lastOutputAt = now
      if (run.stalled) {
        // Output resumed — clear stall flag
        patch.stalled = false
        patch.status = 'running'
      }
    }

    // Stall detection
    if (!outputGrew && run.lastOutputAt) {
      const silentMs = Date.now() - new Date(run.lastOutputAt).getTime()
      if (silentMs > run.stallThresholdMs && !run.stalled) {
        patch.stalled = true
        patch.status = 'stalled'
      }
    }

    // Output size cap — kill if output exceeds MAX_OUTPUT_BYTES
    if (currentBytes > MAX_OUTPUT_BYTES) {
      const handle = this.handles.get(run.runId)
      if (handle) {
        handle.kill('SIGTERM').catch(() => {})
        setTimeout(() => { handle.kill('SIGKILL').catch(() => {}) }, 3000)
        this.handles.delete(run.runId)
      }
      const stderrTail = readFileTail(this.store.getStderrPath(run.runId), STDERR_TAIL_BYTES)
      this.store.updateRun(run.runId, {
        ...patch,
        status: 'failed',
        completedAt: now,
        stalled: false,
        stderrTail,
        error: `Output exceeded ${Math.round(MAX_OUTPUT_BYTES / (1024 * 1024))}MB limit. Process killed.`,
      })
      return
    }

    // Timeout check
    if (run.startedAt) {
      const elapsedMs = Date.now() - new Date(run.startedAt).getTime()
      if (elapsedMs > run.timeoutMs) {
        const handle = this.handles.get(run.runId)
        if (handle) {
          handle.kill('SIGTERM').catch(() => {})
          // SIGKILL follow-up after 3s grace period
          setTimeout(() => {
            handle.kill('SIGKILL').catch(() => {})
          }, 3000)
          this.handles.delete(run.runId)
        }
        const stderrTail = readFileTail(this.store.getStderrPath(run.runId), STDERR_TAIL_BYTES)
        this.store.updateRun(run.runId, {
          ...patch,
          status: 'timed_out',
          completedAt: now,
          stalled: false, // Clear stall flag on terminal transition
          stderrTail,
        })
        return
      }
    }

    this.store.updateRun(run.runId, patch)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Stop all active runs and clean up. Called on coordinator destroy / app quit.
   * Sends SIGTERM, waits up to 5s, then SIGKILL any survivors.
   */
  async destroy(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    // Stop flush timer and write pending state
    this.store.stopFlushTimer()
    this.store.flushNow()

    if (this.handles.size === 0) return

    // Phase 1: SIGTERM all active processes
    const entries = [...this.handles.entries()]
    for (const [, handle] of entries) {
      await handle.kill('SIGTERM').catch(() => {})
    }

    // Phase 2: Wait up to DESTROY_KILL_TIMEOUT_MS for graceful exit, then SIGKILL
    const deadline = Date.now() + DESTROY_KILL_TIMEOUT_MS
    const pending = new Map(entries)
    while (pending.size > 0 && Date.now() < deadline) {
      for (const [runId, handle] of pending) {
        const record = this.store.getRun(runId)
        if (!record?.pid || !isPidAlive(record.pid)) {
          pending.delete(runId)
        }
      }
      if (pending.size > 0) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }

    // Phase 3: SIGKILL stragglers
    for (const [, handle] of pending) {
      await handle.kill('SIGKILL').catch(() => {})
    }

    // Phase 4: Update records and cleanup
    for (const [runId, handle] of entries) {
      await handle.cleanup().catch(() => {})
      this.store.updateRun(runId, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        stalled: false,
      })
    }
    this.handles.clear()
    this.store.flushNow()
  }

  /**
   * Get the RunStore for direct queries (used by tools).
   */
  getStore(): RunStore {
    return this.store
  }

  /**
   * Get the ExperienceStore for queries.
   */
  getExperience(): ExperienceStore {
    return this.experience
  }
}
