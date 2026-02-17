import { createAgent, packs } from '../../../src/index.js'
import type { AgentRunResult } from '../../../src/index.js'

import type { AgentLike, PlannerInput, PlannerIntentRoute } from '../runtime/types.js'

export interface IntentRouter {
  route(input: PlannerInput): Promise<PlannerIntentRoute>
}

export interface YoloIntentRouterConfig {
  projectPath: string
  model?: string
  apiKey?: string
  maxSteps?: number
  maxTokens?: number
  debug?: boolean
  identityPrompt?: string
  constraints?: string[]
  createAgentInstance?: () => AgentLike
}

const DEFAULT_IDENTITY = [
  'You are the YOLO-Scholar intent router.',
  'Classify intent for one turn context.',
  'Return strict JSON only.'
].join(' ')

const DEFAULT_CONSTRAINTS = [
  'Output strict JSON only.',
  'Do not invent fields outside schema.',
  'Do not ask questions.'
]

const CODING_INTENT_STRONG_PATTERNS: readonly RegExp[] = [
  /\b(codebase|repository|repo|pull request|merge request|git|commit|diff|patch|hotfix|bugfix|refactor|debug|checkout|rebase|cherry-pick)\b/i,
  /\b(bug|regression|runtime error|compile error|build error|import error|module not found|syntaxerror|stack trace|traceback|exception)\b/i,
  /\b(npm|pnpm|yarn|npx|node|python3?|pip|pytest|vitest|jest|cargo|go test|mvn|gradle|cmake|eslint|prettier|ruff|poetry|uv)\b/i,
  /\b(package\.json|tsconfig\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|dockerfile|makefile)\b/i,
  /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|scala|swift|sh|bash|zsh|ps1|toml|yaml|yml|json)\b/i,
  /(仓库|代码库|重构|修复\s*bug|修复bug|补丁|脚本|单元测试|单测|集成测试|编译|构建|报错|堆栈|分支|提交|命令行)/i
]

const CODING_INTENT_ACTION_PATTERNS: readonly RegExp[] = [
  /\b(implement|refactor|fix|debug|patch|modify|edit|rewrite|add|remove|update|write)\b/i,
  /(实现|重构|修复|调试|修改|新增|删除|更新|编程|编码|改写)/i
]

const CODING_INTENT_OBJECT_PATTERNS: readonly RegExp[] = [
  /\b(code|script|module|function|class|api|endpoint|cli|dependency|unit test|integration test|test suite|build pipeline|config file)\b/i,
  /(代码|脚本|模块|函数|类|接口|命令|依赖|单测|测试用例|构建|编译|配置文件)/i
]

const NON_CODING_RESEARCH_PATTERNS: readonly RegExp[] = [
  /\b(literature|related work|paper|citation|doi|survey|meta-analysis|theoretical model|hypothesis)\b/i,
  /(文献|论文|引用|综述|元分析|理论模型|假设)/i
]

function countPatternMatches(text: string, patterns: readonly RegExp[]): number {
  let count = 0
  for (const pattern of patterns) {
    if (pattern.test(text)) count += 1
  }
  return count
}

function buildIntentCorpus(input: PlannerInput): string {
  const mergedInputText = input.mergedUserInputs.map((item) => item.text).join(' ')
  return [
    input.goal,
    input.planContent,
    input.branchDossierContent,
    mergedInputText,
    input.researchContext
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
}

export function detectCodingIntentHeuristic(input: PlannerInput): PlannerIntentRoute {
  const text = buildIntentCorpus(input)
  if (!text) {
    return {
      label: 'unknown',
      isCoding: false,
      confidence: 0.5,
      source: 'router_heuristic',
      rationale: 'empty_context'
    }
  }

  const strongHits = countPatternMatches(text, CODING_INTENT_STRONG_PATTERNS)
  if (strongHits > 0) {
    return {
      label: 'coding_repository',
      isCoding: true,
      confidence: 0.92,
      source: 'router_heuristic',
      rationale: `strong_hits=${strongHits}`
    }
  }

  const actionHits = countPatternMatches(text, CODING_INTENT_ACTION_PATTERNS)
  const objectHits = countPatternMatches(text, CODING_INTENT_OBJECT_PATTERNS)
  if (actionHits > 0 && objectHits > 0) {
    return {
      label: 'coding_general',
      isCoding: true,
      confidence: 0.78,
      source: 'router_heuristic',
      rationale: `action_hits=${actionHits},object_hits=${objectHits}`
    }
  }

  const nonCodingResearchHits = countPatternMatches(text, NON_CODING_RESEARCH_PATTERNS)
  if (nonCodingResearchHits > 0) {
    return {
      label: 'research_literature',
      isCoding: false,
      confidence: 0.82,
      source: 'router_heuristic',
      rationale: `research_hits=${nonCodingResearchHits}`
    }
  }

  return {
    label: 'research_general',
    isCoding: false,
    confidence: 0.58,
    source: 'router_heuristic',
    rationale: 'no_strong_signal'
  }
}

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

function parseIntentJson(rawOutput: string): Record<string, unknown> | undefined {
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
    return tryParseJson(text.slice(firstBrace, lastBrace + 1))
  }

  return undefined
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return 'unknown'
  return trimmed
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < 0 || value > 1) return undefined
  return value
}

