/**
 * Local Compute Tools — 5 AgentTools.
 *
 * v1.0: local_compute_execute, wait, status, stop
 * v1.2: local_compute_plan (LLM-enhanced profiling + risk assessment)
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult, toolError } from '../tools/tool-utils.js'
import type { ResearchToolContext } from '../tools/types.js'
import { ComputeRunner, type SubmitConfig } from './runner.js'
import { profileTask } from './task-profiler.js'
import { probeStaticProfile } from './environment-model.js'
import { assessRisk } from './strategy.js'
import { inferTaskKind } from './experience.js'

/**
 * Create all local compute tools. Returns tools + a destroy function for cleanup.
 */
export function createLocalComputeTools(ctx: ResearchToolContext): {
  tools: AgentTool[]
  destroy: () => Promise<void>
} {
  const runner = new ComputeRunner({
    projectPath: ctx.projectPath,
    workspacePath: ctx.workspacePath,
  })

  const tools: AgentTool[] = [
    createPlanTool(runner, ctx),
    createExecuteTool(runner, ctx),
    createWaitTool(runner),
    createStatusTool(runner),
    createStopTool(runner),
  ]

  return {
    tools,
    destroy: () => runner.destroy(),
  }
}

// ---------------------------------------------------------------------------
// local_compute_plan (v1.2 — LLM-enhanced, optional)
// ---------------------------------------------------------------------------

function createPlanTool(runner: ComputeRunner, ctx: ResearchToolContext): AgentTool {
  return {
    name: 'local_compute_plan',
    label: 'Local Compute: Plan',
    description:
      'Analyze a script before execution: profile the task, assess risks, and get recommendations.\n' +
      'Optional — you can skip this and call local_compute_execute directly for simple tasks.\n' +
      'Use this for complex or risky tasks (large datasets, GPU training, unfamiliar code).',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute' }),
      script_path: Type.Optional(Type.String({ description: 'Relative path to the main script (for deeper analysis)' })),
      sandbox: Type.Optional(Type.String({ description: '"docker" | "process" | "auto"' })),
      timeout_minutes: Type.Optional(Type.Number({ description: 'Suggested timeout' })),
      smoke_command: Type.Optional(Type.String({ description: 'Quick validation command (e.g., "python3 script.py --smoke")' })),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const command = typeof params.command === 'string' ? params.command.trim() : ''

      if (!command) {
        return toAgentResult('local_compute_plan', toolError('MISSING_PARAMETER', 'command is required.'))
      }

      // Read script content if path provided
      let scriptContent: string | undefined
      if (typeof params.script_path === 'string') {
        const scriptPath = path.isAbsolute(params.script_path)
          ? params.script_path
          : path.resolve(ctx.workspacePath, params.script_path)
        try {
          scriptContent = fs.readFileSync(scriptPath, 'utf-8')
        } catch { /* script not readable, proceed without */ }
      }

      // Task profiling (LLM if available, else defaults)
      const taskProfile = await profileTask(command, scriptContent, ctx.callLlm)

      // Environment probe
      let env
      try {
        env = await probeStaticProfile()
      } catch {
        return toAgentResult('local_compute_plan', toolError('EXECUTION_FAILED', 'Failed to probe system environment.'))
      }

      // Get pre-run snapshot
      let freeDiskMb = 10_000
      try {
        const dfOut = execSync('df -m .', { cwd: ctx.workspacePath, encoding: 'utf-8', timeout: 3000 })
        const parts = dfOut.trim().split('\n')[1]?.split(/\s+/)
        const avail = parseInt(parts?.[3] ?? '', 10)
        if (!isNaN(avail)) freeDiskMb = avail
      } catch { /* use default */ }
      const snapshot = {
        freeMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
        cpuLoadPercent: Math.round((os.loadavg()[0] / os.cpus().length) * 100),
        freeDiskMb,
        activeRuns: runner.getStore().getActiveRuns().map(r => ({ runId: r.runId, weight: r.weight })),
      }

      // Experience lookup
      const taskKind = inferTaskKind(command, scriptContent)
      const experience = runner.getExperience().summarize(taskKind)

      // Risk assessment (LLM if available, else defaults)
      const riskAdvice = await assessRisk({
        taskProfile,
        env,
        snapshot,
        experience,
        command,
        callLlm: ctx.callLlm,
      })

      return toAgentResult('local_compute_plan', {
        success: true,
        data: {
          task_profile: taskProfile,
          risk_assessment: {
            feasible: riskAdvice.feasible,
            risks: riskAdvice.risks,
            warnings: riskAdvice.warnings,
          },
          recommendations: {
            sandbox: riskAdvice.recommendedSandbox,
            timeout_minutes: riskAdvice.recommendedTimeoutMinutes,
            stall_threshold_minutes: riskAdvice.recommendedStallThresholdMinutes,
            agent_guidance: riskAdvice.agentGuidance,
          },
          experience_summary: experience ? {
            task_kind: experience.taskKind,
            total_runs: experience.totalRuns,
            successes: experience.successes,
            failures: experience.failures,
            avg_duration_seconds: experience.avgDurationSeconds,
            common_failures: experience.commonFailures,
          } : null,
        },
      })
    },
  }
}

