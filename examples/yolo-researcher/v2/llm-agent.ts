import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import { createAgent, definePack, generateStructured, getLanguageModelByModelId } from '../../../src/index.js'
import { packs } from '../../../src/packs/index.js'
import { yoloResearcherSkills } from '../skills/index.js'
import { createYoloToolWrapperPack } from './tool-wrappers.js'

import type {
  ClaimEvidence,
  NorthStarSemanticGateEvaluator,
  NorthStarSemanticGateInput,
  ToolEventRecord,
  TurnContext,
  TurnRunOutcome,
  YoloSingleAgent
} from './types.js'
import type { Pack } from '../../../src/types/pack.js'
import type { ResourceLimits } from '../../../src/types/runtime.js'
import type { DetailedTokenUsage, TokenCost } from '../../../src/llm/provider.types.js'

export type CapabilityProfile = 'minimal' | 'full'

export interface LlmSingleAgentConfig {
  projectPath: string
  model: string
  apiKey?: string
  maxSteps?: number
  maxTokens?: number
  enableNetwork?: boolean
  capabilityProfile?: CapabilityProfile
  autoApprove?: boolean
  externalSkillsDir?: string
  communitySkillsDir?: string
  watchExternalSkills?: boolean
  watchCommunitySkills?: boolean
  disablePolicies?: boolean
  ioLimits?: Partial<ResourceLimits>
  runtimeSystemInfo?: string
  onToolEvent?: (event: LlmRealtimeToolEvent) => void
  onExecEvent?: (event: LlmRealtimeExecEvent) => void
  onUsage?: (usage: DetailedTokenUsage, cost: TokenCost) => void
}

export interface LlmRealtimeToolEvent extends ToolEventRecord {
  turnNumber: number
}

export interface LlmRealtimeExecEvent {
  turnNumber: number
  timestamp: string
  phase: 'start' | 'chunk' | 'end' | 'error'
  traceId?: string
  caller?: string
  command?: string
  cwd?: string
  stream?: 'stdout' | 'stderr'
  chunk?: string
  truncated?: boolean
  exitCode?: number
  signal?: string
  durationMs?: number
  error?: string
}

const MAX_OUTCOME_ATTEMPTS = 5
const MAX_FAILURE_RECOVERY_ATTEMPTS = 2
const DEFAULT_LONG_TASK_IO_LIMITS: Partial<ResourceLimits> = {
  timeout: 6 * 60 * 60 * 1000,       // 6 hours
  maxBytes: 512 * 1024 * 1024,       // 512MB per stdout/stderr stream
  maxWriteBytes: 50 * 1024 * 1024,   // 50MB
  maxLines: 1_000_000,
  maxResults: 20_000
}
const BOOTSTRAP_PLAN_PREFIX = 'bootstrap pending: replace with 3-5 goal-specific next actions'
const TOOL_EVENT_STRING_LIMIT = 6000
const FETCH_EVENT_STRING_LIMIT = 80_000
const POLICY_BLOCK_RE = /(no[-\s]?destructive|destructive policy|blocked by (a )?policy|policy block|forbidden|not allowed|disallowed)/i
const DESTRUCTIVE_RM_RE = /\brm\s+-rf\b/i
const DEFAULT_NORTHSTAR_SEMANTIC_GATE_MAX_TOKENS = 1_000
const DEFAULT_NORTHSTAR_SEMANTIC_GATE_TIMEOUT_MS = 30_000
const CODING_LARGE_REPO_TIMEOUT_BUFFER_MS = 180_000

const northStarSemanticGateOutputSchema = z.object({
  confidence: z.number().min(0).max(1),
  dimension_scores: z.object({
    goal_alignment: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    evidence_strength: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    novelty_delta: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    falsifiability: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    trajectory_health: z.union([z.literal(0), z.literal(1), z.literal(2)])
  }),
  reason_codes: z.array(z.string().min(1).max(120)).max(30),
  claim_audit: z.object({
    supported_ids: z.array(z.string().min(1).max(64)).max(100),
    unsupported_ids: z.array(z.string().min(1).max(64)).max(100),
    contradicted_ids: z.array(z.string().min(1).max(64)).max(100)
  }),
  required_actions: z.array(
    z.object({
      tier: z.enum(['must_candidate', 'should', 'suggest']),
      code: z.string().min(1).max(120),
      description: z.string().min(1).max(300),
      // Responses API structured schema requires every property to be listed in `required`.
      // Use nullable required field instead of optional for provider compatibility.
      due_turn: z.union([z.number().int().min(1).max(1_000_000), z.null()])
    })
  ).max(4),
  summary: z.string().max(1_000),
  // Runtime derives authoritative verdict from dimension_scores, but provider-side schema
  // validation is stricter when optional object properties exist.
  verdict: z.enum(['advance_confirmed', 'advance_weak', 'no_progress', 'regress', 'abstain'])
}).strict()

const NORTHSTAR_SEMANTIC_GATE_SYSTEM_PROMPT = [
  'You are a strict North Star research progress auditor.',
  'Judge whether the current turn made meaningful progress toward the stated research objective.',
  'Do not reward count inflation, wording churn, or unverifiable claims.',
  'Runtime hard checks are authoritative and cannot be overridden.',
  'Do not decide final verdict; runtime derives verdict deterministically from dimension scores.',
  'If uncertain, keep confidence low and reflect uncertainty in scores/reason_codes.',
  'Use only facts from input JSON. Never invent files or metrics.',
  'Schema compliance rules:',
  '1) Include ALL top-level fields required by schema.',
  '2) claim_audit is required; use empty arrays when no IDs.',
  '3) required_actions is required; use [] when no actions.',
  '4) For each required action, include due_turn; use null when unspecified.',
  '5) verdict is required for schema compatibility; use abstain when uncertain.',
  'Return JSON only following the schema.'
].join('\n')

