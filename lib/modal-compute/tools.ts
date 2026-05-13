import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult, toolError } from '../tools/tool-utils.js'
import type { ResearchToolContext } from '../tools/types.js'
import { PendingPlanStore } from './pending-plan-store.js'
import { ModalRunner } from './modal-runner.js'
import type { ModalRunStatusResult } from './types.js'

function getCostThreshold(ctx: ResearchToolContext): number {
  return ctx.getSettings?.().modalCompute.costThresholdUsd
    ?? ctx.settings?.modalCompute.costThresholdUsd
    ?? 5
}

export function createModalComputeTools(ctx: ResearchToolContext): {
  tools: AgentTool[]
  destroy: () => Promise<void>
} {
  const runner = new ModalRunner({
    projectPath: ctx.projectPath,
    workspacePath: ctx.workspacePath,
    modalCredentials: ctx.modalCredentials,
    getCostThreshold: () => getCostThreshold(ctx),
    onCostKilled: (runId, costUsd) => {
      ctx.onModalCostKilled?.(runId, costUsd)
    },
    onRunUpdate: (runId, status) => {
      ctx.onModalRunUpdate?.(runId, status)
    },
  })
  const pendingPlanStore = new PendingPlanStore(ctx.projectPath)

  const tools: AgentTool[] = [
    createExecuteTool(runner, pendingPlanStore, ctx),
    createWaitTool(runner),
    createStatusTool(runner),
    createStopTool(runner),
  ]

  return { tools, destroy: () => runner.destroy() }
}

function hasCredentials(ctx: ResearchToolContext): boolean {
  return !!(ctx.modalCredentials?.tokenId && ctx.modalCredentials?.tokenSecret)
}

function createExecuteTool(runner: ModalRunner, pendingPlanStore: PendingPlanStore, ctx: ResearchToolContext): AgentTool {
  return {
    name: 'modal_execute',
    label: 'Modal Compute: Execute',
    description: 'Execute the approved pending Modal compute plan. Call compute_plan with env="modal" first, then wait for user approval.',
    parameters: Type.Object({
      timeout_minutes: Type.Optional(Type.Number({ description: 'Max runtime in minutes (default: 60, max: 1440)' })),
      stall_threshold_minutes: Type.Optional(Type.Number({ description: 'Minutes without output before flagging stall (default: 5)' })),
      parent_run_id: Type.Optional(Type.String({ description: 'Previous failed run ID (for retry lineage tracking)' })),
    }),
    execute: async (_toolCallId, rawParams) => {
      if (!hasCredentials(ctx)) {
        return toAgentResult('modal_execute', toolError(
          'EXECUTION_FAILED',
          'Modal credentials are missing. Configure MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in Settings > API Keys.',
          { retryable: true, suggestions: ['Open Settings > API Keys and add Modal credentials, or run modal token new and paste the token values.'] },
        ))
      }
      const plan = pendingPlanStore.read()
      if (!plan) {
        return toAgentResult('modal_execute', toolError('NOT_FOUND', 'No pending Modal plan found. Call compute_plan with env="modal" first.'))
      }
      if (plan.rejectedAt) {
        return toAgentResult('modal_execute', {
          success: true,
          data: {
            rejected: true,
            plan_id: plan.planId,
            rejection_comments: plan.rejectionComments ?? '',
            message: 'The user rejected the pending Modal plan. Read the rejection comments and call compute_plan with env="modal" again before trying modal_execute.',
          },
        })
      }
      if (!plan.approved) {
        return toAgentResult('modal_execute', {
          success: true,
          data: {
            waiting_for_approval: true,
            plan_id: plan.planId,
            message: 'Waiting for the user to approve the Modal plan in the Compute tab.',
          },
        })
      }
      const params = rawParams as Record<string, unknown>
      try {
        const run = await runner.submit({
          plan,
          timeoutMinutes: typeof params.timeout_minutes === 'number' ? params.timeout_minutes : 60,
          stallThresholdMinutes: typeof params.stall_threshold_minutes === 'number' ? params.stall_threshold_minutes : 5,
          parentRunId: typeof params.parent_run_id === 'string' ? params.parent_run_id : undefined,
        })
        pendingPlanStore.clear()
        return toAgentResult('modal_execute', {
          success: true,
          data: {
            run_id: run.runId,
            plan_id: run.planId,
            status: run.status,
            command: run.command,
            task_description: run.taskDescription,
            script_path: run.scriptPath,
            output_path: run.outputPath,
            estimated_cost_usd: run.estimatedCostSoFar,
            cost_estimate: run.costEstimate,
            cost_threshold_usd: getCostThreshold(ctx),
            image: run.image,
          },
        })
      } catch (err) {
        return toAgentResult('modal_execute', toolError('EXECUTION_FAILED', err instanceof Error ? err.message : String(err)))
      }
    },
  }
}

