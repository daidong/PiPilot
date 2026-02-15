import { createAgent, packs } from '../../../src/index.js'
import type { AgentRunResult } from '../../../src/index.js'

import { buildDefaultP0Constraints, createConservativeFallbackSpec } from '../runtime/planner.js'
import type {
  PlannerContract,
  PlannerInput,
  PlannerOutput,
  PlannerToolPlanStep,
  TurnConstraints,
  TurnPlanner,
  TurnSpec,
  YoloStage,
  YoloTurnAction
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
  'Produce one plan contract per invocation as strict JSON.',
  'Prioritize bounded, auditable progress over process abstraction.',
  'Be budget-aware and stage-appropriate.'
].join(' ')

const DEFAULT_CONSTRAINTS = [
  'Output strict JSON only.',
  'Do not fabricate asset references.',
  'Keep tool_plan <= 3 steps.',
  'Use plain language and concrete execution intent.'
]

const VALID_BRANCH_ACTIONS = new Set(['advance', 'fork', 'revisit', 'merge', 'prune'])
const VALID_TURN_ACTIONS = new Set<YoloTurnAction>([
  'explore',
  'refine_question',
  'issue_experiment_request',
  'digest_uploaded_results'
])

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

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized ? normalized : undefined
}

function normalizeStringArray(value: unknown, maxItems?: number): string[] {
  if (!Array.isArray(value)) return []
  const output = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
  return typeof maxItems === 'number' ? output.slice(0, maxItems) : output
}

function normalizeTurnAction(value: unknown, fallback: YoloTurnAction): YoloTurnAction {
  if (typeof value !== 'string') return fallback
  const action = value.trim() as YoloTurnAction
  return VALID_TURN_ACTIONS.has(action) ? action : fallback
}

function inferActionFromExpectedOutput(expectedOutput: string[]): YoloTurnAction | undefined {
  const lowered = expectedOutput.map((item) => item.toLowerCase())
  if (lowered.some((item) => item.includes('experimentrequest') || item.includes('experiment'))) {
    return 'issue_experiment_request'
  }
  if (lowered.some((item) => item.includes('resultinsight') || item.includes('insight') || item.includes('digest'))) {
    return 'digest_uploaded_results'
  }
  if (lowered.length > 0 && lowered.every((item) => item.includes('note'))) {
    return 'explore'
  }
  return undefined
}

function defaultActionForStage(stage: YoloStage): YoloTurnAction {
  if (stage === 'S2' || stage === 'S3') return 'issue_experiment_request'
  if (stage === 'S4' || stage === 'S5') return 'digest_uploaded_results'
  return 'refine_question'
}

function defaultExpectedOutputForAction(action: YoloTurnAction): string[] {
  switch (action) {
    case 'explore':
      return ['Note']
    case 'issue_experiment_request':
      return ['ExperimentRequest']
    case 'digest_uploaded_results':
      return ['ResultInsight']
    case 'refine_question':
    default:
      return ['ResearchQuestion']
  }
}

function normalizeExpectedOutput(value: unknown, action: YoloTurnAction): string[] {
  const raw = normalizeStringArray(value)
  if (raw.length > 0) return raw
  return defaultExpectedOutputForAction(action)
}

function defaultToolForAction(action: YoloTurnAction): string {
  if (action === 'explore') return 'literature-search'
  if (action === 'issue_experiment_request') return 'writing-draft'
  if (action === 'digest_uploaded_results') return 'data-analyze'
  return 'writing-outline'
}

function normalizeToolPlan(value: unknown, action: YoloTurnAction): PlannerToolPlanStep[] {
  if (!Array.isArray(value)) {
    return [{
      step: 1,
      tool: defaultToolForAction(action),
      goal: 'Execute one bounded step that advances the current focus.',
      output_contract: 'Return one concrete output that can be committed this turn.'
    }]
  }

  const normalized: PlannerToolPlanStep[] = []
  for (const item of value) {
    if (!isObject(item)) continue
    const stepRaw = item.step
    const step = typeof stepRaw === 'number' && Number.isFinite(stepRaw) && stepRaw > 0
      ? Math.round(stepRaw)
      : normalized.length + 1
    const tool = normalizeString(item.tool)
    const goal = normalizeString(item.goal)
    const outputContract = normalizeString(item.output_contract)
    if (!tool || !goal || !outputContract) continue
    normalized.push({
      step,
      tool,
      goal,
      output_contract: outputContract
    })
    if (normalized.length >= 3) break
  }

  if (normalized.length > 0) {
    normalized.sort((a, b) => a.step - b.step)
    return normalized
  }

  return [{
    step: 1,
    tool: defaultToolForAction(action),
    goal: 'Execute one bounded step that advances the current focus.',
    output_contract: 'Return one concrete output that can be committed this turn.'
  }]
}