function truncateText(value: string, limit: number = TOOL_EVENT_STRING_LIMIT): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(1, limit - 1))}…`
}

function sanitizeForEvent(value: unknown, depth: number = 0, stringLimit: number = TOOL_EVENT_STRING_LIMIT): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return truncateText(value, stringLimit)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= 3) return '[truncated-depth]'

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeForEvent(item, depth + 1, stringLimit))
  }

  if (typeof value === 'object') {
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      next[key] = sanitizeForEvent(item, depth + 1, stringLimit)
    }
    return next
  }

  return String(value)
}

function extractJson(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return text
}

function toPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function extractBashCommandFromInput(input: unknown): string {
  const obj = toPlainObject(input)
  if (!obj) return ''
  const command = safeString(obj.command).trim()
  if (command) return command
  const cmd = safeString(obj.cmd).trim()
  return cmd
}

function extractToolErrorText(event: ToolEventRecord): string {
  const chunks = [safeString(event.error).trim()]
  const resultObj = toPlainObject(event.result)
  if (resultObj) {
    chunks.push(safeString(resultObj.error).trim())
    const dataObj = toPlainObject(resultObj.data)
    if (dataObj) {
      chunks.push(safeString(dataObj.stderr).trim())
      chunks.push(safeString(dataObj.stdout).trim())
    }
  }
  return chunks.filter(Boolean).join('\n').trim()
}

function firstNonEmptyLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || ''
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function toStringArgArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => (typeof entry === 'string' ? entry : String(entry ?? '')))
}

function parsePositiveInt(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

export function applyCodingLargeRepoRunGuards(rawInput: unknown): void {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return
  const input = rawInput as Record<string, unknown>
  const skillId = safeString(input.skillId).trim().toLowerCase()
  const script = safeString(input.script).trim().toLowerCase()
  if (skillId !== 'coding-large-repo' || script !== 'agent-run-to-completion') return

  const args = toStringArgArray(input.args)
  if (args.length > 0) {
    const hasExplicitCwd = args.includes('--cwd')
    const rewritten: string[] = []
    for (let idx = 0; idx < args.length; idx += 1) {
      const token = args[idx] || ''
      if (token !== '--repo') {
        rewritten.push(token)
        continue
      }

      const repoValue = (args[idx + 1] || '').trim()
      if (!hasExplicitCwd) {
        rewritten.push('--cwd')
        if (repoValue) rewritten.push(repoValue)
      }
      if (repoValue) idx += 1
    }
    input.args = rewritten
  }

  const normalizedArgs = toStringArgArray(input.args)
  let timeoutSec: number | null = null
  for (let idx = 0; idx < normalizedArgs.length; idx += 1) {
    if (normalizedArgs[idx] !== '--timeout-sec') continue
    timeoutSec = parsePositiveInt(normalizedArgs[idx + 1] || '')
    break
  }
  if (!timeoutSec) return

  const requiredTimeoutMs = timeoutSec * 1000 + CODING_LARGE_REPO_TIMEOUT_BUFFER_MS
  const currentTimeoutMs = (
    typeof input.timeout === 'number' && Number.isFinite(input.timeout)
      ? Math.floor(input.timeout)
      : null
  )
  if (currentTimeoutMs === null || currentTimeoutMs < requiredTimeoutMs) {
    input.timeout = requiredTimeoutMs
  }
}

function formatTurnId(turnNumber: number): string {
  return `turn-${String(turnNumber).padStart(4, '0')}`
}

function canonicalTurnArtifactPaths(context: TurnContext): {
  turnId: string
  canonicalRelativeFromProject: string
  canonicalAbsolute: string
} {
  const turnId = formatTurnId(context.turnNumber)
  const canonicalRelativeFromProject = `runs/${turnId}/artifacts`
  const canonicalAbsolute = toPosixPath(join(context.projectRoot, canonicalRelativeFromProject))

  return {
    turnId,
    canonicalRelativeFromProject,
    canonicalAbsolute
  }
}

export interface DestructivePolicyBlock {
  command: string
  errorLine: string
}

export interface LiteratureSearchUsage {
  invoked: boolean
  fullMode: boolean
  via: 'literature-study' | 'literature-search' | 'skill-script-run' | ''
  detail: string
  success: boolean
  fullModeSuccess: boolean
  lastError?: string
  argError?: boolean
}


export function detectDestructivePolicyBlockedBash(toolEvents: ToolEventRecord[]): DestructivePolicyBlock | null {
  let lastBashCommand = ''

  for (const event of toolEvents) {
    const tool = (event.tool || '').trim().toLowerCase()
    if (tool !== 'bash') continue

    if (event.phase === 'call') {
      const command = extractBashCommandFromInput(event.input)
      if (command) lastBashCommand = command
      continue
    }

    const resultCommand = extractBashCommandFromInput(event.input)
    const command = resultCommand || lastBashCommand
    const errorText = extractToolErrorText(event)
    if (!errorText) continue

    const blockedByPolicy = POLICY_BLOCK_RE.test(errorText)
    const hasDestructiveRm = DESTRUCTIVE_RM_RE.test(command) || DESTRUCTIVE_RM_RE.test(errorText)
    if (!blockedByPolicy || !hasDestructiveRm) continue

    const firstErrorLine = errorText.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || 'destructive command blocked by policy'
    return {
      command: command || 'bash command',
      errorLine: firstErrorLine
    }
  }

  return null
}

export function detectLiteratureSearchUsage(toolEvents: ToolEventRecord[]): LiteratureSearchUsage {
  let invoked = false
  let fullMode = false
  let via: LiteratureSearchUsage['via'] = ''
  let detail = ''
  let success = false
  let fullModeSuccess = false
  let lastError = ''
  let argError = false

  for (const event of toolEvents) {
    const tool = (event.tool || '').trim().toLowerCase()
    const input = toPlainObject(event.input)

    if (tool === 'literature-study') {
      invoked = true
      via = 'literature-study'

      const modeFromInput = safeString(input?.mode).trim().toLowerCase()
      const mode = modeFromInput === 'quick' ? 'quick' : (modeFromInput === 'deep' ? 'deep' : 'standard')
      const isFullModeCall = mode !== 'quick'
      detail = `literature-study(${mode})`
      if (isFullModeCall) fullMode = true

      if (event.phase !== 'result') continue
      const resultObj = toPlainObject(event.result)
      const dataObj = toPlainObject(resultObj?.data)
      const structured = toPlainObject(dataObj?.structuredResult)
      const modeFromResult = safeString(dataObj?.mode || structured?.mode).trim().toLowerCase()
      const isFullModeResult = modeFromResult
        ? modeFromResult !== 'quick'
        : isFullModeCall
      if (isFullModeResult) fullMode = true

      const eventSuccess = typeof event.success === 'boolean'
        ? event.success
        : typeof resultObj?.success === 'boolean'
          ? resultObj.success
          : false
      if (eventSuccess) {
        success = true
        if (isFullModeResult) fullModeSuccess = true
      } else {
        const errorText = extractToolErrorText(event)
        if (errorText) {
          const line = firstNonEmptyLine(errorText)
          if (line) lastError = line
        }
      }
      continue
    }

    if (tool === 'literature-search') {
      invoked = true
      via = 'literature-search'

      const modeFromInput = safeString(input?.mode).trim().toLowerCase()
      const mode = modeFromInput === 'quick' ? 'quick' : 'sweep'
      const isFullModeCall = mode !== 'quick'
      detail = `literature-search(${mode})`
      if (isFullModeCall) {
        fullMode = true
      }

      if (event.phase !== 'result') continue

      const resultObj = toPlainObject(event.result)
      const dataObj = toPlainObject(resultObj?.data)
      const structured = toPlainObject(dataObj?.structuredResult)
      const script = safeString(dataObj?.script || structured?.script).trim().toLowerCase()
      const modeFromResult = safeString(dataObj?.mode || structured?.mode).trim().toLowerCase()
      const isFullModeResult = modeFromResult
        ? modeFromResult !== 'quick'
        : !(script === 'search-papers' || script === 'quick')

      if (isFullModeResult) {
        fullMode = true
      }

      const eventSuccess = typeof event.success === 'boolean'
        ? event.success
        : typeof resultObj?.success === 'boolean'
          ? resultObj.success
          : false

      if (eventSuccess) {
        success = true
        if (isFullModeResult) {
          fullModeSuccess = true
        }
      } else {
        const errorText = extractToolErrorText(event)
        if (errorText) {
          const line = firstNonEmptyLine(errorText)
          if (line) lastError = line
          if (/unrecognized arguments:/i.test(errorText)) {
            argError = true
          }
        }
      }
      continue
    }

    if (tool !== 'skill-script-run') continue
    if (!input) continue

    const skillId = safeString(input.skillId).trim()
    if (skillId !== 'literature-search') continue

    invoked = true
    if (!via) via = 'skill-script-run'
    const script = safeString(input.script).trim().toLowerCase()
    detail = `skill-script-run(literature-search/${script || 'unknown'})`
    const isFullModeScript = script === 'search-sweep' || script === 'sweep-papers'
    if (isFullModeScript) {
      fullMode = true
    }

    if (event.phase !== 'result') continue

    const resultObj = toPlainObject(event.result)
    const eventSuccess = typeof event.success === 'boolean'
      ? event.success
      : typeof resultObj?.success === 'boolean'
        ? resultObj.success
        : false

    if (eventSuccess) {
      success = true
      if (isFullModeScript) {
        fullModeSuccess = true
      }
      continue
    }

    const errorText = extractToolErrorText(event)
    if (errorText) {
      const line = firstNonEmptyLine(errorText)
      if (line) lastError = line
      if (/unrecognized arguments:/i.test(errorText)) {
        argError = true
      }
    }
  }

  return {
    invoked,
    fullMode,
    via,
    detail,
    success,
    fullModeSuccess,
    lastError: lastError || undefined,
    argError
  }
}

function resolveBundledSkillSourceDir(): string | null {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(moduleDir, '..', 'skills', 'default-project-skills'),
    resolve(process.cwd(), 'examples', 'yolo-researcher', 'skills', 'default-project-skills'),
    resolve(process.cwd(), 'skills', 'default-project-skills')
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function resolveExternalSkillsDir(projectPath: string, configuredDir?: string): string {
  if (!configuredDir?.trim()) {
    return resolve(projectPath, '.agentfoundry', 'skills')
  }
  return isAbsolute(configuredDir) ? resolve(configuredDir) : resolve(projectPath, configuredDir)
}

function seedBundledSkills(targetDir: string, bundledSourceDir: string | null): void {
  function syncMissingEntries(sourceDir: string, targetDirPath: string): void {
    mkdirSync(targetDirPath, { recursive: true })
    const entries = readdirSync(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name)
      const targetPath = join(targetDirPath, entry.name)

      if (entry.isDirectory()) {
        if (!existsSync(targetPath)) {
          cpSync(sourcePath, targetPath, { recursive: true })
          continue
        }
        syncMissingEntries(sourcePath, targetPath)
        continue
      }

      if (entry.isFile() && !existsSync(targetPath)) {
        cpSync(sourcePath, targetPath)
      }
    }
  }

  mkdirSync(targetDir, { recursive: true })
  if (!bundledSourceDir || !existsSync(bundledSourceDir)) return

  const entries = readdirSync(bundledSourceDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sourceSkillDir = join(bundledSourceDir, entry.name)
    const sourceSkillFile = join(sourceSkillDir, 'SKILL.md')
    if (!existsSync(sourceSkillFile)) continue

    const targetSkillDir = join(targetDir, entry.name)
    try {
      if (existsSync(targetSkillDir)) {
        syncMissingEntries(sourceSkillDir, targetSkillDir)
      } else {
        cpSync(sourceSkillDir, targetSkillDir, { recursive: true })
      }
    } catch {
      // Best-effort seeding/sync only.
    }
  }
}

async function buildAgentPacks(profile: CapabilityProfile, enableNetwork: boolean, projectPath: string): Promise<Pack[]> {
  const packList: Pack[] = [
    packs.safe(),
    packs.exec({ approvalMode: 'none' }),
    packs.exploration(),
    packs.discovery(),
    createYoloToolWrapperPack(projectPath)
  ]

  if (enableNetwork) {
    let networkPack: Pack | null = null
    const braveApiKey = safeString(process.env.BRAVE_API_KEY).trim()
    if (braveApiKey) {
      try {
        networkPack = await packs.web({
          timeout: 30_000,
          enabledTools: ['brave_web_search'],
          includeFetch: true
        })
      } catch {
        networkPack = null
      }
    }
    if (!networkPack) {
      networkPack = packs.network()
    }
    packList.push(networkPack)
  }

  try {
    const documentMcpPack = await packs.documents({
      toolPrefix: 'mcp_markitdown',
      timeout: 60_000,
      startTimeout: 120_000
    })
    packList.push(documentMcpPack)
  } catch {
    // Optional MCP pack; wrapper fallback still works via skills.
  }

  if (profile === 'full') {
    packList.push(packs.git())
    packList.push(packs.todo())
    packList.push(packs.docs())
    packList.push(packs.compute({ requireApproval: false }))
  }

  packList.push(definePack({
    id: 'yolo-research-skills',
    description: 'Local yolo-researcher skills for literature, writing, data analysis, and experiment design.',
    skills: yoloResearcherSkills,
    skillLoadingConfig: {
      lazy: ['literature-skill', 'experiment-request-skill', 'academic-writing-skill', 'data-analysis-skill']
    }
  }))

  return packList
}

function normalizePlanText(text: string): string {
  return text
    .toLowerCase()
    .replace(/^p\d+\s*[:|-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.。]$/u, '')
    .trim()
}

function isLegacyTemplatePlan(plan: string[]): boolean {
  const normalized = plan.map(normalizePlanText).filter(Boolean)
  if (normalized.length !== 3) return false

  const first = normalized[0] ?? ''
  const middle = normalized[1] ?? ''
  const last = normalized[2] ?? ''

  return (
    first.startsWith('collect initial constraints evidence')
    && middle.includes('verification')
    && last.startsWith('record verified fact with evidence pointer')
  )
}

function isBootstrapPlan(plan: string[]): boolean {
  return plan.some((item) => normalizePlanText(item).startsWith(BOOTSTRAP_PLAN_PREFIX))
}

function requiresPlanRewrite(plan: string[]): boolean {
  if (plan.length === 0) return true
  if (isLegacyTemplatePlan(plan)) return true
  if (isBootstrapPlan(plan)) return true

  return plan.some((item) => {
    const normalized = normalizePlanText(item)
    return (
      normalized === '...'
      || normalized.startsWith('<')
      || normalized.includes('replace with 3-5 goal-specific')
    )
  })
}

function goalNeedsLiteratureBootstrap(goal: string): boolean {
  const normalized = goal.toLowerCase()
  if (!normalized.trim()) return false
  return (
    /(paper|papers|literature|related work|prior art|survey|novel|state of the art|citation|doi|arxiv|scholar|openalex|research)/.test(normalized)
    || normalized.includes('alphaevolve')
    || normalized.includes('openevolve')
    || normalized.includes('origin study')
  )
}

function getTrustedEvidencePool(context: TurnContext): string[] {
  const trusted = (context.trustedEvidencePaths ?? [])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
  if (trusted.length > 0) return [...new Set(trusted)]

  return [...new Set([
    ...context.project.keyArtifacts,
    ...context.project.facts.map((item) => item.evidencePath),
    ...context.project.constraints.map((item) => item.evidencePath),
    ...context.project.done.map((item) => item.evidencePath),
    ...context.project.planBoard.flatMap((item) => item.evidencePaths)
  ])]
}

function hasLiteratureArtifacts(context: TurnContext): boolean {
  const pool = getTrustedEvidencePool(context)

  return pool.some((value) => /literature|paper|arxiv|scholar|openalex|crossref|doi/i.test(value))
}

function validatePlanRewriteProjectUpdate(projectUpdate: unknown): void {
  const candidate = projectUpdate && typeof projectUpdate === 'object'
    ? projectUpdate as Record<string, unknown>
    : null

  const plan = candidate?.currentPlan
  if (!Array.isArray(plan)) {
    throw new Error('projectUpdate.currentPlan with 3-5 concrete items is required when current plan is bootstrap/template')
  }

  const items = plan
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)

  if (items.length < 3 || items.length > 5) {
    throw new Error('projectUpdate.currentPlan must contain 3-5 non-empty items when current plan is bootstrap/template')
  }

  const hasGenericItem = items.some((item) => {
    const normalized = normalizePlanText(item)
    return (
      normalized.length < 8
      || normalized === '...'
      || normalized.startsWith('define next')
      || normalized.startsWith('collect initial constraints')
    )
  })

  if (hasGenericItem) {
    throw new Error('projectUpdate.currentPlan contains generic placeholders; provide concrete goal-specific actions')
  }
}

function renderPlanBoardForPrompt(context: TurnContext): string {
  const rows = context.project.planBoard
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 12)
    .map((item) => {
      const doneDefinition = item.doneDefinition.length > 0
        ? item.doneDefinition.slice(0, 2).join(' | ')
        : '(missing done_definition)'
      const evidenceHint = item.evidencePaths.length > 0
        ? item.evidencePaths[item.evidencePaths.length - 1]
        : '(none)'
      return `- ${item.id} [${item.status}] ${item.title} :: done=${doneDefinition} :: evidence=${evidenceHint}`
    })

  return rows.length > 0 ? rows.join('\n') : '- none'
}

function normalizeDeliverableTarget(raw: string): string {
  const trimmed = raw.trim().replace(/^['"`]+|['"`]+$/g, '')
  if (!trimmed) return ''
  const normalized = toPosixPath(trimmed)
  if (!normalized) return ''
  const match = normalized.match(/^runs\/turn-\d{4}\/(artifacts\/.+)$/i)
  const scoped = match?.[1] ? match[1] : normalized
  if (!scoped.startsWith('artifacts/')) return ''
  return scoped
}

