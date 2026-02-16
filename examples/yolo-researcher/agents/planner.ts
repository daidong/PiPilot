import { createAgent, packs } from '../../../src/index.js'
import type { AgentRunResult } from '../../../src/index.js'

import { buildDefaultP0Constraints, createConservativeFallbackSpec } from '../runtime/planner.js'
import type {
  AgentLike,
  PlannerContract,
  PlannerInput,
  PlannerOutput,
  PlannerToolPlanStep,
  TurnConstraints,
  TurnPlanner,
  TurnSpec,
  YoloStage
} from '../runtime/types.js'

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
  'Be resourceful — plan for action, not negotiation. Prefer plans that use available tools and make progress over plans that ask clarifying questions.',
  'Be budget-aware and stage-appropriate.'
].join(' ')

const DEFAULT_CONSTRAINTS = [
  'Output strict JSON only.',
  'Do not fabricate asset references.',
  'Keep tool_plan <= 5 steps.',
  'Use plain language and concrete execution intent.',
  'Do not use ctx-get in planner; rely on provided turn context only.'
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

function normalizeTurnAction(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function defaultExpectedOutputForStage(stage: YoloStage): string[] {
  if (stage === 'S1') return ['Note', 'ResearchQuestion']
  if (stage === 'S2' || stage === 'S3') return ['ExperimentRequest']
  if (stage === 'S4') return ['ResultInsight']
  return ['Note']
}

function defaultToolPlanForStage(stage: YoloStage): PlannerToolPlanStep[] {
  if (stage === 'S1') return [
    { step: 1, tool: 'literature-search', goal: 'Survey related work and prior art.', output_contract: 'Key findings as Note.' },
    { step: 2, tool: 'writing-outline', goal: 'Synthesize findings into a research question.', output_contract: 'ResearchQuestion.' }
  ]
  if (stage === 'S2' || stage === 'S3') return [
    { step: 1, tool: 'literature-search', goal: 'Find prior benchmarks relevant to experiment design.', output_contract: 'Targeted literature findings.' },
    { step: 2, tool: 'writing-draft', goal: 'Draft executable experiment request.', output_contract: 'ExperimentRequest with method steps.' }
  ]
  if (stage === 'S4') return [
    { step: 1, tool: 'data-analyze', goal: 'Analyze uploaded results and extract key metrics.', output_contract: 'ResultInsight with findings.' }
  ]
  return [
    { step: 1, tool: 'writing-draft', goal: 'Consolidate final insights.', output_contract: 'Final synthesis Note.' }
  ]
}

function normalizeExpectedOutput(value: unknown, stage: YoloStage): string[] {
  const raw = normalizeStringArray(value)
  if (raw.length > 0) return raw
  return defaultExpectedOutputForStage(stage)
}

function normalizeToolPlan(value: unknown, stage: YoloStage): PlannerToolPlanStep[] {
  if (!Array.isArray(value)) return defaultToolPlanForStage(stage)

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
    if (normalized.length >= 5) break
  }

  if (normalized.length > 0) {
    normalized.sort((a, b) => a.step - b.step)
    return normalized
  }

  return defaultToolPlanForStage(stage)
}

function normalizeNeedFromUser(value: unknown): PlannerContract['need_from_user'] {
  const requiredByDefault = false
  if (!isObject(value)) {
    return {
      required: requiredByDefault,
      request: requiredByDefault
        ? 'Please execute the experiment request and upload required files.'
        : 'No external input required for this turn.',
      required_files: []  // Let the coordinator and experiment-request skill determine required files per experiment
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

  const action = normalizeTurnAction(root.action) ?? `stage_${input.stage.toLowerCase()}_default`
  const expectedOutput = normalizeExpectedOutput(root.expected_output, input.stage)

  const objectiveFallback = normalizeString(root.objective)
    ?? normalizeString(turnSpec?.objective)
    ?? `Advance ${input.stage} on: ${input.goal}`

  const currentFocus = normalizeString(root.current_focus) ?? objectiveFallback
  const whyNow = normalizeString(root.why_now)
    ?? 'This is the highest-leverage bounded step given current stage and budget.'
  const doneDefinition = normalizeString(root.done_definition)
    ?? `Complete one auditable ${expectedOutput.join('/')} output for this turn.`
  const toolPlan = normalizeToolPlan(root.tool_plan, input.stage)

  return {
    current_focus: currentFocus,
    why_now: whyNow,
    action,
    tool_plan: toolPlan,
    expected_output: expectedOutput,
    need_from_user: normalizeNeedFromUser(root.need_from_user),
    done_definition: doneDefinition,
    risk_flags: normalizeStringArray(root.risk_flags, 5)
  }
}

function normalizeExpectedAssetsFromContract(contract: PlannerContract, stage: YoloStage): string[] {
  if (contract.expected_output.length > 0) return contract.expected_output
  return defaultExpectedOutputForStage(stage)
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
  action: unknown
): TurnSpec['branch']['action'] {
  if (typeof action !== 'string' || !VALID_BRANCH_ACTIONS.has(action)) return 'advance'
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
    : normalizeExpectedAssetsFromContract(contract, stage)

  return {
    turnNumber: input.turnNumber,
    stage,
    branch: {
      activeBranchId: input.activeBranchId,
      activeNodeId: input.activeNodeId,
      action: normalizeBranchAction(branch.action),
      targetNodeId: typeof branch.targetNodeId === 'string' ? branch.targetNodeId : undefined
    },
    objective: normalizeString(raw.objective) ?? contract.current_focus,
    expectedAssets: expectedAssets.length > 0 ? expectedAssets : normalizeExpectedAssetsFromContract(contract, stage),
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
      'S1 (Define): understand the research topic and define a testable research question.',
      'Start with literature-search to find related work.',
      'Use bash to run quick local experiments when feasible.',
      'Combine with writing-outline to produce a focused research question.',
      'Multi-tool plans are encouraged.',
      'Keep outputs concrete and free of taxonomy inflation.'
    ].join(' '),
    S2: [
      'S2 (Request): produce an outsource-ready ExperimentRequest plan.',
      'Focus on objective, setup, method steps, controls, metrics, expected result, and upload checklist.',
      'Use bash to run experiments locally when the environment supports it, rather than only writing protocols for the user.',
      'Literature review can be revisited here for targeted deep-dives on specific sub-questions (e.g., prior benchmarks, competing methods).'
    ].join(' '),
    S3: [
      'S3 (Bridge): improve ExperimentRequest quality or digest newly uploaded results.',
      'Prefer one high-quality executable request over multiple shallow tasks.',
      'Make `need_from_user` explicit when external execution is required.',
      'If experiment design has open questions about prior art, call literature-search before finalizing.'
    ].join(' '),
    S4: [
      'S4 (Digest): convert uploaded results into ResultInsight with clear bottlenecks and next optimization direction.',
      'Avoid process-heavy artifacts; prioritize direct technical insight.',
      'When interpreting results, consider calling literature-search to contextualize findings against published baselines.'
    ].join(' '),
    S5: [
      'S5 (Closure): consolidate final ResultInsight and actionable recommendations.',
      'No new process layers; finish with clear, bounded closure outputs.'
    ].join(' ')
  }
  return guidance[stage]
}

function buildBranchGuidance(): string {
  return 'Lean default branch policy: runtime manages branching; omit turnSpec.branch unless there is a clear, explicit need to override. Prefer action=advance.'
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
      'You are the YOLO-Scholar turn planner.',
      'Goal: choose one bounded, highest-leverage action that creates irreversible research progress this turn.',
      'Return strict JSON only.',
      'Required schema:',
      JSON.stringify({
        planContract: {
          current_focus: 'string',
          action: 'string — free-form intent label describing what this turn will do',
          tool_plan: [{ step: 'number', tool: 'string', goal: 'string', output_contract: 'string' }],
          done_definition: 'string',
          need_from_user: {
            required: 'boolean',
            request: 'string',
            required_files: ['string']
          },
          why_now: 'string(optional)',
          expected_output: ['string(optional)'],
          risk_flags: ['string(optional)']
        },
        suggestedPrompt: 'string(optional)',
        rationale: 'string(optional)',
        uncertaintyNote: 'string(optional)',
        turnSpec: {
          note: 'optional advanced override; omit unless strictly needed'
        }
      }, null, 2),
      'Rules:',
      '- tool_plan must be 1-5 concrete steps.',
      '- Each step should name an available tool (literature-search, bash, writing-draft, data-analyze, etc.).',
      '- Multi-tool plans are encouraged: combine literature-search + bash + writing-draft in one turn when useful.',
      '- action is a free-form label for logging — it does NOT restrict which tools the coordinator may use.',
      '- planContract.action and expected_output should be consistent in intent.',
      '- Prefer the smallest plan that can move the research forward now.',
      '- Avoid process/taxonomy artifacts unless directly needed for this turn.',
      '- For S2-S4, prioritize actionable ExperimentRequest quality over workflow abstraction.'
    ].join('\n'),

    input.researchContext
      ? `## User Research Context (research.md)\n\n${input.researchContext}`
      : '',

    buildStageGuidance(input.stage),
    buildBranchGuidance(),
    buildBudgetGuidance(input.remainingBudget),

    [
      `Session: ${input.sessionId}`,
      `Turn: ${input.turnNumber}`,
      `State: ${input.state}`,
      `Stage: ${input.stage}`,
      `Goal: ${input.goal}`,
      `Active branch: ${input.activeBranchId}`,
      `Active node: ${input.activeNodeId}`,
      `Non-progress turns: ${input.nonProgressTurns}`,
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
            (s) => `  Turn ${s.turnNumber} [${s.stage}]: ${s.objective} (created: ${s.assetsCreated}, updated: ${s.assetsUpdated})${s.summary ? `\n    Summary: ${s.summary}` : ''}`
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

  return sections.filter(Boolean).join('\n\n')
}

function createFallbackPlanContract(input: PlannerInput): PlannerContract {
  return {
    current_focus: 'consolidate current state and report blockers',
    why_now: 'Planner fallback path preserves forward progress with conservative scope.',
    action: 'fallback_consolidation',
    tool_plan: defaultToolPlanForStage(input.stage),
    expected_output: defaultExpectedOutputForStage(input.stage),
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
