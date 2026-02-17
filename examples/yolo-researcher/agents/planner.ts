import { createAgent, packs } from '../../../src/index.js'
import type { AgentRunResult } from '../../../src/index.js'

import { buildDefaultP0Constraints, createConservativeFallbackSpec } from '../runtime/planner.js'
import { detectCodingIntentHeuristic } from './intent-router.js'
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

function hasCodingIntent(input: PlannerInput): boolean {
  if (input.intentRoute) return input.intentRoute.isCoding
  return detectCodingIntentHeuristic(input).isCoding
}

const CLOUDLAB_INTENT_PATTERNS: readonly RegExp[] = [
  /\b(cloudlab|powder|emulab|portal api|portal-cli|resgroup|reservation group|geni-lib|cluster reservation)\b/i,
  /\b(distributed experiment|distributed benchmark|multi-node|multinode|cluster node|artifact evaluation)\b/i,
  /(云实验|分布式实验|多节点|集群实验|CloudLab|Powder|Portal API)/i
]

function hasCloudlabIntent(input: PlannerInput): boolean {
  const corpus = [
    input.goal,
    input.researchContext,
    input.planContent,
    input.branchDossierContent,
    ...input.mergedUserInputs.map((item) => item.text)
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')

  if (!corpus) return false
  return CLOUDLAB_INTENT_PATTERNS.some((pattern) => pattern.test(corpus))
}

function defaultExpectedOutputForStage(stage: YoloStage): string[] {
  if (stage === 'S1') return ['Note', 'ResearchQuestion']
  if (stage === 'S2' || stage === 'S3') return ['ExperimentRequest']
  if (stage === 'S4') return ['ResultInsight']
  return ['Note']
}

function defaultToolPlanForStage(stage: YoloStage, input?: PlannerInput): PlannerToolPlanStep[] {
  const codingIntent = input ? hasCodingIntent(input) : false
  const cloudlabIntent = input ? hasCloudlabIntent(input) : false

  if (codingIntent && !cloudlabIntent && stage === 'S1') return [
    {
      step: 1,
      tool: 'skill-script-run',
      goal: 'Run coding-large-repo/repo-intake to capture repository state and candidate verification commands.',
      output_contract: 'Repo intake summary with branch, dirty-state, and verify command candidates.'
    },
    {
      step: 2,
      tool: 'bash',
      goal: 'Execute one minimal local verification command to confirm the environment for coding changes.',
      output_contract: 'A concrete local command outcome with pass/fail notes.'
    },
    {
      step: 3,
      tool: 'literature-search',
      goal: 'Collect targeted prior-art context that informs implementation scope or baseline behavior.',
      output_contract: 'Key findings as Note.'
    }
  ]

  if (codingIntent && !cloudlabIntent && (stage === 'S2' || stage === 'S3')) return [
    {
      step: 1,
      tool: 'skill-script-run',
      goal: 'Run coding-large-repo/change-plan to generate a scoped edit plan before touching files.',
      output_contract: 'A scoped coding change plan path and checklist.'
    },
    {
      step: 2,
      tool: 'skill-script-run',
      goal: 'Run coding-large-repo/delegate-coding-agent to execute implementation via Codex/Claude with concrete command evidence.',
      output_contract: 'A coding-agent execution record (provider, command, exit status, log path).'
    },
    {
      step: 3,
      tool: 'skill-script-run',
      goal: 'Run coding-large-repo/verify-targets for focused regression validation (Docker-preferred runtime with host fallback) and log capture.',
      output_contract: 'Verification status, effective runtime, fallback indicator, and log path for audit evidence.'
    },
    {
      step: 4,
      tool: 'writing-draft',
      goal: 'Summarize implementation deltas, verification evidence, and remaining blockers.',
      output_contract: 'ExperimentRequest or Note with executable next actions.'
    }
  ]

  if (cloudlabIntent && stage === 'S1') return [
    {
      step: 1,
      tool: 'literature-search',
      goal: 'Survey CloudLab/Powder prior-art and reproducibility baselines before freezing the research question.',
      output_contract: 'Key prior-art findings as Note.'
    },
    {
      step: 2,
      tool: 'skill-script-run',
      goal: 'Run cloudlab-distributed-experiments/portal-intake to validate token, portal endpoint, and local orchestration readiness.',
      output_contract: 'Structured readiness report with blocked prerequisites (if any).'
    },
    {
      step: 3,
      tool: 'writing-outline',
      goal: 'Refine a testable CloudLab experiment question and minimum viable benchmark path.',
      output_contract: 'ResearchQuestion.'
    }
  ]

  if (cloudlabIntent && (stage === 'S2' || stage === 'S3')) return [
    {
      step: 1,
      tool: 'literature-search',
      goal: 'Collect benchmark and methodology references relevant to the CloudLab experiment setup.',
      output_contract: 'Targeted baseline citations and experimental caveats.'
    },
    {
      step: 2,
      tool: 'skill-script-run',
      goal: 'Run cloudlab-distributed-experiments lifecycle scripts (portal-intake/create/wait-ready/hosts) for a minimal local reproducibility slice.',
      output_contract: 'Experiment id, readiness status, and host inventory evidence.'
    },
    {
      step: 3,
      tool: 'skill-script-run',
      goal: 'Run cloudlab-distributed-experiments/distributed-ssh and collect-artifacts for at least one concrete command path.',
      output_contract: 'Per-host execution logs and collected output summary.'
    },
    {
      step: 4,
      tool: 'skill-script-run',
      goal: 'Run cloudlab-distributed-experiments/experiment-terminate after evidence capture to avoid resource leaks.',
      output_contract: 'Structured teardown confirmation.'
    },
    {
      step: 5,
      tool: 'writing-draft',
      goal: 'Produce executable ExperimentRequest with verified command sequence and explicit fallback boundaries.',
      output_contract: 'ExperimentRequest.'
    }
  ]

  if (stage === 'S1') return [
    { step: 1, tool: 'literature-search', goal: 'Survey related work and prior art.', output_contract: 'Key findings as Note.' },
    { step: 2, tool: 'bash', goal: 'Run one small local smoke check to validate environment and feasibility of the first benchmark path.', output_contract: 'A concrete local command outcome with pass/fail notes.' },
    { step: 3, tool: 'writing-outline', goal: 'Synthesize findings into a focused research question and a first runnable hypothesis.', output_contract: 'ResearchQuestion.' }
  ]
  if (stage === 'S2' || stage === 'S3') return [
    { step: 1, tool: 'literature-search', goal: 'Find prior benchmarks relevant to experiment design.', output_contract: 'Targeted literature findings.' },
    { step: 2, tool: 'bash', goal: 'Run a minimal local baseline or dry-run command before outsourcing; capture concrete blockers if execution fails.', output_contract: 'At least one local execution attempt with command-level evidence.' },
    { step: 3, tool: 'writing-draft', goal: 'Draft executable experiment request with locally validated commands and explicit external-only gaps.', output_contract: 'ExperimentRequest with method steps and clear fallback boundaries.' }
  ]
  if (stage === 'S4') return [
    { step: 1, tool: 'data-analyze', goal: 'Analyze uploaded and local run results to extract key metrics.', output_contract: 'ResultInsight with findings.' },
    { step: 2, tool: 'bash', goal: 'If findings are ambiguous, run one local sanity-check command to confirm direction.', output_contract: 'A concise local sanity-check record (or explicit failure reason).' }
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

function normalizeToolPlan(value: unknown, stage: YoloStage, input?: PlannerInput): PlannerToolPlanStep[] {
  if (!Array.isArray(value)) return defaultToolPlanForStage(stage, input)

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

  return defaultToolPlanForStage(stage, input)
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
  const toolPlan = normalizeToolPlan(root.tool_plan, input.stage, input)

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
      'For repository-scale coding tasks, begin with skill-script-run using skillId="coding-large-repo" and script="repo-intake".',
      'For CloudLab/Powder distributed infra tasks, run skill-script-run with skillId="cloudlab-distributed-experiments" and script="portal-intake" after literature-search.',
      'Use bash to run at least one small local smoke-check command when feasible.',
      'Combine with writing-outline to produce a focused research question.',
      'If a local command fails, try one alternative path before asking the user.',
      'Multi-tool plans are encouraged.',
      'Keep outputs concrete and free of taxonomy inflation.'
    ].join(' '),
    S2: [
      'S2 (Request): produce an outsource-ready ExperimentRequest plan.',
      'Focus on objective, setup, method steps, controls, metrics, expected result, and upload checklist.',
      'Default to local-first: attempt a minimal runnable slice with bash before asking the user to execute.',
      'For non-trivial code modifications, include skill-script-run steps with skillId="coding-large-repo" (repo-intake/change-plan/delegate-coding-agent/verify-targets; use agent-start/agent-poll for long runs). Keep verify-targets Docker-preferred (`--runtime auto`) and rely on host fallback only when Docker is unavailable.',
      'For CloudLab/Powder distributed experiments, prefer skill-script-run with skillId=\"cloudlab-distributed-experiments\" (portal-intake -> experiment-create -> experiment-wait-ready -> experiment-hosts -> distributed-ssh -> collect-artifacts -> experiment-terminate).',
      'When CloudLab capacity or setup is uncertain, include resgroup-search/resgroup-create and profile-create/profile-update before experiment-create.',
      'Only set need_from_user.required=true after local attempts are blocked by permissions, missing credentials, missing hardware, or unacceptable runtime cost.',
      'Literature review can be revisited here for targeted deep-dives on specific sub-questions (e.g., prior benchmarks, competing methods).'
    ].join(' '),
    S3: [
      'S3 (Bridge): improve ExperimentRequest quality or digest newly uploaded results.',
      'Prefer one high-quality executable request over multiple shallow tasks.',
      'When the turn includes codebase edits, keep coding-large-repo skill-script-run steps explicit in tool_plan (delegate-coding-agent or agent-start/poll) before broad bash loops.',
      'When the turn includes CloudLab/Powder infra execution, keep cloudlab-distributed-experiments skill-script-run steps explicit in tool_plan and include teardown.',
      'Add reservation/profile management sub-steps when resource contention or profile drift is likely.',
      'Make `need_from_user` explicit only when external execution is genuinely required after local attempts.',
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
      '- For medium/large repository code changes, prefer skill-script-run with skillId="coding-large-repo" (repo-intake -> change-plan -> delegate-coding-agent -> verify-targets; use agent-start/agent-poll for long runs) before open-ended bash edits.',
      '- For CloudLab/Powder distributed experiment orchestration, prefer skill-script-run with skillId="cloudlab-distributed-experiments" (portal-intake -> experiment-create -> experiment-wait-ready -> experiment-hosts -> distributed-ssh -> collect-artifacts -> experiment-terminate).',
      '- Add cloudlab reservation/profile scripts (resgroup-search/resgroup-create/profile-create/profile-update) when resource guarantees or profile updates are needed.',
      '- Keep coding delegation on host (delegate-coding-agent), but run verify-targets with Docker-preferred runtime (`--runtime auto`) unless there is a clear reason to force host.',
      '- Multi-tool plans are encouraged: combine literature-search + bash + writing-draft in one turn when useful.',
      '- action is a free-form label for logging — it does NOT restrict which tools the coordinator may use.',
      '- planContract.action and expected_output should be consistent in intent.',
      '- Default to local-first execution: include bash/data-analyze steps when experiments can be probed locally.',
      '- Keep need_from_user.required=false unless you are truly blocked after concrete local attempts.',
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
      input.intentRoute
        ? `IntentRoute: label=${input.intentRoute.label}; coding=${String(input.intentRoute.isCoding)}; confidence=${input.intentRoute.confidence.toFixed(2)}; source=${input.intentRoute.source}`
        : undefined,
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
    tool_plan: defaultToolPlanForStage(input.stage, input),
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
  hasCodingIntent,
  hasCloudlabIntent,
  buildPlannerPrompt,
  createFallbackOutput
}