function extractDeliverablesFromDoneDefinition(doneDefinition: string[]): string[] {
  const deliverables: string[] = []
  for (const row of doneDefinition) {
    const line = row.trim()
    if (!line) continue
    if (!/^deliverables?\s*:/i.test(line)) continue
    const raw = line.split(':').slice(1).join(':').trim()
    const normalized = normalizeDeliverableTarget(raw)
    if (!normalized) continue
    deliverables.push(normalized)
  }
  return [...new Set(deliverables)]
}

function buildArtifactGravityPrompt(context: TurnContext): string {
  const recent = context.recentTurns
    .map((turn) => `- ${turn.actionPath}: ${turn.summary}`)
    .join('\n')
  const blocked = context.failures
    .filter((item) => item.status === 'BLOCKED')
    .map((item) => `- [${item.runtime}] ${item.cmd} :: ${item.errorLine}`)
    .join('\n')
  const done = context.project.done
    .slice(-8)
    .map((item) => `- ${item.text} (evidence: ${item.evidencePath})`)
    .join('\n')
  const pendingUserInputs = context.pendingUserInputs
    .map((item) => `- ${item.submittedAt} :: ${item.text} (evidence: ${item.evidencePath})`)
    .join('\n')

  const artifactPaths = canonicalTurnArtifactPaths(context)
  const northStar = context.northStar
  const northStarArtifactPaths = northStar?.artifactPaths ?? []
  const paperMode = context.orchestrationMode === 'artifact_gravity_v3_paper'
  const pivotAllowed = Boolean(context.northStarPivotAllowed)
  const semanticFeedback = context.northStarSemantic
  const semanticOpenActions = semanticFeedback?.openRequiredActions ?? []
  const semanticMustActions = semanticOpenActions.filter((row) => row.tier === 'must')
  const semanticAdvisoryActions = semanticOpenActions.filter((row) => row.tier !== 'must')

  return [
    `You are YOLO-Researcher ${paperMode ? 'v3-paper' : 'v3'} Artifact-Gravity runner.`,
    'Mainline progress rule (critical):',
    ...(paperMode
      ? [
        '- Progress is valid only when: Internal checks pass, Scoreboard improves, and External friction quota is satisfied.',
        '- Repeated check-only pass without scoreboard improvement is NO_DELTA.',
        '- If consecutive turns skip Internal RealityCheck execution, anti-churn may force NO_DELTA + pivot.'
      ]
      : [
        '- Progress is valid only when NorthStarArtifact changes in this turn OR NorthStar verify cmd succeeds in this turn.',
        '- Verify-only success is rejected when there is no substantive delta (no non-verify artifact and no workspace/repo change).'
      ]),
    '- All other work (notes/exploration/plan chatter) is support only and will be NO_DELTA.',
    '- Do not optimize for plan control-plane fields.',
    '',
    `Turn: ${context.turnNumber}`,
    `Goal: ${context.project.goal}`,
    `Default runtime: ${context.project.defaultRuntime}`,
    `Turn artifact dir (relative): ${artifactPaths.canonicalRelativeFromProject}`,
    `Turn artifact dir (absolute): ${artifactPaths.canonicalAbsolute}`,
    'Turn artifact URI base: artifact://',
    '',
    'North Star contract:',
    `- contract: ${northStar?.filePath ?? 'NORTHSTAR.md (missing or invalid)'}`,
    `- goal: ${northStar?.goal || context.project.goal}`,
    `- current objective: ${northStar?.currentObjective || '(not specified)'}`,
    `- objective id/version: ${northStar?.objectiveId || '(none)'}/${northStar?.objectiveVersion || 1}`,
    `- artifact type: ${northStar?.artifactType || 'unknown'}`,
    `- artifact paths: ${northStarArtifactPaths.length > 0 ? northStarArtifactPaths.join(', ') : '(none declared)'}`,
    `- artifact gate: ${northStar?.artifactGate || 'any'}`,
    ...(paperMode
      ? [
        `- internal checks: ${(northStar?.internalCheckCommands ?? []).length > 0 ? northStar!.internalCheckCommands.join(' | ') : '(none declared)'}`,
        `- internal gate: ${northStar?.internalCheckGate || 'any'}`,
        `- external checks: ${(northStar?.externalCheckCommands ?? []).length > 0 ? northStar!.externalCheckCommands.join(' | ') : '(none declared)'}`,
        `- external gate: ${northStar?.externalCheckGate || 'any'}`,
        `- external quota: require one external success every ${northStar?.externalCheckRequireEvery || 3} turns`,
        `- scoreboard metrics: ${(northStar?.scoreboardMetricPaths ?? []).length > 0 ? northStar!.scoreboardMetricPaths.join(', ') : '(none declared)'}`
      ]
      : []),
    `- verify cmd: ${northStar?.verifyCmd || '(none)'}`,
    `- next action: ${northStar?.nextAction || '(not specified)'}`,
    `- pivot allowed (after >=2 no_delta): ${pivotAllowed ? 'YES' : 'NO'}`,
    ...(paperMode
      ? [
        `- last semantic verdict: ${semanticFeedback?.lastVerdict || 'none'}`,
        `- last semantic reason codes: ${(semanticFeedback?.reasonCodes ?? []).slice(0, 8).join(', ') || '(none)'}`,
        `- open semantic actions: ${(semanticFeedback?.openRequiredActions ?? []).length}`
      ]
      : []),
    '',
    'Execution rules:',
    '1) Produce exactly one primary deliverable action around NorthStarArtifact.',
    ...(paperMode
      ? [
        '2) Execute at least one allowed Internal RealityCheck cmd in this turn and capture command evidence.',
        '2.1) If external quota is due, execute at least one allowed External RealityCheck cmd this turn.',
        '2.2) Use check output to improve scoreboard metrics; unchanged metrics will be NO_DELTA.'
      ]
      : [
        '2) If verify cmd exists, run it in this turn and capture command evidence.',
        '2.1) Do not run verify as the sole action repeatedly; pair it with a real artifact/workspace delta.'
      ]),
    '3) Do not rewrite legacy project planning fields in this mode.',
    '4) NorthStarArtifact paths must be stable project-relative paths; never use runs/turn-xxxx/ paths or any artifact:// URI.',
    '5) If pivot is necessary and allowed, update only NORTHSTAR.md with a short rationale linked to latest failure evidence.',
    ...(pivotAllowed
      ? ['6) Pivot structure edits (path/cmd/realitycheck/scoreboard/external policy) require Pivot rationale + runs/turn-xxxx evidence reference in NORTHSTAR.md.']
      : ['6) Pivot is locked this turn: do not change NorthStarArtifact.path / Verify.cmd / RealityCheck.cmd / Scoreboard / External policy.']),
    '7) Never use destructive shell cleanup (rm -rf / sudo rm / recursive delete).',
    '8) For git-repo code changes, use coding-large-repo/agent-run-to-completion.',
    '9) Evidence paths in projectUpdate must use runs/turn-xxxx/... only.',
    ...(paperMode && semanticMustActions.length > 0
      ? [
        '10) Runtime-promoted semantic MUST actions are blocking debt; prioritize resolving them this turn unless impossible:',
        ...(semanticMustActions.slice(0, 3).map((row) => (
          `- [${row.tier}] ${row.code} (due_turn=${row.due_turn ?? 'n/a'}): ${row.description}`
        )))
      ]
      : []),
    ...(paperMode && semanticMustActions.length === 0 && semanticAdvisoryActions.length > 0
      ? [
        '10) Semantic SHOULD/SUGGEST actions are advisory; integrate when aligned with objective and current constraints:',
        ...(semanticAdvisoryActions.slice(0, 3).map((row) => (
          `- [${row.tier}] ${row.code} (due_turn=${row.due_turn ?? 'n/a'}): ${row.description}`
        )))
      ]
      : []),
    '',
    'Recent turn summaries:',
    recent || '- none',
    '',
    'Blocked failures:',
    blocked || '- none',
    '',
    'Pending user inputs:',
    pendingUserInputs || '- none',
    '',
    'Done (do-not-repeat):',
    done || '- none',
    '',
    'Return JSON only with schema:',
    '{',
    '  "intent": "why this turn",',
    '  "status": "success|failure|ask_user|stopped",',
    '  "summary": "one concise observation",',
    '  "primaryAction": "short label of what was actually done",',
    '  "repoId": "optional explicit repo target id",',
    '  "askQuestion": "required when status=ask_user",',
    '  "stopReason": "required when status=stopped",',
    '  "projectUpdate": {',
    '    "facts": [{"text":"...","evidencePath":"runs/turn-0001/..."}],',
    '    "constraints": [{"text":"...","evidencePath":"runs/turn-0001/..."}],',
    '    "hypotheses": ["[HYP] ..."],',
    '    "keyArtifacts": ["runs/turn-0001/..."],',
    '    "defaultRuntime": "host|docker|venv",',
    '    "claims": [{"claim":"...","evidencePaths":["runs/turn-0001/..."],"status":"uncovered|partial|covered"}]',
    '  },',
    '  "updateSummary": ["<=5 pointer lines"]',
    '}'
  ].join('\n')
}

