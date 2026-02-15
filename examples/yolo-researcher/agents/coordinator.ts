import { createAgent, definePack, defineTool, packs } from '../../../src/index.js'
import type { AgentRunResult, Pack, Tool } from '../../../src/index.js'

import type {
  AskUserRequest,
  CoordinatorTurnMetrics,
  CoordinatorTurnResult,
  QueuedUserInput,
  TurnSpec,
  YoloCoordinator,
  YoloStage
} from '../runtime/types.js'

interface CoordinatorJsonAsset {
  type: string
  payload: Record<string, unknown>
  supersedes?: string
}

interface CoordinatorJsonOutput {
  summary?: string
  assets?: CoordinatorJsonAsset[]
  askUser?: AskUserRequest
}

interface TurnTelemetryAccumulator {
  toolCalls: number
  discoveryOps: number
  readBytes: number
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
  allowBash?: boolean
  createAgentInstance?: (callbacks: {
    onToolCall: (name: string, args: unknown) => void
    onToolResult: (name: string, result: unknown, args?: unknown) => void
    onAskUser: (request: AskUserRequest) => void
  }) => AgentLike
}

export interface AgentLike {
  ensureInit: () => Promise<void>
  run: (prompt: string) => Promise<AgentRunResult>
  destroy?: () => Promise<void>
}

const DEFAULT_IDENTITY = [
  'You are YOLO coordinator for one bounded research turn.',
  'Prioritize concrete auditable assets over long prose.',
  'If missing critical information, call ask_user tool.'
].join(' ')

const DEFAULT_CONSTRAINTS: string[] = [
  'Produce machine-readable output only as specified.',
  'Do not fabricate evidence. If blocked, call ask_user.',
  'Keep branch action aligned with TurnSpec constraints.'
]

