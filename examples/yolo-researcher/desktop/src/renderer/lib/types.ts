export const MONO_FONT = "'SF Mono', Monaco, Menlo, 'Fira Code', monospace"

export type RuntimeKind = 'host' | 'docker' | 'venv'
export type TurnFileName = 'action.md' | 'cmd.txt' | 'stdout.txt' | 'stderr.txt' | 'exit_code.txt' | 'patch.diff' | 'result.json'

export interface TurnListItem {
  turnNumber: number
  status: string
  summary: string
  actionPath: string
  turnDir: string
}

export interface DesktopOverview {
  projectPath: string
  goal: string
  model: string
  defaultRuntime: RuntimeKind
  loopRunning: boolean
  hasSession: boolean
  turnCount: number
  lastTurn: TurnListItem | null
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

export interface TerminalChunk {
  turnNumber: number
  stream: 'stdout' | 'stderr'
  text: string
  timestamp: string
}

export const TURN_FILES: TurnFileName[] = ['action.md', 'stdout.txt', 'stderr.txt', 'cmd.txt', 'exit_code.txt', 'result.json', 'patch.diff']
export const DEFAULT_MAX_LOOP_TURNS = 12

export function toneForStatus(status: string): string {
  const normalized = status.toLowerCase()
  if (normalized === 'success') return 'border-emerald-400/50 bg-emerald-500/10 text-emerald-200'
  if (normalized === 'failure' || normalized === 'blocked') return 'border-rose-400/50 bg-rose-500/10 text-rose-200'
  if (normalized === 'ask_user') return 'border-amber-400/50 bg-amber-500/10 text-amber-200'
  if (normalized === 'stopped') return 'border-sky-400/50 bg-sky-500/10 text-sky-200'
  return 'border-zinc-500/50 bg-zinc-500/10 text-zinc-200'
}

export function nowLabel(): string {
  return new Date().toLocaleTimeString()
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