function buildNativeTurnPrompt(context: TurnContext): string {
  return buildArtifactGravityPrompt(context)
}

function buildNativeRepairPrompt(input: {
  context: TurnContext
  validationError: string
  previousOutput: string
  requirePlanRewrite: boolean
}): string {
  const artifactPaths = canonicalTurnArtifactPaths(input.context)
  const evidencePathRepairHints = /evidence path|runs\/turn-\d{4}/i.test(input.validationError)
    ? [
      '- Evidence path repair required:',
      '- Do NOT use work/... or absolute file paths in projectUpdate evidence fields.',
      `- If proof comes from work/... first write a snapshot under "${artifactPaths.canonicalRelativeFromProject}/evidence/".`,
      '- Then reference only runs/turn-xxxx/... in facts/constraints/claims evidence fields.'
    ]
    : []

  return [
    'Your previous native turn JSON is invalid for YOLO v2.',
    `Validation error: ${input.validationError}`,
    '',
    `Turn: ${input.context.turnNumber}`,
    `Goal: ${input.context.project.goal}`,
    `Default runtime: ${input.context.project.defaultRuntime}`,
    '',
    'Return ONE corrected JSON outcome only.',
    'Allowed status: success|failure|ask_user|stopped.',
    'Required fields:',
    '- intent: non-empty string',
    '- status or statusHint: success|failure|ask_user|stopped',
    '- summary: non-empty string',
    '- askQuestion: required when status=ask_user',
    '- stopReason: required when status=stopped',
    ...evidencePathRepairHints,
    ...(input.requirePlanRewrite
      ? ['- projectUpdate.currentPlan: REQUIRED, 3-5 concrete goal-specific actions (no placeholders)']
      : []),
    '',
    'Previous invalid output:',
    '```',
    input.previousOutput.slice(0, 4000),
    '```'
  ].join('\n')
}

