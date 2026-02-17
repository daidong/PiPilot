import { contextBridge, ipcRenderer } from 'electron'

export type RuntimeKind = 'host' | 'docker' | 'venv'
export type TurnFileName = 'action.md' | 'cmd.txt' | 'stdout.txt' | 'stderr.txt' | 'exit_code.txt' | 'patch.diff' | 'result.json'

export interface StartPayload {
  goal: string
  projectId?: string
  model?: string
  defaultRuntime?: RuntimeKind
  autoRun?: boolean
  maxTurns?: number
}

export interface TurnListItem {
  turnNumber: number
  status: string
  summary: string
  actionPath: string
  turnDir: string
}

export interface DesktopOverview {
  projectPath: string
  projectId: string
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

export interface ElectronAPI {
  getCurrentSession: () => Promise<DesktopOverview>
  pickFolder: () => Promise<DesktopOverview | null>
  closeProject: () => Promise<DesktopOverview>

  yoloStart: (payload: StartPayload) => Promise<DesktopOverview>
  yoloRunTurn: () => Promise<any>
  yoloRunLoop: (maxTurns?: number) => Promise<DesktopOverview>
  yoloStop: () => Promise<DesktopOverview>
  yoloGetOverview: () => Promise<DesktopOverview>

  yoloGetProjectMarkdown: () => Promise<string>
  yoloGetFailuresMarkdown: () => Promise<string>
  yoloListTurns: () => Promise<TurnListItem[]>
  yoloReadTurnFile: (turnNumber: number, fileName: TurnFileName) => Promise<TurnFileContent>
  yoloListTurnArtifacts: (turnNumber: number) => Promise<TurnArtifactMeta[]>
  yoloReadArtifactFile: (turnNumber: number, fileName: string) => Promise<TurnFileContent>

  onYoloEvent: (cb: (payload: any) => void) => () => void
  onYoloTurnResult: (cb: (payload: any) => void) => () => void
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
  onProjectClosed: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('project:closed', handler)
    return () => ipcRenderer.removeListener('project:closed', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
