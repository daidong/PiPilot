import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createLlmSingleAgent,
  createYoloSession,
  type TurnExecutionResult
} from '@yolo-researcher/index'

type RuntimeKind = 'host' | 'docker' | 'venv'
type TurnFileName = 'action.md' | 'cmd.txt' | 'stdout.txt' | 'stderr.txt' | 'exit_code.txt' | 'patch.diff' | 'result.json'

interface StartPayload {
  goal: string
  model?: string
  defaultRuntime?: RuntimeKind
  runtimeSystemInfo?: string
  autoRun?: boolean
  maxTurns?: number
}

interface TurnListItem {
  turnNumber: number
  status: string
  summary: string
  actionPath: string
  turnDir: string
  partial?: boolean
}

interface DesktopOverview {
  projectPath: string
  goal: string
  model: string
  defaultRuntime: RuntimeKind
  runtimeSystemInfo: string
  loopRunning: boolean
  pausedForUserInput: boolean
  hasSession: boolean
  turnCount: number
  lastTurn: TurnListItem | null
  usage: UsageSnapshot
}

interface UsageSnapshot {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  totalCost: number
  callCount: number
}

interface PersistedUsageTotals {
  totals?: {
    tokens?: number
    promptTokens?: number
    cachedTokens?: number
    cost?: number
    calls?: number
  }
}

interface DesktopStateFile {
  lastProjectPath?: string
  lastGoal?: string
  lastModel?: string
  lastRuntime?: RuntimeKind
  lastRuntimeSystemInfo?: string
}

interface WindowRuntimeState {
  projectPath: string
  goal: string
  model: string
  defaultRuntime: RuntimeKind
  runtimeSystemInfo: string
  yoloSession: ReturnType<typeof createYoloSession> | null
  yoloAgent: { destroy?: () => Promise<void> } | null
  loopRunning: boolean
  stopRequested: boolean
  manualPauseForInput: boolean
  executingTurn: boolean
  usage: UsageSnapshot
}

const DEFAULT_MODEL = 'gpt-5.2'
const DEFAULT_RUNTIME: RuntimeKind = 'host'
const DEFAULT_LOOP_TURNS = 12
const MAX_LOOP_TURNS = 200
const ACTIVITY_DETAIL_LIMIT = 420
const TERMINAL_CHUNK_UI_LIMIT = 12_000
const windowStates = new Map<number, WindowRuntimeState>()
let handlersRegistered = false
const REQUIRED_BOOTSTRAP_SKILL_ID = 'literature-search'
const REQUIRED_COMMUNITY_SKILL_ID = 'markitdown'

function resolveDefaultSkillsSourceDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return resolve(moduleDir, '..', '..', '..', 'skills', 'default-project-skills')
}

function resolveCommunitySkillsSourceDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return resolve(moduleDir, '..', '..', '..', '..', '..', 'src', 'skills', 'community-builtin')
}

function workspaceSkillsDir(projectPath: string): string {
  return join(projectPath, '.agentfoundry', 'skills')
}

function syncDefaultSkillsToWorkspace(projectPath: string): { sourceDir: string; targetDir: string; copiedSkills: number } {
  const sourceDir = resolveDefaultSkillsSourceDir()
  const targetDir = workspaceSkillsDir(projectPath)

  if (!existsSync(sourceDir)) {
    throw new Error(`Default skills source not found: ${sourceDir}`)
  }

  const sourceEntries = readdirSync(sourceDir, { withFileTypes: true })
  const skillDirs = sourceEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(sourceDir, name, 'SKILL.md')))

  if (skillDirs.length === 0) {
    throw new Error(`No default skills found under: ${sourceDir}`)
  }

  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })

  for (const skillId of skillDirs) {
    const from = join(sourceDir, skillId)
    const to = join(targetDir, skillId)
    cpSync(from, to, { recursive: true, force: true })
  }

  return { sourceDir, targetDir, copiedSkills: skillDirs.length }
}

function assertWorkspaceSkillsReady(projectPath: string): void {
  const skillsDir = workspaceSkillsDir(projectPath)
  if (!existsSync(skillsDir)) {
    throw new Error(`Workspace skills directory is missing: ${skillsDir}`)
  }

  const requiredSkillFile = join(skillsDir, REQUIRED_BOOTSTRAP_SKILL_ID, 'SKILL.md')
  if (!existsSync(requiredSkillFile)) {
    throw new Error(`Required skill is missing: ${requiredSkillFile}`)
  }
}

function assertCommunitySkillsReady(): string {
  const communityDir = resolveCommunitySkillsSourceDir()
  if (!existsSync(communityDir)) {
    throw new Error(`Community skills directory is missing: ${communityDir}`)
  }

  const requiredSkillFile = join(communityDir, REQUIRED_COMMUNITY_SKILL_ID, 'SKILL.md')
  if (!existsSync(requiredSkillFile)) {
    throw new Error(`Required community skill is missing: ${requiredSkillFile}`)
  }
  return communityDir
}

function createWindowRuntimeState(): WindowRuntimeState {
  return {
    projectPath: '',
    goal: '',
    model: DEFAULT_MODEL,
    defaultRuntime: DEFAULT_RUNTIME,
    runtimeSystemInfo: '',
    yoloSession: null,
    yoloAgent: null,
    loopRunning: false,
    stopRequested: false,
    manualPauseForInput: false,
    executingTurn: false,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      totalCost: 0,
      callCount: 0
    }
  }
}