function buildDestructivePolicyRecoveryPrompt(input: {
  context: TurnContext
  blockedCommand: string
  blockedError: string
  previousOutput: string
  requirePlanRewrite: boolean
}): string {
  const artifactPaths = canonicalTurnArtifactPaths(input.context)
  return [
    'Your previous attempt used a destructive bash pattern and was blocked by policy.',
    `Blocked command: ${input.blockedCommand || 'bash command'}`,
    `Policy error: ${input.blockedError || 'destructive command blocked'}`,
    '',
    `Turn: ${input.context.turnNumber}`,
    `Goal: ${input.context.project.goal}`,
    `Default runtime: ${input.context.project.defaultRuntime}`,
    '',
    'Recovery requirements (execute now in this turn):',
    '- Do NOT use rm -rf, sudo rm, or recursive destructive cleanup.',
    '- If an existing directory conflicts, choose a fresh directory name instead of deleting.',
    '- For repository bootstrap/update, use safe idempotent git flow only:',
    '  1) mkdir -p workspace/external',
    '  2) if repo exists: git -C <dir> fetch --depth 1 origin && git -C <dir> pull --ff-only',
    '  3) else: git clone --depth 1 <url> <dir>',
    '- Keep long-lived workspace outside runs/turn-xxxx/.',
    `- Persist verifiable evidence artifacts under "${artifactPaths.canonicalRelativeFromProject}" and reference them in projectUpdate.keyArtifacts.`,
    '',
    'Return ONE corrected JSON outcome only.',
    'Allowed status: success|failure|ask_user|stopped.',
    ...(input.requirePlanRewrite
      ? ['projectUpdate.currentPlan is REQUIRED with 3-5 concrete goal-specific actions.']
      : []),
    '',
    'Previous output:',
    '```',
    input.previousOutput.slice(0, 4000),
    '```'
  ].join('\n')
}

function buildLiteratureBootstrapRepairPrompt(input: {
  context: TurnContext
  previousOutput: string
  usage: LiteratureSearchUsage
  requirePlanRewrite: boolean
}): string {
  const artifactPaths = canonicalTurnArtifactPaths(input.context)
  return [
    'Literature bootstrap requirement was not satisfied in your previous attempt.',
    input.usage.invoked
      ? `Detected literature call, but it did not complete a successful full study: ${input.usage.detail || 'unknown'}`
      : 'No literature-study/literature-search call detected.',
    ...(input.usage.lastError
      ? [`Last literature tool error: ${input.usage.lastError}`]
      : []),
    '',
    `Turn: ${input.context.turnNumber}`,
    `Goal: ${input.context.project.goal}`,
    `Default runtime: ${input.context.project.defaultRuntime}`,
    '',
    'Recovery requirements (execute now in this turn):',
    '- Preferred: call `literature-study` with mode="standard".',
    '- Fallback: call `literature-search` with mode="sweep" if study path fails.',
    `- Include query + bounded limits and outputDir under "${artifactPaths.canonicalRelativeFromProject}/literature-study" or "${artifactPaths.canonicalRelativeFromProject}/literature".`,
    '- Do not stop at one-shot random OpenAlex query dumps.',
    '- Persist produced literature artifacts and include paths in projectUpdate.keyArtifacts.',
    '- Continue with next concrete action only after full study/sweep completes.',
    '',
    'Return ONE corrected JSON outcome only.',
    'Allowed status: success|failure|ask_user|stopped.',
    ...(input.requirePlanRewrite
      ? ['projectUpdate.currentPlan is REQUIRED with 3-5 concrete goal-specific actions.']
      : []),
    '',
    'Previous output:',
    '```',
    input.previousOutput.slice(0, 4000),
    '```'
  ].join('\n')
}

function resolveCurrentActivePlanId(context: TurnContext): string {
  const active = context.project.planBoard
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .find((item) => item.status === 'ACTIVE')
  return active?.id || ''
}

function buildFailureRecoveryPrompt(input: {
  context: TurnContext
  previousOutput: string
  failedSummary: string
  failedPrimaryAction: string
  failureAttempt: number
  requirePlanRewrite: boolean
}): string {
  const activePlanId = resolveCurrentActivePlanId(input.context)
  const artifactPaths = canonicalTurnArtifactPaths(input.context)

  return [
    'Previous attempt ended with status=failure.',
    `Failure summary: ${input.failedSummary || 'unknown failure'}`,
    `Failure action: ${input.failedPrimaryAction || 'agent.run'}`,
    `Recovery attempt: ${input.failureAttempt}/${MAX_FAILURE_RECOVERY_ATTEMPTS}`,
    '',
    `Turn: ${input.context.turnNumber}`,
    `Goal: ${input.context.project.goal}`,
    `Default runtime: ${input.context.project.defaultRuntime}`,
    '',
    'Recovery requirements (execute now in this SAME turn):',
    `- Keep focus on active plan item: ${activePlanId || 'current ACTIVE item'}.`,
    '- For runtime/tool errors, run targeted troubleshooting search first (web/docs) using exact error signature before next blind retry.',
    '- Try a different concrete remediation than previous attempt (different command/tool/input).',
    '- Produce at least one new verifiable artifact under runs/turn-xxxx/artifacts.',
    '- Do NOT mark ACTIVE -> DONE unless done_definition is satisfied by this turn evidence.',
    '- If still blocked after retries, return status=ask_user with one concrete question that unblocks execution.',
    `- Evidence paths must stay under "${artifactPaths.canonicalRelativeFromProject}".`,
    '',
    'Return ONE corrected JSON outcome only.',
    'Allowed status: success|failure|ask_user|stopped.',
    ...(input.requirePlanRewrite
      ? ['projectUpdate.currentPlan is REQUIRED with 3-5 concrete goal-specific actions.']
      : []),
    '',
    'Previous output:',
    '```',
    input.previousOutput.slice(0, 4000),
    '```'
  ].join('\n')
}

