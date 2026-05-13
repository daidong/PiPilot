import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult, toolError } from '../tools/tool-utils.js'
import type { ResearchToolContext } from '../tools/types.js'
import { ComputeRunner } from '../local-compute/runner.js'
import { profileTask } from '../local-compute/task-profiler.js'
import { probeStaticProfile } from '../local-compute/environment-model.js'
import { assessRisk } from '../local-compute/strategy.js'
import { inferTaskKind } from '../local-compute/experience.js'
import { PendingPlanStore } from '../modal-compute/pending-plan-store.js'
import { runPlanAgent } from '../modal-compute/plan-agent.js'
import { estimateCost } from '../modal-compute/cost-estimator.js'

function readScriptContent(workspacePath: string, scriptPathParam: unknown): { scriptPath?: string; content?: string } {
  if (typeof scriptPathParam !== 'string' || !scriptPathParam.trim()) return {}
  const scriptPath = path.isAbsolute(scriptPathParam)
    ? scriptPathParam
    : path.resolve(workspacePath, scriptPathParam)
  try {
    return { scriptPath, content: fs.readFileSync(scriptPath, 'utf-8') }
  } catch {
    return { scriptPath }
  }
}

function buildPlanningContent(taskDescription: string | undefined, scriptContent: string | undefined): string | undefined {
  const sections: string[] = []
  if (taskDescription) sections.push(`Task description:\n${taskDescription}`)
  if (scriptContent) sections.push(`Script content:\n${scriptContent}`)
  return sections.length > 0 ? sections.join('\n\n') : undefined
}

export function createComputePlanTool(
  localRunner: ComputeRunner,
  pendingPlanStore: PendingPlanStore,
  ctx: ResearchToolContext,
): AgentTool {
  return {
    name: 'compute_plan',
    label: 'Compute: Plan',
    description:
      'Analyze a compute task before execution. Use env="local" for local sandboxed compute and env="modal" for Modal remote compute with approval and cost estimation.',
    parameters: Type.Object({
      env: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('modal')], { description: 'Compute target (default: local)' })),
      command: Type.String({ description: 'Shell command to execute' }),
      task_description: Type.Optional(Type.String({
        description: 'Concise description of the computational task, dataset/input, expected output, and success criteria.',
      })),
      script_path: Type.Optional(Type.String({ description: 'Relative path to the main script (for deeper analysis)' })),
      sandbox: Type.Optional(Type.String({ description: '"docker" | "process" | "auto" | "modal"' })),
      timeout_minutes: Type.Optional(Type.Number({ description: 'Suggested timeout' })),
      smoke_command: Type.Optional(Type.String({ description: 'Quick validation command' })),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const env = params.env === 'modal' ? 'modal' : 'local'
      const command = typeof params.command === 'string' ? params.command.trim() : ''
      if (!command) return toAgentResult('compute_plan', toolError('MISSING_PARAMETER', 'command is required.'))

      const taskDescription = typeof params.task_description === 'string' && params.task_description.trim()
        ? params.task_description.trim()
        : undefined
      const { scriptPath, content: scriptContent } = readScriptContent(ctx.workspacePath, params.script_path)

      if (env === 'modal') {
        if (!scriptPath) {
          return toAgentResult('compute_plan', toolError('MISSING_PARAMETER', 'script_path is required when env is "modal".'))
        }

        // Run the plan agent to analyze the script and recommend an image
        const { taskProfile, image } = await runPlanAgent(scriptPath, command, taskDescription, ctx)

        const threshold = ctx.getSettings?.().modalCompute.costThresholdUsd
          ?? ctx.settings?.modalCompute.costThresholdUsd
          ?? 5
        const costEstimate = estimateCost(image, taskProfile, threshold)
        const plan = {
          planId: pendingPlanStore.nextPlanId(),
          createdAt: new Date().toISOString(),
          approved: false,
          taskDescription,
          command,
          scriptPath,
          image,
          costEstimate,
          taskProfile,
        }
        pendingPlanStore.write(plan)
        return toAgentResult('compute_plan', {
          success: true,
          data: {
            target: 'modal',
            task_description: taskDescription,
            plan_id: plan.planId,
            plan,
            waiting_for_approval: true,
            approval_required: true,
            message: 'Modal plan is ready. Ask the user to approve it in the Compute tab before calling modal_execute.',
          },
        })
      }

      // Local path: profile the task, assess risks, and return recommendations
      const planningContent = buildPlanningContent(taskDescription, scriptContent)
      const profileCommand = taskDescription ? `${command}\n\nTask description: ${taskDescription}` : command
      const taskProfile = await profileTask(profileCommand, planningContent, ctx.callLlm)

      let localEnv
      try {
        localEnv = await probeStaticProfile()
      } catch {
        return toAgentResult('compute_plan', toolError('EXECUTION_FAILED', 'Failed to probe system environment.'))
      }

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
        activeRuns: localRunner.getStore().getActiveRuns().map(r => ({ runId: r.runId, weight: r.weight })),
      }
      const taskKind = inferTaskKind(command, planningContent)
      const experience = localRunner.getExperience().summarize(taskKind)
      const riskAdvice = await assessRisk({
        taskProfile,
        env: localEnv,
        snapshot,
        experience,
        command: profileCommand,
        callLlm: ctx.callLlm,
      })

      return toAgentResult('compute_plan', {
        success: true,
        data: {
          target: 'local',
          task_description: taskDescription,
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