function getWindowState(win: BrowserWindow): WindowRuntimeState {
  const existing = windowStates.get(win.id)
  if (existing) return existing
  const created = createWindowRuntimeState()
  windowStates.set(win.id, created)
  return created
}

function getWindowContext(event: IpcMainInvokeEvent): { win: BrowserWindow; state: WindowRuntimeState } {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) throw new Error('Window not found for IPC event')
  return { win, state: getWindowState(win) }
}

function safeSend(win: BrowserWindow, channel: string, payload?: unknown): void {
  if (!win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

function makeUiEventId(tag: string): string {
  return `${Date.now()}-${tag}-${Math.random().toString(36).slice(2, 8)}`
}

function clipText(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(1, limit - 1))}…`
}

function summarizeUnknown(value: unknown, limit: number = ACTIVITY_DETAIL_LIMIT): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return clipText(value.trim(), limit)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return clipText(JSON.stringify(value), limit)
  } catch {
    return clipText(String(value), limit)
  }
}

function formatTurnLabel(turnNumber: number): string {
  return `turn-${String(turnNumber).padStart(4, '0')}`
}

function desktopStatePath(): string {
  return join(app.getPath('userData'), 'yolo-researcher-v2-desktop-state.json')
}

function readDesktopState(): DesktopStateFile {
  try {
    const raw = readFileSync(desktopStatePath(), 'utf-8')
    return JSON.parse(raw) as DesktopStateFile
  } catch {
    return {}
  }
}

function writeDesktopState(state: DesktopStateFile): void {
  try {
    writeFileSync(desktopStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  } catch {
    // Preference persistence is best effort.
  }
}

function parseTurnNumber(name: string): number | null {
  const match = /^turn-(\d{4})$/.exec(name)
  if (!match) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : null
}

function sessionRoot(projectPath: string): string {
  return projectPath
}

function inferGoalFromProjectMd(projectPath: string): string {
  const mdPath = join(sessionRoot(projectPath), 'PROJECT.md')
  if (!existsSync(mdPath)) return ''
  try {
    const raw = readFileSync(mdPath, 'utf-8')
    const line = raw
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.startsWith('- Goal:'))
    return line ? line.slice('- Goal:'.length).trim() : ''
  } catch {
    return ''
  }
}

function toFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function usageSnapshotFromTotals(raw: PersistedUsageTotals | null): UsageSnapshot {
  const tokens = toFiniteNumber(raw?.totals?.tokens)
  const promptTokens = toFiniteNumber(raw?.totals?.promptTokens)
  const cachedTokens = toFiniteNumber(raw?.totals?.cachedTokens)
  const totalCost = toFiniteNumber(raw?.totals?.cost)
  const callCount = toFiniteNumber(raw?.totals?.calls)
  return {
    promptTokens,
    completionTokens: Math.max(0, tokens - promptTokens),
    totalTokens: tokens,
    cachedTokens,
    totalCost,
    callCount
  }
}

function readUsageSnapshotFromUsageFile(projectPath: string): UsageSnapshot | null {
  const usagePath = join(projectPath, '.agentfoundry', 'usage.json')
  if (!existsSync(usagePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(usagePath, 'utf-8')) as PersistedUsageTotals
    const snapshot = usageSnapshotFromTotals(parsed)
    if (snapshot.totalTokens <= 0 && snapshot.callCount <= 0) return null
    return snapshot
  } catch {
    return null
  }
}

function readUsageSnapshotFromTraceSummaries(projectPath: string): UsageSnapshot | null {
  const tracesDir = join(projectPath, '.agentfoundry', 'traces')
  if (!existsSync(tracesDir)) return null
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  let cachedTokens = 0
  let totalCost = 0
  let callCount = 0

  try {
    const files = readdirSync(tracesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.summary.json'))
      .map((entry) => entry.name)

    for (const fileName of files) {
      const raw = JSON.parse(readFileSync(join(tracesDir, fileName), 'utf-8')) as Record<string, any>
      const usage = raw.usage as Record<string, any> | undefined
      const tokens = usage?.tokens as Record<string, any> | undefined
      const cost = usage?.cost as Record<string, any> | undefined
      promptTokens += toFiniteNumber(tokens?.promptTokens)
      completionTokens += toFiniteNumber(tokens?.completionTokens)
      totalTokens += toFiniteNumber(tokens?.totalTokens)
      cachedTokens += toFiniteNumber(tokens?.cacheReadInputTokens)
      totalCost += toFiniteNumber(cost?.totalCost)
      callCount += toFiniteNumber(usage?.callCount)
    }
  } catch {
    return null
  }

  if (totalTokens <= 0 && callCount <= 0) return null
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens || (promptTokens + completionTokens),
    cachedTokens,
    totalCost,
    callCount
  }
}

function readUsageSnapshotFromTraceJsonl(projectPath: string): UsageSnapshot | null {
  const tracesDir = join(projectPath, '.agentfoundry', 'traces')
  if (!existsSync(tracesDir)) return null

  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  let cachedTokens = 0
  let callCount = 0

  try {
    const files = readdirSync(tracesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.startsWith('trace-'))
      .map((entry) => entry.name)

    for (const fileName of files) {
      const raw = readFileSync(join(tracesDir, fileName), 'utf-8')
      const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      for (const line of lines) {
        let row: Record<string, any>
        try {
          row = JSON.parse(line) as Record<string, any>
        } catch {
          continue
        }
        if (row.type !== 'llm.response') continue
        const data = row.data as Record<string, any> | undefined
        const usage = data?.usage as Record<string, any> | undefined
        if (!usage) continue

        const prompt = toFiniteNumber(usage.promptTokens ?? usage.inputTokens)
        const completion = toFiniteNumber(usage.completionTokens ?? usage.outputTokens)
        const total = toFiniteNumber(usage.totalTokens) || (prompt + completion)
        const cached = toFiniteNumber(usage.cacheReadInputTokens ?? usage.cachedTokens)

        promptTokens += prompt
        completionTokens += completion
        totalTokens += total
        cachedTokens += cached
        callCount += 1
      }
    }
  } catch {
    return null
  }

  if (totalTokens <= 0 && callCount <= 0) return null
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens || (promptTokens + completionTokens),
    cachedTokens,
    totalCost: 0,
    callCount
  }
}

function loadUsageSnapshotFromDisk(projectPath: string): UsageSnapshot {
  return (
    readUsageSnapshotFromUsageFile(projectPath)
    || readUsageSnapshotFromTraceSummaries(projectPath)
    || readUsageSnapshotFromTraceJsonl(projectPath)
    || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      totalCost: 0,
      callCount: 0
    }
  )
}

function readFirstNonEmptyLine(raw: string, prefix: string): string {
  const line = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
  return line ? line.slice(prefix.length).trim() : ''
}

function parseResultSummaryFromDisk(resultPath: string): { status: string; summary: string } | null {
  if (!existsSync(resultPath)) return null
  try {
    const raw = readFileSync(resultPath, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>
    const status = typeof data.status === 'string' ? data.status.trim() : ''
    const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
    if (!status && !summary) return null
    return {
      status: status || 'unknown',
      summary: summary || 'No summary.'
    }
  } catch {
    return null
  }
}

function hasArtifactFiles(artifactsDir: string): boolean {
  if (!existsSync(artifactsDir)) return false
  try {
    return readdirSync(artifactsDir, { withFileTypes: true }).some((entry) => entry.isFile())
  } catch {
    return false
  }
}

function listTurnsFromDisk(projectPath: string): TurnListItem[] {
  const runsDir = join(sessionRoot(projectPath), 'runs')
  if (!existsSync(runsDir)) return []

  const numbers = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => parseTurnNumber(entry.name))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)

  const turns: TurnListItem[] = []
  for (const turnNumber of numbers) {
    const turnDirName = `turn-${turnNumber.toString().padStart(4, '0')}`
    const turnDir = join(runsDir, turnDirName)
    const actionPath = join(turnDir, 'action.md')
    const resultPath = join(turnDir, 'result.json')
    const resultSummary = parseResultSummaryFromDisk(resultPath)
    const artifactsDir = join(turnDir, 'artifacts')
    const hasArtifacts = hasArtifactFiles(artifactsDir)
    const hasExecEvidence = ['cmd.txt', 'stdout.txt', 'stderr.txt', 'exit_code.txt', 'patch.diff']
      .some((fileName) => existsSync(join(turnDir, fileName)))
    let status = 'unknown'
    let summary = 'No summary.'
    let partial = false

    if (existsSync(actionPath)) {
      try {
        const raw = readFileSync(actionPath, 'utf-8')
        status = readFirstNonEmptyLine(raw, '- Status:') || 'unknown'
        summary = readFirstNonEmptyLine(raw, '- Key observation:') || 'No summary.'
      } catch {
        status = 'unknown'
      }
      if (resultSummary) {
        if (status === 'unknown' && resultSummary.status) status = resultSummary.status
        if (summary === 'No summary.' && resultSummary.summary) summary = resultSummary.summary
      }
    } else if (resultSummary) {
      partial = true
      status = resultSummary.status || 'partial'
      summary = resultSummary.summary || 'Partial turn with result metadata.'
    } else if (hasArtifacts || hasExecEvidence) {
      partial = true
      status = 'partial'
      summary = hasArtifacts
        ? 'Partial turn with artifacts; action/result metadata missing.'
        : 'Partial turn with execution evidence; action/result metadata missing.'
    }

    turns.push({
      turnNumber,
      status,
      summary,
      actionPath: evidencePath(turnNumber, 'action.md'),
      turnDir: evidenceTurnDirPath(turnNumber),
      partial
    })
  }

  return turns
}

function queuedUserInputCount(projectPath: string): number {
  const queuePath = join(sessionRoot(projectPath), 'user-input-queue.json')
  if (!existsSync(queuePath)) return 0
  try {
    const raw = readFileSync(queuePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return 0
    return parsed
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => typeof entry.text === 'string' && entry.text.trim().length > 0)
      .length
  } catch {
    return 0
  }
}

function isPausedForUserInput(projectPath: string, turns: TurnListItem[]): boolean {
  const latestTurn = turns[turns.length - 1] ?? null
  if (!latestTurn) return false
  if ((latestTurn.status || '').toLowerCase() !== 'ask_user') return false
  return queuedUserInputCount(projectPath) === 0
}

function evidenceTurnDirPath(turnNumber: number): string {
  return `runs/turn-${turnNumber.toString().padStart(4, '0')}`
}

function evidencePath(turnNumber: number, fileName: string): string {
  return `${evidenceTurnDirPath(turnNumber)}/${fileName}`
}

function resolveApiKey(): string | undefined {
  const keys = [
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.DEEPSEEK_API_KEY,
    process.env.GOOGLE_API_KEY
  ]
  return keys.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function assertProjectSelected(state: WindowRuntimeState): void {
  if (!state.projectPath) throw new Error('No project folder selected.')
}

async function destroyRuntime(state: WindowRuntimeState): Promise<void> {
  state.stopRequested = true
  state.loopRunning = false
  state.manualPauseForInput = false
  state.executingTurn = false
  if (state.yoloAgent?.destroy) {
    await state.yoloAgent.destroy().catch(() => undefined)
  }
  state.yoloAgent = null
  state.yoloSession = null
}

async function buildOverview(state: WindowRuntimeState): Promise<DesktopOverview> {
  if (state.projectPath && state.usage.callCount === 0 && state.usage.totalTokens === 0) {
    state.usage = loadUsageSnapshotFromDisk(state.projectPath)
  }
  const turns = state.projectPath
    ? listTurnsFromDisk(state.projectPath)
    : []
  const pausedForUserInput = state.projectPath
    ? (
      isPausedForUserInput(state.projectPath, turns)
      || (state.manualPauseForInput && queuedUserInputCount(state.projectPath) === 0)
    )
    : false

  return {
    projectPath: state.projectPath,
    goal: state.goal,
    model: state.model,
    defaultRuntime: state.defaultRuntime,
    runtimeSystemInfo: state.runtimeSystemInfo,
    loopRunning: state.loopRunning,
    pausedForUserInput,
    hasSession: state.yoloSession !== null,
    turnCount: turns.length,
    lastTurn: turns.length > 0 ? turns[turns.length - 1] ?? null : null,
    usage: { ...state.usage }
  }
}

async function loadCurrentProjectControlFile(state: WindowRuntimeState, fileName: 'PROJECT.md' | 'FAILURES.md'): Promise<string> {
  if (!state.projectPath) return ''

  const filePath = join(sessionRoot(state.projectPath), fileName)
  if (!existsSync(filePath)) return ''
  return readFileSync(filePath, 'utf-8')
}

function clampTurns(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1
  const normalized = Math.floor(value as number)
  if (normalized < 1) return 1
  if (normalized > MAX_LOOP_TURNS) return MAX_LOOP_TURNS
  return normalized
}

function resetUsageSnapshot(state: WindowRuntimeState): void {
  state.usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    totalCost: 0,
    callCount: 0
  }
}

function isTurnTerminal(status: TurnExecutionResult['status']): boolean {
  return status === 'ask_user' || status === 'stopped'
}

function describeExecutedAction(result: TurnExecutionResult): string {
  if (result.primaryAction?.trim()) return result.primaryAction.trim()
  return 'agent.run'
}

function inferNextTurnNumber(state: WindowRuntimeState): number | null {
  if (!state.projectPath) return null
  const turns = listTurnsFromDisk(state.projectPath)
  const last = turns[turns.length - 1]?.turnNumber ?? 0
  return last + 1
}

async function runSingleTurn(state: WindowRuntimeState, win: BrowserWindow): Promise<TurnExecutionResult> {
  if (!state.yoloSession) throw new Error('No active v2 session. Call yolo:start first.')
  if (state.executingTurn) throw new Error('A turn is already running.')
  if (state.projectPath) {
    const queuedInputs = queuedUserInputCount(state.projectPath)
    if (state.manualPauseForInput && queuedInputs === 0) {
      throw new Error('Session is paused for user input. Submit input to continue.')
    }
    if (state.manualPauseForInput && queuedInputs > 0) {
      state.manualPauseForInput = false
    }
    const turns = listTurnsFromDisk(state.projectPath)
    if (isPausedForUserInput(state.projectPath, turns)) {
      throw new Error('Session is paused for user input. Submit reply first.')
    }
  }

  state.executingTurn = true
  const turnStartTime = Date.now()
  const nextTurn = inferNextTurnNumber(state)
  safeSend(win, 'yolo:activity', {
    id: `${Date.now()}-start`,
    timestamp: new Date().toISOString(),
    type: 'turn_started',
    summary: nextTurn ? `Starting turn-${String(nextTurn).padStart(4, '0')}` : 'Starting turn'
  })
  try {
    const result = await state.yoloSession.runNextTurn()
    const durationMs = Date.now() - turnStartTime
    const actionLabel = describeExecutedAction(result)
    const statusLabel = result.status === 'ask_user' ? 'paused' : result.status
    safeSend(win, 'yolo:turn-result', result)
    safeSend(win, 'yolo:event', {
      type: 'turn_completed',
      turnNumber: result.turnNumber,
      status: result.status,
      summary: `Agent: ${actionLabel}`,
      observation: result.summary,
      intent: result.intent
    })
    safeSend(win, 'yolo:activity', {
      id: `${Date.now()}-done`,
      timestamp: new Date().toISOString(),
      type: 'turn_completed',
      summary: `Turn ${result.turnNumber} -> ${statusLabel}`,
      detail: `Agent: ${actionLabel}\nintent: ${result.intent}\n${result.summary} (${durationMs}ms)`
    })
    return result
  } finally {
    state.executingTurn = false
  }
}

async function runLoop(win: BrowserWindow, state: WindowRuntimeState, requestedTurns: number): Promise<void> {
  if (state.loopRunning) return
  if (!state.yoloSession) throw new Error('No active v2 session.')

  const maxTurns = clampTurns(requestedTurns)
  state.loopRunning = true
  state.stopRequested = false
  safeSend(win, 'yolo:event', { type: 'loop_started', maxTurns })

  try {
    for (let index = 0; index < maxTurns; index += 1) {
      if (state.stopRequested) {
        const reason = state.manualPauseForInput ? 'pause_requested' : 'stop_requested'
        safeSend(win, 'yolo:event', { type: 'loop_stopped', reason })
        safeSend(win, 'yolo:activity', {
          id: `${Date.now()}-stop`,
          timestamp: new Date().toISOString(),
          type: 'loop_stopped',
          summary: state.manualPauseForInput
            ? 'Loop paused: waiting for user input before next turn'
            : 'Loop stopped by user request'
        })
        break
      }

      safeSend(win, 'yolo:activity', {
        id: `${Date.now()}-progress`,
        timestamp: new Date().toISOString(),
        type: 'loop_progress',
        summary: `Loop turn ${index + 1}/${maxTurns}`
      })

      const result = await runSingleTurn(state, win)

      if (result.status === 'ask_user') {
        safeSend(win, 'yolo:event', { type: 'loop_paused', reason: 'ask_user' })
        safeSend(win, 'yolo:activity', {
          id: `${Date.now()}-paused`,
          timestamp: new Date().toISOString(),
          type: 'loop_paused',
          summary: 'Loop paused: waiting for user input'
        })
        break
      }

      if (isTurnTerminal(result.status)) {
        safeSend(win, 'yolo:event', { type: 'loop_stopped', reason: result.status })
        safeSend(win, 'yolo:activity', {
          id: `${Date.now()}-terminal`,
          timestamp: new Date().toISOString(),
          type: 'loop_stopped',
          summary: `Loop stopped: ${result.status}`
        })
        break
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    safeSend(win, 'yolo:event', { type: 'loop_error', message })
    safeSend(win, 'yolo:activity', {
      id: `${Date.now()}-error`,
      timestamp: new Date().toISOString(),
      type: 'loop_error',
      summary: `Loop error: ${message}`
    })
    throw error
  } finally {
    state.loopRunning = false
    state.stopRequested = false
    safeSend(win, 'yolo:event', { type: 'loop_idle' })
  }
}

async function restoreWindowStateFromDisk(state: WindowRuntimeState): Promise<void> {
  if (state.projectPath) return

  const saved = readDesktopState()
  if (!saved.lastProjectPath?.trim()) return
  if (!existsSync(saved.lastProjectPath)) return

  const projectPath = saved.lastProjectPath
  try {
    syncDefaultSkillsToWorkspace(projectPath)
    assertWorkspaceSkillsReady(projectPath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to sync default skills for restored workspace "${projectPath}": ${reason}`)
  }

  const goal = saved.lastGoal?.trim() || inferGoalFromProjectMd(projectPath)

  state.projectPath = projectPath
  state.goal = goal
  state.model = saved.lastModel?.trim() || DEFAULT_MODEL
  state.defaultRuntime = saved.lastRuntime ?? DEFAULT_RUNTIME
  state.runtimeSystemInfo = saved.lastRuntimeSystemInfo?.trim() || ''
  state.usage = loadUsageSnapshotFromDisk(projectPath)
}