function buildEscalationAskQuestion(input: {
  goal: string
  activePlanId: string
  failureSummary: string
  suggestedNeed?: string
}): string {
  const targetPlan = input.activePlanId || 'current ACTIVE plan item'
  const reason = input.failureSummary.trim() || 'execution remained blocked after retries'
  const suggestion = input.suggestedNeed?.trim()
    ? `Need from you: ${input.suggestedNeed.trim()}`
    : 'Need from you: choose one unblock path (credentials/environment fix/scope change).'

  return [
    `Paused at ${targetPlan}.`,
    `Goal: ${input.goal}`,
    `Blocker: ${reason}`,
    suggestion
  ].join(' ')
}

function normalizeTurnOutcome(value: unknown): TurnRunOutcome {
  if (!value || typeof value !== 'object') {
    throw new Error('turn outcome must be a JSON object')
  }

  const row = value as Record<string, unknown>
  const intent = typeof row.intent === 'string' ? row.intent.trim() : ''
  const summary = typeof row.summary === 'string' ? row.summary.trim() : ''
  const rawStatus = typeof row.status === 'string'
    ? row.status
    : (typeof row.statusHint === 'string' ? row.statusHint : '')
  const status = rawStatus.trim().toLowerCase()

  if (!intent) throw new Error('turn outcome.intent is required')
  if (!summary) throw new Error('turn outcome.summary is required')
  if (!['success', 'failure', 'ask_user', 'stopped'].includes(status)) {
    throw new Error('turn outcome.status/statusHint is invalid')
  }

  const askQuestion = typeof row.askQuestion === 'string' ? row.askQuestion.trim() : ''
  const stopReason = typeof row.stopReason === 'string' ? row.stopReason.trim() : ''
  const activePlanId = typeof row.activePlanId === 'string' ? row.activePlanId.trim().toUpperCase() : ''
  const repoId = typeof row.repoId === 'string'
    ? row.repoId.trim()
    : (typeof row.repo_id === 'string' ? row.repo_id.trim() : '')
  const statusChange = typeof row.statusChange === 'string' ? row.statusChange.trim() : ''
  const delta = typeof row.delta === 'string' ? row.delta.trim() : ''
  const evidencePaths = Array.isArray(row.evidencePaths)
    ? row.evidencePaths.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
  const dropReason = typeof row.dropReason === 'string' ? row.dropReason.trim() : ''
  const replacedBy = row.replacedBy === null
    ? null
    : typeof row.replacedBy === 'string'
      ? row.replacedBy.trim().toUpperCase()
      : undefined
  if (status === 'ask_user' && !askQuestion) {
    throw new Error('turn outcome.askQuestion is required when status=ask_user')
  }
  if (status === 'stopped' && !stopReason) {
    throw new Error('turn outcome.stopReason is required when status=stopped')
  }
  if (/->\s*DROPPED/i.test(statusChange)) {
    if (!dropReason) throw new Error('turn outcome.dropReason is required when dropping a plan item')
    if (replacedBy === undefined) throw new Error('turn outcome.replacedBy (Pn|null) is required when dropping a plan item')
  }

  return {
    intent,
    status: status as TurnRunOutcome['status'],
    summary,
    primaryAction: typeof row.primaryAction === 'string' ? row.primaryAction.trim() : undefined,
    repoId: repoId || undefined,
    activePlanId: activePlanId || undefined,
    statusChange: statusChange || undefined,
    delta: delta || undefined,
    evidencePaths: evidencePaths.length > 0 ? evidencePaths : undefined,
    dropReason: dropReason || undefined,
    replacedBy,
    askQuestion: askQuestion || undefined,
    stopReason: stopReason || undefined,
    projectUpdate: typeof row.projectUpdate === 'object' && row.projectUpdate
      ? row.projectUpdate as TurnRunOutcome['projectUpdate']
      : undefined,
    updateSummary: Array.isArray(row.updateSummary)
      ? row.updateSummary.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : undefined
  }
}

export interface NorthStarSemanticGateLlmEvaluatorConfig {
  model: string
  apiKey?: string
  timeoutMs?: number
  maxTokens?: number
}

