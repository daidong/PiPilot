/**
 * Strategy — LLM-driven risk assessment from raw system facts.
 *
 * Runtime provides facts (task profile, environment, experience).
 * LLM reasons about risks and returns advice.
 * Falls back to sensible defaults if LLM is unavailable.
 *
 * v1.2: LLM-enhanced. v1.0-1.1: uses defaults only.
 */

import type { ResearchToolContext } from '../tools/types.js'
import { type TaskProfile, parseJsonFromLlm } from './task-profiler.js'
import type { StaticProfile } from './environment-model.js'
import type { PreRunSnapshot } from './types.js'
import type { ExperienceSummary } from './experience.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RiskItem {
  severity: 'low' | 'medium' | 'high' | 'blocking'
  category: string
  message: string
  mitigation?: string
}

export interface RiskAdvice {
  feasible: boolean
  risks: RiskItem[]
  recommendedSandbox: 'docker' | 'process'
  recommendedTimeoutMinutes: number
  recommendedStallThresholdMinutes: number
  warnings: string[]
  agentGuidance: string[]
}

// ---------------------------------------------------------------------------
// LLM system prompt
// ---------------------------------------------------------------------------

const RISK_ASSESSMENT_PROMPT = `You are a compute execution risk assessor. Given the task profile, system environment, and past experience, assess risks and recommend execution parameters.

Output a JSON object:
{
  "feasible": boolean,
  "risks": [
    { "severity": "low"|"medium"|"high"|"blocking", "category": "memory"|"disk"|"gpu"|"dependency"|"network"|"timeout", "message": "...", "mitigation": "..." }
  ],
  "recommendedSandbox": "docker" | "process",
  "recommendedTimeoutMinutes": number,
  "recommendedStallThresholdMinutes": number,
  "warnings": ["..."],
  "agentGuidance": ["tips for the coding agent..."]
}

Guidelines:
- Mark "blocking" severity only for showstopper issues (no GPU when GPU required, <100MB disk)
- recommendedTimeoutMinutes: use experience average × 2 if available, else estimate from task type
- recommendedSandbox: prefer "process" on macOS (Docker lacks GPU passthrough), "docker" on Linux with NVIDIA
- For Apple Silicon with MLX: recommend process sandbox for Metal GPU access
- Be actionable in mitigations and guidance

Output ONLY the JSON object.`

// ---------------------------------------------------------------------------
// Assess function
// ---------------------------------------------------------------------------

/**
 * Assess risk and generate execution advice.
 * Uses LLM if available; falls back to deterministic defaults.
 */
export async function assessRisk(opts: {
  taskProfile: TaskProfile | null
  env: StaticProfile
  snapshot: PreRunSnapshot
  experience?: ExperienceSummary
  command: string
  callLlm?: ResearchToolContext['callLlm']
}): Promise<RiskAdvice> {
  const { taskProfile, env, snapshot, experience, command, callLlm } = opts

  // Without LLM, return sensible defaults
  if (!callLlm) return defaultAdvice(env, snapshot)

  try {
    const facts = formatFacts(taskProfile, env, snapshot, experience, command)
    const response = await callLlm(RISK_ASSESSMENT_PROMPT, facts)
    const parsed = parseJsonFromLlm(response) as Partial<RiskAdvice> | null
    if (!parsed) return defaultAdvice(env, snapshot)
    return mergeWithDefaults(parsed, env, snapshot)
  } catch {
    return defaultAdvice(env, snapshot)
  }
}

// ---------------------------------------------------------------------------
// Fact formatting
// ---------------------------------------------------------------------------

function formatFacts(
  taskProfile: TaskProfile | null,
  env: StaticProfile,
  snapshot: PreRunSnapshot,
  experience: ExperienceSummary | undefined,
  command: string,
): string {
  const sections: string[] = []

  if (taskProfile) {
    sections.push(`## Task Profile\n${JSON.stringify(taskProfile, null, 2)}`)
  }

  sections.push(`## Command\n${command}`)

  sections.push(`## Environment
OS: ${env.os} ${env.arch}
CPU: ${env.cpuCores} cores (${env.cpuModel})
RAM: ${env.totalMemoryMb}MB total, ~${snapshot.freeMemoryMb}MB free
GPU: ${env.gpu.type === 'none' ? 'None' : `${env.gpu.model} (${env.gpu.type})`}
MLX: ${env.gpu.mlxAvailable ? `Yes (${env.gpu.mlxPackages.join(', ')})` : 'No'}
CUDA: ${env.gpu.cudaAvailable ? 'Yes' : 'No'}
Python: ${env.pythonVersion}
Docker: ${env.dockerAvailable ? 'Yes' : 'No'}
Disk free: ~${snapshot.freeDiskMb}MB
CPU load: ${snapshot.cpuLoadPercent}%
Active runs: ${snapshot.activeRuns.length}`)

  if (experience) {
    sections.push(`## Past Experience (${experience.taskKind})
Total runs: ${experience.totalRuns}
Successes: ${experience.successes}, Failures: ${experience.failures}
${experience.avgDurationSeconds ? `Avg duration: ${Math.round(experience.avgDurationSeconds / 60)} min` : ''}
${Object.keys(experience.commonFailures).length > 0 ? `Common failures: ${JSON.stringify(experience.commonFailures)}` : ''}`)
  }

  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultAdvice(env: StaticProfile, snapshot: PreRunSnapshot): RiskAdvice {
  const risks: RiskItem[] = []
  const warnings: string[] = []

  if (snapshot.freeMemoryMb < 1000) {
    risks.push({
      severity: snapshot.freeMemoryMb < 500 ? 'high' : 'medium',
      category: 'memory',
      message: `Only ${snapshot.freeMemoryMb}MB free memory.`,
      mitigation: 'Close memory-intensive applications.',
    })
  }

  if (snapshot.freeDiskMb < 2000) {
    risks.push({
      severity: snapshot.freeDiskMb < 500 ? 'blocking' : 'medium',
      category: 'disk',
      message: `Only ${snapshot.freeDiskMb}MB free disk space.`,
    })
  }

  if (snapshot.cpuLoadPercent > 80) {
    warnings.push(`High CPU load (${snapshot.cpuLoadPercent}%). Run may be slower than expected.`)
  }

  return {
    feasible: !risks.some(r => r.severity === 'blocking'),
    risks,
    recommendedSandbox: 'process',
    recommendedTimeoutMinutes: 60,
    recommendedStallThresholdMinutes: 5,
    warnings,
    agentGuidance: [],
  }
}

function mergeWithDefaults(
  partial: Partial<RiskAdvice>,
  env: StaticProfile,
  snapshot: PreRunSnapshot,
): RiskAdvice {
  const defaults = defaultAdvice(env, snapshot)
  return {
    feasible: partial.feasible ?? defaults.feasible,
    risks: partial.risks ?? defaults.risks,
    recommendedSandbox: partial.recommendedSandbox ?? defaults.recommendedSandbox,
    recommendedTimeoutMinutes: partial.recommendedTimeoutMinutes ?? defaults.recommendedTimeoutMinutes,
    recommendedStallThresholdMinutes: partial.recommendedStallThresholdMinutes ?? defaults.recommendedStallThresholdMinutes,
    warnings: partial.warnings ?? defaults.warnings,
    agentGuidance: partial.agentGuidance ?? defaults.agentGuidance,
  }
}
