import { contextBridge, ipcRenderer } from 'electron'

export interface UsageEvent {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cost: number
  cacheHitRate: number
}

export interface ElectronAPI {
  // Agent
  sendMessage: (message: string, rawMentions?: string, model?: string) => Promise<any>
  onStreamChunk: (cb: (chunk: string) => void) => () => void
  onAgentDone: (cb: (result: any) => void) => () => void
  onUsage: (cb: (event: UsageEvent) => void) => () => void

  // Entity commands
  listNotes: () => Promise<any>
  listLiterature: () => Promise<any>
  listData: () => Promise<any>
  search: (query: string) => Promise<any>
  deleteEntity: (id: string) => Promise<any>
  renameNote: (id: string, newTitle: string) => Promise<any>
  updateEntity: (id: string, updates: { title?: string; content?: string }) => Promise<any>
  saveNote: (title: string, content: string, messageId?: string) => Promise<any>
  savePaper: (argsStr: string) => Promise<any>
  saveData: (argsStr: string) => Promise<any>

  // Agent control
  stopAgent: () => Promise<void>
  clearSessionMemory: () => Promise<void>
  getRealtimeSnapshot: () => Promise<{
    streamingText: string
    isStreaming: boolean
    progressItems: any[]
    activityEvents: any[]
  }>

  // Select/Pin
  toggleSelect: (id: string) => Promise<any>
  getSelected: () => Promise<any>
  clearSelections: () => Promise<any>
  togglePin: (id: string) => Promise<any>
  getPinned: () => Promise<any>

  // Mentions
  getCandidates: (partial: string, type?: string) => Promise<any>

  // Todo progress
  onTodoUpdate: (cb: (item: any) => void) => () => void
  onTodoClear: (cb: () => void) => () => void

  // Activity feed
  onActivity: (cb: (event: any) => void) => () => void

  // Entity creation notifications
  onEntityCreated: (cb: (info: { type: string; id: string; title: string }) => void) => () => void

  // File tracking
  onFileCreated: (cb: (path: string) => void) => () => void
  readFile: (path: string) => Promise<{ success: boolean; content?: string; error?: string }>
  readFileBinary: (path: string) => Promise<{ success: boolean; base64?: string; mime?: string; error?: string }>
  resolvePath: (path: string) => Promise<{ success: boolean; absPath?: string; error?: string }>
  openFile: (path: string) => Promise<{ success: boolean; error?: string }>
  listRootFiles: () => Promise<{ path: string; name: string }[]>

  // File drop
  dropFile: (fileName: string, content: string, tab: string) => Promise<any>

  // Enrichment
  enrichAllPapers: (paperIds?: string[]) => Promise<{ success: boolean; enriched: number; skipped: number; failed: number }>
  onEnrichProgress: (cb: (info: { paperId: string; status: string }) => void) => () => void

  // Session/Project
  getCurrentSession: () => Promise<{ sessionId: string; projectPath: string }>
  pickFolder: () => Promise<{ projectPath: string; sessionId: string } | null>
  closeProject: () => Promise<void>
  onProjectClosed: (cb: () => void) => () => void

  // Preferences
  loadPreferences: () => Promise<{ selectedModel?: string; reasoningEffort?: string; theme?: string } | null>
  savePreferences: (prefs: { selectedModel?: string; reasoningEffort?: string; theme?: string }) => Promise<void>

  // Folder operations
  openFolderWith: (app: 'finder' | 'zed' | 'cursor' | 'vscode') => Promise<{ success: boolean; error?: string }>

  // Session history
  saveMessage: (sessionId: string, msg: any) => Promise<void>
  loadMessages: (sessionId: string, offset: number, limit: number) => Promise<any[]>
  getMessageCount: (sessionId: string) => Promise<number>
  markMessageSaved: (sessionId: string, messageId: string) => Promise<void>
  loadSavedMessageIds: (sessionId: string) => Promise<string[]>
}