export function createNorthStarSemanticGateLlmEvaluator(config: NorthStarSemanticGateLlmEvaluatorConfig): NorthStarSemanticGateEvaluator {
  const modelId = (config.model || '').trim()
  if (!modelId) {
    throw new Error('createNorthStarSemanticGateLlmEvaluator: model is required')
  }

  const languageModel = getLanguageModelByModelId(modelId, {
    ...(config.apiKey?.trim() ? { apiKey: config.apiKey.trim() } : {})
  })

  const timeoutMs = (
    typeof config.timeoutMs === 'number'
    && Number.isFinite(config.timeoutMs)
    && config.timeoutMs >= 3_000
  )
    ? Math.floor(config.timeoutMs)
    : DEFAULT_NORTHSTAR_SEMANTIC_GATE_TIMEOUT_MS

  const maxTokens = (
    typeof config.maxTokens === 'number'
    && Number.isFinite(config.maxTokens)
    && config.maxTokens >= 100
  )
    ? Math.floor(config.maxTokens)
    : DEFAULT_NORTHSTAR_SEMANTIC_GATE_MAX_TOKENS

  return async (input: NorthStarSemanticGateInput) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const payload = JSON.stringify(input)
      const result = await generateStructured({
        model: languageModel,
        system: NORTHSTAR_SEMANTIC_GATE_SYSTEM_PROMPT,
        prompt: [
          'Evaluate the following JSON input.',
          'Focus on objective alignment, evidence validity, substantive novelty, falsifiability, and trajectory health.',
          'Output schema: yolo.northstar_semantic_gate.output.v1',
          '',
          payload
        ].join('\n'),
        schema: northStarSemanticGateOutputSchema,
        schemaName: 'YoloNorthStarSemanticGateOutput',
        temperature: 0,
        maxTokens,
        retries: 1,
        abortSignal: controller.signal
      })

      return {
        schema: 'yolo.northstar_semantic_gate.output.v1',
        confidence: result.output.confidence,
        dimension_scores: result.output.dimension_scores,
        reason_codes: result.output.reason_codes,
        claim_audit: result.output.claim_audit,
        required_actions: result.output.required_actions.map((action) => ({
          tier: action.tier,
          code: action.code,
          description: action.description,
          ...(typeof action.due_turn === 'number' ? { due_turn: action.due_turn } : {})
        })),
        summary: result.output.summary,
        ...(result.output.verdict ? { verdict: result.output.verdict } : {})
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const cause = error && typeof error === 'object'
        ? (error as { cause?: unknown }).cause
        : undefined
      const causeMessage = cause instanceof Error
        ? cause.message
        : (typeof cause === 'string' ? cause : '')
      const diagnosticMessage = causeMessage && causeMessage !== message
        ? `${message}; cause=${causeMessage}`
        : message
      return {
        schema: 'yolo.northstar_semantic_gate.output.v1',
        confidence: 0,
        dimension_scores: {
          goal_alignment: 0,
          evidence_strength: 0,
          novelty_delta: 0,
          falsifiability: 0,
          trajectory_health: 0
        },
        reason_codes: ['evaluator_error'],
        required_actions: [],
        summary: `semantic evaluator fallback: ${diagnosticMessage}`,
        verdict: 'abstain'
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export class LlmSingleAgent implements YoloSingleAgent {
  private readonly agentPromise: Promise<ReturnType<typeof createAgent>>
  private currentToolEvents: ToolEventRecord[] | null = null
  private currentTurnNumber: number | null = null
  private readonly realtimeUnsubscribers: Array<() => void> = []

  constructor(private readonly config: LlmSingleAgentConfig) {
    const capabilityProfile = config.capabilityProfile ?? 'full'
    const enableNetwork = config.enableNetwork ?? true
    const externalSkillsDir = resolveExternalSkillsDir(config.projectPath, config.externalSkillsDir)
    seedBundledSkills(externalSkillsDir, resolveBundledSkillSourceDir())

    this.agentPromise = this.createRuntimeAgent({
      capabilityProfile,
      enableNetwork,
      externalSkillsDir
    })
  }

  private async createRuntimeAgent(input: {
    capabilityProfile: CapabilityProfile
    enableNetwork: boolean
    externalSkillsDir: string
  }): Promise<ReturnType<typeof createAgent>> {
    const packList = await buildAgentPacks(input.capabilityProfile, input.enableNetwork, this.config.projectPath)
    const ioLimits = {
      ...DEFAULT_LONG_TASK_IO_LIMITS,
      ...(this.config.ioLimits ?? {})
    }

    const runtimeSystemInfo = (this.config.runtimeSystemInfo || '').trim()
    const agent = createAgent({
      projectPath: this.config.projectPath,
      model: this.config.model,
      apiKey: this.config.apiKey,
      maxSteps: this.config.maxSteps ?? (input.capabilityProfile === 'full' ? 16 : 8),
      maxTokens: this.config.maxTokens ?? (input.capabilityProfile === 'full' ? 8_000 : 4_000),
      ioLimits,
      packs: packList,
      disablePolicies: this.config.disablePolicies ?? true,
      externalSkillsDir: input.externalSkillsDir,
      communitySkillsDir: this.config.communitySkillsDir,
      watchExternalSkills: this.config.watchExternalSkills ?? true,
      watchCommunitySkills: this.config.watchCommunitySkills ?? false,
      onApprovalRequired: this.config.autoApprove === false
        ? undefined
        : async () => true,
      onToolCall: (tool, input) => {
        if (tool === 'skill-script-run') {
          applyCodingLargeRepoRunGuards(input)
        }
        const stringLimit = tool === 'fetch' ? FETCH_EVENT_STRING_LIMIT : TOOL_EVENT_STRING_LIMIT
        const event: ToolEventRecord = {
          timestamp: new Date().toISOString(),
          phase: 'call',
          tool,
          input: sanitizeForEvent(input, 0, stringLimit)
        }
        if (this.currentToolEvents) {
          this.currentToolEvents.push(event)
        }
        this.emitRealtimeToolEvent(event)
      },
      onToolResult: (tool, result, args) => {
        const stringLimit = tool === 'fetch' ? FETCH_EVENT_STRING_LIMIT : TOOL_EVENT_STRING_LIMIT
        const resultObj = result && typeof result === 'object'
          ? result as Record<string, unknown>
          : null
        const event: ToolEventRecord = {
          timestamp: new Date().toISOString(),
          phase: 'result',
          tool,
          input: sanitizeForEvent(args, 0, stringLimit),
          result: sanitizeForEvent(result, 0, stringLimit),
          success: typeof resultObj?.success === 'boolean' ? resultObj.success : undefined,
          error: typeof resultObj?.error === 'string' ? truncateText(resultObj.error) : undefined
        }
        if (this.currentToolEvents) {
          this.currentToolEvents.push(event)
        }
        this.emitRealtimeToolEvent(event)
      },
      onUsage: this.config.onUsage,
      constraints: [
        'One turn = one native execution report. You may perform multiple tool calls inside the turn.',
        'Prefer evidence-producing actions. Save turn artifacts under runs/turn-xxxx/artifacts and use evidencePath as runs/turn-xxxx/...',
        'Never use work/... or absolute paths in projectUpdate evidence fields; snapshot to runs/turn-xxxx/artifacts/evidence first.',
        'For research/prior-art goals, run literature-study(mode="standard") early (fallback: literature-search(mode="sweep")) and persist processed literature artifacts locally.',
        'When modifying files inside a git repo, use coding-large-repo/agent-run-to-completion before code edits.',
        'Runtime derives active_plan_id/status_change/delta/evidence_paths from tool events + file writes.',
        'Success is valid only if this turn touches a plan deliverable (done_definition deliverable:) or clears a blocker.',
        'Use mechanical done_definition rows only: deliverable:<turn-local path or token> and optional evidence_min:<n>.',
        'For turn artifacts prefer deliverable: artifacts/<name>; avoid fixed runs/turn-xxxx/... deliverable paths.',
        'Be resourceful before asking user; Ask is last resort when truly blocked.',
        'Never use destructive shell cleanup (rm -rf / sudo rm / recursive delete). Prefer fresh target dirs.',
        'Do not Stop unless milestone completion or explicit stop/safety condition.',
        'Use available tools/skills before asking user. Treat ask_user as escalation, not default.',
        ...(runtimeSystemInfo
          ? [`Runtime/system hint from user: ${runtimeSystemInfo}`]
          : [])
      ],
      identity: 'You are a single-agent autonomous researcher that follows YOLO v2 thin protocol.'
    })

    this.attachRealtimeExecBridge(agent)
    return agent
  }

  private emitRealtimeToolEvent(event: ToolEventRecord): void {
    const turnNumber = this.currentTurnNumber
    if (!this.config.onToolEvent || typeof turnNumber !== 'number') return

    try {
      this.config.onToolEvent({
        ...event,
        turnNumber
      })
    } catch {
      // Best-effort telemetry callback only.
    }
  }

  private attachRealtimeExecBridge(agent: ReturnType<typeof createAgent>): void {
    if (!this.config.onExecEvent) return

    const emitExec = (phase: LlmRealtimeExecEvent['phase'], payload: unknown): void => {
      const turnNumber = this.currentTurnNumber
      if (typeof turnNumber !== 'number') return

      const row = toPlainObject(payload)
      const streamCandidate = safeString(row?.stream).trim().toLowerCase()
      const stream = streamCandidate === 'stdout' || streamCandidate === 'stderr'
        ? streamCandidate
        : undefined
      const traceId = safeString(row?.traceId).trim() || undefined
      const caller = safeString(row?.caller).trim() || undefined
      const command = safeString(row?.command).trim() || undefined
      const cwd = safeString(row?.cwd).trim() || undefined
      const chunk = safeString(row?.chunk)
      const error = safeString(row?.error).trim() || undefined
      const truncated = typeof row?.truncated === 'boolean' ? row.truncated : undefined
      const exitCode = typeof row?.exitCode === 'number' ? row.exitCode : undefined
      const signal = safeString(row?.signal).trim() || undefined
      const durationMs = typeof row?.durationMs === 'number' ? row.durationMs : undefined

      try {
        this.config.onExecEvent?.({
          turnNumber,
          timestamp: new Date().toISOString(),
          phase,
          traceId,
          caller,
          command,
          cwd,
          stream,
          chunk: chunk || undefined,
          truncated,
          exitCode,
          signal,
          durationMs,
          error
        })
      } catch {
        // Best-effort telemetry callback only.
      }
    }

    this.realtimeUnsubscribers.push(agent.runtime.eventBus.on('io:exec:start', (payload) => emitExec('start', payload)))
    this.realtimeUnsubscribers.push(agent.runtime.eventBus.on('io:exec:chunk', (payload) => emitExec('chunk', payload)))
    this.realtimeUnsubscribers.push(agent.runtime.eventBus.on('io:exec:end', (payload) => emitExec('end', payload)))
    this.realtimeUnsubscribers.push(agent.runtime.eventBus.on('io:exec:error', (payload) => emitExec('error', payload)))
  }

  async runTurn(context: TurnContext): Promise<TurnRunOutcome> {
    let agent: ReturnType<typeof createAgent>
    try {
      agent = await this.agentPromise
      await agent.ensureInit()
      const turnPaths = canonicalTurnArtifactPaths(context)
      agent.runtime.sessionState.set('yolo.turnId', turnPaths.turnId)
      agent.runtime.sessionState.set('yolo.turnArtifactsDir', turnPaths.canonicalRelativeFromProject)
      agent.runtime.sessionState.set('yolo.turnArtifactsAbsDir', turnPaths.canonicalAbsolute)
      agent.runtime.sessionState.set('yolo.workspaceRoot', context.projectRoot)
      if (Array.isArray(context.workspaceGitRepos) && context.workspaceGitRepos.length > 0) {
        agent.runtime.sessionState.set('yolo.workspaceGitRepos', context.workspaceGitRepos)
        agent.runtime.sessionState.set('git.defaultCwd', context.workspaceGitRepos[0])
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        intent: 'Initialize native agent runtime',
        status: 'failure',
        summary: `Agent initialization failed: ${message}`,
        primaryAction: 'agent.init'
      }
    }

    const requirePlanRewrite = false
    const literatureBootstrapNeeded = goalNeedsLiteratureBootstrap(context.project.goal) && !hasLiteratureArtifacts(context)

    let prompt = buildNativeTurnPrompt(context)
    let rawOutput = ''
    let lastValidationError = ''
    let failureRecoveryAttempts = 0
    let runtimeFailureAttempts = 0
    const fallbackActivePlanId = resolveCurrentActivePlanId(context)
    this.currentTurnNumber = context.turnNumber
    this.currentToolEvents = []

    try {
      for (let attempt = 1; attempt <= MAX_OUTCOME_ATTEMPTS; attempt += 1) {
        const result = await agent.run(prompt)
        rawOutput = result.output || rawOutput

        if (!result.success) {
          const failureMessage = (result.error || 'Agent run failed without error details.').trim()
          runtimeFailureAttempts += 1
          if (runtimeFailureAttempts <= MAX_FAILURE_RECOVERY_ATTEMPTS && attempt < MAX_OUTCOME_ATTEMPTS) {
            prompt = buildFailureRecoveryPrompt({
              context,
              previousOutput: result.output || '',
              failedSummary: failureMessage,
              failedPrimaryAction: 'agent.run',
              failureAttempt: runtimeFailureAttempts,
              requirePlanRewrite
            })
            continue
          }

          return {
            intent: 'Pause for user input after repeated runtime failures',
            status: 'ask_user',
            summary: `Paused: ${failureMessage}`,
            primaryAction: 'agent.run',
            activePlanId: fallbackActivePlanId || undefined,
            askQuestion: buildEscalationAskQuestion({
              goal: context.project.goal,
              activePlanId: fallbackActivePlanId,
              failureSummary: failureMessage,
              suggestedNeed: 'confirm runtime/environment fix or allow narrowing scope'
            }),
            toolEvents: this.currentToolEvents,
            rawOutput
          }
        }

        try {
          const parsed = JSON.parse(extractJson(result.output)) as unknown
          const outcome = normalizeTurnOutcome(parsed)
          if (requirePlanRewrite) {
            validatePlanRewriteProjectUpdate(outcome.projectUpdate)
          }

          if (literatureBootstrapNeeded) {
            const usage = detectLiteratureSearchUsage(this.currentToolEvents ?? [])
            if (!usage.invoked || !usage.fullMode || !usage.fullModeSuccess) {
              if (attempt >= MAX_OUTCOME_ATTEMPTS) {
                const failureSummary = !usage.invoked
                  ? 'Literature bootstrap missing: literature-study(mode="standard") or literature-search(mode="sweep") was never executed.'
                  : !usage.fullMode
                    ? `Literature bootstrap incomplete (${usage.detail || 'non-full study'}); retry budget exhausted.`
                    : `Literature bootstrap failed after invocation: ${usage.lastError || 'full literature study did not complete successfully'}.`
                return {
                  intent: 'Pause for user input after literature bootstrap retries exhausted',
                  status: 'ask_user',
                  summary: `Paused: ${failureSummary}`,
                  primaryAction: 'literature-study: standard',
                  activePlanId: fallbackActivePlanId || undefined,
                  askQuestion: buildEscalationAskQuestion({
                    goal: context.project.goal,
                    activePlanId: fallbackActivePlanId,
                    failureSummary,
                    suggestedNeed: 'confirm literature source/tool availability or provide alternate source constraints'
                  }),
                  toolEvents: this.currentToolEvents,
                  rawOutput
                }
              }

              prompt = buildLiteratureBootstrapRepairPrompt({
                context,
                previousOutput: result.output,
                usage,
                requirePlanRewrite
              })
              continue
            }
          }

          const destructiveBlock = detectDestructivePolicyBlockedBash(this.currentToolEvents ?? [])
          if (destructiveBlock) {
            if (attempt >= MAX_OUTCOME_ATTEMPTS) {
              const failureSummary = `Policy blocked destructive command (${destructiveBlock.errorLine}); safe retry attempts exhausted.`
              return {
                intent: 'Pause for user input after policy-blocked retries exhausted',
                status: 'ask_user',
                summary: `Paused: ${failureSummary}`,
                primaryAction: 'bash: safe repo bootstrap',
                activePlanId: fallbackActivePlanId || undefined,
                askQuestion: buildEscalationAskQuestion({
                  goal: context.project.goal,
                  activePlanId: fallbackActivePlanId,
                  failureSummary,
                  suggestedNeed: 'approve alternate non-destructive directory/repo strategy'
                }),
                toolEvents: this.currentToolEvents,
                rawOutput
              }
            }

            prompt = buildDestructivePolicyRecoveryPrompt({
              context,
              blockedCommand: destructiveBlock.command,
              blockedError: destructiveBlock.errorLine,
              previousOutput: result.output,
              requirePlanRewrite
            })
            continue
          }

          if (outcome.status === 'failure') {
            failureRecoveryAttempts += 1
            const failedSummary = outcome.summary || 'Native attempt failed.'
            const failedPrimaryAction = outcome.primaryAction || 'agent.run'
            const activePlanId = outcome.activePlanId?.trim().toUpperCase() || fallbackActivePlanId

            if (failureRecoveryAttempts <= MAX_FAILURE_RECOVERY_ATTEMPTS && attempt < MAX_OUTCOME_ATTEMPTS) {
              prompt = buildFailureRecoveryPrompt({
                context,
                previousOutput: result.output,
                failedSummary,
                failedPrimaryAction,
                failureAttempt: failureRecoveryAttempts,
                requirePlanRewrite
              })
              continue
            }

            return {
              intent: 'Pause for user input after repeated native failures',
              status: 'ask_user',
              summary: `Paused after ${failureRecoveryAttempts} failed attempt(s): ${failedSummary}`,
              primaryAction: failedPrimaryAction,
              activePlanId: activePlanId || undefined,
              askQuestion: buildEscalationAskQuestion({
                goal: context.project.goal,
                activePlanId,
                failureSummary: failedSummary
              }),
              updateSummary: outcome.updateSummary,
              toolEvents: this.currentToolEvents,
              rawOutput
            }
          }

          return {
            ...outcome,
            toolEvents: this.currentToolEvents,
            rawOutput
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          lastValidationError = message

          if (attempt >= MAX_OUTCOME_ATTEMPTS) break
          prompt = buildNativeRepairPrompt({
            context,
            validationError: message,
            previousOutput: result.output,
            requirePlanRewrite
          })
        }
      }

      return {
        intent: 'Pause for user input after invalid native output retries exhausted',
        status: 'ask_user',
        summary: `Paused: native turn output remained invalid after ${MAX_OUTCOME_ATTEMPTS} attempts`,
        primaryAction: 'agent.run',
        activePlanId: fallbackActivePlanId || undefined,
        askQuestion: buildEscalationAskQuestion({
          goal: context.project.goal,
          activePlanId: fallbackActivePlanId,
          failureSummary: lastValidationError || 'native output invalid after repeated retries',
          suggestedNeed: 'decide whether to continue with stricter constraints or reset this turn'
        }),
        toolEvents: this.currentToolEvents,
        rawOutput
      }
    } finally {
      this.currentToolEvents = null
      this.currentTurnNumber = null
    }
  }

  async destroy(): Promise<void> {
    for (const unsubscribe of this.realtimeUnsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch {
        // Ignore bridge cleanup errors.
      }
    }
    const agent = await this.agentPromise
    await agent.destroy()
  }
}

export function createLlmSingleAgent(config: LlmSingleAgentConfig): LlmSingleAgent {
  return new LlmSingleAgent(config)
}