function persistWindowState(state: WindowRuntimeState): void {
  if (!state.projectPath) {
    writeDesktopState({})
    return
  }

  writeDesktopState({
    lastProjectPath: state.projectPath,
    lastGoal: state.goal,
    lastModel: state.model,
    lastRuntime: state.defaultRuntime,
    lastRuntimeSystemInfo: state.runtimeSystemInfo
  })
}

async function initializeSession(win: BrowserWindow, state: WindowRuntimeState, payload: StartPayload): Promise<void> {
  assertProjectSelected(state)
  syncDefaultSkillsToWorkspace(state.projectPath)
  assertWorkspaceSkillsReady(state.projectPath)
  const communitySkillsDir = assertCommunitySkillsReady()
  if (state.loopRunning || state.executingTurn) {
    throw new Error('Cannot start/rebind while a turn is running.')
  }

  const goal = payload.goal?.trim()
  if (!goal) throw new Error('Goal is required.')

  const model = payload.model?.trim() || state.model || DEFAULT_MODEL
  const defaultRuntime = payload.defaultRuntime ?? state.defaultRuntime ?? DEFAULT_RUNTIME
  const runtimeSystemInfo = payload.runtimeSystemInfo?.trim() ?? state.runtimeSystemInfo ?? ''

  const needsFreshSession = (
    !state.yoloSession
    || state.goal !== goal
    || state.model !== model
    || state.defaultRuntime !== defaultRuntime
    || state.runtimeSystemInfo !== runtimeSystemInfo
  )

  if (needsFreshSession) {
    await destroyRuntime(state)
    state.manualPauseForInput = false

    const terminalChunkBuffer = new Map<string, {
      turnNumber: number
      stream: 'stdout' | 'stderr'
      timestamp: string
      traceId?: string
      caller?: string
      chunk: string
      truncated?: boolean
    }>()
    let terminalChunkFlushTimer: NodeJS.Timeout | null = null

    const flushTerminalChunks = (): void => {
      terminalChunkFlushTimer = null
      if (terminalChunkBuffer.size === 0) return

      for (const entry of terminalChunkBuffer.values()) {
        safeSend(win, 'yolo:terminal', {
          id: makeUiEventId('terminal'),
          turnNumber: entry.turnNumber,
          phase: 'chunk',
          timestamp: entry.timestamp,
          traceId: entry.traceId,
          caller: entry.caller,
          stream: entry.stream,
          chunk: clipText(entry.chunk, TERMINAL_CHUNK_UI_LIMIT),
          truncated: entry.truncated
        })
      }
      terminalChunkBuffer.clear()
    }

    const enqueueTerminalChunk = (event: {
      turnNumber: number
      timestamp: string
      traceId?: string
      caller?: string
      stream?: 'stdout' | 'stderr'
      chunk?: string
      truncated?: boolean
    }): void => {
      const stream = event.stream === 'stderr' ? 'stderr' : 'stdout'
      const key = `${event.turnNumber}:${stream}`
      const prev = terminalChunkBuffer.get(key)
      const merged = prev
        ? clipText(`${prev.chunk}${event.chunk || ''}`, TERMINAL_CHUNK_UI_LIMIT * 2)
        : clipText(event.chunk || '', TERMINAL_CHUNK_UI_LIMIT * 2)

      terminalChunkBuffer.set(key, {
        turnNumber: event.turnNumber,
        stream,
        timestamp: event.timestamp,
        traceId: event.traceId || prev?.traceId,
        caller: event.caller || prev?.caller,
        chunk: merged,
        truncated: Boolean(event.truncated || prev?.truncated)
      })

      if (!terminalChunkFlushTimer) {
        terminalChunkFlushTimer = setTimeout(flushTerminalChunks, 50)
      }
    }

    const agent = createLlmSingleAgent({
      projectPath: state.projectPath,
      model,
      apiKey: resolveApiKey(),
      enableNetwork: true,
      capabilityProfile: 'full',
      autoApprove: true,
      communitySkillsDir,
      runtimeSystemInfo,
      onToolEvent: (event) => {
        const toolName = (event.tool || 'tool').trim() || 'tool'
        const turnLabel = formatTurnLabel(event.turnNumber)
        if (event.phase === 'call') {
          const inputSnippet = summarizeUnknown(event.input)
          safeSend(win, 'yolo:activity', {
            id: makeUiEventId('tool-call'),
            timestamp: event.timestamp || new Date().toISOString(),
            type: 'tool_call',
            summary: `${turnLabel} · ${toolName} call`,
            detail: inputSnippet ? `input: ${inputSnippet}` : undefined
          })
          return
        }

        const successText = event.success === true ? 'ok' : event.success === false ? 'failed' : 'result'
        const errorSnippet = summarizeUnknown(event.error)
        const resultSnippet = summarizeUnknown(event.result)
        safeSend(win, 'yolo:activity', {
          id: makeUiEventId('tool-result'),
          timestamp: event.timestamp || new Date().toISOString(),
          type: 'tool_result',
          summary: `${turnLabel} · ${toolName} ${successText}`,
          detail: errorSnippet
            ? `error: ${errorSnippet}`
            : (resultSnippet ? `result: ${resultSnippet}` : undefined)
        })
      },
      onExecEvent: (event) => {
        const baseTimestamp = event.timestamp || new Date().toISOString()
        if (event.phase === 'chunk') {
          enqueueTerminalChunk({
            turnNumber: event.turnNumber,
            timestamp: baseTimestamp,
            traceId: event.traceId,
            caller: event.caller,
            stream: event.stream,
            chunk: event.chunk,
            truncated: event.truncated
          })
        } else {
          flushTerminalChunks()
          safeSend(win, 'yolo:terminal', {
            id: makeUiEventId('terminal'),
            turnNumber: event.turnNumber,
            phase: event.phase,
            timestamp: baseTimestamp,
            traceId: event.traceId,
            caller: event.caller,
            command: event.command,
            cwd: event.cwd,
            stream: event.stream,
            chunk: event.chunk ? clipText(event.chunk, TERMINAL_CHUNK_UI_LIMIT) : undefined,
            truncated: event.truncated,
            exitCode: event.exitCode,
            signal: event.signal,
            durationMs: event.durationMs,
            error: event.error
          })
        }

        const turnLabel = formatTurnLabel(event.turnNumber)
        if (event.phase === 'start') {
          safeSend(win, 'yolo:activity', {
            id: makeUiEventId('terminal-start'),
            timestamp: event.timestamp || new Date().toISOString(),
            type: 'terminal_start',
            summary: `${turnLabel} · exec started (${event.caller || 'runtime.io'})`,
            detail: event.command ? `cmd: ${clipText(event.command, ACTIVITY_DETAIL_LIMIT)}` : undefined
          })
          return
        }

        if (event.phase === 'end') {
          safeSend(win, 'yolo:activity', {
            id: makeUiEventId('terminal-end'),
            timestamp: event.timestamp || new Date().toISOString(),
            type: 'terminal_end',
            summary: `${turnLabel} · exec finished (exit ${typeof event.exitCode === 'number' ? event.exitCode : '?'})`,
            detail: typeof event.durationMs === 'number' ? `duration: ${event.durationMs}ms` : undefined
          })
          return
        }

        if (event.phase === 'error') {
          safeSend(win, 'yolo:activity', {
            id: makeUiEventId('terminal-error'),
            timestamp: event.timestamp || new Date().toISOString(),
            type: 'terminal_error',
            summary: `${turnLabel} · exec error`,
            detail: summarizeUnknown(event.error)
          })
        }
      },
      onUsage: (usage, cost) => {
        const promptTokens = usage.promptTokens ?? 0
        const completionTokens = usage.completionTokens ?? 0
        const cachedTokens = usage.cacheReadInputTokens ?? 0
        const totalTokens = usage.totalTokens ?? (promptTokens + completionTokens)
        const totalCost = cost.totalCost ?? 0

        state.usage.promptTokens += promptTokens
        state.usage.completionTokens += completionTokens
        state.usage.cachedTokens += cachedTokens
        state.usage.totalTokens += totalTokens
        state.usage.totalCost += totalCost
        state.usage.callCount += 1

        safeSend(win, 'yolo:usage', {
          promptTokens,
          completionTokens,
          cachedTokens,
          totalTokens,
          totalCost,
          cacheHitRate: promptTokens > 0 ? cachedTokens / promptTokens : 0,
          callCount: 1
        })
      }
    })

    const session = createYoloSession({
      projectPath: state.projectPath,
      goal,
      defaultRuntime,
      agent
    })

    await session.init()

    state.yoloAgent = agent
    state.yoloSession = session
  }

  state.goal = goal
  state.model = model
  state.defaultRuntime = defaultRuntime
  state.runtimeSystemInfo = runtimeSystemInfo
  state.manualPauseForInput = false
  persistWindowState(state)
}

