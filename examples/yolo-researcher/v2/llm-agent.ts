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
}

const MAX_OUTCOME_ATTEMPTS = 3
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
  via: 'literature-search' | 'skill-script-run' | ''
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
  const literatureBootstrapNeeded = goalNeedsLiteratureBootstrap(context.project.goal) && !hasLiteratureArtifacts(context)
  const literatureLibraryPath = `${context.yoloRoot}/library/literature`
  const artifactPaths = canonicalTurnArtifactPaths(context)
  const hasProblemStatement = context.project.keyArtifacts.some((entry) => /problem_statement/i.test(entry))

  return [
    'You are YOLO-Researcher v2 native runner.',
    'Design axiom: minimal discipline to avoid death + evidence-driven strengthening.',
    'This turn is native: you may use ALL available tools/skills/subagents directly.',
    'Do real work, produce evidence, then return one JSON report.',
    '',
    'Hard rules:',
    '1) Prefer autonomous execution. Ask user only when external input/permission is truly required.',
    '2) For research/prior-art/novelty goals, run literature-search({mode:"sweep"}) early; fallback to fetch only if literature-search is unavailable.',
    '3) Do not do exhaustive repo reading. Use high-leverage slices first (README, rg, entrypoints).',
    '4) For large repos, prefer coding-large-repo via skill-script-run before manual deep reads.',
    '5) Never use destructive shell cleanup (rm -rf / sudo rm / recursive delete). If path is dirty, choose a new target directory name.',
    '6) Never clone or create long-lived workspaces under runs/turn-xxxx/.',
    `7) Write turn artifacts only under "${artifactPaths.canonicalRelativeFromProject}" (absolute: ${artifactPaths.canonicalAbsolute}).`,
    '8) Facts/Constraints evidencePath must use "runs/turn-xxxx/...". No evidence -> hypotheses.',
    '9) Persist processed literature artifacts locally for future retrieval.',
    '10) Respect Done(Do-not-repeat): avoid repeating identical action fingerprints unless you will produce a new artifact type.',
    '11) Prefer typed wrapper tools over raw skill-script-run when available: literature-search, data-analyze, writing-outline, writing-draft, convert_to_markdown.',
    '12) For PDF/DOCX conversion, use convert_to_markdown before ad-hoc python parsing.',
    '13) If wrapper calls fail due missing skills/scripts, run skills-health-check and report concrete missing pieces.',
    '',
    `Turn: ${context.turnNumber}`,
    `Goal: ${context.project.goal}`,
    `Default runtime: ${context.project.defaultRuntime}`,
    `Literature library (local cache): ${literatureLibraryPath}`,
    `Turn artifact dir (relative): ${artifactPaths.canonicalRelativeFromProject}`,
    `Turn artifact dir (absolute): ${artifactPaths.canonicalAbsolute}`,
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
        '- In this turn, run literature-search({query:"<query>",mode:"sweep"}) before deep code reading.',
        '- Use outputDir ".yolo-researcher/library/literature".',
        `- Save at least one processed artifact under "${artifactPaths.canonicalRelativeFromProject}", and keep references in projectUpdate.keyArtifacts.`
      ]
      : []),
    '',
    'Current Plan:',
    ...context.project.currentPlan.map((item, idx) => `${idx + 1}. ${item}`),
    ...(planNeedsRewrite
      ? [
        '',
        'Plan quality gate:',
        '- Current Plan is bootstrap/template.',
        '- In this turn, projectUpdate.currentPlan is REQUIRED and must contain 3-5 concrete goal-specific next actions.'
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
    '  "status": "success|failure|ask_user|stopped",',
    '  "summary": "one concise observation",',
    '  "primaryAction": "short label of what was actually done",',
    '  "askQuestion": "required when status=ask_user",',
    '  "stopReason": "required when status=stopped",',
    '  "projectUpdate": {',
    '    "currentPlan": ["up to 5 items"],',
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
    '- status: success|failure|ask_user|stopped',
    '- summary: non-empty string',
    '- askQuestion: required when status=ask_user',
    '- stopReason: required when status=stopped',
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
      ? `Detected literature call, but it did not complete a successful full sweep: ${input.usage.detail || 'unknown'}`
      : 'No literature-search call detected.',
    ...(input.usage.lastError
      ? [`Last literature-search error: ${input.usage.lastError}`]
      : []),
    '',
    `Turn: ${input.context.turnNumber}`,
    `Goal: ${input.context.project.goal}`,
    `Default runtime: ${input.context.project.defaultRuntime}`,
    '',
    'Recovery requirements (execute now in this turn):',
    '- Call `literature-search` with mode="sweep".',
    '- Include query + bounded limits and outputDir=".yolo-researcher/library/literature".',
    '- Do not stop at one-shot random OpenAlex query dumps.',
    '- Persist produced literature artifacts and include paths in projectUpdate.keyArtifacts.',
    '- Continue with next concrete action only after search-sweep completes.',
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

function normalizeTurnOutcome(value: unknown): TurnRunOutcome {
  if (!value || typeof value !== 'object') {
    throw new Error('turn outcome must be a JSON object')
  }

  const row = value as Record<string, unknown>
  const intent = typeof row.intent === 'string' ? row.intent.trim() : ''
  const summary = typeof row.summary === 'string' ? row.summary.trim() : ''
  const status = typeof row.status === 'string' ? row.status.trim().toLowerCase() : ''

  if (!intent) throw new Error('turn outcome.intent is required')
  if (!summary) throw new Error('turn outcome.summary is required')
  if (!['success', 'failure', 'ask_user', 'stopped'].includes(status)) {
    throw new Error('turn outcome.status is invalid')
  }

  const askQuestion = typeof row.askQuestion === 'string' ? row.askQuestion.trim() : ''
  const stopReason = typeof row.stopReason === 'string' ? row.stopReason.trim() : ''
  if (status === 'ask_user' && !askQuestion) {
    throw new Error('turn outcome.askQuestion is required when status=ask_user')
  }
  if (status === 'stopped' && !stopReason) {
    throw new Error('turn outcome.stopReason is required when status=stopped')
  }

  return {
    intent,
    status: status as TurnRunOutcome['status'],
    summary,
    primaryAction: typeof row.primaryAction === 'string' ? row.primaryAction.trim() : undefined,
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

    return createAgent({
      projectPath: this.config.projectPath,
      model: this.config.model,
      apiKey: this.config.apiKey,
      maxSteps: this.config.maxSteps ?? (input.capabilityProfile === 'full' ? 16 : 8),
      maxTokens: this.config.maxTokens ?? (input.capabilityProfile === 'full' ? 8_000 : 4_000),
      packs: packList,
      externalSkillsDir: input.externalSkillsDir,
      communitySkillsDir: this.config.communitySkillsDir,
      watchExternalSkills: this.config.watchExternalSkills ?? true,
      watchCommunitySkills: this.config.watchCommunitySkills ?? false,
      onApprovalRequired: this.config.autoApprove === false
        ? undefined
        : async () => true,
      onToolCall: (tool, input) => {
        if (!this.currentToolEvents) return
        const stringLimit = tool === 'fetch' ? FETCH_EVENT_STRING_LIMIT : TOOL_EVENT_STRING_LIMIT
        this.currentToolEvents.push({
          timestamp: new Date().toISOString(),
          phase: 'call',
          tool,
          input: sanitizeForEvent(input, 0, stringLimit)
        })
      },
      onToolResult: (tool, result, args) => {
        if (!this.currentToolEvents) return
        const stringLimit = tool === 'fetch' ? FETCH_EVENT_STRING_LIMIT : TOOL_EVENT_STRING_LIMIT
        const resultObj = result && typeof result === 'object'
          ? result as Record<string, unknown>
          : null
        this.currentToolEvents.push({
          timestamp: new Date().toISOString(),
          phase: 'result',
          tool,
          input: sanitizeForEvent(args, 0, stringLimit),
          result: sanitizeForEvent(result, 0, stringLimit),
          success: typeof resultObj?.success === 'boolean' ? resultObj.success : undefined,
          error: typeof resultObj?.error === 'string' ? truncateText(resultObj.error) : undefined
        })
      },
      constraints: [
        'One turn = one native execution report. You may perform multiple tool calls inside the turn.',
        'Prefer evidence-producing actions. Save turn artifacts under runs/turn-xxxx/artifacts and use evidencePath as runs/turn-xxxx/...',
        'For research/prior-art goals, run literature-search(mode="sweep") early and persist processed literature artifacts locally.',
        'Use wrapper tools over raw skill-script-run when possible: literature-search, data-analyze, writing-outline, writing-draft, convert_to_markdown.',
        'Be resourceful before asking user; Ask is last resort when truly blocked.',
        'Never use destructive shell cleanup (rm -rf / sudo rm / recursive delete). Prefer fresh target dirs.',
        'Do not Stop unless milestone completion or explicit stop/safety condition.',
        'Use available tools/skills before asking user. Treat ask_user as escalation, not default.'
      ],
      identity: 'You are a single-agent autonomous researcher that follows YOLO v2 thin protocol.'
    })
  }

  async runTurn(context: TurnContext): Promise<TurnRunOutcome> {
    let agent: ReturnType<typeof createAgent>
    try {
      agent = await this.agentPromise
      await agent.ensureInit()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        intent: 'Initialize native agent runtime',
        status: 'failure',
        summary: `Agent initialization failed: ${message}`,
        primaryAction: 'agent.init'
      }
    }

    const requirePlanRewrite = requiresPlanRewrite(context.project.currentPlan)
    const literatureBootstrapNeeded = goalNeedsLiteratureBootstrap(context.project.goal) && !hasLiteratureArtifacts(context)

    let prompt = buildNativeTurnPrompt(context)
    let rawOutput = ''
    let lastValidationError = ''
    this.currentToolEvents = []

    try {
      for (let attempt = 1; attempt <= MAX_OUTCOME_ATTEMPTS; attempt += 1) {
        const result = await agent.run(prompt)
        rawOutput = result.output || rawOutput

        if (!result.success) {
          return {
            intent: 'Handle agent runtime error safely',
            status: 'failure',
            summary: result.error || 'Agent run failed without error details.',
            primaryAction: 'agent.run',
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
                return {
                  intent: 'Enforce literature bootstrap before deep research turns',
                  status: 'failure',
                  summary: !usage.invoked
                    ? 'Literature bootstrap missing: literature-search(mode="sweep") was never executed.'
                    : !usage.fullMode
                      ? `Literature bootstrap incomplete (${usage.detail || 'non-full search'}); retry budget exhausted.`
                      : `Literature bootstrap failed after invocation: ${usage.lastError || 'search-sweep did not complete successfully'}.`,
                  primaryAction: 'literature-search: sweep',
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
              return {
                intent: 'Recover from policy-blocked destructive command',
                status: 'failure',
                summary: `Policy blocked destructive command (${destructiveBlock.errorLine}); safe retry attempts exhausted.`,
                primaryAction: 'bash: safe repo bootstrap',
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
        intent: 'Handle invalid native turn output safely',
        status: 'failure',
        summary: `Native turn output invalid after ${MAX_OUTCOME_ATTEMPTS} attempts: ${lastValidationError || 'unknown error'}`,
        primaryAction: 'agent.run',
        toolEvents: this.currentToolEvents,
        rawOutput
      }
    } finally {
      this.currentToolEvents = null
    }
  }

  async destroy(): Promise<void> {
    const agent = await this.agentPromise
    await agent.destroy()
  }
}

export function createLlmSingleAgent(config: LlmSingleAgentConfig): LlmSingleAgent {
  return new LlmSingleAgent(config)
}