function normalizeNeedFromUser(value: unknown, action: YoloTurnAction): PlannerContract['need_from_user'] {
  const requiredByDefault = action === 'issue_experiment_request'
  if (!isObject(value)) {
    return {
      required: requiredByDefault,
      request: requiredByDefault
        ? 'Please execute the experiment request and upload required files.'
        : 'No external input required for this turn.',
      required_files: requiredByDefault ? ['raw_traces.jsonl', 'summary_percentiles.csv', 'env_info.txt'] : []
    }
  }

  const request = normalizeString(value.request)
  return {
    required: typeof value.required === 'boolean' ? value.required : requiredByDefault,
    request: request ?? (requiredByDefault
      ? 'Please execute the experiment request and upload required files.'
      : 'No external input required for this turn.'),
    required_files: normalizeStringArray(value.required_files, 8)
  }
}

function normalizePlanContract(raw: unknown, input: PlannerInput): PlannerContract | undefined {
  if (!isObject(raw)) return undefined

  const root = isObject(raw.planContract) ? raw.planContract : raw
  const turnSpec = isObject(raw.turnSpec) ? raw.turnSpec : (isObject(raw) ? raw : undefined)

  const fallbackAction = defaultActionForStage(input.stage)
  const expectedOutputHint = normalizeExpectedOutput(root.expected_output, fallbackAction)
  const inferredAction = inferActionFromExpectedOutput(expectedOutputHint) ?? fallbackAction
  const action = normalizeTurnAction(root.action, inferredAction)
  const expectedOutput = normalizeExpectedOutput(root.expected_output, action)

  const objectiveFallback = normalizeString(root.objective)
    ?? normalizeString(turnSpec?.objective)
    ?? `Advance ${input.stage} on: ${input.goal}`

  const currentFocus = normalizeString(root.current_focus) ?? objectiveFallback
  const whyNow = normalizeString(root.why_now)
    ?? 'This is the highest-leverage bounded step given current stage and budget.'
  const doneDefinition = normalizeString(root.done_definition)
    ?? `Complete one auditable ${expectedOutput.join('/')} output for this turn.`
  const toolPlan = normalizeToolPlan(root.tool_plan, action)

  return {
    current_focus: currentFocus,
    why_now: whyNow,
    action,
    tool_plan: toolPlan,
    expected_output: expectedOutput,
    need_from_user: normalizeNeedFromUser(root.need_from_user, action),
    done_definition: doneDefinition,
    risk_flags: normalizeStringArray(root.risk_flags, 5)
  }
}

