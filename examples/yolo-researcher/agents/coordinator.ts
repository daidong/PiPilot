import { createAgent, definePack, defineTool, packs, createTokenTracker } from '../../../src/index.js'
import type { AgentRunResult, Pack, Tool, TokenTracker } from '../../../src/index.js'
import { createLiteratureSearchTool } from './literature-subagent.js'
import { createDataAnalyzeTool } from './data-subagent.js'
import { createWritingTools } from './writing-subagent.js'
import { yoloResearcherSkills } from '../skills/index.js'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  ActivityEvent,
  AgentLike,
  AskUserRequest,
  CoordinatorExecutionTraceItem,
  CoordinatorToolCallSummary,
  CoordinatorToolingStatus,
  CoordinatorTurnMetrics,
  CoordinatorTurnResult,
  PlannerOutput,
  QueuedUserInput,
  ReviewerProcessReview,
  TurnSpec,
  YoloCoordinator,
  YoloRuntimeMode,
  YoloStage,
  YoloTurnAction
} from '../runtime/types.js'
import { randomId, nowIso } from '../runtime/utils.js'

interface CoordinatorJsonAsset {
  type: string
  payload: Record<string, unknown>
  supersedes?: string
}

interface CoordinatorJsonOutput {
  action?: unknown
  actionRationale?: unknown
  summary?: unknown
  assets?: unknown
  askUser?: unknown
  execution_trace?: unknown
}

interface TurnTelemetryAccumulator {
  toolCalls: number
  discoveryOps: number
  readBytes: number
  toolSummaries: CoordinatorToolCallSummary[]
  lastAskUser?: AskUserRequest
}

interface CoordinatorCallbacks {
  onToolCall: (name: string, args: unknown) => void
  onToolResult: (name: string, result: unknown, args?: unknown) => void
  onAskUser: (request: AskUserRequest) => void
}

export interface YoloCoordinatorConfig {
  projectPath: string
  model: string
  apiKey?: string
  maxSteps?: number
  maxTokens?: number
  debug?: boolean
  identityPrompt?: string
  constraints?: string[]
  mode?: YoloRuntimeMode
  allowBash?: boolean
  enableLiteratureTools?: boolean
  enableLiteratureSubagent?: boolean
  literatureSubagentMaxCallsPerTurn?: number
  enableDataSubagent?: boolean
  dataSubagentMaxCallsPerTurn?: number
  enableWritingSubagent?: boolean
  writingSubagentMaxCallsPerTurn?: number
  enableResearchSkills?: boolean
  externalSkillsDir?: string
  watchExternalSkills?: boolean
  braveApiKey?: string
  onActivity?: (event: ActivityEvent) => void
  createAgentInstance?: (callbacks: {
    onToolCall: (name: string, args: unknown) => void
    onToolResult: (name: string, result: unknown, args?: unknown) => void
    onAskUser: (request: AskUserRequest) => void
  }) => AgentLike
}

// AgentLike is defined in runtime/types.ts
export type { AgentLike } from '../runtime/types.js'

const DEFAULT_IDENTITY = [
  'You are YOLO coordinator for one bounded research turn.',
  'Progress-first and contract-first.',
  'Prioritize concrete auditable outputs over process abstractions.',
  'Be resourceful — use every tool at your disposal, try alternative approaches when one path fails, and make things happen.',
  'Make reasonable assumptions and push forward. Only ask the user when truly blocked.'
].join('\n')

const DEFAULT_CONSTRAINTS: string[] = [
  'Produce machine-readable output only as specified.',
  'Keep outputs aligned to three core assets: ResearchQuestion, ExperimentRequest, ResultInsight.',
  'Do not fabricate evidence or external results.',
  'Never fabricate citations, DOIs, or paper details.',
  'If full text is required but unavailable, note the gap and proceed with available information.',
  'Use relative paths in asset payloads and tool arguments.',
  'Follow PlannerOutput.planContract.tool_plan as the primary execution strategy when provided.',
  'For unfamiliar domains or prior-art questions, try literature-search if available, then reason from returned results.',
  'For dataset or measurement-file questions, use data-analyze instead of manual computation in prompt space.',
  'For writing/refinement requests, use writing-outline or writing-draft to produce structured drafts.',
  'Use ctx-get only when background/literature context retrieval is truly needed; otherwise prefer explicit tools.',
  'Make reasonable assumptions based on the research topic and standard conventions unless the user specifies otherwise. Do NOT ask about obvious details you can infer or look up.',
  'Only call ask_user when you truly cannot proceed (e.g., missing credentials, fundamentally ambiguous goal). Do NOT ask about details you can reasonably assume or look up yourself.',
  'Be resourceful: when one approach fails, try alternatives. Use literature-search, data-analyze, writing tools, and file operations to find answers yourself before asking the user.'
]

