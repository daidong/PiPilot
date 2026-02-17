import * as path from 'node:path'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'

import { FailureStore } from './failure-store.js'
import { ProjectStore } from './project-store.js'
import type {
  CreateYoloSessionConfig,
  DeliverableRequirement,
  EvidenceLine,
  FailureEntry,
  PendingUserInput,
  ProjectUpdate,
  QueuedUserInput,
  RecentTurnContext,
  StageStatus,
  StagnationInfo,
  ToolEventRecord,
  TurnContext,
  TurnExecutionResult,
  TurnRunOutcome,
  TurnStatus
} from './types.js'
import {
  ensureDir,
  fileExists,
  firstNonEmptyLine,
  formatTurnId,
  listTurnNumbers,
  normalizeText,
  readTextOrEmpty,
  toIso,
  toPosixPath,
  writeText
} from './utils.js'

const DEFAULT_RUNTIME = 'host'
const DEFAULT_RECENT_TURNS_TO_LOAD = 3
const LITERATURE_BODY_LIMIT = 40_000
const LITERATURE_INDEX_LIMIT = 800
const LITERATURE_HOST_HINTS = [
  'arxiv.org',
  'api.semanticscholar.org',
  'semanticscholar.org',
  'openalex.org',
  'api.openalex.org',
  'doi.org',
  'crossref.org',
  'dblp.org',
  'pubmed.ncbi.nlm.nih.gov',
  'europepmc.org',
  'paperswithcode.com'
]
const REDUNDANCY_WINDOW_TURNS = 20
const SYSTEM_ARTIFACT_NAMES = new Set(['tool-events.jsonl', 'agent-output.txt', 'ask-user.md'])
const EVIDENCE_PATH_RE = /^runs\/turn-\d{4}\/.+/

const DELIVERABLE_PATTERNS: string[] = [
  'problem_statement',   // S1
  'literature_map',      // S2
  'idea_candidates',     // S3
  'experiment_plan',     // S4 (file)
  'exp-',                // S4 (directory prefix, e.g., exp-001/)
  'paper_draft',         // S5
  'outline',             // S5 (alias)
]

const DELIVERABLE_CHECKLIST: DeliverableRequirement[] = [
  { stage: 'S1', label: 'Problem Definition', patterns: ['problem_statement'] },
  { stage: 'S2', label: 'Literature',         patterns: ['literature_map'] },
  { stage: 'S3', label: 'Innovation',         patterns: ['idea_candidates'] },
  { stage: 'S4', label: 'Implementation',     patterns: ['experiment_plan', 'exp-'] },
  { stage: 'S5', label: 'Writing',            patterns: ['paper_draft', 'outline'] },
]

const DETERMINISTIC_ERROR_PATTERNS = [
  /modulenotfound/i,
  /module.?not.?found/i,
  /module\s*not\s*found/i,
  /no such file/i,
  /cannot find/i,
  /not found/i,
  /permission denied/i,
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /read-only file system/i,
  /address already in use/i
]

function isDeterministicFailure(errorLine: string): boolean {
  if (!errorLine.trim()) return false
  return DETERMINISTIC_ERROR_PATTERNS.some((pattern) => pattern.test(errorLine))
}

function buildFailureFingerprint(cmd: string, errorLine: string, runtime: string): string {
  return `${normalizeText(cmd)}|${normalizeText(errorLine)}|${normalizeText(runtime)}`
}

function summarizeRecentAction(rawActionMd: string): string {
  const line = rawActionMd
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith('- Key observation:') || value.startsWith('- Next:') || value.startsWith('- Status:'))
  if (!line) return 'No summary line found.'
  return line.replace(/^-\s+/, '').trim()
}

function safeString(value: unknown, fallback: string = ''): string {
  return typeof value === 'string' ? value : fallback
}

function toPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function buildJsonLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function slugifyForFile(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'item'
}

