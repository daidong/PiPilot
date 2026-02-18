import { contextBridge, ipcRenderer } from 'electron'

export type RuntimeKind = 'host' | 'docker' | 'venv'
export type TurnFileName = 'action.md' | 'cmd.txt' | 'stdout.txt' | 'stderr.txt' | 'exit_code.txt' | 'patch.diff' | 'result.json'

export interface StartPayload {
  goal: string
  model?: string
  defaultRuntime?: RuntimeKind
  runtimeSystemInfo?: string
  autoRun?: boolean
  maxTurns?: number
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
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    cachedTokens: number
    totalCost: number
    callCount: number
  }
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

export interface ElectronAPI {
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
  onYoloActivity: (cb: (payload: any) => void) => () => void
  onYoloTerminal: (cb: (payload: TerminalLiveEvent) => void) => () => void
  onYoloUsage: (cb: (payload: UsageEvent) => void) => () => void
  onProjectClosed: (cb: () => void) => () => void
}

const api: ElectronAPI = {
  getCurrentSession: () => ipcRenderer.invoke('session:current'),
  pickFolder: () => ipcRenderer.invoke('project:pick-folder'),
  closeProject: () => ipcRenderer.invoke('project:close'),

  yoloStart: (payload) => ipcRenderer.invoke('yolo:start', payload),
  yoloRunTurn: () => ipcRenderer.invoke('yolo:run-turn'),
  yoloRunLoop: (maxTurns) => ipcRenderer.invoke('yolo:run-loop', maxTurns),
  yoloStop: () => ipcRenderer.invoke('yolo:stop'),
  yoloSubmitUserInput: (text) => ipcRenderer.invoke('yolo:submit-user-input', text),
  yoloGetOverview: () => ipcRenderer.invoke('yolo:get-overview'),

  yoloGetProjectMarkdown: () => ipcRenderer.invoke('yolo:get-project-markdown'),
  yoloGetFailuresMarkdown: () => ipcRenderer.invoke('yolo:get-failures-markdown'),
  yoloListTurns: () => ipcRenderer.invoke('yolo:list-turns'),
  yoloReadTurnFile: (turnNumber, fileName) => ipcRenderer.invoke('yolo:read-turn-file', turnNumber, fileName),
  yoloListTurnArtifacts: (turnNumber) => ipcRenderer.invoke('yolo:list-turn-artifacts', turnNumber),
  yoloReadArtifactFile: (turnNumber, fileName) => ipcRenderer.invoke('yolo:read-artifact-file', turnNumber, fileName),

  onYoloEvent: (cb) => {
    const handler = (_: unknown, payload: any) => cb(payload)
    ipcRenderer.on('yolo:event', handler)
    return () => ipcRenderer.removeListener('yolo:event', handler)
  },
  onYoloTurnResult: (cb) => {
    const handler = (_: unknown, payload: any) => cb(payload)
    ipcRenderer.on('yolo:turn-result', handler)
    return () => ipcRenderer.removeListener('yolo:turn-result', handler)
  },
  onYoloActivity: (cb) => {
    const handler = (_: unknown, payload: any) => cb(payload)
    ipcRenderer.on('yolo:activity', handler)
    return () => ipcRenderer.removeListener('yolo:activity', handler)
  },
  onYoloTerminal: (cb) => {
    const handler = (_: unknown, payload: TerminalLiveEvent) => cb(payload)
    ipcRenderer.on('yolo:terminal', handler)
    return () => ipcRenderer.removeListener('yolo:terminal', handler)
  },
  onYoloUsage: (cb) => {
    const handler = (_: unknown, payload: UsageEvent) => cb(payload)
    ipcRenderer.on('yolo:usage', handler)
    return () => ipcRenderer.removeListener('yolo:usage', handler)
  },
  onProjectClosed: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('project:closed', handler)
    return () => ipcRenderer.removeListener('project:closed', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