const DISCOVERY_TOOL_SET = new Set([
  'glob',
  'grep',
  'read',
  'ctx-get',
  'literature-search',
  'fetch'
])

const COORDINATOR_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_EXTERNAL_SKILLS_DIR = join(COORDINATOR_DIR, '..', 'skills', 'default-project-skills')
const VALID_ACTIONS = new Set<YoloTurnAction>([
  'explore',
  'refine_question',
  'issue_experiment_request',
  'digest_uploaded_results'
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function summarizeForTelemetry(value: unknown, limit: number = 180): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value)
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return undefined
  if (compact.length <= limit) return compact
  return `${compact.slice(0, limit)}...`
}

function normalizeTurnAction(value: unknown): YoloTurnAction | undefined {
  if (typeof value !== 'string') return undefined
  const action = value.trim() as YoloTurnAction
  if (!VALID_ACTIONS.has(action)) return undefined
  return action
}

function normalizeActionRationale(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function normalizeAskUser(value: unknown): AskUserRequest | undefined {
  if (!isObject(value)) return undefined
  const required = typeof value.required === 'boolean' ? value.required : false
  const question = typeof value.question === 'string' ? value.question.trim() : ''
  if (required && !question) return undefined

  const normalized: AskUserRequest = {
    required,
    question: question || 'Need input from user to proceed.'
  }

  if (Array.isArray(value.options)) {
    normalized.options = value.options.filter((item): item is string => typeof item === 'string')
  }

  if (typeof value.context === 'string') normalized.context = value.context
  if (Array.isArray(value.required_files)) {
    normalized.requiredFiles = value.required_files
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (typeof value.checkpoint === 'string') {
    const checkpoint = value.checkpoint as AskUserRequest['checkpoint']
    if (checkpoint === 'problem-freeze' || checkpoint === 'baseline-freeze' || checkpoint === 'claim-freeze' || checkpoint === 'final-scope') {
      normalized.checkpoint = checkpoint
    }
  }

  if (typeof value.blocking === 'boolean') normalized.blocking = value.blocking
  return normalized
}

function normalizeExecutionTrace(value: unknown): CoordinatorExecutionTraceItem[] {
  if (!Array.isArray(value)) return []
  const normalized: CoordinatorExecutionTraceItem[] = []
  for (const item of value) {
    if (!isObject(item)) continue
    if (typeof item.tool !== 'string' || !item.tool.trim()) continue
    if (typeof item.reason !== 'string' || !item.reason.trim()) continue
    if (typeof item.result_summary !== 'string' || !item.result_summary.trim()) continue
    normalized.push({
      tool: item.tool.trim(),
      reason: item.reason.trim(),
      result_summary: item.result_summary.trim()
    })
  }
  return normalized
}

function buildContextCompilerView(input: {
  turnSpec: TurnSpec
  goal: string
  mergedUserInputs: QueuedUserInput[]
  plannerOutput?: PlannerOutput
  reviewerOutput?: ReviewerProcessReview
}): {
  currentFocus: string
  latestInsight: string
  needFromUser: string
} {
  const currentFocus = input.plannerOutput?.planContract.current_focus
    ?? input.turnSpec.objective
  const latestInsight = input.mergedUserInputs.length > 0
    ? input.mergedUserInputs[input.mergedUserInputs.length - 1]?.text ?? 'No recent user insight.'
    : 'No recent user insight.'
  const needFromUser = input.plannerOutput?.planContract.need_from_user?.request
    ?? input.reviewerOutput?.notes_for_user
    ?? 'Only ask user when blocked or external execution is required.'

  return {
    currentFocus,
    latestInsight,
    needFromUser
  }
}

function normalizeLeanAssetType(rawType: string): string {
  const key = rawType.trim().toLowerCase().replace(/[^a-z]/g, '')
  if (!key) return 'Note'

  if (
    key === 'researchquestion'
    || key === 'problemdefinitionpack'
    || key === 'problemdefinition'
    || key === 'problemstatement'
    || key === 'hypothesis'
    || key === 'question'
  ) {
    return 'ResearchQuestion'
  }

  if (
    key === 'experimentrequest'
    || key === 'experimentrequirement'
    || key === 'experimentrequirements'
    || key === 'measurementplan'
    || key === 'instrumentationspec'
  ) {
    return 'ExperimentRequest'
  }

  if (
    key === 'resultinsight'
    || key === 'resultinsights'
    || key === 'insight'
    || key === 'finding'
    || key === 'findings'
    || key === 'analysisresult'
  ) {
    return 'ResultInsight'
  }

  if (key === 'note' || key === 'notes') return 'Note'
  return 'Note'
}

function normalizeAssets(
  value: unknown,
  mode: YoloRuntimeMode,
  action: YoloTurnAction | undefined
): CoordinatorJsonAsset[] {
  if (!Array.isArray(value)) return []

  const normalized: CoordinatorJsonAsset[] = []
  for (const entry of value) {
    if (!isObject(entry)) continue
    if (typeof entry.type !== 'string' || !entry.type.trim()) continue
    if (!isObject(entry.payload)) continue

    const resolvedType = mode === 'lean_v2'
      ? normalizeLeanAssetType(entry.type)
      : entry.type.trim()

    const asset: CoordinatorJsonAsset = {
      type: (mode === 'lean_v2' && action === 'explore') ? 'Note' : resolvedType,
      payload: entry.payload
    }

    if (typeof entry.supersedes === 'string' && entry.supersedes.trim()) {
      asset.supersedes = entry.supersedes.trim()
    }

    normalized.push(asset)
  }

  return normalized
}

function inferActionFromAssets(assets: CoordinatorJsonAsset[]): YoloTurnAction {
  const types = new Set(assets.map((asset) => asset.type))
  if (types.has('ExperimentRequest')) return 'issue_experiment_request'
  if (types.has('ResultInsight')) return 'digest_uploaded_results'
  if (types.size > 0 && Array.from(types).every((type) => type === 'Note')) return 'explore'
  return 'refine_question'
}

function parseCoordinatorJson(rawOutput: string): CoordinatorJsonOutput | undefined {
  const text = rawOutput.trim()
  if (!text) return undefined

  const direct = tryParseJson(text)
  if (direct) return direct

  const codeFenceMatch = text.match(/```json\s*([\s\S]*?)```/i)
  if (codeFenceMatch?.[1]) {
    const parsed = tryParseJson(codeFenceMatch[1].trim())
    if (parsed) return parsed
  }

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const parsed = tryParseJson(text.slice(firstBrace, lastBrace + 1))
    if (parsed) return parsed
  }

  return undefined
}

function tryParseJson(input: string): CoordinatorJsonOutput | undefined {
  try {
    const parsed = JSON.parse(input)
    if (!isObject(parsed)) return undefined
    return parsed as CoordinatorJsonOutput
  } catch {
    return undefined
  }
}

function buildCoordinatorStageGuidance(stage: YoloStage): string {
  if (stage === 'S1') {
    return [
      '## S1 (Define) — Understand the topic and refine the research question',
      '',
      '### Research workflow:',
      '1. **Understand the topic** — if unfamiliar, start with keyword searches and background reading',
      '2. **Literature search** — survey related work to find existing approaches, published baselines, and gaps',
      '3. **Synthesize findings** — produce a Note asset summarizing related work (include "relatedWork" or "literatureReview" in the payload)',
      '4. **Refine the question** — use literature findings to tighten scope, identify gaps, and formulate testable sub-questions',
      '5. **Propose directions** — based on the literature landscape, propose concrete research ideas and hypotheses',
      '',
      'After understanding the landscape, move quickly toward experiment design.',
      'If the research question is clear and you have enough context, proceed to action=issue_experiment_request.',
      'Make standard research assumptions rather than asking the user for trivial details.',
      'Keep outputs auditable and scoped to one bounded turn.'
    ].join('\n')
  }

  if (stage === 'S2' || stage === 'S3' || stage === 'S4') {
    return [
      '## ExperimentRequest design',
      '',
      'Produce an ExperimentRequest asset that can be executed.',
      'Either run the experiment yourself if the environment is available, or prepare a clear spec for the user.',
      '',
      '### Key sections:',
      '1. **goal**: What this experiment tests and why it matters (link to hypothesis/claim)',
      '2. **methodSteps**: Numbered steps with concrete commands. Use `<PLACEHOLDER>` for variable parts.',
      '3. **expectedResult**: What success looks like — specific enough to verify',
      '4. **filesProduced**: Output files with basic schema',
      '5. **metrics**: What to measure and how to extract it from outputs',
      '6. **controls**: What varies, what stays constant',
      '',
      'Make reasonable assumptions based on the research topic rather than asking.',
      'Start with the simplest experiment that can test the hypothesis.',
      'Missing details can be iterated — do NOT block on perfection.',
      'If you need something from the user, include it in the ExperimentRequest spec rather than calling ask_user.'
    ].join('\n')
  }

  // S5
  return 'For this stage, consolidate final insights and keep outputs auditable and scoped to one bounded turn.'
}

function buildTurnPrompt(input: {
  turnSpec: TurnSpec
  stage: YoloStage
  goal: string
  mergedUserInputs: QueuedUserInput[]
  plannerOutput?: PlannerOutput
  reviewerOutput?: ReviewerProcessReview
  researchContext?: string
}, options: {
  mode: YoloRuntimeMode
  tooling: CoordinatorToolingStatus
}): string {
  const mergedInputs = input.mergedUserInputs.map((item) => ({
    id: item.id,
    text: item.text,
    priority: item.priority,
    source: item.source
  }))
  const contextView = buildContextCompilerView(input)
  const stageGuidance = buildCoordinatorStageGuidance(input.stage)

  const toolAvailabilityNote = [
    `Tooling mode: ${options.tooling.mode}.`,
    `Enabled packs: ${options.tooling.enabledPacks.join(', ') || 'none'}.`,
    options.tooling.degradeReason ? `Degrade reason: ${options.tooling.degradeReason}` : undefined
  ].filter(Boolean).join(' ')

  return [
    'Execute exactly one YOLO turn.',
    'Return STRICT JSON only (no prose).',
    'Minimum required JSON shape:',
    '{"action":"explore|refine_question|issue_experiment_request|digest_uploaded_results","actionRationale":"string","summary":"string","assets":[{"type":"string","payload":{}}],"askUser":{"required":"boolean","question":"string","blocking":"boolean"},"execution_trace":[{"tool":"string","reason":"string","result_summary":"string"}]}',
    'If you are genuinely blocked and cannot proceed with any reasonable assumption, set askUser.required=true and askUser.blocking=true. Do NOT ask about trivial details you can reasonably assume or look up — make assumptions and iterate.',
    input.researchContext
      ? `## User Research Context (research.md)\n\n${input.researchContext}`
      : undefined,
    stageGuidance,
    `Runtime mode: ${options.mode}`,
    toolAvailabilityNote,
    `Context compiler: ${JSON.stringify(contextView)}`,
    `Goal: ${input.goal}`,
    `Stage: ${input.stage}`,
    `TurnSpec: ${JSON.stringify(input.turnSpec)}`,
    `PlannerOutput: ${JSON.stringify(input.plannerOutput ?? null)}`,
    `ReviewerOutput: ${JSON.stringify(input.reviewerOutput ?? null)}`,
    `MergedUserInputs: ${JSON.stringify(mergedInputs)}`
  ].filter(Boolean).join('\n\n')
}

function collectReadBytes(result: unknown): number {
  if (!isObject(result)) return 0
  if (result.success !== true) return 0
  if (!isObject(result.data)) return 0
  const value = result.data.bytes
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function createAskUserTool(onAskUser: (request: AskUserRequest) => void) {
  return defineTool<{
    required?: boolean
    question: string
    options?: string[]
    context?: string
    required_files?: string[]
    checkpoint?: AskUserRequest['checkpoint']
    blocking?: boolean
  }, { accepted: boolean }>({
    name: 'ask_user',
    description: 'Request clarification or approval from the supervising user. Use for blocking uncertainties.',
    parameters: {
      required: { type: 'boolean', required: false, description: 'Whether this is an actionable user request for this turn.' },
      question: { type: 'string', required: true, description: 'Question to ask the user.' },
      options: { type: 'array', required: false, description: 'Optional choices for user response.' },
      context: { type: 'string', required: false, description: 'Optional context shown with the question.' },
      required_files: { type: 'array', required: false, description: 'Optional required file list for user upload.' },
      checkpoint: {
        type: 'string',
        required: false,
        description: 'Optional checkpoint type.',
        enum: ['problem-freeze', 'baseline-freeze', 'claim-freeze', 'final-scope']
      },
      blocking: { type: 'boolean', required: false, description: 'Whether the session should block for reply.' }
    },
    execute: async (input) => {
      onAskUser({
        required: input.required ?? false,
        question: input.question,
        options: input.options,
        context: input.context,
        requiredFiles: Array.isArray(input.required_files) ? input.required_files : undefined,
        checkpoint: input.checkpoint,
        blocking: input.blocking ?? false
      })
      return { success: true, data: { accepted: true } }
    }
  })
}

function buildCoordinatorMetrics(runResult: AgentRunResult, telemetry: TurnTelemetryAccumulator, subagentTracker?: TokenTracker): CoordinatorTurnMetrics {
  const usageTokens = runResult.usage?.tokens
  const usageCost = runResult.usage?.cost

  // Include subagent costs in the total turn cost
  const subagentSummary = subagentTracker?.getSummary()
  const subagentCostUsd = subagentSummary?.cost?.totalCost ?? 0

  return {
    toolCalls: telemetry.toolCalls,
    wallClockSec: Math.max(0, Math.round((runResult.durationMs / 1000) * 1000) / 1000),
    stepCount: runResult.steps,
    readBytes: telemetry.readBytes,
    promptTokens: usageTokens?.promptTokens ?? 0,
    completionTokens: usageTokens?.completionTokens ?? 0,
    turnTokens: usageTokens?.totalTokens ?? 0,
    turnCostUsd: (usageCost?.totalCost ?? 0) + subagentCostUsd,
    discoveryOps: telemetry.discoveryOps
  }
}

function chooseSummary(rawOutput: string, parsed: CoordinatorJsonOutput | undefined): string {
  if (typeof parsed?.summary === 'string' && parsed.summary.trim()) {
    return parsed.summary.trim()
  }

  const text = rawOutput.trim()
  if (!text) return 'No summary returned by coordinator.'
  if (text.length <= 240) return text
  return `${text.slice(0, 240)}...`
}

function buildExecutionTrace(
  parsed: CoordinatorJsonOutput | undefined,
  telemetry: TurnTelemetryAccumulator
): CoordinatorExecutionTraceItem[] {
  const normalized = normalizeExecutionTrace(parsed?.execution_trace)
  if (normalized.length > 0) return normalized

  if (telemetry.toolSummaries.length === 0) {
    return [{
      tool: 'none',
      reason: 'No external tools were required for this bounded turn.',
      result_summary: 'Coordinator produced output without tool calls.'
    }]
  }

  return telemetry.toolSummaries.slice(0, 8).map((item) => ({
    tool: item.tool,
    reason: item.argsPreview ? `Invoked with ${item.argsPreview}` : 'Invoked for turn execution.',
    result_summary: item.resultPreview ?? 'Tool result captured in telemetry.'
  }))
}

function fallbackNoteAsset(reason: string, rawOutput: string): CoordinatorJsonAsset {
  return {
    type: 'Note',
    payload: {
      reason,
      outputExcerpt: rawOutput.slice(0, 1000)
    }
  }
}

function createDefaultToolingStatus(reason: string): CoordinatorToolingStatus {
  return {
    mode: 'local-only',
    literatureEnabled: false,
    enabledPacks: ['safe', 'ask_user'],
    degradeReason: reason
  }
}

async function buildSelectedPacks(config: YoloCoordinatorConfig, askUserPack: Pack, subagentTracker?: TokenTracker): Promise<{
  selectedPacks: Pack[]
  tooling: CoordinatorToolingStatus
}> {
  const selectedPacks: Pack[] = [packs.safe(), askUserPack]
  const enabledPacks: string[] = ['safe', 'ask_user']

  const allowBash = config.allowBash ?? (config.mode === 'lean_v2')
  if (allowBash) {
    selectedPacks.push(packs.exec({ approvalMode: 'dangerous' }))
    enabledPacks.push('exec')
  }

  const enableLiterature = config.enableLiteratureTools ?? (config.mode === 'lean_v2')
  const enableDataSubagent = config.enableDataSubagent ?? (config.mode === 'lean_v2')
  const enableWritingSubagent = config.enableWritingSubagent ?? (config.mode === 'lean_v2')
  const enableResearchSkills = config.enableResearchSkills ?? (config.mode === 'lean_v2')

  selectedPacks.push(packs.docs())
  enabledPacks.push('docs')

  const enableLiteratureSubagent = (config.enableLiteratureSubagent ?? (config.mode === 'lean_v2')) && enableLiterature
  if (enableLiteratureSubagent) {
    const literatureSearchTool = createLiteratureSearchTool({
      apiKey: config.apiKey,
      model: config.model,
      projectPath: config.projectPath,
      sessionId: 'yolo',
      maxCallsPerTurn: config.literatureSubagentMaxCallsPerTurn ?? 1,
      tokenTracker: subagentTracker
    })
    const literaturePack: Pack = definePack({
      id: 'yolo-literature-subagent',
      description: 'YOLO local literature study subagent for deep paper search/review/synthesis with local paper persistence.',
      tools: [literatureSearchTool as unknown as Tool]
    })
    selectedPacks.push(literaturePack)
    enabledPacks.push('literature-search')
  }

  if (enableDataSubagent) {
    const dataAnalyzeTool = createDataAnalyzeTool({
      apiKey: config.apiKey,
      model: config.model,
      projectPath: config.projectPath,
      sessionId: 'yolo',
      maxCallsPerTurn: config.dataSubagentMaxCallsPerTurn ?? 2,
      tokenTracker: subagentTracker
    })
    const dataPack: Pack = definePack({
      id: 'yolo-data-subagent',
      description: 'YOLO local data analysis subagent (Python execution + structured outputs).',
      tools: [dataAnalyzeTool as unknown as Tool]
    })
    selectedPacks.push(dataPack)
    enabledPacks.push('data-analyze')
  }

  if (enableWritingSubagent) {
    const writingTools = createWritingTools({
      apiKey: config.apiKey,
      model: config.model,
      maxCallsPerTurn: config.writingSubagentMaxCallsPerTurn ?? 2,
      tokenTracker: subagentTracker
    })
    const writingPack: Pack = definePack({
      id: 'yolo-writing-subagent',
      description: 'YOLO local writing subagent for outline and draft generation.',
      tools: [
        writingTools.writingOutlineTool as unknown as Tool,
        writingTools.writingDraftTool as unknown as Tool
      ]
    })
    selectedPacks.push(writingPack)
    enabledPacks.push('writing')
  }

  if (enableResearchSkills) {
    selectedPacks.push(definePack({
      id: 'yolo-research-skills',
      description: 'Local yolo-researcher skills for literature, writing, and data analysis.',
      skills: yoloResearcherSkills,
      skillLoadingConfig: {
        lazy: ['academic-writing-skill', 'literature-skill', 'data-analysis-skill']
      }
    }))
    enabledPacks.push('skills')
  }

  let webDegradeReason: string | undefined

  if (enableLiterature) {
    try {
      const webPack = await packs.web({ braveApiKey: config.braveApiKey })
      selectedPacks.push(webPack)
      enabledPacks.push('web')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      webDegradeReason = `literature web search unavailable: ${reason}`
    }
  } else {
    webDegradeReason = 'literature tools disabled by config'
  }

  return {
    selectedPacks,
    tooling: {
      mode: enableLiterature ? 'full' : 'local-only',
      literatureEnabled: enableLiterature,
      enabledPacks,
      degradeReason: webDegradeReason
    }
  }
}

async function defaultAgentFactory(config: YoloCoordinatorConfig, callbacks: CoordinatorCallbacks): Promise<{
  agent: AgentLike
  tooling: CoordinatorToolingStatus
  subagentTracker: TokenTracker
}> {
  const askUserTool = createAskUserTool(callbacks.onAskUser)
  const askUserPack: Pack = definePack({
    id: 'yolo-ask-user',
    description: 'YOLO ask_user interaction tool',
    tools: [askUserTool as unknown as Tool]
  })

  // Shared tracker for all subagent LLM calls (writing, data, literature)
  const subagentTracker = createTokenTracker()
  subagentTracker.startRun(`subagent-${Date.now()}`)

  const { selectedPacks, tooling } = await buildSelectedPacks(config, askUserPack, subagentTracker)

  // Accumulate streaming text so each activity event contains the full running buffer
  let streamBuffer = ''
  let streamEventId = randomId('act')
  const externalSkillsDir = config.externalSkillsDir ?? DEFAULT_EXTERNAL_SKILLS_DIR
  const hasExternalSkillsDir = existsSync(externalSkillsDir)

  const agent = createAgent({
    projectPath: config.projectPath,
    apiKey: config.apiKey,
    model: config.model,
    maxSteps: config.maxSteps ?? 30,
    maxTokens: config.maxTokens,
    debug: config.debug,
    identity: config.identityPrompt ?? DEFAULT_IDENTITY,
    constraints: [...(config.constraints ?? DEFAULT_CONSTRAINTS)],
    packs: selectedPacks,
    externalSkillsDir: hasExternalSkillsDir ? externalSkillsDir : undefined,
    watchExternalSkills: config.watchExternalSkills ?? false,
    skipConfigFile: true,
    onToolCall: (name, args) => {
      // Reset stream buffer when a tool call starts (new generation segment)
      streamBuffer = ''
      streamEventId = randomId('act')
      callbacks.onToolCall(name, args)
    },
    onToolResult: (name, result, args) => callbacks.onToolResult(name, result, args),
    onStream: (text) => {
      streamBuffer += text
      // Keep the tail (~10 lines worth of content)
      const preview = streamBuffer.length > 2000
        ? '...' + streamBuffer.slice(-1997)
        : streamBuffer
      config.onActivity?.({
        id: streamEventId,
        timestamp: nowIso(),
        kind: 'llm_text',
        agent: 'coordinator',
        preview
      })
    },
    onUsage: () => {}
  })

  return {
    agent: {
      ensureInit: () => agent.ensureInit(),
      run: (prompt: string) => agent.run(prompt),
      destroy: () => agent.destroy()
    },
    tooling,
    subagentTracker
  }
}

export function createYoloCoordinator(config: YoloCoordinatorConfig): YoloCoordinator {
  let initialized = false
  let agent: AgentLike | undefined
  let toolingStatus: CoordinatorToolingStatus = createDefaultToolingStatus('agent not initialized yet')
  let currentTelemetry: TurnTelemetryAccumulator | undefined
  let subagentTracker: TokenTracker | undefined

  const callbacks: CoordinatorCallbacks = {
    onToolCall: (name, args) => {
      if (!currentTelemetry) return
      currentTelemetry.toolCalls += 1
      if (DISCOVERY_TOOL_SET.has(name)) currentTelemetry.discoveryOps += 1
      if (currentTelemetry.toolSummaries.length < 24) {
        currentTelemetry.toolSummaries.push({
          tool: name,
          argsPreview: summarizeForTelemetry(args)
        })
      }
      config.onActivity?.({
        id: randomId('act'),
        timestamp: nowIso(),
        kind: 'tool_call',
        agent: 'coordinator',
        tool: name,
        preview: summarizeForTelemetry(args, 120)
      })
    },
    onToolResult: (name, result, args) => {
      if (!currentTelemetry) return
      if (name === 'ask_user') {
        currentTelemetry.lastAskUser = normalizeAskUser(args)
      }
      if (name === 'read') {
        currentTelemetry.readBytes += collectReadBytes(result)
      }
      for (let i = currentTelemetry.toolSummaries.length - 1; i >= 0; i -= 1) {
        const item = currentTelemetry.toolSummaries[i]
        if (item.tool !== name || item.resultPreview) continue
        item.resultPreview = summarizeForTelemetry(result)
        break
      }
      config.onActivity?.({
        id: randomId('act'),
        timestamp: nowIso(),
        kind: 'tool_result',
        agent: 'coordinator',
        tool: name,
        preview: summarizeForTelemetry(result, 120)
      })
    },
    onAskUser: (request) => {
      if (!currentTelemetry) return
      currentTelemetry.lastAskUser = request
    }
  }

  const getAgent = async (): Promise<AgentLike> => {
    if (!agent) {
      if (config.createAgentInstance) {
        agent = config.createAgentInstance(callbacks)
      } else {
        const built = await defaultAgentFactory(config, callbacks)
        agent = built.agent
        toolingStatus = built.tooling
        subagentTracker = built.subagentTracker
      }
    }

    if (!initialized) {
      await agent.ensureInit()
      initialized = true
    }

    return agent
  }

  return {
    async runTurn(input): Promise<CoordinatorTurnResult> {
      const telemetry: TurnTelemetryAccumulator = {
        toolCalls: 0,
        discoveryOps: 0,
        readBytes: 0,
        toolSummaries: []
      }
      currentTelemetry = telemetry
      let runResult: AgentRunResult
      try {
        const coordinatorAgent = await getAgent()
        const runPrompt = buildTurnPrompt(input, {
          mode: config.mode ?? 'legacy',
          tooling: toolingStatus
        })
        runResult = await coordinatorAgent.run(runPrompt)
      } finally {
        currentTelemetry = undefined
      }

      if (!runResult.success) {
        return {
          action: 'refine_question',
          actionRationale: 'Coordinator failed to execute turn; produced fallback Note to preserve auditability.',
          summary: runResult.error ? `Coordinator run failed: ${runResult.error}` : 'Coordinator run failed',
          assets: [fallbackNoteAsset('coordinator_run_failed', runResult.output)],
          askUser: {
            required: true,
            question: 'Run failed. Do you want to retry this turn with tighter scope?',
            blocking: true
          },
          executionTrace: buildExecutionTrace(undefined, telemetry),
          metrics: buildCoordinatorMetrics(runResult, telemetry, subagentTracker),
          toolCalls: telemetry.toolSummaries,
          tooling: toolingStatus
        }
      }

      const parsed = parseCoordinatorJson(runResult.output)
      const requestedAction = normalizeTurnAction(parsed?.action)
      const normalizedAssets = normalizeAssets(parsed?.assets, config.mode ?? 'legacy', requestedAction)
      const action = requestedAction ?? inferActionFromAssets(normalizedAssets)
      const actionRationale = normalizeActionRationale(parsed?.actionRationale)
        ?? `Selected action "${action}" based on generated assets.`
      const askUser = telemetry.lastAskUser ?? normalizeAskUser(parsed?.askUser) ?? {
        required: false,
        question: 'No user action required this turn.',
        blocking: false
      }

      const assets = normalizedAssets.length > 0
        ? normalizedAssets
        : [fallbackNoteAsset('coordinator_output_missing_assets', runResult.output)]

      return {
        action,
        actionRationale,
        summary: chooseSummary(runResult.output, parsed),
        assets,
        askUser,
        executionTrace: buildExecutionTrace(parsed, telemetry),
        metrics: buildCoordinatorMetrics(runResult, telemetry, subagentTracker),
        toolCalls: telemetry.toolSummaries,
        tooling: toolingStatus
      }
    }
  }
}

export function createStaticYoloCoordinator(result: CoordinatorTurnResult): YoloCoordinator {
  return {
    async runTurn() {
      return result
    }
  }
}

export const __private = {
  parseCoordinatorJson,
  normalizeAssets,
  normalizeAskUser,
  normalizeExecutionTrace,
  buildContextCompilerView,
  normalizeTurnAction,
  inferActionFromAssets,
  buildTurnPrompt,
  collectReadBytes,
  buildExecutionTrace,
  buildCoordinatorMetrics
}
