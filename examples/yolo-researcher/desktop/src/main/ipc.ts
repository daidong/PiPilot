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
  autoRun?: boolean
  maxTurns?: number
}

interface TurnListItem {
  turnNumber: number
  status: string
  summary: string
  actionPath: string
  turnDir: string
}

interface DesktopOverview {
  projectPath: string
  goal: string
  model: string
  defaultRuntime: RuntimeKind
  loopRunning: boolean
  hasSession: boolean
  turnCount: number
  lastTurn: TurnListItem | null
}

interface DesktopStateFile {
  lastProjectPath?: string
  lastGoal?: string
  lastModel?: string
  lastRuntime?: RuntimeKind
}

interface WindowRuntimeState {
  projectPath: string
  goal: string
  model: string
  defaultRuntime: RuntimeKind
  yoloSession: ReturnType<typeof createYoloSession> | null
  yoloAgent: { destroy?: () => Promise<void> } | null
  loopRunning: boolean
  stopRequested: boolean
  executingTurn: boolean
}

const DEFAULT_MODEL = 'gpt-5.2'
const DEFAULT_RUNTIME: RuntimeKind = 'host'
const DEFAULT_LOOP_TURNS = 12
const MAX_LOOP_TURNS = 200
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
    yoloSession: null,
    yoloAgent: null,
    loopRunning: false,
    stopRequested: false,
    executingTurn: false
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

function readFirstNonEmptyLine(raw: string, prefix: string): string {
  const line = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
  return line ? line.slice(prefix.length).trim() : ''
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
    const actionPath = join(runsDir, turnDirName, 'action.md')
    let status = 'unknown'
    let summary = 'No summary.'

    if (existsSync(actionPath)) {
      try {
        const raw = readFileSync(actionPath, 'utf-8')
        status = readFirstNonEmptyLine(raw, '- Status:') || 'unknown'
        summary = readFirstNonEmptyLine(raw, '- Key observation:') || 'No summary.'
      } catch {
        status = 'unknown'
      }
    }

    turns.push({
      turnNumber,
      status,
      summary,
      actionPath: evidencePath(turnNumber, 'action.md'),
      turnDir: evidenceTurnDirPath(turnNumber)
    })
  }

  return turns
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
  state.executingTurn = false
  if (state.yoloAgent?.destroy) {
    await state.yoloAgent.destroy().catch(() => undefined)
  }
  state.yoloAgent = null
  state.yoloSession = null
}

async function buildOverview(state: WindowRuntimeState): Promise<DesktopOverview> {
  const turns = state.projectPath
    ? listTurnsFromDisk(state.projectPath)
    : []

  return {
    projectPath: state.projectPath,
    goal: state.goal,
    model: state.model,
    defaultRuntime: state.defaultRuntime,
    loopRunning: state.loopRunning,
    hasSession: state.yoloSession !== null,
    turnCount: turns.length,
    lastTurn: turns.length > 0 ? turns[turns.length - 1] ?? null : null
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
      summary: `Turn ${result.turnNumber} -> ${result.status}`,
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
        safeSend(win, 'yolo:event', { type: 'loop_stopped', reason: 'stop_requested' })
        safeSend(win, 'yolo:activity', {
          id: `${Date.now()}-stop`,
          timestamp: new Date().toISOString(),
          type: 'loop_stopped',
          summary: 'Loop stopped by user request'
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
    lastRuntime: state.defaultRuntime
  })
}

async function initializeSession(state: WindowRuntimeState, payload: StartPayload): Promise<void> {
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

  const needsFreshSession = (
    !state.yoloSession
    || state.goal !== goal
    || state.model !== model
    || state.defaultRuntime !== defaultRuntime
  )

  if (needsFreshSession) {
    await destroyRuntime(state)

    const agent = createLlmSingleAgent({
      projectPath: state.projectPath,
      model,
      apiKey: resolveApiKey(),
      enableNetwork: true,
      capabilityProfile: 'full',
      autoApprove: true,
      communitySkillsDir
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
    await initializeSession(state, payload)
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
    safeSend(win, 'yolo:event', { type: 'stop_requested' })
    return buildOverview(state)
  })

  handleWindow('yolo:submit-user-input', async ({ win, state }, text: string) => {
    if (!state.yoloSession) throw new Error('No active v2 session. Call yolo:start first.')
    const normalized = text?.trim()
    if (!normalized) throw new Error('User input text is required.')

    const queued = await state.yoloSession.submitUserInput(normalized)
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