// ---------------------------------------------------------------------------
// local_compute_execute
// ---------------------------------------------------------------------------

function createExecuteTool(runner: ComputeRunner, ctx: ResearchToolContext): AgentTool {
  return {
    name: 'local_compute_execute',
    label: 'Local Compute: Execute',
    description:
      'Execute a command in a sandboxed local environment. Use this for long-running tasks ' +
      'like ML training, data preprocessing, or heavy analysis that may take minutes to hours.\n' +
      'The command runs asynchronously. Use local_compute_wait or local_compute_status to monitor.\n' +
      'For long-running scripts, consider adding a --smoke flag for quick validation.\n\n' +
      'Progress monitoring: print lines starting with ##PROGRESS## followed by JSON for structured progress:\n' +
      '  ##PROGRESS## {"step": 3, "total": 10, "loss": 0.85, "phase": "training"}',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute (e.g., "python3 train.py")' }),
      work_dir: Type.Optional(Type.String({ description: 'Relative path within workspace (default: workspace root)' })),
      sandbox: Type.Optional(Type.String({ description: '"docker" | "process" | "auto" (default: auto)' })),
      timeout_minutes: Type.Optional(Type.Number({ description: 'Max runtime in minutes (default: 60, max: 1440)' })),
      stall_threshold_minutes: Type.Optional(Type.Number({ description: 'Minutes without output before flagging stall (default: 5)' })),
      env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Extra environment variables' })),
      smoke_command: Type.Optional(Type.String({ description: 'Quick validation command (e.g., "python3 train.py --smoke"). Runs before full command.' })),
      parent_run_id: Type.Optional(Type.String({ description: 'Previous failed run ID (for retry lineage tracking)' })),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const command = typeof params.command === 'string' ? params.command.trim() : ''

      if (!command) {
        return toAgentResult('local_compute_execute', toolError('MISSING_PARAMETER', 'command is required.', {
          suggestions: ['Provide a shell command to execute (e.g., "python3 train.py").'],
        }))
      }

      const config: SubmitConfig = {
        command,
        workDir: typeof params.work_dir === 'string' ? params.work_dir : undefined,
        sandbox: typeof params.sandbox === 'string' ? params.sandbox as 'docker' | 'process' | 'auto' : 'auto',
        timeoutMinutes: typeof params.timeout_minutes === 'number' ? params.timeout_minutes : 60,
        stallThresholdMinutes: typeof params.stall_threshold_minutes === 'number' ? params.stall_threshold_minutes : 5,
        env: typeof params.env === 'object' && params.env !== null ? params.env as Record<string, string> : undefined,
        smokeCommand: typeof params.smoke_command === 'string' ? params.smoke_command : undefined,
        parentRunId: typeof params.parent_run_id === 'string' ? params.parent_run_id : undefined,
      }

      try {
        const run = await runner.submit(config)
        ctx.onToolCall?.('local_compute_execute', { command, runId: run.runId })

        return toAgentResult('local_compute_execute', {
          success: true,
          data: {
            run_id: run.runId,
            sandbox: run.sandbox,
            status: run.status,
            current_phase: run.currentPhase,
            output_path: run.outputPath,
            weight: run.weight,
          },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Scheduler rejection
        if (msg.startsWith('Scheduler:')) {
          return toAgentResult('local_compute_execute', toolError('EXECUTION_FAILED', msg, {
            retryable: true,
            suggestions: ['Wait for the active run to finish, or stop it with local_compute_stop.'],
          }))
        }
        return toAgentResult('local_compute_execute', toolError('EXECUTION_FAILED', msg, {
          retryable: false,
          suggestions: ['Check the command and try again.'],
        }))
      }
    },
  }
}

// ---------------------------------------------------------------------------
// local_compute_wait
// ---------------------------------------------------------------------------

function createWaitTool(runner: ComputeRunner): AgentTool {
  return {
    name: 'local_compute_wait',
    label: 'Local Compute: Wait',
    description:
      'Wait for a compute run to complete. Blocks until the run finishes, stalls, or the wait timeout elapses.\n' +
      'Returns immediately if the run has already completed or stalled.',
    parameters: Type.Object({
      run_id: Type.String({ description: 'The run ID returned by local_compute_execute' }),
      timeout_seconds: Type.Optional(Type.Number({ description: 'Max seconds to wait (default: 120, max: 600)' })),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const runId = typeof params.run_id === 'string' ? params.run_id.trim() : ''

      if (!runId) {
        return toAgentResult('local_compute_wait', toolError('MISSING_PARAMETER', 'run_id is required.'))
      }

      const timeoutSec = typeof params.timeout_seconds === 'number'
        ? Math.min(params.timeout_seconds, 600)
        : 120

      const result = await runner.waitForCompletion(runId, timeoutSec * 1000)

      if (!result) {
        return toAgentResult('local_compute_wait', toolError('NOT_FOUND', `Run not found: ${runId}`, {
          suggestions: ['Check the run_id. Use local_compute_execute to start a new run.'],
        }))
      }

      return toAgentResult('local_compute_wait', {
        success: true,
        data: formatStatusResult(runId, result),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// local_compute_status
// ---------------------------------------------------------------------------

function createStatusTool(runner: ComputeRunner): AgentTool {
  return {
    name: 'local_compute_status',
    label: 'Local Compute: Status',
    description:
      'Check the current status of a compute run. Non-blocking — returns immediately.\n' +
      'Includes output tail, progress, stall detection, and failure analysis.',
    parameters: Type.Object({
      run_id: Type.String({ description: 'The run ID to check' }),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const runId = typeof params.run_id === 'string' ? params.run_id.trim() : ''

      if (!runId) {
        return toAgentResult('local_compute_status', toolError('MISSING_PARAMETER', 'run_id is required.'))
      }

      const result = runner.getStatus(runId)

      if (!result) {
        return toAgentResult('local_compute_status', toolError('NOT_FOUND', `Run not found: ${runId}`))
      }

      return toAgentResult('local_compute_status', {
        success: true,
        data: formatStatusResult(runId, result),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// local_compute_stop
// ---------------------------------------------------------------------------

function createStopTool(runner: ComputeRunner): AgentTool {
  return {
    name: 'local_compute_stop',
    label: 'Local Compute: Stop',
    description: 'Stop (cancel) a running compute task. The process is killed.',
    parameters: Type.Object({
      run_id: Type.String({ description: 'The run ID to stop' }),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const runId = typeof params.run_id === 'string' ? params.run_id.trim() : ''

      if (!runId) {
        return toAgentResult('local_compute_stop', toolError('MISSING_PARAMETER', 'run_id is required.'))
      }

      try {
        await runner.stop(runId)
        return toAgentResult('local_compute_stop', {
          success: true,
          data: { run_id: runId, status: 'cancelled' },
        })
      } catch (err) {
        return toAgentResult('local_compute_stop', toolError('EXECUTION_FAILED',
          err instanceof Error ? err.message : String(err)))
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

function formatStatusResult(runId: string, result: import('./types.js').RunStatusResult): Record<string, unknown> {
  const data: Record<string, unknown> = {
    run_id: runId,
    status: result.status,
    current_phase: result.currentPhase,
    elapsed_seconds: result.elapsedSeconds,
    output_bytes: result.outputBytes,
    output_lines: result.outputLines,
    stalled: result.stalled,
  }

  if (result.exitCode !== undefined) data.exit_code = result.exitCode
  if (result.outputTail) data.output_tail = result.outputTail
  if (result.progress) data.progress = result.progress
  if (result.failure) data.failure = result.failure

  return data
}
