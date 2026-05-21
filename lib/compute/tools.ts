/**
 * Compute Tools — unified tool surface per RFC-008 §4.
 *
 *   compute_plan(backend, ...)           — generic planner
 *   list_compute_backends()              — introspection
 *   <toolPrefix>_execute(plan_id, ...)   — per-backend
 *   <toolPrefix>_wait(run_id, ...)       — per-backend
 *   <toolPrefix>_status(run_id)          — per-backend
 *   <toolPrefix>_stop(run_id)            — per-backend
 *
 * Replaces lib/local-compute/tools.ts, lib/modal-compute/tools.ts, and
 * lib/compute/plan-tool.ts (all from PR #62). Those files get deleted
 * in §7.10 once the new path is fully wired through IPC + renderer.
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult, toolError } from '../tools/tool-utils.js'
import { resolveUserPath } from '../utils/path-utils.js'
import type { ComputeRegistry } from './registry.js'
import type { ComputeBackend } from './backend.js'
import type { ComputeRun, RunStatus } from './types.js'
import { probeWithTimeout } from './probe.js'

interface ToolsOpts {
  registry: ComputeRegistry
  /** Workspace path for resolving relative script_path arguments. */
  workspacePath: string
}

/**
 * Build the compute tool set for the registered backends. Call once
 * per coordinator instance; returns a (possibly empty) AgentTool list.
 */
export function createComputeTools(opts: ToolsOpts): AgentTool[] {
  const tools: AgentTool[] = [
    createComputePlanTool(opts),
    createListBackendsTool(opts),
  ]
  for (const backend of opts.registry.list()) {
    tools.push(...createBackendTools(backend, opts))
  }
  return tools
}

// ─── compute_plan (generic) ──────────────────────────────────────────────