function createWaitTool(runner: ModalRunner): AgentTool {
  return {
    name: 'modal_wait',
    label: 'Modal Compute: Wait',
    description: 'Wait for a Modal run to complete. Blocks until finished, stalled, or wait timeout elapses.',
    parameters: Type.Object({
      run_id: Type.String({ description: 'The run ID returned by modal_execute' }),
      timeout_seconds: Type.Optional(Type.Number({ description: 'Max seconds to wait (default: 120, max: 600)' })),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const runId = typeof params.run_id === 'string' ? params.run_id.trim() : ''
      if (!runId) return toAgentResult('modal_wait', toolError('MISSING_PARAMETER', 'run_id is required.'))
      const timeoutSec = typeof params.timeout_seconds === 'number' ? Math.min(params.timeout_seconds, 600) : 120
      const result = await runner.waitForCompletion(runId, timeoutSec * 1000)
      if (!result) return toAgentResult('modal_wait', toolError('NOT_FOUND', `Run not found: ${runId}`))
      return toAgentResult('modal_wait', { success: true, data: formatStatusResult(runId, result) })
    },
  }
}

function createStatusTool(runner: ModalRunner): AgentTool {
  return {
    name: 'modal_status',
    label: 'Modal Compute: Status',
    description: 'Check the current status of a Modal compute run.',
    parameters: Type.Object({ run_id: Type.String({ description: 'The run ID to check' }) }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const runId = typeof params.run_id === 'string' ? params.run_id.trim() : ''
      if (!runId) return toAgentResult('modal_status', toolError('MISSING_PARAMETER', 'run_id is required.'))
      const result = runner.getStatus(runId)
      if (!result) return toAgentResult('modal_status', toolError('NOT_FOUND', `Run not found: ${runId}`))
      return toAgentResult('modal_status', { success: true, data: formatStatusResult(runId, result) })
    },
  }
}

function createStopTool(runner: ModalRunner): AgentTool {
  return {
    name: 'modal_stop',
    label: 'Modal Compute: Stop',
    description: 'Stop a running Modal compute task.',
    parameters: Type.Object({ run_id: Type.String({ description: 'The run ID to stop' }) }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const runId = typeof params.run_id === 'string' ? params.run_id.trim() : ''
      if (!runId) return toAgentResult('modal_stop', toolError('MISSING_PARAMETER', 'run_id is required.'))
      try {
        await runner.stop(runId)
        return toAgentResult('modal_stop', { success: true, data: { run_id: runId, status: 'cancelled' } })
      } catch (err) {
        return toAgentResult('modal_stop', toolError('EXECUTION_FAILED', err instanceof Error ? err.message : String(err)))
      }
    },
  }
}

export function formatStatusResult(runId: string, result: ModalRunStatusResult): Record<string, unknown> {
  const data: Record<string, unknown> = {
    run_id: runId,
    status: result.status,
    current_phase: 'modal',
    plan_id: result.planId,
    task_description: result.taskDescription,
    command: result.command,
    script_path: result.scriptPath,
    image: result.image,
    cost_estimate: result.costEstimate,
    cost_threshold_usd: result.costThresholdUsd,
    started_at: result.startedAt,
    elapsed_seconds: result.elapsedSeconds,
    output_bytes: result.outputBytes,
    output_lines: result.outputLines,
    last_output_at: result.lastOutputAt,
    timeout_ms: result.timeoutMs,
    stall_threshold_ms: result.stallThresholdMs,
    stalled: result.stalled,
    estimated_cost_usd: result.estimatedCostUsd,
  }
  if (result.exitCode !== undefined) data.exit_code = result.exitCode
  if (result.outputTail) data.output_tail = result.outputTail
  if (result.progress) data.progress = result.progress
  if (result.failure) data.failure = result.failure
  return data
}