function readTurnFileFromDisk(state: WindowRuntimeState, turnNumber: number, fileName: TurnFileName): { exists: boolean; content: string; relativePath: string } {
  if (!state.projectPath) return { exists: false, content: '', relativePath: '' }
  const turnDir = join(sessionRoot(state.projectPath), 'runs', `turn-${turnNumber.toString().padStart(4, '0')}`)
  const filePath = join(turnDir, fileName)
  if (!existsSync(filePath)) {
    return {
      exists: false,
      content: '',
      relativePath: evidencePath(turnNumber, fileName)
    }
  }

  return {
    exists: true,
    content: readFileSync(filePath, 'utf-8'),
    relativePath: evidencePath(turnNumber, fileName)
  }
}

export function registerWindow(win: BrowserWindow): void {
  const state = getWindowState(win)
  win.on('closed', () => {
    void destroyRuntime(state)
    windowStates.delete(win.id)
  })
}

export async function closeProjectForWindow(win: BrowserWindow): Promise<void> {
  const state = getWindowState(win)
  if (state.loopRunning || state.executingTurn) {
    throw new Error('Cannot close project while a turn is running.')
  }
  await destroyRuntime(state)
  state.projectPath = ''
  state.goal = ''
  state.model = DEFAULT_MODEL
  state.defaultRuntime = DEFAULT_RUNTIME
  state.runtimeSystemInfo = ''
  state.manualPauseForInput = false
  resetUsageSnapshot(state)
  persistWindowState(state)
  safeSend(win, 'project:closed')
}