function hashStable(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function isLikelyLiteratureUrl(rawUrl: string): boolean {
  const input = rawUrl.trim().toLowerCase()
  if (!input) return false

  try {
    const url = new URL(input)
    const host = url.hostname.toLowerCase()
    if (LITERATURE_HOST_HINTS.some((hint) => host === hint || host.endsWith(`.${hint}`))) {
      return true
    }
    const pathWithQuery = `${url.pathname}${url.search}`.toLowerCase()
    return /(paper|publication|arxiv|scholar|citation|doi|related[-_]work|survey|bibliograph|openalex|crossref)/.test(pathWithQuery)
  } catch {
    return /(arxiv|semantic|scholar|openalex|crossref|doi|dblp|pubmed|paper|citation|survey|literature)/.test(input)
  }
}

function extractLiteratureTitle(body: unknown): string {
  if (typeof body === 'string') {
    const head = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 5)
    return head ? head.slice(0, 180) : ''
  }

  const row = toPlainObject(body)
  if (row) {
    const direct = safeString(row.title).trim()
    if (direct) return direct.slice(0, 180)

    const nestedResults = Array.isArray(row.results) ? row.results : (Array.isArray(row.data) ? row.data : null)
    if (nestedResults) {
      for (const item of nestedResults) {
        const entry = toPlainObject(item)
        const title = safeString(entry?.title).trim()
        if (title) return title.slice(0, 180)
      }
    }
  }

  return ''
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function stageRank(stage: StageStatus['currentStage']): number {
  if (stage === 'S1') return 1
  if (stage === 'S2') return 2
  if (stage === 'S3') return 3
  if (stage === 'S4') return 4
  return 5
}

export class YoloSession {
  readonly yoloRoot: string
  readonly runsDir: string
  readonly projectFilePath: string
  readonly failuresFilePath: string
  readonly userInputQueuePath: string

  private readonly projectStore: ProjectStore
  private readonly failureStore: FailureStore
  private readonly now: () => Date
  private initialized = false

  constructor(private readonly config: CreateYoloSessionConfig) {
    this.now = config.now ?? (() => new Date())
    this.yoloRoot = config.projectPath
    this.runsDir = path.join(this.yoloRoot, 'runs')

    const fallbackRuntime = config.defaultRuntime?.trim() || DEFAULT_RUNTIME
    this.projectStore = new ProjectStore(this.yoloRoot, config.goal, config.successCriteria ?? [], fallbackRuntime)
    this.failureStore = new FailureStore(this.yoloRoot, this.now)

    this.projectFilePath = this.projectStore.filePath
    this.failuresFilePath = this.failureStore.filePath
    this.userInputQueuePath = path.join(this.yoloRoot, 'user-input-queue.json')
  }

  async init(): Promise<void> {
    if (this.initialized) return

    await ensureDir(this.yoloRoot)
    await ensureDir(this.runsDir)
    await this.projectStore.init()
    await this.failureStore.init()
    await this.ensureUserInputQueueFile()

    this.initialized = true
  }

  async runNextTurn(): Promise<TurnExecutionResult> {
    await this.init()

    const project = await this.projectStore.load()
    const failures = await this.failureStore.load()
    const turnNumber = await this.computeNextTurnNumber()
    const turnDir = path.join(this.runsDir, formatTurnId(turnNumber))
    const artifactsDir = path.join(turnDir, 'artifacts')

    await ensureDir(turnDir)
    await ensureDir(artifactsDir)

    const pendingUserInputs = await this.materializePendingUserInputs(artifactsDir)
    const stagnation = await this.detectStagnation()
    const context: TurnContext = {
      turnNumber,
      projectRoot: this.config.projectPath,
      yoloRoot: this.yoloRoot,
      runsDir: this.runsDir,
      project,
      failures,
      recentTurns: await this.loadRecentTurns(this.config.recentTurnsToLoad ?? DEFAULT_RECENT_TURNS_TO_LOAD),
      pendingUserInputs,
      stagnation: stagnation.stagnant ? stagnation : undefined
    }

    return this.runNativeTurn({
      context,
      turnNumber,
      turnDir,
      artifactsDir,
      pendingUserInputs
    })
  }

  async runUntilStop(maxTurns: number): Promise<TurnExecutionResult[]> {
    const results: TurnExecutionResult[] = []
    for (let idx = 0; idx < maxTurns; idx += 1) {
      const result = await this.runNextTurn()
      results.push(result)
      if (result.status === 'stopped' || result.status === 'ask_user') {
        break
      }
    }
    return results
  }

  async getRecentTurns(limit: number = DEFAULT_RECENT_TURNS_TO_LOAD): Promise<RecentTurnContext[]> {
    await this.init()
    return this.loadRecentTurns(limit)
  }

  async getProjectMarkdown(): Promise<string> {
    await this.init()
    return readTextOrEmpty(this.projectFilePath)
  }

  async getFailuresMarkdown(): Promise<string> {
    await this.init()
    return readTextOrEmpty(this.failuresFilePath)
  }

  async submitUserInput(text: string): Promise<QueuedUserInput> {
    await this.init()

    const normalized = text.trim()
    if (!normalized) {
      throw new Error('User input text is required')
    }

    const queue = await this.loadQueuedUserInputs()
    const item: QueuedUserInput = {
      id: `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: normalized,
      submittedAt: toIso(this.now)
    }

    queue.push(item)
    await this.saveQueuedUserInputs(queue)
    return item
  }

  private normalizeNativeStatus(status: unknown): TurnStatus {
    const normalized = typeof status === 'string' ? status.trim().toLowerCase() : ''
    if (normalized === 'success') return 'success'
    if (normalized === 'ask_user') return 'ask_user'
    if (normalized === 'stopped') return 'stopped'
    return 'failure'
  }

  private inferPrimaryActionFromToolEvents(toolEvents: ToolEventRecord[]): string {
    const calls = toolEvents
      .filter((event) => event.phase === 'call')
      .slice(-3)
      .map((event) => {
        const tool = event.tool?.trim() || 'tool'
        const input = toPlainObject(event.input)
        if (!input) return tool
        const command = safeString(input.command).trim()
        const targetPath = safeString(input.path).trim()
        const url = safeString(input.url).trim()
        if (command) return `${tool}: ${command}`
        if (targetPath) return `${tool}: ${targetPath}`
        if (url) return `${tool}: ${url}`
        return tool
      })
      .filter(Boolean)

    if (calls.length === 0) return 'agent.run'
    return calls.join(' | ')
  }

  private extractLastBashSnapshot(toolEvents: ToolEventRecord[], runtime: string): {
    cmd: string
    cwd: string
    stdout: string
    stderr: string
    exitCode: number
    runtime: string
  } | null {
    let lastCommand = ''
    let lastCwd = this.config.projectPath
    let snapshot: {
      cmd: string
      cwd: string
      stdout: string
      stderr: string
      exitCode: number
      runtime: string
    } | null = null

    for (const event of toolEvents) {
      const tool = normalizeText(event.tool || '')
      if (tool !== 'bash') continue

      if (event.phase === 'call') {
        const input = toPlainObject(event.input)
        const command = safeString(input?.command).trim()
        const cwd = safeString(input?.cwd).trim()
        if (command) lastCommand = command
        if (cwd) {
          try {
            lastCwd = this.ensureSafeTargetPath(cwd)
          } catch {
            lastCwd = this.config.projectPath
          }
        }
        continue
      }

      const result = toPlainObject(event.result)
      const data = toPlainObject(result?.data)
      const stdout = safeString(data?.stdout)
      const stderr = safeString(data?.stderr, safeString(result?.error))
      const exitCode = typeof data?.exitCode === 'number'
        ? data.exitCode
        : (event.success === true ? 0 : 1)

      snapshot = {
        cmd: lastCommand || 'bash',
        cwd: lastCwd || this.config.projectPath,
        stdout,
        stderr,
        exitCode,
        runtime
      }
    }

    return snapshot
  }

  private normalizeActionFingerprintSegment(value: string): string {
    return value
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/["'`]/g, '')
      .trim()
      .slice(0, 240)
  }

  private normalizeUrlForFingerprint(rawUrl: string): string {
    const input = rawUrl.trim()
    if (!input) return ''
    try {
      const url = new URL(input)
      const params = [...url.searchParams.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, 8)
      const compactQuery = params.map(([k, v]) => `${k}=${v}`).join('&')
      const joined = `${url.hostname}${url.pathname}${compactQuery ? `?${compactQuery}` : ''}`
      return this.normalizeActionFingerprintSegment(joined)
    } catch {
      return this.normalizeActionFingerprintSegment(input)
    }
  }

  private buildActionFingerprint(input: {
    toolEvents: ToolEventRecord[]
    primaryAction: string
    cmd: string
  }): string {
    let actionType = 'agent'
    let target = input.primaryAction || input.cmd || 'agent.run'

    for (let idx = input.toolEvents.length - 1; idx >= 0; idx -= 1) {
      const event = input.toolEvents[idx]
      if (event.phase !== 'call') continue
      const tool = (event.tool || '').trim()
      if (!tool) continue
      actionType = normalizeText(tool) || 'agent'

      const row = toPlainObject(event.input)
      const command = safeString(row?.command).trim()
      const pathValue = safeString(row?.path).trim()
      const url = safeString(row?.url).trim()
      if (actionType === 'fetch' && url) {
        target = this.normalizeUrlForFingerprint(url)
      } else if (command) {
        target = this.normalizeActionFingerprintSegment(command)
      } else if (pathValue) {
        target = this.normalizeActionFingerprintSegment(pathValue)
      } else if (url) {
        target = this.normalizeUrlForFingerprint(url)
      } else if (input.primaryAction) {
        const [head, tail] = input.primaryAction.split(':', 2)
        if (tail) {
          target = this.normalizeActionFingerprintSegment(tail)
        } else if (head) {
          target = this.normalizeActionFingerprintSegment(head)
        }
      }
      break
    }

    if (!target.trim()) {
      target = this.normalizeActionFingerprintSegment(input.cmd || input.primaryAction || 'agent.run')
    }

    const normalizedTarget = this.normalizeActionFingerprintSegment(target || 'agent.run')
    return `${actionType}:${normalizedTarget}`.slice(0, 320)
  }

  private isSystemArtifactFile(fileName: string): boolean {
    if (SYSTEM_ARTIFACT_NAMES.has(fileName)) return true
    return /^user-input-\d{2}-.+\.md$/i.test(fileName)
  }

  private async collectBusinessArtifactEvidencePaths(artifactsDir: string): Promise<string[]> {
    if (!(await fileExists(artifactsDir))) return []

    const entries = await fs.readdir(artifactsDir, { withFileTypes: true })
    const paths: string[] = []

    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (this.isSystemArtifactFile(entry.name)) continue
      const fullPath = path.join(artifactsDir, entry.name)
      paths.push(this.toEvidencePath(fullPath))
    }

    return paths.sort((a, b) => a.localeCompare(b))
  }

  private async collectArtifactEntryNames(artifactsDir: string): Promise<string[]> {
    if (!(await fileExists(artifactsDir))) return []
    const entries = await fs.readdir(artifactsDir, { withFileTypes: true })
    return entries
      .filter((entry) => !this.isSystemArtifactFile(entry.name))
      .map((entry) => entry.name)
  }

  private extractDeliverablePatternsFromEntries(entryNames: string[]): Set<string> {
    const found = new Set<string>()
    for (const name of entryNames) {
      const lower = name.toLowerCase()
      for (const pattern of DELIVERABLE_PATTERNS) {
        if (lower.includes(pattern)) found.add(pattern)
      }
    }
    return found
  }

  private async countRecentActionFingerprintMatches(fingerprint: string, window: number = REDUNDANCY_WINDOW_TURNS): Promise<number> {
    const normalizedFingerprint = normalizeText(fingerprint)
    if (!normalizedFingerprint) return 0

    const turnNumbers = await listTurnNumbers(this.runsDir)
    const selected = turnNumbers.slice(-Math.max(0, window))
    let count = 0

    for (const turnNumber of selected) {
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const value = normalizeText(parsed.action_fingerprint)
        if (value && value === normalizedFingerprint) count += 1
      } catch {
        // Ignore malformed result rows.
      }
    }

    return count
  }

  private normalizeProjectPathPointer(rawPath: string): string {
    const input = rawPath.trim()
    if (!input) return ''

    let normalized = toPosixPath(input.replace(/^\.\//, ''))

    if (path.isAbsolute(input)) {
      const relToYolo = toPosixPath(path.relative(this.yoloRoot, input))
      if (relToYolo && !relToYolo.startsWith('../') && relToYolo !== '..') {
        normalized = relToYolo
      } else {
        const relToProject = toPosixPath(path.relative(this.config.projectPath, input))
        if (relToProject && !relToProject.startsWith('../') && relToProject !== '..') {
          normalized = relToProject
        }
      }
    }

    return normalized
  }

  private async assertYoloEvidencePathExists(evidencePath: string, label: string): Promise<void> {
    const normalized = this.normalizeProjectPathPointer(evidencePath)
    if (!EVIDENCE_PATH_RE.test(normalized)) {
      throw new Error(`${label} evidence path must use runs/turn-xxxx/... format`)
    }

    const absolutePath = path.join(this.yoloRoot, normalized)
    if (!(await fileExists(absolutePath))) {
      throw new Error(`${label} evidence path does not exist under workspace session root: ${normalized}`)
    }
  }

  private async normalizeAndValidateEvidenceLines(lines: EvidenceLine[], label: string): Promise<EvidenceLine[]> {
    const normalized: EvidenceLine[] = []
    for (const line of lines) {
      const text = line.text.trim()
      const evidencePath = this.normalizeProjectPathPointer(line.evidencePath)
      if (!text) {
        throw new Error(`${label} entry text is required`)
      }
      if (!evidencePath) {
        throw new Error(`${label} evidencePath is required`)
      }
      await this.assertYoloEvidencePathExists(evidencePath, label)
      normalized.push({ text, evidencePath })
    }
    return normalized
  }

  private async normalizeAndValidateProjectUpdate(update: ProjectUpdate): Promise<ProjectUpdate> {
    const normalized: ProjectUpdate = { ...update }

    if (update.facts) {
      normalized.facts = await this.normalizeAndValidateEvidenceLines(update.facts, 'Facts')
    }
    if (update.constraints) {
      normalized.constraints = await this.normalizeAndValidateEvidenceLines(update.constraints, 'Constraints')
    }
    if (update.done) {
      normalized.done = await this.normalizeAndValidateEvidenceLines(update.done, 'Done')
    }

    if (update.claims) {
      normalized.claims = []
      for (const claim of update.claims) {
        const evidencePaths: string[] = []
        for (const rawPath of claim.evidencePaths) {
          const evidencePath = this.normalizeProjectPathPointer(rawPath)
          await this.assertYoloEvidencePathExists(evidencePath, `Claim "${claim.claim}"`)
          evidencePaths.push(evidencePath)
        }
        normalized.claims.push({
          claim: claim.claim,
          status: claim.status,
          evidencePaths
        })
      }
    }

    if (update.keyArtifacts) {
      const keyArtifacts: string[] = []
      for (const rawPath of update.keyArtifacts) {
        const pointer = this.normalizeProjectPathPointer(rawPath)
        if (!pointer) continue
        if (EVIDENCE_PATH_RE.test(pointer)) {
          const absolutePath = path.join(this.yoloRoot, pointer)
          if (!(await fileExists(absolutePath))) {
            throw new Error(`keyArtifacts path does not exist under workspace session root: ${pointer}`)
          }
        }
        keyArtifacts.push(pointer)
      }
      normalized.keyArtifacts = dedupeStrings(keyArtifacts)
    }

    return normalized
  }

  private async writeToolEventsJsonl(eventsPath: string, toolEvents: ToolEventRecord[]): Promise<void> {
    if (toolEvents.length === 0) {
      await writeText(eventsPath, '')
      return
    }
    await writeText(eventsPath, toolEvents.map((event) => buildJsonLine(event)).join(''))
  }

  private async runNativeTurn(input: {
    context: TurnContext
    turnNumber: number
    turnDir: string
    artifactsDir: string
    pendingUserInputs: PendingUserInput[]
  }): Promise<TurnExecutionResult> {
    const runtime = input.context.project.defaultRuntime || this.config.defaultRuntime || DEFAULT_RUNTIME
    const cmdPath = path.join(input.turnDir, 'cmd.txt')
    const stdoutPath = path.join(input.turnDir, 'stdout.txt')
    const stderrPath = path.join(input.turnDir, 'stderr.txt')
    const exitCodePath = path.join(input.turnDir, 'exit_code.txt')
    const resultPath = path.join(input.turnDir, 'result.json')
    const toolEventsPath = path.join(input.artifactsDir, 'tool-events.jsonl')
    const rawOutputPath = path.join(input.artifactsDir, 'agent-output.txt')

    const turnStartedAt = this.now()
    let consumedPendingUserInputs = false

    let outcome: TurnRunOutcome
    try {
      outcome = await this.config.agent.runTurn(input.context)
      if (input.pendingUserInputs.length > 0) {
        await this.clearQueuedUserInputs()
        consumedPendingUserInputs = true
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outcome = {
        intent: 'Handle native turn runtime error',
        status: 'failure',
        summary: `Native turn runtime error: ${message}`,
        primaryAction: 'agent.run',
        updateSummary: ['Next: inspect runtime error and retry with narrower scope.']
      }
    }

    const toolEvents = Array.isArray(outcome.toolEvents) ? outcome.toolEvents : []
    await this.writeToolEventsJsonl(toolEventsPath, toolEvents)
    const literatureCache = await this.persistLiteratureCacheFromToolEvents({
      turnNumber: input.turnNumber,
      artifactsDir: input.artifactsDir,
      toolEvents
    })

    if (typeof outcome.rawOutput === 'string' && outcome.rawOutput.trim()) {
      await writeText(rawOutputPath, `${outcome.rawOutput}\n`)
    }

    let finalStatus: TurnStatus = this.normalizeNativeStatus(outcome.status)
    const intent = outcome.intent?.trim() || 'Native turn execution'
    let summary = outcome.summary?.trim() || 'Turn completed without summary.'
    const primaryAction = outcome.primaryAction?.trim() || this.inferPrimaryActionFromToolEvents(toolEvents)
    const bashSnapshot = this.extractLastBashSnapshot(toolEvents, runtime)

    const cmd = bashSnapshot?.cmd || primaryAction || 'agent.run'
    const stdout = bashSnapshot?.stdout || ''
    const stderr = bashSnapshot?.stderr || ''
    const cwd = bashSnapshot?.cwd || this.config.projectPath
    let exitCode = typeof bashSnapshot?.exitCode === 'number'
      ? bashSnapshot.exitCode
      : (finalStatus === 'success' || finalStatus === 'stopped' || finalStatus === 'ask_user' ? 0 : 1)

    if (exitCode !== 0 && finalStatus === 'success') {
      finalStatus = 'failure'
    }

    await writeText(cmdPath, cmd ? `${cmd}\n` : '')
    await writeText(stdoutPath, stdout)
    await writeText(stderrPath, stderr)
    await writeText(exitCodePath, `${exitCode}\n`)

    const turnEndedAt = this.now()
    const durationSecRaw = (turnEndedAt.getTime() - turnStartedAt.getTime()) / 1000
    const durationSec = Number.isFinite(durationSecRaw)
      ? Math.max(0, Number(durationSecRaw.toFixed(3)))
      : 0

    const errorLine = exitCode === 0 ? '' : (firstNonEmptyLine(stderr, stdout) || `exit code ${exitCode}`)
    const deterministicFingerprint = (
      finalStatus === 'failure' && cmd && exitCode !== 0 && isDeterministicFailure(errorLine)
        ? buildFailureFingerprint(cmd, errorLine, runtime)
        : null
    )

    let failureEntry: FailureEntry | null = null
    if (deterministicFingerprint) {
      failureEntry = await this.failureStore.recordDeterministicFailure({
        cmd,
        runtime,
        fingerprint: deterministicFingerprint,
        errorLine,
        evidencePath: this.toEvidencePath(stderrPath),
        alternatives: []
      })
      if (failureEntry?.status === 'BLOCKED') {
        finalStatus = 'blocked'
        // Promote to PROJECT.md constraint
        try {
          await this.projectStore.applyUpdate({
            constraints: [{
              text: `[ENV-BLOCKED] ${failureEntry.cmd}: ${failureEntry.errorLine} (${failureEntry.runtime})`,
              evidencePath: failureEntry.evidencePath
            }]
          })
        } catch { /* best-effort */ }
      }
    }

    let clearedBlocked = false
    if (!deterministicFingerprint && exitCode === 0 && bashSnapshot) {
      clearedBlocked = await this.failureStore.clearBlockedAfterVerifiedSuccess({
        cmd: bashSnapshot.cmd,
        runtime,
        resolved: 'Successful native verification after remediation.',
        evidencePath: this.toEvidencePath(resultPath)
      })
    }

    const actionFingerprint = this.buildActionFingerprint({
      toolEvents,
      primaryAction,
      cmd
    })
    const actionType = normalizeText(actionFingerprint.split(':')[0] || 'agent') || 'agent'
    const priorFingerprintCount = await this.countRecentActionFingerprintMatches(actionFingerprint)
    const doneFingerprintHit = input.context.project.done.some((item) => normalizeText(item.text) === normalizeText(actionFingerprint))

    const evidencePaths = [
      this.toEvidencePath(cmdPath),
      this.toEvidencePath(resultPath),
      this.toEvidencePath(stdoutPath),
      this.toEvidencePath(stderrPath),
      this.toEvidencePath(exitCodePath),
      this.toEvidencePath(toolEventsPath)
    ]

    if (typeof outcome.rawOutput === 'string' && outcome.rawOutput.trim()) {
      evidencePaths.push(this.toEvidencePath(rawOutputPath))
    }
    if (literatureCache.evidencePath) {
      evidencePaths.push(literatureCache.evidencePath)
    }

    if (finalStatus === 'ask_user') {
      const askPath = path.join(input.artifactsDir, 'ask-user.md')
      const question = outcome.askQuestion?.trim() || summary
      await writeText(askPath, `# Blocking Question\n\n${question}\n`)
      evidencePaths.push(this.toEvidencePath(askPath))
      if (!summary.trim()) {
        summary = 'User input required to proceed.'
      }
    }

    if (consumedPendingUserInputs) {
      evidencePaths.push(...input.pendingUserInputs.map((item) => item.evidencePath))
    }

    const businessArtifactEvidencePaths = await this.collectBusinessArtifactEvidencePaths(input.artifactsDir)
    evidencePaths.push(...businessArtifactEvidencePaths)

    const deltaReasons: string[] = []
    if (bashSnapshot?.cmd?.trim() && bashSnapshot.exitCode === 0) {
      const hasOutput = (bashSnapshot.stdout?.trim().length || 0) > 0
      if (hasOutput || businessArtifactEvidencePaths.length > 0) {
        deltaReasons.push('reproducible_exec_bundle')
      }
    }
    if (businessArtifactEvidencePaths.length > 0) deltaReasons.push('artifact_file')
    if (failureEntry) deltaReasons.push('failure_recorded')
    if (clearedBlocked) deltaReasons.push('blocked_cleared')

    // Stagnation enforcement: repeated dominant action type without strong delta
    // (stage advancement or blocker transitions) is treated as no progress.
    if (input.context.stagnation?.stagnant && finalStatus === 'success') {
      const dominantAction = normalizeText(input.context.stagnation.dominantAction)
      const repeatedDominant = dominantAction && actionType === dominantAction

      if (repeatedDominant) {
        const previousDeliverables = await this.findProducedDeliverables({
          maxTurnsToScan: 50,
          maxTurnNumber: input.turnNumber - 1
        })
        const previousStage = this.inferStage(previousDeliverables)
        const currentTurnEntries = await this.collectArtifactEntryNames(input.artifactsDir)
        const currentTurnDeliverables = this.extractDeliverablePatternsFromEntries(currentTurnEntries)
        const nextDeliverables = new Set<string>([...previousDeliverables, ...currentTurnDeliverables])
        const nextStage = this.inferStage(nextDeliverables)
        const stageAdvanced = this.isStageAdvanced(previousStage, nextStage)
        if (stageAdvanced && !deltaReasons.includes('stage_advanced')) {
          deltaReasons.push('stage_advanced')
        }

        const hasStrongDelta = deltaReasons.includes('blocked_cleared')
          || deltaReasons.includes('failure_recorded')
          || stageAdvanced

        if (!hasStrongDelta) {
          deltaReasons.length = 0
        }
      }
    }

    let blockedReason: string | null = null
    if (finalStatus === 'success' && deltaReasons.length === 0) {
      finalStatus = 'no_delta'
      summary = `NO_DELTA: ${summary}`
      blockedReason = 'no_delta'
    }

    if (finalStatus === 'no_delta' && (doneFingerprintHit || priorFingerprintCount > 0)) {
      const redundant = await this.failureStore.recordRedundancyBlocked({
        fingerprint: actionFingerprint,
        errorLine: 'Repeated action fingerprint produced NO_DELTA.',
        evidencePath: this.toEvidencePath(resultPath)
      })
      failureEntry = redundant
      finalStatus = 'blocked'
      blockedReason = 'redundant_no_delta'
      summary = `Redundant action blocked: ${actionFingerprint}`
      deltaReasons.push('redundancy_blocked')
    }

    const uniqueEvidencePaths = dedupeStrings(evidencePaths)

    let clearedRedundancyBlocked = false
    if (finalStatus === 'success' && deltaReasons.length > 0 && actionFingerprint) {
      clearedRedundancyBlocked = await this.failureStore.clearRedundancyBlocked({
        fingerprint: actionFingerprint,
        resolved: 'New delta artifact produced for previously blocked fingerprint.',
        evidencePath: this.toEvidencePath(resultPath)
      })
    }

    const doneEntries = (
      finalStatus === 'success' && deltaReasons.length > 0 && actionFingerprint
        ? [{
          text: actionFingerprint,
          evidencePath: businessArtifactEvidencePaths[0] ?? this.toEvidencePath(resultPath)
        }]
        : []
    )

    const autoProjectUpdate: ProjectUpdate = {
      keyArtifacts: dedupeStrings([...uniqueEvidencePaths, ...literatureCache.libraryPaths]),
      ...(doneEntries.length > 0 ? { done: doneEntries } : {})
    }

    const updateSummaryLines = [
      ...(outcome.updateSummary ?? []).map((line) => line.trim()).filter(Boolean)
    ]

    let projectUpdated = false
    if (outcome.projectUpdate) {
      try {
        const normalizedProjectUpdate = await this.normalizeAndValidateProjectUpdate(outcome.projectUpdate)
        await this.projectStore.applyUpdate(normalizedProjectUpdate)
        projectUpdated = true
        updateSummaryLines.push('PROJECT.md: applied structured update from native turn.')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        finalStatus = 'failure'
        summary = `PROJECT.md update rejected: ${message}`
        updateSummaryLines.push(`PROJECT.md update rejected: ${message}`)
        if (exitCode === 0) {
          exitCode = 1
          await writeText(exitCodePath, '1\n')
        }
      }
    }

    await this.projectStore.applyUpdate(autoProjectUpdate)
    projectUpdated = true
    updateSummaryLines.push('PROJECT.md: applied runtime-generated evidence pointers.')

    if (consumedPendingUserInputs) {
      updateSummaryLines.push(`User input: consumed ${input.pendingUserInputs.length} queued item(s).`)
    }

    if (projectUpdated) {
      const panel = await this.projectStore.load()
      updateSummaryLines.push(`PROJECT.md: plan=${panel.currentPlan.length}, facts=${panel.facts.length}, artifacts=${panel.keyArtifacts.length}`)
    }

    if (failureEntry) {
      updateSummaryLines.push(`FAILURES.md: ${failureEntry.status} recorded for fingerprint ${failureEntry.fingerprint}`)
    }

    if (clearedBlocked) {
      updateSummaryLines.push('FAILURES.md: BLOCKED fingerprint cleared after successful verification.')
    }
    if (clearedRedundancyBlocked) {
      updateSummaryLines.push('FAILURES.md: REDUNDANT block cleared after new delta.')
    }
    if (doneEntries.length > 0) {
      updateSummaryLines.push('PROJECT.md: Done (Do-not-repeat) updated with action fingerprint.')
    }
    if (literatureCache.cachedCount > 0) {
      updateSummaryLines.push(`Literature cache: saved ${literatureCache.cachedCount} document(s) under yolo library.`)
    }
    if (finalStatus === 'no_delta') {
      updateSummaryLines.push('NO_DELTA: no new verifiable artifact/evidence package was produced this turn.')
    }

    const boundedUpdates = updateSummaryLines
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 5)

    // Fix 4: Compute deliverable checklist / stage status
    const producedDeliverables = await this.findProducedDeliverables()
    const stageStatus = this.inferStage(producedDeliverables)

    // Fix 6e: Claims coverage
    const claimsCoverage = input.context.project.claims.length > 0
      ? {
        claims_total: input.context.project.claims.length,
        claims_covered: input.context.project.claims.filter(c => c.status === 'covered').length,
        claims_coverage: Number((input.context.project.claims.filter(c => c.status === 'covered').length / input.context.project.claims.length).toFixed(2))
      }
      : {}

    await writeText(resultPath, `${JSON.stringify({
      status: finalStatus,
      intent,
      summary,
      primary_action: primaryAction,
      action_fingerprint: actionFingerprint,
      action_type: actionType,
      exit_code: exitCode,
      runtime,
      cmd,
      cwd,
      duration_sec: durationSec,
      timestamp: toIso(turnEndedAt),
      tool_events_path: this.toEvidencePath(toolEventsPath),
      tool_events_count: toolEvents.length,
      delta_reasons: deltaReasons,
      stage_status: stageStatus,
      ...(deterministicFingerprint ? { failure_fingerprint: deterministicFingerprint } : {}),
      ...(clearedBlocked ? { unblock_verified: true } : {}),
      ...(blockedReason ? { blocked_reason: blockedReason } : {}),
      ...claimsCoverage
    }, null, 2)}\n`)

    await writeText(path.join(input.turnDir, 'action.md'), this.renderNativeActionMarkdown({
      turnNumber: input.turnNumber,
      intent,
      status: finalStatus,
      primaryAction,
      keyObservation: summary,
      evidencePaths: uniqueEvidencePaths,
      updateSummary: boundedUpdates
    }))

    return {
      turnNumber: input.turnNumber,
      turnDir: input.turnDir,
      status: finalStatus,
      intent,
      summary,
      evidencePaths: uniqueEvidencePaths,
      primaryAction,
      toolEventsCount: toolEvents.length,
      blockedBy: finalStatus === 'blocked' ? failureEntry ?? undefined : undefined,
      stageStatus
    }
  }

  private static readonly STAGNATION_WINDOW = 5
  private static readonly STAGNATION_THRESHOLD = 4

  private async findProducedDeliverables(input?: {
    maxTurnsToScan?: number
    maxTurnNumber?: number
  }): Promise<Set<string>> {
    const maxTurnsToScan = input?.maxTurnsToScan ?? 50
    const maxTurnNumber = typeof input?.maxTurnNumber === 'number'
      ? input.maxTurnNumber
      : Number.MAX_SAFE_INTEGER
    const turnNumbers = await listTurnNumbers(this.runsDir)
    const toScan = turnNumbers
      .filter((turnNumber) => turnNumber <= maxTurnNumber)
      .slice(-maxTurnsToScan)
      .reverse() // newest first
    const found = new Set<string>()

    for (const tn of toScan) {
      if (found.size >= DELIVERABLE_PATTERNS.length) break // all found
      const artifactsDir = path.join(this.runsDir, formatTurnId(tn), 'artifacts')
      if (!(await fileExists(artifactsDir))) continue
      try {
        const entryNames = await this.collectArtifactEntryNames(artifactsDir)
        const matched = this.extractDeliverablePatternsFromEntries(entryNames)
        for (const pattern of matched) found.add(pattern)
      } catch { /* skip */ }
    }
    return found
  }

  private async detectStagnation(): Promise<StagnationInfo> {
    const W = YoloSession.STAGNATION_WINDOW
    const threshold = YoloSession.STAGNATION_THRESHOLD
    const turnNumbers = await listTurnNumbers(this.runsDir)

    const counts = new Map<string, number>()
    let considered = 0
    for (let idx = turnNumbers.length - 1; idx >= 0 && considered < W; idx -= 1) {
      const turnNumber = turnNumbers[idx]
      if (typeof turnNumber !== 'number') continue
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue

      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        let actionType = normalizeText(parsed.action_type)
        if (!actionType) {
          const fingerprint = normalizeText(parsed.action_fingerprint)
          actionType = fingerprint.split(':')[0] || ''
        }
        const normalizedAction = actionType || 'agent'
        counts.set(normalizedAction, (counts.get(normalizedAction) ?? 0) + 1)
        considered += 1
      } catch {
        // Ignore malformed historical rows.
      }
    }

    if (considered < W) {
      return { stagnant: false, dominantAction: '', count: 0, window: W }
    }

    let dominantAction = ''
    let dominantCount = 0
    for (const [action, count] of counts) {
      if (count > dominantCount) {
        dominantAction = action
        dominantCount = count
      }
    }

    if (dominantAction && dominantCount >= threshold) {
      return {
        stagnant: true,
        dominantAction,
        count: dominantCount,
        window: W
      }
    }

    return {
      stagnant: false,
      dominantAction: '',
      count: 0,
      window: W
    }
  }

  private inferStage(producedDeliverables: Set<string>): StageStatus {
    for (const req of DELIVERABLE_CHECKLIST) {
      const completed = req.patterns.filter(p => producedDeliverables.has(p))
      const missing = req.patterns.filter(p => !producedDeliverables.has(p))
      // Stage complete if at least one pattern matches
      if (completed.length === 0) {
        return { currentStage: req.stage, label: req.label, missingDeliverables: missing, completedDeliverables: completed }
      }
    }
    return { currentStage: 'S5', label: 'Writing', missingDeliverables: [], completedDeliverables: ['paper_draft'] }
  }

  private isStageAdvanced(previous: StageStatus, next: StageStatus): boolean {
    const previousRank = stageRank(previous.currentStage)
    const nextRank = stageRank(next.currentStage)
    if (nextRank > previousRank) return true
    if (nextRank < previousRank) return false
    return next.completedDeliverables.length > previous.completedDeliverables.length
  }

  private async computeNextTurnNumber(): Promise<number> {
    const numbers = await listTurnNumbers(this.runsDir)
    return (numbers[numbers.length - 1] ?? 0) + 1
  }

  private async loadRecentTurns(limit: number): Promise<RecentTurnContext[]> {
    const numbers = await listTurnNumbers(this.runsDir)
    const selected = numbers.slice(-Math.max(0, limit)).reverse()

    const contexts: RecentTurnContext[] = []
    for (const number of selected) {
      const actionPath = path.join(this.runsDir, formatTurnId(number), 'action.md')
      const raw = await readTextOrEmpty(actionPath)
      if (!raw.trim()) continue
      contexts.push({
        turnNumber: number,
        actionPath: toPosixPath(path.relative(this.yoloRoot, actionPath)),
        summary: summarizeRecentAction(raw)
      })
    }

    return contexts
  }

  private async ensureUserInputQueueFile(): Promise<void> {
    if (!(await fileExists(this.userInputQueuePath))) {
      await writeText(this.userInputQueuePath, '[]\n')
    }
  }

  private async loadQueuedUserInputs(): Promise<QueuedUserInput[]> {
    await this.ensureUserInputQueueFile()
    const raw = await readTextOrEmpty(this.userInputQueuePath)
    if (!raw.trim()) return []

    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const row = item as Record<string, unknown>
          const id = typeof row.id === 'string' ? row.id.trim() : ''
          const text = typeof row.text === 'string' ? row.text.trim() : ''
          const submittedAt = typeof row.submittedAt === 'string' ? row.submittedAt.trim() : ''
          if (!id || !text || !submittedAt) return null
          return { id, text, submittedAt } satisfies QueuedUserInput
        })
        .filter((item): item is QueuedUserInput => item !== null)
    } catch {
      return []
    }
  }

  private async saveQueuedUserInputs(entries: QueuedUserInput[]): Promise<void> {
    const normalized = entries
      .map((entry) => ({
        id: entry.id.trim(),
        text: entry.text.trim(),
        submittedAt: entry.submittedAt.trim()
      }))
      .filter((entry) => entry.id && entry.text && entry.submittedAt)

    await writeText(this.userInputQueuePath, `${JSON.stringify(normalized, null, 2)}\n`)
  }

  private async clearQueuedUserInputs(): Promise<void> {
    await this.saveQueuedUserInputs([])
  }

  private async materializePendingUserInputs(artifactsDir: string): Promise<PendingUserInput[]> {
    const queue = await this.loadQueuedUserInputs()
    if (queue.length === 0) return []

    const items: PendingUserInput[] = []
    for (let index = 0; index < queue.length; index += 1) {
      const queued = queue[index]
      const safeId = queued.id.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
      const fileName = `user-input-${String(index + 1).padStart(2, '0')}-${safeId || 'entry'}.md`
      const filePath = path.join(artifactsDir, fileName)

      await writeText(filePath, [
        '# User Input',
        `- id: ${queued.id}`,
        `- submitted_at: ${queued.submittedAt}`,
        '',
        queued.text,
        ''
      ].join('\n'))

      items.push({
        ...queued,
        evidencePath: this.toEvidencePath(filePath)
      })
    }

    return items
  }

  private ensureSafeTargetPath(inputPath: string): string {
    const resolved = path.resolve(this.config.projectPath, inputPath)
    const projectRoot = path.resolve(this.config.projectPath)
    if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`targetPath escapes project root: ${inputPath}`)
    }
    return resolved
  }

  private toEvidencePath(absPath: string): string {
    return toPosixPath(path.relative(this.yoloRoot, absPath))
  }

  private toProjectRelativePath(absPath: string): string {
    return toPosixPath(path.relative(this.config.projectPath, absPath))
  }

  private async persistLiteratureCacheFromToolEvents(input: {
    turnNumber: number
    artifactsDir: string
    toolEvents: ToolEventRecord[]
  }): Promise<{
      evidencePath: string | null
      cachedCount: number
      libraryPaths: string[]
    }> {
    if (input.toolEvents.length === 0) {
      return { evidencePath: null, cachedCount: 0, libraryPaths: [] }
    }

    const literatureDir = path.join(this.yoloRoot, 'library', 'literature')
    const indexPath = path.join(literatureDir, 'index.json')
    const scriptLibraryPathSet = new Set<string>()
    const normalizeArtifactPath = (raw: unknown): string => {
      if (typeof raw !== 'string') return ''
      const trimmed = raw.trim()
      if (!trimmed) return ''

      if (path.isAbsolute(trimmed)) {
        try {
          return this.toProjectRelativePath(this.ensureSafeTargetPath(trimmed))
        } catch {
          return ''
        }
      }

      const normalized = toPosixPath(trimmed.replace(/^\.\//, ''))
      if (!normalized) return ''
      return normalized
    }

    for (const event of input.toolEvents) {
      if (event.phase !== 'result') continue
      const tool = normalizeText(event.tool || '')
      const resultObj = toPlainObject(event.result)
      const dataObj = toPlainObject(resultObj?.data)
      const inputObj = toPlainObject(event.input)

      const isLiteratureSkillRun = tool === 'skill-script-run' && safeString(inputObj?.skillId).trim() === 'literature-search'
      const isLiteratureWrapper = tool === 'literature-search'
      if (isLiteratureSkillRun || isLiteratureWrapper) {
        const structured = toPlainObject(dataObj?.structuredResult)
        const jsonPath = normalizeArtifactPath(structured?.jsonPath ?? dataObj?.jsonPath)
        const markdownPath = normalizeArtifactPath(structured?.markdownPath ?? dataObj?.markdownPath)
        if (jsonPath) scriptLibraryPathSet.add(jsonPath)
        if (markdownPath) scriptLibraryPathSet.add(markdownPath)
      }
    }
    const records: Array<{
      id: string
      url: string
      title: string
      sourceHost: string
      status: number
      fetchedAt: string
      turnNumber: number
      jsonPath: string
      markdownPath: string
      excerptChars: number
    }> = []

    let lastFetchUrl = ''
    for (const event of input.toolEvents) {
      if (normalizeText(event.tool || '') !== 'fetch') continue

      if (event.phase === 'call') {
        const callInput = toPlainObject(event.input)
        const maybeUrl = safeString(callInput?.url).trim()
        if (maybeUrl) lastFetchUrl = maybeUrl
        continue
      }

      const resultInput = toPlainObject(event.input)
      const url = safeString(resultInput?.url).trim() || lastFetchUrl
      if (!url || !isLikelyLiteratureUrl(url)) continue

      const resultObj = toPlainObject(event.result)
      const dataObj = toPlainObject(resultObj?.data)
      const status = typeof dataObj?.status === 'number' ? dataObj.status : (event.success === true ? 200 : 500)
      const ok = typeof dataObj?.ok === 'boolean' ? dataObj.ok : event.success === true
      if (!ok || status >= 400) continue

      const fetchedAt = event.timestamp || toIso(this.now)
      const body = dataObj?.body
      let rawBody = ''
      if (typeof body === 'string') {
        rawBody = body
      } else if (body !== undefined) {
        try {
          rawBody = JSON.stringify(body, null, 2)
        } catch {
          rawBody = String(body)
        }
      }
      const excerpt = rawBody.slice(0, LITERATURE_BODY_LIMIT).trim()
      if (!excerpt) continue

      let sourceHost = 'unknown'
      try {
        sourceHost = new URL(url).hostname
      } catch {
        sourceHost = 'unknown'
      }

      const title = extractLiteratureTitle(body)
      const fileStem = `${slugifyForFile(sourceHost)}-${hashStable(`${url}\n${excerpt.slice(0, 4096)}`)}`
      const jsonPath = path.join(literatureDir, `${fileStem}.json`)
      const markdownPath = path.join(literatureDir, `${fileStem}.md`)

      await writeText(jsonPath, `${JSON.stringify({
        id: fileStem,
        url,
        sourceHost,
        title: title || null,
        status,
        fetchedAt,
        turnNumber: input.turnNumber,
        body
      }, null, 2)}\n`)

      const markdown = [
        `# Literature Cache: ${title || sourceHost}`,
        '',
        `- id: ${fileStem}`,
        `- source: ${sourceHost}`,
        `- url: ${url}`,
        `- status: ${status}`,
        `- fetched_at: ${fetchedAt}`,
        `- turn: ${formatTurnId(input.turnNumber)}`,
        '',
        '## Content Excerpt',
        '```',
        excerpt,
        '```',
        ''
      ].join('\n')
      await writeText(markdownPath, markdown)

      records.push({
        id: fileStem,
        url,
        title,
        sourceHost,
        status,
        fetchedAt,
        turnNumber: input.turnNumber,
        jsonPath: this.toProjectRelativePath(jsonPath),
        markdownPath: this.toProjectRelativePath(markdownPath),
        excerptChars: excerpt.length
      })
    }

    if (records.length === 0 && scriptLibraryPathSet.size === 0) {
      return { evidencePath: null, cachedCount: 0, libraryPaths: [] }
    }

    if (records.length > 0) {
      let existingIndex: Array<Record<string, unknown>> = []
      try {
        const raw = await readTextOrEmpty(indexPath)
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) {
          existingIndex = parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        }
      } catch {
        existingIndex = []
      }

      const mergedById = new Map<string, Record<string, unknown>>()
      for (const row of existingIndex) {
        const id = safeString(row.id).trim()
        if (!id) continue
        mergedById.set(id, row)
      }
      for (const record of records) {
        mergedById.set(record.id, {
          id: record.id,
          url: record.url,
          title: record.title || null,
          sourceHost: record.sourceHost,
          fetchedAt: record.fetchedAt,
          turnNumber: record.turnNumber,
          jsonPath: record.jsonPath,
          markdownPath: record.markdownPath,
          excerptChars: record.excerptChars
        })
      }

      const nextIndex = Array.from(mergedById.values())
        .sort((a, b) => safeString(b.fetchedAt).localeCompare(safeString(a.fetchedAt)))
        .slice(0, LITERATURE_INDEX_LIMIT)

      await writeText(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`)
    }

    const manifestPath = path.join(input.artifactsDir, 'literature-cache.json')
    await writeText(manifestPath, `${JSON.stringify({
      turnNumber: input.turnNumber,
      cachedCount: records.length,
      records,
      scriptArtifacts: Array.from(scriptLibraryPathSet.values()).sort((a, b) => a.localeCompare(b))
    }, null, 2)}\n`)

    const scriptLibraryPaths = Array.from(scriptLibraryPathSet.values()).sort((a, b) => a.localeCompare(b))

    return {
      evidencePath: this.toEvidencePath(manifestPath),
      cachedCount: records.length + scriptLibraryPaths.length,
      libraryPaths: dedupeStrings([
        ...records.flatMap((record) => [record.jsonPath, record.markdownPath]),
        ...scriptLibraryPaths
      ])
    }
  }

  private renderNativeActionMarkdown(input: {
    turnNumber: number
    intent: string
    status: TurnStatus
    primaryAction: string
    keyObservation: string
    evidencePaths: string[]
    updateSummary: string[]
  }): string {
    const updateLines = input.updateSummary.length > 0
      ? input.updateSummary.map((line) => `- ${line}`)
      : ['- Next: continue with native tool execution.']

    return [
      `# Turn ${formatTurnId(input.turnNumber)}`,
      '',
      '## Intent',
      `- Why this turn: ${input.intent.trim()}`,
      '- Expected outcome: Produce fresh evidence and update control files with pointers only.',
      '',
      '## Action',
      '- Tool: Agent',
      `- Command or target: ${input.primaryAction || 'agent.run'}`,
      '',
      '## Result',
      `- Status: ${input.status}`,
      `- Key observation: ${input.keyObservation}`,
      `- Evidence: ${input.evidencePaths.length > 0 ? input.evidencePaths.join(', ') : 'none'}`,
      '',
      '## Update (<=5 lines, pointers only)',
      ...updateLines,
      ''
    ].join('\n')
  }
}

export function createYoloSession(config: CreateYoloSessionConfig): YoloSession {
  return new YoloSession(config)
}