function normalizeExpectedAssetsFromContract(contract: PlannerContract): string[] {
  if (contract.expected_output.length > 0) return contract.expected_output
  return defaultExpectedOutputForAction(contract.action)
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
    maxToolCalls: Math.max(defaults.maxToolCalls, safePositiveInt(raw.maxToolCalls, defaults.maxToolCalls)),
    maxWallClockSec: Math.max(defaults.maxWallClockSec, safePositiveInt(raw.maxWallClockSec, defaults.maxWallClockSec)),
    maxStepCount: Math.max(defaults.maxStepCount, safePositiveInt(raw.maxStepCount, defaults.maxStepCount)),
    // Keep asset fan-out floor at baseline in lean runtime to avoid false hard-fails.
    maxNewAssets: Math.max(defaults.maxNewAssets, safePositiveInt(raw.maxNewAssets, defaults.maxNewAssets)),
    maxDiscoveryOps: Math.max(defaults.maxDiscoveryOps, safePositiveInt(raw.maxDiscoveryOps, defaults.maxDiscoveryOps)),
    maxReadBytes: Math.max(defaults.maxReadBytes, safePositiveInt(raw.maxReadBytes, defaults.maxReadBytes)),
    // Keep token ceilings at or above baseline to avoid impossible hard-fail budgets
    // when tool schema overhead is non-trivial (especially in lean_v2 with literature packs).
    maxPromptTokens: Math.max(defaults.maxPromptTokens, safePositiveInt(raw.maxPromptTokens, defaults.maxPromptTokens)),
    maxCompletionTokens: Math.max(defaults.maxCompletionTokens, safePositiveInt(raw.maxCompletionTokens, defaults.maxCompletionTokens)),
    maxTurnTokens: Math.max(defaults.maxTurnTokens, safePositiveInt(raw.maxTurnTokens, defaults.maxTurnTokens)),
    maxTurnCostUsd: Math.max(defaults.maxTurnCostUsd, safePositiveFloat(raw.maxTurnCostUsd, defaults.maxTurnCostUsd))
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

function buildTurnSpecFromContract(
  contract: PlannerContract,
  rawTurnSpec: unknown,
  input: PlannerInput
): TurnSpec {
  const raw = isObject(rawTurnSpec) ? rawTurnSpec : {}
  const branch = isObject(raw.branch) ? raw.branch : {}
  const stage = (typeof raw.stage === 'string' && /^S[1-5]$/.test(raw.stage))
    ? raw.stage as YoloStage
    : input.stage

  const expectedAssets = Array.isArray(raw.expectedAssets)
    ? raw.expectedAssets.filter((item): item is string => typeof item === 'string')
    : normalizeExpectedAssetsFromContract(contract)

  return {
    turnNumber: input.turnNumber,
    stage,
    branch: {
      activeBranchId: input.activeBranchId,
      activeNodeId: input.activeNodeId,
      action: normalizeBranchAction(branch.action, input.phase),
      targetNodeId: typeof branch.targetNodeId === 'string' ? branch.targetNodeId : undefined
    },
    objective: normalizeString(raw.objective) ?? contract.current_focus,
    expectedAssets: expectedAssets.length > 0 ? expectedAssets : normalizeExpectedAssetsFromContract(contract),
    constraints: normalizeConstraints(raw.constraints)
  }
}

function normalizePlannerOutput(
  raw: Record<string, unknown>,
  input: PlannerInput
): PlannerOutput | undefined {
  const planContract = normalizePlanContract(raw, input)
  if (!planContract) return undefined

  const turnSpec = buildTurnSpecFromContract(
    planContract,
    isObject(raw.turnSpec) ? raw.turnSpec : raw,
    input
  )

  return {
    turnSpec,
    suggestedPrompt: typeof raw.suggestedPrompt === 'string'
      ? raw.suggestedPrompt
      : `Turn ${input.turnNumber}: ${planContract.current_focus}`,
    rationale: typeof raw.rationale === 'string'
      ? raw.rationale
      : planContract.why_now,
    uncertaintyNote: typeof raw.uncertaintyNote === 'string'
      ? raw.uncertaintyNote
      : (planContract.risk_flags.length > 0
        ? `Risk flags: ${planContract.risk_flags.join(', ')}`
        : ''),
    planContract
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildStageGuidance(stage: YoloStage): string {
  const guidance: Record<YoloStage, string> = {
    S1: [
      'S1 (Define): tighten the ResearchQuestion and boundary assumptions.',
      'Prefer explore/refine_question unless there is already enough context for an executable request.',
      'Keep outputs short, concrete, and free of taxonomy inflation.'
    ].join(' '),
    S2: [
      'S2 (Request): produce an outsource-ready ExperimentRequest plan.',
      'Focus on objective, setup, method steps, controls, metrics, expected result, and upload checklist.',
      'Do not propose in-process heavy/system experiments.'
    ].join(' '),
    S3: [
      'S3 (Bridge): improve ExperimentRequest quality or digest newly uploaded results.',
      'Prefer one high-quality executable request over multiple shallow tasks.',
      'Make `need_from_user` explicit when external execution is required.'
    ].join(' '),
    S4: [
      'S4 (Digest): convert uploaded results into ResultInsight with clear bottlenecks and next optimization direction.',
      'Avoid process-heavy artifacts; prioritize direct technical insight.'
    ].join(' '),
    S5: [
      'S5 (Closure): consolidate final ResultInsight and actionable recommendations.',
      'No new process layers; finish with clear, bounded closure outputs.'
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
    'Use non-advance actions only when non-progress or repeated gate loops are explicit.'
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
      'Tighten scope and tool plan.',
      'Prefer consolidation over exploration sprawl.'
    ].join(' ')
  }
  return [
    'Budget: critical (<20% turns remaining).',
    'Pick the smallest action that creates irreversible progress.',
    'Keep tool_plan minimal and avoid speculative work.'
  ].join(' ')
}

function buildPlannerPrompt(input: PlannerInput): string {
  const sections = [
    [
      'You are the YOLO-Scholar turn planner. Produce one plan contract as strict JSON.',
      'Primary required schema:',
      JSON.stringify({
        current_focus: 'string',
        why_now: 'string',
        action: 'explore|refine_question|issue_experiment_request|digest_uploaded_results',
        tool_plan: [{ step: 'number', tool: 'string', goal: 'string', output_contract: 'string' }],
        expected_output: ['string'],
        need_from_user: {
          required: 'boolean',
          request: 'string',
          required_files: ['string']
        },
        done_definition: 'string',
        risk_flags: ['string'],
        turnSpec: {
          stage: 'S1|S2|S3|S4|S5',
          branch: { action: 'advance|fork|revisit|merge|prune', targetNodeId: 'string(optional)' },
          objective: 'string',
          expectedAssets: ['string'],
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
      }, null, 2),
      'Rules: tool_plan min=1 max=3; keep action and expected_output consistent; no process theater.'
    ].join('\n'),

    buildStageGuidance(input.stage),
    buildBranchGuidance(input.phase),
    buildBudgetGuidance(input.remainingBudget),

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
      `Merged user inputs: ${JSON.stringify(input.mergedUserInputs)}`
    ].join('\n'),

    [
      'Stage gate status:',
      ...Object.entries(input.previousStageGateStatus).map(
        ([stage, status]) => `  ${stage}: ${status}`
      )
    ].join('\n'),

    input.lastTurnSummaries.length > 0
      ? [
          'Recent turn history:',
          ...input.lastTurnSummaries.map(
            (s) => `  Turn ${s.turnNumber} [${s.stage}]: ${s.objective} (created: ${s.assetsCreated}, updated: ${s.assetsUpdated})`
          )
        ].join('\n')
      : 'No previous turns completed yet.',

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

    input.planContent
      ? `Current research plan:\n${input.planContent}`
      : 'No research plan document yet.',

    input.branchDossierContent
      ? `Active branch dossier:\n${input.branchDossierContent}`
      : 'No branch dossier for active branch yet.'
  ]

  return sections.join('\n\n')
}

function createFallbackPlanContract(input: PlannerInput): PlannerContract {
  const action = defaultActionForStage(input.stage)
  return {
    current_focus: 'consolidate current state and report blockers',
    why_now: 'Planner fallback path preserves forward progress with conservative scope.',
    action,
    tool_plan: [{
      step: 1,
      tool: defaultToolForAction(action),
      goal: 'Produce one conservative, auditable turn output.',
      output_contract: 'Return one bounded asset and list blockers clearly.'
    }],
    expected_output: defaultExpectedOutputForAction(action),
    need_from_user: {
      required: false,
      request: 'No external input required for fallback planning.',
      required_files: []
    },
    done_definition: 'One conservative turn output is produced with constraints respected.',
    risk_flags: ['planner_fallback']
  }
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

function createFallbackOutput(input: PlannerInput): PlannerOutput {
  const planContract = createFallbackPlanContract(input)
  return {
    turnSpec: createConservativeFallbackSpec({
      turnNumber: input.turnNumber,
      stage: input.stage,
      activeBranchId: input.activeBranchId,
      activeNodeId: input.activeNodeId
    }),
    suggestedPrompt: `Turn ${input.turnNumber}: consolidate current state and report blockers`,
    rationale: 'LLM planner fallback - conservative advance with default constraints.',
    uncertaintyNote: 'Planner could not produce a valid plan; falling back to conservative spec.',
    planContract
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
        return fallback
      }

      if (!runResult.success) {
        return fallback
      }

      const parsed = parsePlannerJson(runResult.output)
      if (!parsed) {
        return fallback
      }

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
  normalizePlanContract,
  buildTurnSpecFromContract,
  normalizeConstraints,
  normalizeBranchAction,
  buildPlannerPrompt,
  createFallbackOutput
}