const DISCOVERY_TOOL_SET = new Set(['glob', 'grep', 'read'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeAskUser(value: unknown): AskUserRequest | undefined {
  if (!isObject(value)) return undefined
  if (typeof value.question !== 'string' || !value.question.trim()) return undefined

  const normalized: AskUserRequest = {
    question: value.question.trim()
  }

  if (Array.isArray(value.options)) {
    normalized.options = value.options.filter((item): item is string => typeof item === 'string')
  }

  if (typeof value.context === 'string') normalized.context = value.context
  if (typeof value.checkpoint === 'string') {
    const checkpoint = value.checkpoint as AskUserRequest['checkpoint']
    if (checkpoint === 'problem-freeze' || checkpoint === 'baseline-freeze' || checkpoint === 'claim-freeze' || checkpoint === 'final-scope') {
      normalized.checkpoint = checkpoint
    }
  }

  if (typeof value.blocking === 'boolean') normalized.blocking = value.blocking
  return normalized
}

function normalizeAssets(value: unknown): CoordinatorJsonAsset[] {
  if (!Array.isArray(value)) return []

  const normalized: CoordinatorJsonAsset[] = []
  for (const entry of value) {
    if (!isObject(entry)) continue
    if (typeof entry.type !== 'string' || !entry.type.trim()) continue
    if (!isObject(entry.payload)) continue

    const asset: CoordinatorJsonAsset = {
      type: entry.type.trim(),
      payload: entry.payload
    }

    if (typeof entry.supersedes === 'string' && entry.supersedes.trim()) {
      asset.supersedes = entry.supersedes.trim()
    }

    normalized.push(asset)
  }

  return normalized
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

function buildTurnPrompt(input: {
  turnSpec: TurnSpec
  stage: YoloStage
  goal: string
  mergedUserInputs: QueuedUserInput[]
}): string {
  const mergedInputs = input.mergedUserInputs.map((item) => ({
    id: item.id,
    text: item.text,
    priority: item.priority,
    source: item.source
  }))
  const stageGuidance = (input.stage === 'S2' || input.stage === 'S3' || input.stage === 'S4')
    ? [
        'For S2-S4, do NOT run heavy/system experiments in-process.',
        'Instead, produce an ExperimentRequirement asset to outsource execution to the user.',
        'ExperimentRequirement payload should include: why, objective, method, expectedResult, requiredFiles.'
      ].join(' ')
    : 'For this stage, keep outputs auditable and scoped to one bounded turn.'

  return [
    'Execute exactly one YOLO turn.',
    'Return STRICT JSON with schema:',
    '{"summary": string, "assets": [{"type": string, "payload": object, "supersedes"?: string}], "askUser"?: {"question": string, "options"?: string[], "context"?: string, "checkpoint"?: "problem-freeze"|"baseline-freeze"|"claim-freeze"|"final-scope", "blocking"?: boolean}}',
    'Do not wrap JSON in prose unless unavoidable. If uncertain, call ask_user tool.',
    stageGuidance,
    `Goal: ${input.goal}`,
    `Stage: ${input.stage}`,
    `TurnSpec: ${JSON.stringify(input.turnSpec)}`,
    `MergedUserInputs: ${JSON.stringify(mergedInputs)}`
  ].join('\n\n')
}

function collectReadBytes(result: unknown): number {
  if (!isObject(result)) return 0
  if (result.success !== true) return 0
  if (!isObject(result.data)) return 0
  const value = result.data.bytes
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function createAskUserTool(onAskUser: (request: AskUserRequest) => void) {
  return defineTool<AskUserRequest, { accepted: boolean }>({
    name: 'ask_user',
    description: 'Request clarification or approval from the supervising user. Use for blocking uncertainties.',
    parameters: {
      question: { type: 'string', required: true, description: 'Question to ask the user.' },
      options: { type: 'array', required: false, description: 'Optional choices for user response.' },
      context: { type: 'string', required: false, description: 'Optional context shown with the question.' },
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
        ...input,
        blocking: input.blocking ?? true
      })
      return { success: true, data: { accepted: true } }
    }
  })
}

function buildCoordinatorMetrics(runResult: AgentRunResult, telemetry: TurnTelemetryAccumulator): CoordinatorTurnMetrics {
  const usageTokens = runResult.usage?.tokens
  const usageCost = runResult.usage?.cost

  return {
    toolCalls: telemetry.toolCalls,
    wallClockSec: Math.max(0, Math.round((runResult.durationMs / 1000) * 1000) / 1000),
    stepCount: runResult.steps,
    readBytes: telemetry.readBytes,
    promptTokens: usageTokens?.promptTokens ?? 0,
    completionTokens: usageTokens?.completionTokens ?? 0,
    turnTokens: usageTokens?.totalTokens ?? 0,
    turnCostUsd: usageCost?.totalCost ?? 0,
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

function fallbackRiskAsset(reason: string, rawOutput: string): CoordinatorJsonAsset {
  return {
    type: 'RiskRegister',
    payload: {
      reason,
      outputExcerpt: rawOutput.slice(0, 1000)
    }
  }
}

function defaultAgentFactory(config: YoloCoordinatorConfig, callbacks: CoordinatorCallbacks): AgentLike {
  const askUserTool = createAskUserTool(callbacks.onAskUser)
  const askUserPack: Pack = definePack({
    id: 'yolo-ask-user',
    description: 'YOLO ask_user interaction tool',
    tools: [askUserTool as unknown as Tool]
  })

  const selectedPacks: Pack[] = [packs.safe(), askUserPack]
  if (config.allowBash) {
    selectedPacks.push(packs.exec({ approvalMode: 'dangerous' }))
  }

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
    skipConfigFile: true,
    onToolCall: (name, _args) => {
      callbacks.onToolCall(name, _args)
    },
    onToolResult: (name, result, args) => callbacks.onToolResult(name, result, args)
  })

  return {
    ensureInit: () => agent.ensureInit(),
    run: (prompt: string) => agent.run(prompt),
    destroy: () => agent.destroy()
  }
}

export function createYoloCoordinator(config: YoloCoordinatorConfig): YoloCoordinator {
  let initialized = false
  let agent: AgentLike | undefined
  let currentTelemetry: TurnTelemetryAccumulator | undefined

  const callbacks: CoordinatorCallbacks = {
    onToolCall: (name) => {
      if (!currentTelemetry) return
      currentTelemetry.toolCalls += 1
      if (DISCOVERY_TOOL_SET.has(name)) currentTelemetry.discoveryOps += 1
    },
    onToolResult: (name, result, args) => {
      if (!currentTelemetry) return
      if (name === 'ask_user') {
        currentTelemetry.lastAskUser = normalizeAskUser(args)
      }
      if (name === 'read') {
        currentTelemetry.readBytes += collectReadBytes(result)
      }
    },
    onAskUser: (request) => {
      if (!currentTelemetry) return
      currentTelemetry.lastAskUser = request
    }
  }

  const getAgent = async (): Promise<AgentLike> => {
    if (!agent) {
      agent = config.createAgentInstance
        ? config.createAgentInstance(callbacks)
        : defaultAgentFactory(config, callbacks)
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
        readBytes: 0
      }
      currentTelemetry = telemetry
      let runResult: AgentRunResult
      try {
        const runPrompt = buildTurnPrompt(input)
        const coordinatorAgent = await getAgent()
        runResult = await coordinatorAgent.run(runPrompt)
      } finally {
        currentTelemetry = undefined
      }

      if (!runResult.success) {
        return {
          summary: runResult.error ? `Coordinator run failed: ${runResult.error}` : 'Coordinator run failed',
          assets: [fallbackRiskAsset('coordinator_run_failed', runResult.output)],
          metrics: buildCoordinatorMetrics(runResult, telemetry)
        }
      }

      const parsed = parseCoordinatorJson(runResult.output)
      const normalizedAssets = normalizeAssets(parsed?.assets)
      const askUser = telemetry.lastAskUser ?? normalizeAskUser(parsed?.askUser)

      const assets = normalizedAssets.length > 0
        ? normalizedAssets
        : [fallbackRiskAsset('coordinator_output_missing_assets', runResult.output)]

      return {
        summary: chooseSummary(runResult.output, parsed),
        assets,
        askUser,
        metrics: buildCoordinatorMetrics(runResult, telemetry)
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
  buildTurnPrompt,
  collectReadBytes,
  buildCoordinatorMetrics
}
