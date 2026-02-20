export const MONO_FONT = "'SF Mono', Monaco, Menlo, 'Fira Code', monospace"

export type RuntimeKind = 'host' | 'docker' | 'venv'
export type TurnFileName = 'action.md' | 'cmd.txt' | 'stdout.txt' | 'stderr.txt' | 'exit_code.txt' | 'patch.diff' | 'result.json'

export interface UsageSnapshot {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  totalCost: number
  callCount: number
}

export interface ProgressReasonCount {
  reason: string
  count: number
}

export interface ProgressHealthSnapshot {
  windowTurns: number
  successRate: number
  orchestrationMode: 'artifact_gravity_v3_paper' | 'unknown'
  northstarGateRate: number
  northstarScoreboardImprovedRate: number
  northstarArtifactChangeRate: number
  northstarVerifySuccessRate: number
  northstarVerifiedGrowthProofRequiredRate: number
  northstarVerifiedGrowthProofPassRate: number
  planDeliverableTouchRate: number
  planFallbackAttributionRate: number
  noDeltaTopReasons: ProgressReasonCount[]
}

export interface UsageEvent {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  totalCost: number
  cacheHitRate: number
  callCount: number
}

export interface TurnListItem {
  turnNumber: number
  status: string
  summary: string
  actionPath: string
  turnDir: string
  partial?: boolean
}

export interface DesktopOverview {
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
  progressHealth: ProgressHealthSnapshot
}

export interface TurnFileContent {
  exists: boolean
  content: string
  relativePath: string
}

export interface TurnArtifactMeta {
  name: string
  relativePath: string
  sizeBytes: number
}

export interface QueuedUserInput {
  id: string
  text: string
  submittedAt: string
}

export interface StartPayload {
  goal: string
  model?: string
  defaultRuntime?: RuntimeKind
  runtimeSystemInfo?: string
  autoRun?: boolean
  maxTurns?: number
}

export interface DesktopApi {
  getCurrentSession: () => Promise<DesktopOverview>
  pickFolder: () => Promise<DesktopOverview | null>
  closeProject: () => Promise<DesktopOverview>

  yoloStart: (payload: StartPayload) => Promise<DesktopOverview>
  yoloRunTurn: () => Promise<any>
  yoloRunLoop: (maxTurns?: number) => Promise<DesktopOverview>
  yoloStop: () => Promise<DesktopOverview>
  yoloSubmitUserInput: (text: string) => Promise<QueuedUserInput>
  yoloGetOverview: () => Promise<DesktopOverview>

  yoloGetProjectMarkdown: () => Promise<string>
  yoloGetFailuresMarkdown: () => Promise<string>
  yoloListTurns: () => Promise<TurnListItem[]>
  yoloReadTurnFile: (turnNumber: number, fileName: TurnFileName) => Promise<TurnFileContent>
  yoloListTurnArtifacts: (turnNumber: number) => Promise<TurnArtifactMeta[]>
  yoloReadArtifactFile: (turnNumber: number, fileName: string) => Promise<TurnFileContent>

  onYoloEvent: (cb: (payload: any) => void) => () => void
  onYoloTurnResult: (cb: (payload: any) => void) => () => void
  onYoloActivity: (cb: (payload: ActivityItem) => void) => () => void
  onYoloTerminal: (cb: (payload: TerminalLiveEvent) => void) => () => void
  onYoloUsage: (cb: (payload: UsageEvent) => void) => () => void
  onProjectClosed: (cb: () => void) => () => void
}

export interface UiEvent {
  id: string
  at: string
  text: string
}

export interface ActivityItem {
  id: string
  timestamp: string
  type: string
  summary: string
  detail?: string
}

export interface TerminalLiveEvent {
  id: string
  turnNumber: number
  phase: 'start' | 'chunk' | 'end' | 'error'
  timestamp: string
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

export const TURN_FILES: TurnFileName[] = ['action.md', 'stdout.txt', 'stderr.txt', 'cmd.txt', 'exit_code.txt', 'result.json', 'patch.diff']
export const DEFAULT_MAX_LOOP_TURNS = 12

export function displayStatus(status: string): string {
  const normalized = status.toLowerCase()
  if (normalized === 'ask_user') return 'paused'
  return normalized
}

export function toneForStatus(status: string): string {
  const normalized = displayStatus(status)
  if (normalized === 'success') return 't-status-success'
  if (normalized === 'failure' || normalized === 'blocked') return 't-status-danger'
  if (normalized === 'paused') return 't-status-warning'
  if (normalized === 'no_delta') return 't-status-warning'
  if (normalized === 'partial') return 't-status-info'
  if (normalized === 'stopped') return 't-status-info'
  return 't-status-neutral'
}

export function nowLabel(): string {
  return new Date().toLocaleTimeString()
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
