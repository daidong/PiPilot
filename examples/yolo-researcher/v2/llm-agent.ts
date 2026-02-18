import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgent, definePack } from '../../../src/index.js'
import { packs } from '../../../src/packs/index.js'
import { yoloResearcherSkills } from '../skills/index.js'
import { createYoloToolWrapperPack } from './tool-wrappers.js'

import type { ClaimEvidence, ToolEventRecord, TurnContext, TurnRunOutcome, YoloSingleAgent } from './types.js'
import type { Pack } from '../../../src/types/pack.js'

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
  onToolEvent?: (event: LlmRealtimeToolEvent) => void
  onExecEvent?: (event: LlmRealtimeExecEvent) => void
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
const BOOTSTRAP_PLAN_PREFIX = 'bootstrap pending: replace with 3-5 goal-specific next actions'
const TOOL_EVENT_STRING_LIMIT = 6000
const FETCH_EVENT_STRING_LIMIT = 80_000
const POLICY_BLOCK_RE = /(no[-\s]?destructive|destructive policy|blocked by (a )?policy|policy block|forbidden|not allowed|disallowed)/i
const DESTRUCTIVE_RM_RE = /\brm\s+-rf\b/i

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

function hasLiteratureArtifacts(context: TurnContext): boolean {
  const pool = [
    ...context.project.keyArtifacts,
    ...context.project.facts.map((item) => item.evidencePath),
    ...context.project.constraints.map((item) => item.evidencePath)
  ]

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

function buildNativeTurnPrompt(context: TurnContext): string {
  const recent = context.recentTurns
    .map((turn) => `- ${turn.actionPath}: ${turn.summary}`)
    .join('\n')

  const blocked = context.failures
    .filter((item) => item.status === 'BLOCKED')
    .map((item) => `- [${item.runtime}] ${item.cmd} :: ${item.errorLine}`)
    .join('\n')

  const pendingUserInputs = context.pendingUserInputs
    .map((item) => `- ${item.submittedAt} :: ${item.text} (evidence: ${item.evidencePath})`)
    .join('\n')
  const done = context.project.done
    .slice(-8)
    .map((item) => `- ${item.text} (evidence: ${item.evidencePath})`)
    .join('\n')

  const planNeedsRewrite = requiresPlanRewrite(context.project.currentPlan)
  const plannerCheckpointDue = Boolean(context.plannerCheckpoint?.due)
  const literatureBootstrapNeeded = goalNeedsLiteratureBootstrap(context.project.goal) && !hasLiteratureArtifacts(context)
  const artifactPaths = canonicalTurnArtifactPaths(context)
  const literatureOutputDir = `${artifactPaths.canonicalRelativeFromProject}/literature`
  const literatureOutputDirAbs = toPosixPath(join(context.projectRoot, literatureOutputDir))
  const hasProblemStatement = [
    ...context.project.keyArtifacts,
    ...context.project.done.map((entry) => entry.evidencePath),
    ...context.project.planBoard.flatMap((item) => item.evidencePaths)
  ].some((entry) => /problem_statement/i.test(entry))
  const workspaceGitRepos = (context.workspaceGitRepos ?? []).slice(0, 8)
  const planBoardView = renderPlanBoardForPrompt(context)
  const plannerCheckpointReasons = context.plannerCheckpoint?.reasons ?? []
  const activePlan = context.project.planBoard
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .find((item) => item.status === 'ACTIVE')
  const top3PlanItems = context.project.planBoard
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 3)
  const top3NeedsLiterature = top3PlanItems.some((item) => {
    if (item.status === 'DONE' || item.status === 'DROPPED') return false
    const text = `${item.title}\n${item.doneDefinition.join('\n')}`.toLowerCase()
    return /(literature|prior art|related work|survey|paper|citation|novelty|reading[_ -]?list|matrix|arxiv|openalex|doi)/.test(text)
  })
  const hasRecentSweepEvidence = context.project.done
    .slice(-8)
    .some((item) => {
      const text = `${item.text}\n${item.evidencePath}`.toLowerCase()
      return /(literature|reading[_ -]?list|matrix|openalex|arxiv|scholar|doi|search[-_ ]?sweep|sweep)/.test(text)
    })
  const literatureSweepRecommended = top3NeedsLiterature && !hasRecentSweepEvidence

  return [
    'You are YOLO-Researcher v2 native runner.',
    'Design axiom: minimal discipline to avoid death + evidence-driven strengthening.',
    'This turn is native: you may use ALL available tools/skills/subagents directly.',
    'Do real work, produce evidence, then return one JSON report.',
    '',
    'Mode rule (critical):',
    `- plannerCheckpoint=${plannerCheckpointDue ? 'TRUE' : 'FALSE'}.`,
    ...(plannerCheckpointDue && plannerCheckpointReasons.length > 0
      ? [`- plannerCheckpoint reasons: ${plannerCheckpointReasons.join(', ')}`]
      : []),
    ...(plannerCheckpointDue
      ? [
        '- This is a PLANNING turn.',
        '- You MAY update Plan Board structure (Top-3 ordering, add/drop/merge items, edit done_definition).',
        '- Keep this turn governance-only. Avoid heavy evidence collection or long multi-tool execution.'
      ]
      : [
        '- This is an EXECUTION turn.',
        '- You MUST NOT modify Plan Board structure (no add/drop/merge/replace/reorder Top-3, no done_definition edits).',
        '- Advance one concrete deliverable in this turn; runtime will attribute plan binding post-turn.'
      ]),
    '',
    'Deliverable rule (critical):',
    '- A SUCCESS hint should correspond to at least one deliverable update or blocker clear with evidence.',
    '- Adding only supporting evidence snippets/cite seeds without deliverable update is NOT success and may be downgraded to no_delta.',
    '',
    'Read-back rule (critical):',
    '- Before new fetch/sweep, read current deliverable files and confirm the exact missing gap first.',
    '',
    'Hard rules:',
    '1) Prefer autonomous execution. Retry concrete fixes before asking user.',
    literatureSweepRecommended
      ? '2) Literature study is recommended now: Top-3 still has unmet literature deliverables and recent sweep evidence is missing. Run literature-study({mode:"standard"}) before deep code reading.'
      : '2) Literature study is conditional: run literature-study({mode:"standard"}) when Top-3 literature deliverables are unmet and recent evidence is missing; otherwise prioritize consolidating existing literature into deliverables.',
    '3) Do not do exhaustive repo reading. Use high-leverage slices first (README, rg, entrypoints).',
    '4) If you will modify files inside a git repo, you MUST use coding-large-repo workflow first: repo-intake -> change-plan -> delegate-coding-agent/agent-start.',
    '5) Direct write/edit repo code changes without coding-large-repo delegate flow are invalid and will be downgraded to no_delta.',
    '6) Never use destructive shell cleanup (rm -rf / sudo rm / recursive delete). If path is dirty, choose a new target directory name.',
    '7) Never clone or create long-lived workspaces under runs/turn-xxxx/.',
    `8) Write turn artifacts only under "${artifactPaths.canonicalRelativeFromProject}" (absolute: ${artifactPaths.canonicalAbsolute}).`,
    '9) projectUpdate evidence paths must use "runs/turn-xxxx/...". Never use work/, absolute paths, or other roots in evidencePath fields.',
    '10) Persist processed literature artifacts under current turn artifacts.',
    '11) Respect Done(Do-not-repeat): avoid repeating identical action fingerprints unless you will produce a new artifact type.',
    '12) Runtime derives active_plan_id/status_change/delta/evidence_paths from observed execution; do not invent them.',
    '13) done_definition must be mechanical only: use "deliverable: <path-or-file-token>" and optional "evidence_min: <n>".',
    '14) Plan structure edits (planBoard/currentPlan rewrite, drop/replace, done_definition edits, Top-3 reorder) are allowed ONLY when planner checkpoint is due.',
    '15) If repeated attempts in this turn still fail, return ask_user with one concrete blocking question and pause.',
    '16) If using git_* tools, always set cwd to a concrete repo path; never assume project root itself is a git repo.',
    '',
    `Turn: ${context.turnNumber}`,
    `Goal: ${context.project.goal}`,
    `Default runtime: ${context.project.defaultRuntime}`,
    `Literature output dir (relative): ${literatureOutputDir}`,
    `Literature output dir (absolute): ${literatureOutputDirAbs}`,
    `Turn artifact dir (relative): ${artifactPaths.canonicalRelativeFromProject}`,
    `Turn artifact dir (absolute): ${artifactPaths.canonicalAbsolute}`,
    `Workspace git repos: ${workspaceGitRepos.length > 0 ? workspaceGitRepos.join(', ') : '(none discovered)'}`,
    'Evidence snapshot rule:',
    '- If source proof is in work/... or any non-runs path, create a snapshot file under runs/turn-xxxx/artifacts/evidence/... first.',
    '- Then cite ONLY that runs/turn-xxxx/... snapshot path in facts/constraints/claims/planBoard evidence fields.',
    ...(hasProblemStatement
      ? []
      : [
        'Deliverable gate: problem_statement.md is still missing.',
        `Produce it in this turn under "${artifactPaths.canonicalRelativeFromProject}" before broader literature synthesis.`
      ]),
    ...(literatureBootstrapNeeded
      ? [
        '',
        'Research bootstrap gate:',
        '- No literature evidence is recorded yet for this goal.',
        '- In this turn, run literature-study({query:"<query>",mode:"standard"}) before deep code reading.',
        `- Use outputDir "${literatureOutputDir}" (or "${artifactPaths.canonicalRelativeFromProject}/literature-study").`,
        `- Save at least one processed artifact under "${artifactPaths.canonicalRelativeFromProject}", and keep references in projectUpdate.keyArtifacts.`
      ]
      : []),
    '',
    'Plan Board (stable IDs):',
    planBoardView,
    '',
    `Current active plan: ${activePlan ? `${activePlan.id} ${activePlan.title}` : '(none)'}`,
    '',
    'Current Plan (derived):',
    ...context.project.currentPlan.map((item, idx) => `${idx + 1}. ${item}`),
    ...(planNeedsRewrite && plannerCheckpointDue
      ? [
        '',
        'Plan quality gate:',
        '- Current Plan is bootstrap/template.',
        '- Planner checkpoint is due: projectUpdate.currentPlan is REQUIRED with 3-5 concrete goal-specific next actions.'
      ]
      : []),
    ...(planNeedsRewrite && !plannerCheckpointDue
      ? [
        '',
        'Plan quality gate:',
        '- Current Plan is bootstrap/template.',
        '- Planner checkpoint is NOT due: do not rewrite planBoard/currentPlan in this turn; focus on deliverable execution only.'
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
    ...(context.plannerCheckpoint?.due
      ? [
        '',
        `Planner checkpoint due: ${context.plannerCheckpoint.reasons.join(', ')}`,
        '- Governance window open: you may refresh Plan Board Top-3 priorities and done_definition fields.'
      ]
      : [
        '',
        'Planner checkpoint not due:',
        '- Do NOT rewrite planBoard/currentPlan in projectUpdate this turn.'
      ]),
    '',
    'Focus: Each turn should advance ONE deliverable.',
    'Do not combine literature search + code analysis + writing in a single turn.',
    ...(context.stagnation?.stagnant
      ? [
        '',
        `STAGNATION WARNING: Last ${context.stagnation.count}/${context.stagnation.window} turns used action type "${context.stagnation.dominantAction}".`,
        'You MUST change strategy this turn:',
        `- Use a different action/tool type than "${context.stagnation.dominantAction}", OR`,
        '- Produce a stage-advancing deliverable, OR',
        '- Clear/record blocker transitions, OR',
        '- Ask user if truly blocked.',
        'Expected deliverables: problem_statement.md, literature_map.md, idea_candidates.md, experiment_plan.md, paper_draft.md',
        'Repeating the dominant action type without stage advancement will be treated as no progress.'
      ]
      : []),
    ...((() => {
      const claims = context.project.claims
      if (claims.length === 0) return []
      const covered = claims.filter((c: ClaimEvidence) => c.status === 'covered').length
      const uncoveredClaims = claims.filter((c: ClaimEvidence) => c.status === 'uncovered')
      const lines = [
        '',
        `Claims coverage: ${covered}/${claims.length} (${Math.round(covered / claims.length * 100)}%)`
      ]
      if (uncoveredClaims.length > 0) {
        lines.push(`Uncovered: "${uncoveredClaims[0].claim}"`)
      }
      return lines
    })()),
    '',
    'Return JSON only with schema:',
    '{',
    '  "intent": "why this turn",',
    '  "status": "success|failure|ask_user|stopped", // or use statusHint with same enum',
    '  "summary": "one concise observation",',
    '  "primaryAction": "short label of what was actually done",',
    '  "statusHint": "success|failure|ask_user|stopped (optional alias of status)",',
    '  "askQuestion": "required when status=ask_user",',
    '  "stopReason": "required when status=stopped",',
    '  "projectUpdate": {',
    '    "planBoard": [{"id":"P2","title":"...","status":"TODO|ACTIVE|DONE|BLOCKED|DROPPED","doneDefinition":["deliverable: runs/turn-0001/artifacts/problem_statement.md","evidence_min: 1"],"evidencePaths":["runs/turn-0001/..."],"nextMinStep":"...","priority":1}], // ONLY when planner checkpoint is due',
    '    "currentPlan": ["up to 5 items"], // ONLY when planner checkpoint is due',
    '    // If proof comes from work/... first write snapshot to runs/turn-xxxx/artifacts/evidence/*.md',
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
      '- Then reference only runs/turn-xxxx/... in facts/constraints/claims/planBoard.evidencePaths.'
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

    const agent = createAgent({
      projectPath: this.config.projectPath,
      model: this.config.model,
      apiKey: this.config.apiKey,
      maxSteps: this.config.maxSteps ?? (input.capabilityProfile === 'full' ? 16 : 8),
      maxTokens: this.config.maxTokens ?? (input.capabilityProfile === 'full' ? 8_000 : 4_000),
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
      constraints: [
        'One turn = one native execution report. You may perform multiple tool calls inside the turn.',
        'Prefer evidence-producing actions. Save turn artifacts under runs/turn-xxxx/artifacts and use evidencePath as runs/turn-xxxx/...',
        'Never use work/... or absolute paths in projectUpdate evidence fields; snapshot to runs/turn-xxxx/artifacts/evidence first.',
        'For research/prior-art goals, run literature-study(mode="standard") early (fallback: literature-search(mode="sweep")) and persist processed literature artifacts locally.',
        'When modifying files inside a git repo, use coding-large-repo workflow (repo-intake/change-plan/delegate-coding-agent or agent-start) before code edits.',
        'Runtime derives active_plan_id/status_change/delta/evidence_paths from tool events + file writes.',
        'Success is valid only if this turn touches a plan deliverable (done_definition deliverable:) or clears a blocker.',
        'Use mechanical done_definition rows only: deliverable:<path-or-token> and optional evidence_min:<n>.',
        'Rewrite planBoard/currentPlan only on planner checkpoint turns.',
        'Be resourceful before asking user; Ask is last resort when truly blocked.',
        'Never use destructive shell cleanup (rm -rf / sudo rm / recursive delete). Prefer fresh target dirs.',
        'Do not Stop unless milestone completion or explicit stop/safety condition.',
        'Use available tools/skills before asking user. Treat ask_user as escalation, not default.'
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

    const requirePlanRewrite = Boolean(context.plannerCheckpoint?.due) && requiresPlanRewrite(context.project.currentPlan)
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