function normalizeModelRoute(raw: Record<string, unknown>): PlannerIntentRoute | undefined {
  const confidence = normalizeConfidence(raw.confidence)
  if (confidence === undefined) return undefined

  const isCoding = raw.is_coding
  if (typeof isCoding !== 'boolean') return undefined

  const rationale = typeof raw.rationale === 'string'
    ? raw.rationale.trim().slice(0, 220)
    : undefined

  return {
    label: normalizeLabel(raw.label),
    isCoding,
    confidence,
    source: 'router_model',
    rationale: rationale || undefined
  }
}

function buildRouterPrompt(input: PlannerInput): string {
  const mergedInputs = input.mergedUserInputs.map((item) => ({
    id: item.id,
    text: item.text,
    priority: item.priority
  }))
  return [
    'Classify the turn intent for routing.',
    'Return strict JSON with this schema only:',
    JSON.stringify({
      label: 'string',
      is_coding: 'boolean',
      confidence: 'number between 0 and 1',
      rationale: 'short string (<= 20 words)'
    }, null, 2),
    'Decision rule:',
    '- is_coding=true only when this turn is primarily repository coding/script execution/debug/refactor work.',
    '- is_coding=false for literature review, writing synthesis, analysis planning, or reporting.',
    `Stage: ${input.stage}`,
    `Goal: ${input.goal}`,
    `MergedUserInputs: ${JSON.stringify(mergedInputs)}`,
    `PlanContext: ${input.planContent.slice(0, 1200)}`,
    `BranchContext: ${input.branchDossierContent.slice(0, 800)}`,
    `ResearchContext: ${input.researchContext.slice(0, 800)}`
  ].join('\n')
}

function createFallbackRoute(heuristic: PlannerIntentRoute, reason: string): PlannerIntentRoute {
  return {
    ...heuristic,
    source: 'router_fallback',
    rationale: reason
  }
}

function defaultAgentFactory(config: YoloIntentRouterConfig): AgentLike {
  const agent = createAgent({
    projectPath: config.projectPath,
    apiKey: config.apiKey,
    model: config.model!,
    maxSteps: config.maxSteps ?? 8,
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

export function createYoloIntentRouter(config: YoloIntentRouterConfig): IntentRouter {
  const modelEnabled = Boolean(config.createAgentInstance || (config.model && config.model.trim()))
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
    async route(input: PlannerInput): Promise<PlannerIntentRoute> {
      const heuristic = detectCodingIntentHeuristic(input)
      if (!modelEnabled) return heuristic

      let runResult: AgentRunResult
      try {
        const routerAgent = await getAgent()
        runResult = await routerAgent.run(buildRouterPrompt(input))
      } catch {
        return createFallbackRoute(heuristic, 'router_model_error')
      }

      if (!runResult.success) {
        return createFallbackRoute(heuristic, 'router_model_unsuccessful')
      }

      const parsed = parseIntentJson(runResult.output)
      if (!parsed) {
        return createFallbackRoute(heuristic, 'router_json_parse_failed')
      }

      const modelRoute = normalizeModelRoute(parsed)
      if (!modelRoute) {
        return createFallbackRoute(heuristic, 'router_contract_invalid')
      }

      if (modelRoute.confidence < 0.6) {
        return createFallbackRoute(heuristic, 'router_model_low_confidence')
      }

      return modelRoute
    }
  }
}

export const __private = {
  buildIntentCorpus,
  parseIntentJson,
  normalizeModelRoute
}