const api: ElectronAPI = {
  sendMessage: (message, rawMentions, model) =>
    ipcRenderer.invoke('agent:send', message, rawMentions, model),
  onStreamChunk: (cb) => {
    const handler = (_: any, chunk: string) => cb(chunk)
    ipcRenderer.on('agent:stream-chunk', handler)
    return () => ipcRenderer.removeListener('agent:stream-chunk', handler)
  },
  onAgentDone: (cb) => {
    const handler = (_: any, result: any) => cb(result)
    ipcRenderer.on('agent:done', handler)
    return () => ipcRenderer.removeListener('agent:done', handler)
  },
  onUsage: (cb) => {
    const handler = (_: any, event: UsageEvent) => cb(event)
    ipcRenderer.on('agent:usage', handler)
    return () => ipcRenderer.removeListener('agent:usage', handler)
  },

  listNotes: () => ipcRenderer.invoke('cmd:list-notes'),
  listLiterature: () => ipcRenderer.invoke('cmd:list-literature'),
  listData: () => ipcRenderer.invoke('cmd:list-data'),
  search: (query) => ipcRenderer.invoke('cmd:search', query),
  deleteEntity: (id) => ipcRenderer.invoke('cmd:delete', id),
  renameNote: (id, newTitle) => ipcRenderer.invoke('cmd:rename-note', id, newTitle),
  updateEntity: (id, updates) => ipcRenderer.invoke('cmd:update-entity', id, updates),
  saveNote: (title, content, messageId) => ipcRenderer.invoke('cmd:save-note', title, content, messageId),
  savePaper: (argsStr) => ipcRenderer.invoke('cmd:save-paper', argsStr),
  saveData: (argsStr) => ipcRenderer.invoke('cmd:save-data', argsStr),

  stopAgent: () => ipcRenderer.invoke('agent:stop'),
  clearSessionMemory: () => ipcRenderer.invoke('agent:clear-memory'),
  getRealtimeSnapshot: () => ipcRenderer.invoke('agent:get-realtime-snapshot'),

  toggleSelect: (id) => ipcRenderer.invoke('cmd:select', id),
  getSelected: () => ipcRenderer.invoke('cmd:get-selected'),
  clearSelections: () => ipcRenderer.invoke('cmd:clear-selections'),
  togglePin: (id) => ipcRenderer.invoke('cmd:pin', id),
  getPinned: () => ipcRenderer.invoke('cmd:get-pinned'),

  getCandidates: (partial, type) => ipcRenderer.invoke('mention:candidates', partial, type),

  onTodoUpdate: (cb) => {
    const handler = (_: any, item: any) => cb(item)
    ipcRenderer.on('agent:todo-update', handler)
    return () => ipcRenderer.removeListener('agent:todo-update', handler)
  },
  onTodoClear: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('agent:todo-clear', handler)
    return () => ipcRenderer.removeListener('agent:todo-clear', handler)
  },

  onActivity: (cb) => {
    const handler = (_: any, event: any) => cb(event)
    ipcRenderer.on('agent:activity', handler)
    return () => ipcRenderer.removeListener('agent:activity', handler)
  },

  onEntityCreated: (cb) => {
    const handler = (_: any, info: { type: string; id: string; title: string }) => cb(info)
    ipcRenderer.on('agent:entity-created', handler)
    return () => ipcRenderer.removeListener('agent:entity-created', handler)
  },

  onFileCreated: (cb) => {
    const handler = (_: any, path: string) => cb(path)
    ipcRenderer.on('agent:file-created', handler)
    return () => ipcRenderer.removeListener('agent:file-created', handler)
  },
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  readFileBinary: (path) => ipcRenderer.invoke('file:read-binary', path),
  resolvePath: (path) => ipcRenderer.invoke('file:resolve-path', path),
  openFile: (path) => ipcRenderer.invoke('file:open-external', path),
  listRootFiles: () => ipcRenderer.invoke('file:list-root'),

  dropFile: (fileName, content, tab) => ipcRenderer.invoke('file:drop', fileName, content, tab),

  enrichAllPapers: (paperIds) => ipcRenderer.invoke('cmd:enrich-papers', paperIds),
  onEnrichProgress: (cb) => {
    const handler = (_: any, info: { paperId: string; status: string }) => cb(info)
    ipcRenderer.on('enrich:progress', handler)
    return () => ipcRenderer.removeListener('enrich:progress', handler)
  },

  getCurrentSession: () => ipcRenderer.invoke('session:current'),
  pickFolder: () => ipcRenderer.invoke('project:pick-folder'),
  closeProject: () => ipcRenderer.invoke('project:close'),
  onProjectClosed: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('project:closed', handler)
    return () => ipcRenderer.removeListener('project:closed', handler)
  },

  loadPreferences: () => ipcRenderer.invoke('prefs:load'),
  savePreferences: (prefs) => ipcRenderer.invoke('prefs:save', prefs),

  openFolderWith: (app) => ipcRenderer.invoke('folder:open-with', app),

  saveMessage: (sessionId, msg) => ipcRenderer.invoke('session:save-message', sessionId, msg),
  loadMessages: (sessionId, offset, limit) => ipcRenderer.invoke('session:load-messages', sessionId, offset, limit),
  getMessageCount: (sessionId) => ipcRenderer.invoke('session:get-total-count', sessionId),
  markMessageSaved: (sessionId, messageId) => ipcRenderer.invoke('session:mark-saved', sessionId, messageId),
  loadSavedMessageIds: (sessionId) => ipcRenderer.invoke('session:load-saved-ids', sessionId)
}

contextBridge.exposeInMainWorld('api', api)
