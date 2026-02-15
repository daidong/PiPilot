import { createAgent, packs } from '../../../src/index.js'
import type { AgentRunResult } from '../../../src/index.js'

import { buildDefaultP0Constraints, createConservativeFallbackSpec } from '../runtime/planner.js'
import type {
  PlannerInput,
  PlannerOutput,
  TurnConstraints,
  TurnPlanner,
  TurnSpec,
  YoloStage
} from '../runtime/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentLike {
  ensureInit: () => Promise<void>
  run: (prompt: string) => Promise<AgentRunResult>
  destroy?: () => Promise<void>
}

export interface YoloPlannerConfig {
  projectPath: string
  model: string
  apiKey?: string
  maxSteps?: number
  maxTokens?: number
  debug?: boolean
  identityPrompt?: string
  constraints?: string[]
  createAgentInstance?: () => AgentLike
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_IDENTITY = [
  'You are the YOLO-Scholar turn planner.',
  'Produce one TurnSpec per invocation as strict JSON.',
  'Prioritize bounded, auditable progress over ambitious scope.',
  'Be budget-aware and stage-appropriate.'
].join(' ')

const DEFAULT_CONSTRAINTS = [
  'Output strict JSON only.',
  'Do not fabricate asset references.',
  'Align branch actions with phase constraints.',
  'Keep constraint allocations realistic for remaining budget.'
]

const VALID_BRANCH_ACTIONS = new Set(['advance', 'fork', 'revisit', 'merge', 'prune'])

// ---------------------------------------------------------------------------
// JSON Parsing (3-tier fallback)
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tryParseJson(input: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(input)
    if (!isObject(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function parsePlannerJson(rawOutput: string): Record<string, unknown> | undefined {
  const text = rawOutput.trim()
  if (!text) return undefined

  // Tier 1: direct parse
  const direct = tryParseJson(text)
  if (direct) return direct

  // Tier 2: code-fenced JSON
  const codeFenceMatch = text.match(/```json\s*([\s\S]*?)```/i)
  if (codeFenceMatch?.[1]) {
    const parsed = tryParseJson(codeFenceMatch[1].trim())
    if (parsed) return parsed
  }

  // Tier 3: brace extraction
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return tryParseJson(text.slice(firstBrace, lastBrace + 1))
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeConstraints(raw: unknown): TurnConstraints {
  const defaults = buildDefaultP0Constraints()
  if (!isObject(raw)) return defaults

  function safePositiveInt(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
    return Math.round(value)
  }

  function safePositiveFloat(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
    return value
  }

  return {
    maxToolCalls: safePositiveInt(raw.maxToolCalls, defaults.maxToolCalls),
    maxWallClockSec: safePositiveInt(raw.maxWallClockSec, defaults.maxWallClockSec),
    maxStepCount: safePositiveInt(raw.maxStepCount, defaults.maxStepCount),
    maxNewAssets: safePositiveInt(raw.maxNewAssets, defaults.maxNewAssets),
    maxDiscoveryOps: safePositiveInt(raw.maxDiscoveryOps, defaults.maxDiscoveryOps),
    maxReadBytes: safePositiveInt(raw.maxReadBytes, defaults.maxReadBytes),
    maxPromptTokens: safePositiveInt(raw.maxPromptTokens, defaults.maxPromptTokens),
    maxCompletionTokens: safePositiveInt(raw.maxCompletionTokens, defaults.maxCompletionTokens),
    maxTurnTokens: safePositiveInt(raw.maxTurnTokens, defaults.maxTurnTokens),
    maxTurnCostUsd: safePositiveFloat(raw.maxTurnCostUsd, defaults.maxTurnCostUsd)
  }
}

function normalizeBranchAction(
  action: unknown,
  phase: string
): TurnSpec['branch']['action'] {
  if (typeof action !== 'string' || !VALID_BRANCH_ACTIONS.has(action)) return 'advance'
  // P0 is advance-only
  if (phase === 'P0') return 'advance'
  return action as TurnSpec['branch']['action']
}

function normalizeTurnSpec(
  raw: unknown,
  input: PlannerInput
): TurnSpec | undefined {
  if (!isObject(raw)) return undefined

  const objective = typeof raw.objective === 'string' ? raw.objective.trim() : ''
  if (!objective) return undefined

  const stage = (typeof raw.stage === 'string' && /^S[1-5]$/.test(raw.stage))
    ? raw.stage as YoloStage
    : input.stage

  const branch = isObject(raw.branch) ? raw.branch : {}
  const action = normalizeBranchAction(branch.action, input.phase)

  const expectedAssets = Array.isArray(raw.expectedAssets)
    ? raw.expectedAssets.filter((item): item is string => typeof item === 'string')
    : ['RiskRegister']

  return {
    turnNumber: input.turnNumber,
    stage,
    branch: {
      activeBranchId: input.activeBranchId,
      activeNodeId: input.activeNodeId,
      action,
      targetNodeId: typeof branch.targetNodeId === 'string' ? branch.targetNodeId : undefined
    },
    objective,
    expectedAssets,
    constraints: normalizeConstraints(raw.constraints)
  }
}

function normalizePlannerOutput(
  raw: Record<string, unknown>,
  input: PlannerInput
): PlannerOutput | undefined {
  // The LLM may return the TurnSpec nested under "turnSpec" or at the top level
  const turnSpecRaw = isObject(raw.turnSpec) ? raw.turnSpec : raw
  const turnSpec = normalizeTurnSpec(turnSpecRaw, input)
  if (!turnSpec) return undefined

  return {
    turnSpec,
    suggestedPrompt: typeof raw.suggestedPrompt === 'string'
      ? raw.suggestedPrompt
      : `Turn ${input.turnNumber}: ${turnSpec.objective}`,
    rationale: typeof raw.rationale === 'string'
      ? raw.rationale
      : 'LLM planner output',
    uncertaintyNote: typeof raw.uncertaintyNote === 'string'
      ? raw.uncertaintyNote
      : ''
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildStageGuidance(stage: YoloStage): string {
  const guidance: Record<YoloStage, string> = {
    S1: [
      'S1 (Problem Definition): Focus on Hypothesis, RiskRegister, and baseline landscape.',
      'Do NOT propose experiments yet — stay in framing mode.',
      'Keep S1 concise: typically 1-2 turns, then advance to S2 when framing is stable.',
      'Ideal assets: Hypothesis, RiskRegister, LandscapeSurvey.'
    ].join(' '),
    S2: [
      'S2 (Evidence Planning): Focus on Claim, EvidenceLink, ExperimentRequirement.',
      'Outsource execution to the user via ExperimentRequirement assets.',
      'Do NOT run experiments in-process.'
    ].join(' '),
    S3: [
      'S3 (Experimentation): Focus on RunRecord and experimental results.',
      'Link results back to claims and evidence links.',
      'Verify reproducibility where possible.'
    ].join(' '),
    S4: [
      'S4 (Verification): Focus on coverage, reproducibility, and parity checks.',
      'Ensure all claims have direct evidence.',
      'Address any remaining gaps flagged by reviewers.'
    ].join(' '),
    S5: [
      'S5 (Writing & Closure): Focus on writing, claim-evidence completeness, and final quality.',
      'All claims must have direct evidence before closure.',
      'Produce final deliverables and summaries.'
    ].join(' ')
  }
  return guidance[stage]
}

function buildBranchGuidance(phase: string): string {
  if (phase === 'P0') {
    return 'P0 branch rules: advance-only. Do not fork, revisit, merge, or prune.'
  }
  return [
    'Branch actions available: advance, fork, revisit, merge, prune.',
    'Warning: excessive non-progress turns may indicate need for fork or revisit.',
    'Warning: repeated gate failures on the same node may indicate gate-loop — consider a different approach.'
  ].join(' ')
}

function buildBudgetGuidance(remaining: PlannerInput['remainingBudget']): string {
  const ratio = remaining.maxTurns > 0
    ? remaining.turns / remaining.maxTurns
    : 0

  if (ratio > 0.5) {
    return 'Budget: healthy (>50% turns remaining). Proceed normally.'
  }
  if (ratio > 0.2) {
    return [
      'Budget: low (20-50% turns remaining).',
      'Tighten constraints. Avoid speculative exploration.',
      'Prefer consolidation over new branches.'
    ].join(' ')
  }
  return [
    'Budget: critical (<20% turns remaining).',
    'Minimize tool calls and token usage.',
    'Focus on completing in-progress work and producing final deliverables.',
    'Strongly prefer advance action with conservative constraints.'
  ].join(' ')
}

function buildPlannerPrompt(input: PlannerInput): string {
  const sections = [
    // 1. Role + JSON schema
    [
      'You are the YOLO-Scholar turn planner. Produce one plan as strict JSON.',
      'Output schema:',
      JSON.stringify({
        turnSpec: {
          turnNumber: 'number',
          stage: 'S1|S2|S3|S4|S5',
          branch: {
            activeBranchId: 'string',
            activeNodeId: 'string',
            action: 'advance|fork|revisit|merge|prune',
            targetNodeId: 'string (optional)'
          },
          objective: 'string',
          expectedAssets: 'string[]',
          constraints: {
            maxToolCalls: 'number',
            maxWallClockSec: 'number',
            maxStepCount: 'number',
            maxNewAssets: 'number',
            maxDiscoveryOps: 'number',
            maxReadBytes: 'number',
            maxPromptTokens: 'number',
            maxCompletionTokens: 'number',
            maxTurnTokens: 'number',
            maxTurnCostUsd: 'number'
          }
        },
        suggestedPrompt: 'string',
        rationale: 'string',
        uncertaintyNote: 'string'
      }, null, 2)
    ].join('\n'),

    // 2. Stage guidance
    buildStageGuidance(input.stage),

    // 3. Branch guidance
    buildBranchGuidance(input.phase),

    // 4. Budget guidance
    buildBudgetGuidance(input.remainingBudget),

    // 5. Context data
    [
      `Session: ${input.sessionId}`,
      `Turn: ${input.turnNumber}`,
      `State: ${input.state}`,
      `Stage: ${input.stage}`,
      `Phase: ${input.phase}`,
      `Goal: ${input.goal}`,
      `Active branch: ${input.activeBranchId}`,
      `Active node: ${input.activeNodeId}`,
      `Non-progress turns: ${input.nonProgressTurns}`,
      `Requires branch diversification: ${input.requiresBranchDiversification}`,
      `Gate failure count on active node: ${input.gateFailureCountOnActiveNode}`,
      `Requires gate-loop break: ${input.requiresGateLoopBreak}`,
      `Remaining budget: ${JSON.stringify(input.remainingBudget)}`,
      `User inputs: ${JSON.stringify(input.mergedUserInputs)}`
    ].join('\n'),

    // 6. Stage gate status
    [
      'Stage gate status:',
      ...Object.entries(input.previousStageGateStatus).map(
        ([stage, status]) => `  ${stage}: ${status}`
      )
    ].join('\n'),

    // 7. Recent turn summaries
    input.lastTurnSummaries.length > 0
      ? [
          'Recent turn history:',
          ...input.lastTurnSummaries.map(
            (s) => `  Turn ${s.turnNumber} [${s.stage}]: ${s.objective} (created: ${s.assetsCreated}, updated: ${s.assetsUpdated})`
          )
        ].join('\n')
      : 'No previous turns completed yet.',

    // 8. Asset inventory
    input.assetInventory.length > 0
      ? [
          `Asset inventory (${input.assetInventory.length} total):`,
          ...input.assetInventory.slice(-20).map(
            (a) => `  [${a.type}] ${a.id} (turn ${a.createdByTurn})`
          ),
          ...(input.assetInventory.length > 20
            ? [`  ... and ${input.assetInventory.length - 20} more`]
            : [])
        ].join('\n')
      : 'No assets created yet.',

    // 9. Plan content
    input.planContent
      ? `Current research plan:\n${input.planContent}`
      : 'No research plan document yet.',

    // 10. Branch dossier content
    input.branchDossierContent
      ? `Active branch dossier:\n${input.branchDossierContent}`
      : 'No branch dossier for active branch yet.'
  ]

  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

function createFallbackOutput(input: PlannerInput): PlannerOutput {
  return {
    turnSpec: createConservativeFallbackSpec({
      turnNumber: input.turnNumber,
      stage: input.stage,
      activeBranchId: input.activeBranchId,
      activeNodeId: input.activeNodeId
    }),
    suggestedPrompt: `Turn ${input.turnNumber}: consolidate current state and report blockers`,
    rationale: 'LLM planner fallback — conservative advance with default constraints.',
    uncertaintyNote: 'Planner could not produce a valid plan; falling back to conservative spec.'
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createYoloPlanner(config: YoloPlannerConfig): TurnPlanner {
  let initialized = false
  let agent: AgentLike | undefined

  const getAgent = async (): Promise<AgentLike> => {
    if (!agent) {
      agent = config.createAgentInstance
        ? config.createAgentInstance()
        : defaultAgentFactory(config)
    }

    if (!initialized) {
      await agent.ensureInit()
      initialized = true
    }

    return agent
  }

  return {
    async generate(input: PlannerInput): Promise<PlannerOutput> {
      const fallback = createFallbackOutput(input)

      let runResult: AgentRunResult
      try {
        const prompt = buildPlannerPrompt(input)
        const plannerAgent = await getAgent()
        runResult = await plannerAgent.run(prompt)
      } catch {
        // Layer 1: agent run fails
        return fallback
      }

      if (!runResult.success) {
        // Layer 1: agent run fails
        return fallback
      }

      // Layer 2: JSON parse
      const parsed = parsePlannerJson(runResult.output)
      if (!parsed) {
        return fallback
      }

      // Layer 3: normalization
      const output = normalizePlannerOutput(parsed, input)
      if (!output) {
        return fallback
      }

      return output
    }
  }
}

function defaultAgentFactory(config: YoloPlannerConfig): AgentLike {
  const agent = createAgent({
    projectPath: config.projectPath,
    apiKey: config.apiKey,
    model: config.model,
    maxSteps: config.maxSteps ?? 15,
    maxTokens: config.maxTokens,
    debug: config.debug,
    identity: config.identityPrompt ?? DEFAULT_IDENTITY,
    constraints: [...(config.constraints ?? DEFAULT_CONSTRAINTS)],
    packs: [packs.safe()],
    skipConfigFile: true
  })

  return {
    ensureInit: () => agent.ensureInit(),
    run: (prompt: string) => agent.run(prompt),
    destroy: () => agent.destroy()
  }
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export const __private = {
  parsePlannerJson,
  normalizePlannerOutput,
  normalizeTurnSpec,
  normalizeConstraints,
  normalizeBranchAction,
  buildPlannerPrompt,
  createFallbackOutput
}