function createComputePlanTool(opts: ToolsOpts): AgentTool {
  const { registry, workspacePath } = opts
  return {
    name: 'compute_plan',
    label: 'Compute: Plan',
    description:
      'Analyze a compute task and produce an execution plan. ' +
      'Choose a backend by id (call list_compute_backends first if unsure). ' +
      'For backends that require approval, the plan is queued until the user ' +
      'approves in the Compute tab — then call <backend>_execute. ' +
      'Tip: the script can emit two cooperative protocol lines to make its ' +
      'output legible: `##PROGRESS## {json}` for live progress, and ' +
      '`##RESULT## {json}` for the final structured return value (the latter ' +
      'survives output truncation and is surfaced as `result` on status).',
    parameters: Type.Object({
      backend: Type.String({ description: 'Backend id: "local" | "modal" | "aws-ec2" | ...' }),
      command: Type.String({ description: 'Shell command to execute' }),
      task_description: Type.Optional(Type.String({ description: 'Concise description of the task, input, expected output.' })),
      script_path: Type.Optional(Type.String({ description: 'Relative path to the main script (for deeper analysis or required by some backends).' })),
      timeout_minutes: Type.Optional(Type.Number({ description: 'Suggested timeout in minutes.' })),
      backend_data: Type.Optional(Type.String({
        description:
          'JSON-encoded backend-specific plan input. ' +
          'aws-ec2 requires this: { "instanceSpec": { instanceType, region, amiId, keyName, privateKeyPath, sshUser, scriptPath, ... }, "taskProfile": { expectedDurationClass, ... } }. ' +
          'local and modal ignore this field (they auto-derive everything from script_path).',
      })),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const backendId = typeof params.backend === 'string' ? params.backend.trim() : ''
      const command = typeof params.command === 'string' ? params.command.trim() : ''
      if (!backendId) return toAgentResult('compute_plan', toolError('MISSING_PARAMETER', 'backend is required.'))
      if (!command) return toAgentResult('compute_plan', toolError('MISSING_PARAMETER', 'command is required.'))
      if (!registry.has(backendId)) {
        return toAgentResult('compute_plan', toolError(
          'NOT_FOUND',
          `Unknown compute backend '${backendId}'. Call list_compute_backends to see registered backends.`,
        ))
      }

      // resolveUserPath expands `~` BEFORE workspace-resolution so
      // `~/foo.sh` becomes `<home>/foo.sh` (absolute), not
      // `<workspace>/~/foo.sh` (broken).
      const scriptPath = typeof params.script_path === 'string' && params.script_path.trim()
        ? resolveUserPath(workspacePath, params.script_path)
        : undefined

      // Parse backend_data at the tool boundary so backends can read a
      // typed object via PlanInput.backendData. Malformed JSON is caught
      // here and reported with INVALID_PARAMETER — agents self-correct
      // on that code without retrying with the same broken payload.
      let backendData: unknown
      if (typeof params.backend_data === 'string' && params.backend_data.trim()) {
        try {
          backendData = JSON.parse(params.backend_data)
        } catch (err) {
          return toAgentResult('compute_plan', toolError(
            'INVALID_PARAMETER',
            `backend_data is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
            {
              suggestions: [
                'Ensure backend_data is a JSON string (object literal serialized).',
                'Check for unescaped quotes, trailing commas, or missing braces.',
              ],
            },
          ))
        }
      } else if (params.backend_data !== undefined && typeof params.backend_data !== 'string') {
        return toAgentResult('compute_plan', toolError(
          'INVALID_PARAMETER',
          `backend_data must be a JSON-encoded string, got ${typeof params.backend_data}.`,
        ))
      }

      try {
        const plan = await registry.plan(backendId, {
          command,
          taskDescription: typeof params.task_description === 'string' ? params.task_description.trim() || undefined : undefined,
          scriptPath,
          suggestedTimeoutMinutes: typeof params.timeout_minutes === 'number' ? params.timeout_minutes : undefined,
          backendData,
        })
        const record = registry.getPlanRecord(backendId, plan.planId)
        const backend = registry.get(backendId)!
        const toolPrefix = backend.identity.toolPrefix
        const requiresApproval = record?.effectiveRequiresApproval ?? backend.capabilities.requiresApproval
        return toAgentResult('compute_plan', {
          success: true,
          data: {
            backend: plan.backend,
            plan_id: plan.planId,
            task_profile: plan.taskProfile,
            cost_estimate: plan.costEstimate,
            backend_data: plan.backendData,
            backend_data_version: plan.backendDataVersion,
            requires_approval: requiresApproval,
            message: requiresApproval
              ? `Plan ready. Ask the user to approve in the Compute tab before calling ${toolPrefix}_execute.`
              : `Plan ready. Call ${toolPrefix}_execute (plan_id="${plan.planId}") to run.`,
          },
        })
      } catch (err) {
        return toAgentResult('compute_plan', toolError(
          'EXECUTION_FAILED',
          err instanceof Error ? err.message : String(err),
        ))
      }
    },
  }
}

// ─── list_compute_backends ───────────────────────────────────────────────

function createListBackendsTool(opts: ToolsOpts): AgentTool {
  return {
    name: 'list_compute_backends',
    label: 'Compute: List Backends',
    description:
      'List registered compute backends with their capabilities and current availability. ' +
      'Call before compute_plan when you need to choose between (e.g.) local vs remote.',
    parameters: Type.Object({}),
    execute: async () => {
      const backends = opts.registry.list()
      const data = await Promise.all(backends.map(async b => ({
        id: b.identity.id,
        display_name: b.identity.displayName,
        tool_prefix: b.identity.toolPrefix,
        capabilities: b.capabilities,
        availability: await probeWithTimeout(b),
      })))
      return toAgentResult('list_compute_backends', { success: true, data: { backends: data } })
    },
  }
}

// ─── per-backend tools ───────────────────────────────────────────────────

function createBackendTools(backend: ComputeBackend, opts: ToolsOpts): AgentTool[] {
  return [
    createExecuteTool(backend, opts),
    createWaitTool(backend, opts),
    createStatusTool(backend, opts),
    createStopTool(backend, opts),
  ]
}

function createExecuteTool(backend: ComputeBackend, opts: ToolsOpts): AgentTool {
  const { registry } = opts
  const toolPrefix = backend.identity.toolPrefix
  const backendId = backend.identity.id
  return {
    name: `${toolPrefix}_execute`,
    label: `${backend.identity.displayName}: Execute`,
    description:
      backend.capabilities.requiresApproval
        ? `Execute a plan that has been approved by the user in the Compute tab. Call compute_plan with backend="${backendId}" first, then wait for approval.`
        : `Execute a plan previously produced by compute_plan with backend="${backendId}".`,
    parameters: Type.Object({
      plan_id: Type.String({ description: 'Plan id returned by compute_plan' }),
      timeout_minutes: Type.Optional(Type.Number({ description: 'Max runtime in minutes' })),
      stall_threshold_minutes: Type.Optional(Type.Number({ description: 'Minutes without output before flagging stall' })),
      parent_run_id: Type.Optional(Type.String({ description: 'Previous failed run id (for retry lineage)' })),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const planId = typeof params.plan_id === 'string' ? params.plan_id.trim() : ''
      if (!planId) return toAgentResult(`${toolPrefix}_execute`, toolError('MISSING_PARAMETER', 'plan_id is required.'))
      try {
        const run = await registry.submit(backendId, planId, {
          timeoutMinutes: typeof params.timeout_minutes === 'number' ? params.timeout_minutes : undefined,
          stallThresholdMinutes: typeof params.stall_threshold_minutes === 'number' ? params.stall_threshold_minutes : undefined,
          parentRunId: typeof params.parent_run_id === 'string' ? params.parent_run_id : undefined,
        })
        return toAgentResult(`${toolPrefix}_execute`, { success: true, data: serializeRun(run) })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Distinguish "needs approval" from other failures so the agent
        // can decide whether to retry or surface to user.
        if (/requires approval/.test(message)) {
          return toAgentResult(`${toolPrefix}_execute`, {
            success: true,
            data: {
              waiting_for_approval: true,
              plan_id: planId,
              message: 'Plan is awaiting user approval in the Compute tab.',
            },
          })
        }
        if (/was rejected/.test(message)) {
          return toAgentResult(`${toolPrefix}_execute`, {
            success: true,
            data: {
              rejected: true,
              plan_id: planId,
              message: 'Plan was rejected by the user. Read the rejection comments via compute tab and call compute_plan again.',
            },
          })
        }
        return toAgentResult(`${toolPrefix}_execute`, toolError('EXECUTION_FAILED', message))
      }
    },
  }
}

function createWaitTool(backend: ComputeBackend, opts: ToolsOpts): AgentTool {
  const { registry } = opts
  const toolPrefix = backend.identity.toolPrefix
  return {
    name: `${toolPrefix}_wait`,
    label: `${backend.identity.displayName}: Wait`,
    description: `Block until a ${backend.identity.displayName} run reaches a terminal state OR the wait timeout elapses.`,
    parameters: Type.Object({
      run_id: Type.String({ description: 'The run id returned by execute' }),
      timeout_seconds: Type.Optional(Type.Number({ description: 'Max seconds to wait (default: 120, max: 600)' })),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const runId = typeof params.run_id === 'string' ? params.run_id.trim() : ''
      if (!runId) return toAgentResult(`${toolPrefix}_wait`, toolError('MISSING_PARAMETER', 'run_id is required.'))
      const timeoutSec = typeof params.timeout_seconds === 'number' ? Math.min(params.timeout_seconds, 600) : 120
      const status = await registry.waitForCompletion(runId, timeoutSec * 1000)
      if (!status) return toAgentResult(`${toolPrefix}_wait`, toolError('NOT_FOUND', `Run not found: ${runId}`))
      return toAgentResult(`${toolPrefix}_wait`, { success: true, data: serializeStatus(runId, status) })
    },
  }
}

function createStatusTool(backend: ComputeBackend, opts: ToolsOpts): AgentTool {
  const { registry } = opts
  const toolPrefix = backend.identity.toolPrefix
  return {
    name: `${toolPrefix}_status`,
    label: `${backend.identity.displayName}: Status`,
    description: `Check the current status of a ${backend.identity.displayName} compute run.`,
    parameters: Type.Object({
      run_id: Type.String({ description: 'The run id to check' }),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const runId = typeof params.run_id === 'string' ? params.run_id.trim() : ''
      if (!runId) return toAgentResult(`${toolPrefix}_status`, toolError('MISSING_PARAMETER', 'run_id is required.'))
      const status = registry.getStatus(runId)
      if (!status) return toAgentResult(`${toolPrefix}_status`, toolError('NOT_FOUND', `Run not found: ${runId}`))
      return toAgentResult(`${toolPrefix}_status`, { success: true, data: serializeStatus(runId, status) })
    },
  }
}

function createStopTool(backend: ComputeBackend, opts: ToolsOpts): AgentTool {
  const { registry } = opts
  const toolPrefix = backend.identity.toolPrefix
  return {
    name: `${toolPrefix}_stop`,
    label: `${backend.identity.displayName}: Stop`,
    description: `Stop a running ${backend.identity.displayName} compute task.`,
    parameters: Type.Object({
      run_id: Type.String({ description: 'The run id to stop' }),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const runId = typeof params.run_id === 'string' ? params.run_id.trim() : ''
      if (!runId) return toAgentResult(`${toolPrefix}_stop`, toolError('MISSING_PARAMETER', 'run_id is required.'))
      try {
        await registry.stop(runId)
        return toAgentResult(`${toolPrefix}_stop`, { success: true, data: { run_id: runId, status: 'cancelled' } })
      } catch (err) {
        return toAgentResult(`${toolPrefix}_stop`, toolError('EXECUTION_FAILED', err instanceof Error ? err.message : String(err)))
      }
    },
  }
}

// ─── serialization helpers ───────────────────────────────────────────────

function serializeRun(run: ComputeRun): Record<string, unknown> {
  return {
    run_id: run.runId,
    backend: run.backend,
    plan_id: run.planId,
    status: run.status,
    command: run.command,
    script_path: run.scriptPath,
    started_at: run.startedAt,
    output_path: run.outputPath,
    estimated_cost_usd: run.estimatedCostUsd,
    backend_data: run.backendData,
    backend_data_version: run.backendDataVersion,
  }
}

function serializeStatus(runId: string, status: RunStatus): Record<string, unknown> {
  return {
    run_id: runId,
    status: status.status,
    exit_code: status.exitCode,
    elapsed_seconds: status.elapsedSeconds,
    output_bytes: status.outputBytes,
    output_lines: status.outputLines,
    output_tail: status.outputTail,
    // Separately captured stderr tail (when the backend keeps the streams
    // separate — Local does, Modal interleaves). Useful for failure
    // diagnosis beyond the failure.message classification.
    stderr_tail: status.stderrTail,
    last_output_at: status.lastOutputAt,
    stalled: status.stalled,
    progress: status.progress,
    failure: status.failure,
    // Authoritative result from the cooperative ##RESULT## protocol —
    // survives output truncation. Prefer this over scraping output_tail.
    result: status.result,
    estimated_cost_usd: status.estimatedCostUsd,
    backend_data: status.backendData,
    backend_data_version: status.backendDataVersion,
  }
}