export function registerIpcHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true

  const handleWindow = <T extends unknown[], R>(
    channel: string,
    handler: (ctx: { win: BrowserWindow; state: WindowRuntimeState }, ...args: T) => Promise<R> | R
  ) => {
    ipcMain.handle(channel, (event, ...args) => handler(getWindowContext(event), ...(args as T)))
  }

  handleWindow('session:current', async ({ state }) => {
    await restoreWindowStateFromDisk(state)
    return buildOverview(state)
  })

  handleWindow('project:pick-folder', async ({ win, state }) => {
    const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (picked.canceled || !picked.filePaths[0]) return null

    await destroyRuntime(state)

    const projectPath = picked.filePaths[0]
    const synced = syncDefaultSkillsToWorkspace(projectPath)

    state.projectPath = projectPath
    state.goal = inferGoalFromProjectMd(projectPath)
    state.model = DEFAULT_MODEL
    state.defaultRuntime = DEFAULT_RUNTIME
    state.runtimeSystemInfo = ''
    state.manualPauseForInput = false
    state.usage = loadUsageSnapshotFromDisk(projectPath)
    persistWindowState(state)

    safeSend(win, 'yolo:event', {
      type: 'project_selected',
      projectPath
    })
    safeSend(win, 'yolo:activity', {
      id: `${Date.now()}-skills-sync`,
      timestamp: new Date().toISOString(),
      type: 'loop_progress',
      summary: `Synced ${synced.copiedSkills} default skills to workspace`,
      detail: `source: ${synced.sourceDir}\ntarget: ${synced.targetDir}`
    })

    return buildOverview(state)
  })

  handleWindow('project:close', async ({ win, state }) => {
    await closeProjectForWindow(win)
    return buildOverview(state)
  })

  handleWindow('yolo:start', async ({ win, state }, payload: StartPayload) => {
    await initializeSession(win, state, payload)
    const overview = await buildOverview(state)

    safeSend(win, 'yolo:event', {
      type: 'session_started',
      goal: overview.goal,
      model: overview.model,
      runtime: overview.defaultRuntime
    })

    if (payload.autoRun && state.yoloSession) {
      void runLoop(win, state, payload.maxTurns ?? DEFAULT_LOOP_TURNS).catch(() => undefined)
    }

    return overview
  })

  handleWindow('yolo:run-turn', async ({ win, state }) => {
    return runSingleTurn(state, win)
  })

  handleWindow('yolo:run-loop', async ({ win, state }, maxTurns?: number) => {
    if (!state.yoloSession) throw new Error('No active v2 session. Call yolo:start first.')
    if (state.executingTurn) throw new Error('A turn is already running.')
    await runLoop(win, state, maxTurns ?? DEFAULT_LOOP_TURNS)
    return buildOverview(state)
  })

  handleWindow('yolo:stop', async ({ win, state }) => {
    state.stopRequested = true
    state.manualPauseForInput = true
    safeSend(win, 'yolo:event', { type: 'pause_requested' })
    safeSend(win, 'yolo:activity', {
      id: `${Date.now()}-pause-request`,
      timestamp: new Date().toISOString(),
      type: 'loop_paused',
      summary: 'Pause requested: will stop before the next turn and wait for input'
    })
    return buildOverview(state)
  })

  handleWindow('yolo:submit-user-input', async ({ win, state }, text: string) => {
    if (!state.yoloSession) throw new Error('No active v2 session. Call yolo:start first.')
    const normalized = text?.trim()
    if (!normalized) throw new Error('User input text is required.')

    const queued = await state.yoloSession.submitUserInput(normalized)
    state.manualPauseForInput = false
    safeSend(win, 'yolo:event', {
      type: 'user_input_submitted',
      submittedAt: queued.submittedAt
    })
    safeSend(win, 'yolo:activity', {
      id: `${Date.now()}-user-input`,
      timestamp: new Date().toISOString(),
      type: 'user_input_submitted',
      summary: 'User input submitted',
      detail: normalized.slice(0, 240)
    })
    return queued
  })

  handleWindow('yolo:get-overview', async ({ state }) => {
    return buildOverview(state)
  })

  handleWindow('yolo:get-project-markdown', async ({ state }) => {
    if (state.yoloSession) {
      return state.yoloSession.getProjectMarkdown()
    }
    return loadCurrentProjectControlFile(state, 'PROJECT.md')
  })

  handleWindow('yolo:get-failures-markdown', async ({ state }) => {
    if (state.yoloSession) {
      return state.yoloSession.getFailuresMarkdown()
    }
    return loadCurrentProjectControlFile(state, 'FAILURES.md')
  })

  handleWindow('yolo:list-turns', async ({ state }) => {
    if (!state.projectPath) return [] as TurnListItem[]
    return listTurnsFromDisk(state.projectPath)
  })

  handleWindow('yolo:read-turn-file', async ({ state }, turnNumber: number, fileName: TurnFileName) => {
    const allowed: TurnFileName[] = ['action.md', 'cmd.txt', 'stdout.txt', 'stderr.txt', 'exit_code.txt', 'patch.diff', 'result.json']
    if (!allowed.includes(fileName)) throw new Error(`Unsupported turn file: ${String(fileName)}`)
    if (!Number.isInteger(turnNumber) || turnNumber <= 0) throw new Error('turnNumber must be a positive integer')
    return readTurnFileFromDisk(state, turnNumber, fileName)
  })

  handleWindow('yolo:list-turn-artifacts', async ({ state }, turnNumber: number) => {
    if (!state.projectPath) return [] as Array<{ name: string; relativePath: string; sizeBytes: number }>
    if (!Number.isInteger(turnNumber) || turnNumber <= 0) throw new Error('turnNumber must be a positive integer')

    const artifactsDir = join(
      sessionRoot(state.projectPath),
      'runs',
      `turn-${turnNumber.toString().padStart(4, '0')}`,
      'artifacts'
    )

    if (!existsSync(artifactsDir)) return []

    const entries = readdirSync(artifactsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const fullPath = join(artifactsDir, entry.name)
        return {
          name: entry.name,
          relativePath: evidencePath(turnNumber, `artifacts/${entry.name}`),
          sizeBytes: statSync(fullPath).size
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))

    return entries
  })

  handleWindow('yolo:read-artifact-file', async ({ state }, turnNumber: number, fileName: string) => {
    if (!state.projectPath) return { exists: false, content: '', relativePath: '' }
    if (!Number.isInteger(turnNumber) || turnNumber <= 0) throw new Error('turnNumber must be a positive integer')
    if (!fileName.trim() || fileName.includes('/') || fileName.includes('..') || fileName.includes('\\')) {
      throw new Error('Invalid artifact file name')
    }

    const artifactsDir = join(
      sessionRoot(state.projectPath),
      'runs',
      `turn-${turnNumber.toString().padStart(4, '0')}`,
      'artifacts'
    )
    const filePath = join(artifactsDir, basename(fileName))

    if (!existsSync(filePath)) {
      return {
        exists: false,
        content: '',
        relativePath: evidencePath(turnNumber, `artifacts/${basename(fileName)}`)
      }
    }

    return {
      exists: true,
      content: readFileSync(filePath, 'utf-8'),
      relativePath: evidencePath(turnNumber, `artifacts/${basename(fileName)}`)
    }
  })
}
