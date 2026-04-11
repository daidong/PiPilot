import { contextBridge, ipcRenderer } from 'electron'

export interface UsageEvent {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cost: number
  rawCost?: number
  billableCost?: number
  authMode?: 'api-key' | 'subscription' | 'none'
  billingSource?: 'api-key' | 'subscription' | 'none'
  cacheHitRate: number
}

export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
  hasChildren?: boolean
  modifiedAt: number
}

export interface ElectronAPI {
  // Agent
  sendMessage: (message: string, rawMentions?: string, model?: string, images?: Array<{ base64: string; mimeType: string }>) => Promise<any>
  onStreamChunk: (cb: (chunk: string) => void) => () => void
  onAgentDone: (cb: (result: any) => void) => () => void
  onUsage: (cb: (event: UsageEvent) => void) => () => void
  getAnthropicAuthStatus: () => Promise<any>
  onAnthropicAuthStatus: (cb: (status: any) => void) => () => void
  getOpenAIAuthStatus: () => Promise<{ hasApiKey: boolean }>

  // OpenAI Codex (ChatGPT Subscription) OAuth
  getOpenAICodexStatus: () => Promise<{ isLoggedIn: boolean; isExpired: boolean }>
  openaiCodexLogin: () => Promise<{ success: boolean; error?: string }>
  openaiCodexLogout: () => Promise<{ success: boolean }>

  // API Key Config
  getApiKeyStatus: () => Promise<Record<string, boolean>>
  saveApiKey: (keyName: string, value: string) => Promise<{ success: boolean; error?: string }>

  // Entity commands
  listNotes: () => Promise<any>
  listLiterature: () => Promise<any>
  listData: () => Promise<any>
  search: (query: string) => Promise<any>
  deleteEntity: (id: string) => Promise<any>
  artifactCreate: (input: Record<string, unknown>) => Promise<any>
  artifactUpdate: (id: string, patch: Record<string, unknown>) => Promise<any>
  artifactGet: (id: string) => Promise<any>
  artifactList: (types?: string[]) => Promise<any[]>
  artifactSearch: (query: string, types?: string[]) => Promise<any[]>
  artifactDelete: (id: string) => Promise<any>

  // Agent control
  stopAgent: () => Promise<void>
  clearSessionMemory: () => Promise<void>
  getRealtimeSnapshot: () => Promise<{
    streamingText: string
    isStreaming: boolean
    progressItems: any[]
    activityEvents: any[]
  }>

  // Context debug and session summary
  turnExplainGet: () => Promise<any>
  sessionSummaryGet: () => Promise<any>

  // Mentions
  getCandidates: (partial: string, type?: string) => Promise<any>

  // Todo progress
  onTodoUpdate: (cb: (item: any) => void) => () => void
  onTodoClear: (cb: () => void) => () => void
  onActivityClear: (cb: () => void) => () => void

  // Activity feed
  onActivity: (cb: (event: any) => void) => () => void

  // Tool execution progress (real-time updates during tool execution)
  onToolProgress: (cb: (event: { tool: string; toolCallId: string; phase: string; data: any; timestamp: number }) => void) => () => void

  // Skill activation tracking
  onSkillLoaded: (cb: (skillName: string) => void) => () => void

  // Entity creation notifications
  onEntityCreated: (cb: (info: { type: string; id: string; title: string }) => void) => () => void

  // Compute (gated behind ENABLE_LOCAL_COMPUTE=1)
  isComputeEnabled: () => boolean
  probeComputeEnvironment: () => Promise<any>
  onComputeRunUpdate: (cb: (event: any) => void) => () => void
  onComputeRunComplete: (cb: (event: any) => void) => () => void
  onComputeEnvironment: (cb: (event: any) => void) => () => void

  // File tracking
  onFileCreated: (cb: (path: string) => void) => () => void
  readFile: (path: string) => Promise<{ success: boolean; content?: string; error?: string }>
  writeFile: (path: string, content: string) => Promise<{ success: boolean; path?: string; error?: string }>
  readFileBinary: (path: string) => Promise<{ success: boolean; base64?: string; mime?: string; error?: string }>
  resolvePath: (path: string) => Promise<{ success: boolean; absPath?: string; error?: string }>
  openFile: (path: string) => Promise<{ success: boolean; error?: string }>
  listRootFiles: () => Promise<{ path: string; name: string }[]>
  listTree: (options?: { relativePath?: string; showIgnored?: boolean; limit?: number }) => Promise<FileTreeNode[]>
  searchTree: (query: string, options?: { showIgnored?: boolean; maxResults?: number }) => Promise<FileTreeNode[]>
  createArtifactFromFile: (filePath: string) => Promise<any>
  createFile: (relativePath: string) => Promise<{ success: boolean; absPath?: string; error?: string }>
  createDir: (relativePath: string) => Promise<{ success: boolean; absPath?: string; error?: string }>
  renameFile: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>

  // Workspace file operations
  trashFile: (filePath: string) => Promise<{ success: boolean; error?: string }>
  dropToDir: (fileName: string, base64Content: string, targetDirRelPath: string) => Promise<{ success: boolean; path?: string; error?: string }>

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

  // Usage totals (framework persistence)
  getUsageTotals: () => Promise<any>
  resetUsageTotals: () => Promise<any>

  // Preferences
  loadPreferences: () => Promise<{ selectedModel?: string; reasoningEffort?: string; theme?: string } | null>
  savePreferences: (prefs: { selectedModel?: string; reasoningEffort?: string; theme?: string }) => Promise<void>

  // Unified settings
  hasLlmAuth: () => Promise<boolean>
  loadSettings: () => Promise<any>
  saveSettings: (settings: any) => Promise<{ success: boolean }>

  // Wiki agent
  wikiGetStatus: () => Promise<any>
  wikiGetStats: () => Promise<any>
  wikiGetLog: () => Promise<string[]>
  onWikiStatus: (cb: (status: any) => void) => () => void

  // Folder operations
  openFolderWith: (app: 'finder' | 'zed' | 'cursor' | 'vscode') => Promise<{ success: boolean; error?: string }>

  // Terminal
  terminalSpawn: (cwd: string) => Promise<{ success: boolean; pid?: number; error?: string }>
  terminalInput: (data: string) => void
  terminalResize: (cols: number, rows: number) => void
  terminalKill: () => Promise<void>
  onTerminalData: (cb: (data: string) => void) => () => void
  onTerminalExit: (cb: (exitCode: number) => void) => () => void

  // Skills
  listSkills: () => Promise<Array<{ name: string; description: string; source: string; enabled: boolean }>>
  setEnabledSkills: (enabledSkills: string[]) => Promise<{ success: boolean; error?: string }>
  uploadSkill: (fileName: string, base64Data: string) => Promise<{ success: boolean; skillName?: string; error?: string }>

  // File conversion
  convertFileToText: (fileName: string, base64Data: string) => Promise<{ success: boolean; content?: string; error?: string }>

  // Chat export
  exportChat: () => Promise<{ success: boolean; path?: string; error?: string }>
  onExportChat: (cb: () => void) => () => void

  // Version check
  checkForUpdate: () => Promise<{ latest: string; current: string; hasUpdate: boolean }>

  // Session history
  saveMessage: (sessionId: string, msg: any) => Promise<void>
  loadMessages: (sessionId: string, offset: number, limit: number) => Promise<any[]>
  getMessageCount: (sessionId: string) => Promise<number>
  markMessageSaved: (sessionId: string, messageId: string) => Promise<void>
  loadSavedMessageIds: (sessionId: string) => Promise<string[]>
}

const api: ElectronAPI = {
  sendMessage: (message, rawMentions, model, images) =>
    ipcRenderer.invoke('agent:send', message, rawMentions, model, images),
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
  getAnthropicAuthStatus: () => ipcRenderer.invoke('auth:get-anthropic-status'),
  onAnthropicAuthStatus: (cb) => {
    const handler = (_: any, status: any) => cb(status)
    ipcRenderer.on('auth:anthropic-status', handler)
    return () => ipcRenderer.removeListener('auth:anthropic-status', handler)
  },
  getOpenAIAuthStatus: () => ipcRenderer.invoke('auth:get-openai-status'),

  // OpenAI Codex (ChatGPT Subscription) OAuth
  getOpenAICodexStatus: () => ipcRenderer.invoke('auth:get-openai-codex-status'),
  openaiCodexLogin: () => ipcRenderer.invoke('auth:openai-codex-login'),
  openaiCodexLogout: () => ipcRenderer.invoke('auth:openai-codex-logout'),

  getApiKeyStatus: () => ipcRenderer.invoke('config:get-api-key-status'),
  saveApiKey: (keyName, value) => ipcRenderer.invoke('config:save-api-key', keyName, value),

  listNotes: () => ipcRenderer.invoke('cmd:list-notes'),
  listLiterature: () => ipcRenderer.invoke('cmd:list-literature'),
  listData: () => ipcRenderer.invoke('cmd:list-data'),
  search: (query) => ipcRenderer.invoke('cmd:search', query),
  deleteEntity: (id) => ipcRenderer.invoke('cmd:delete', id),
  artifactCreate: (input) => ipcRenderer.invoke('cmd:artifact-create', input),
  artifactUpdate: (id, patch) => ipcRenderer.invoke('cmd:artifact-update', id, patch),
  artifactGet: (id) => ipcRenderer.invoke('cmd:artifact-get', id),
  artifactList: (types) => ipcRenderer.invoke('cmd:artifact-list', types),
  artifactSearch: (query, types) => ipcRenderer.invoke('cmd:artifact-search', query, types),
  artifactDelete: (id) => ipcRenderer.invoke('cmd:artifact-delete', id),

  stopAgent: () => ipcRenderer.invoke('agent:stop'),
  clearSessionMemory: () => ipcRenderer.invoke('agent:clear-memory'),
  getRealtimeSnapshot: () => ipcRenderer.invoke('agent:get-realtime-snapshot'),

  turnExplainGet: () => ipcRenderer.invoke('cmd:turn-explain-get'),
  sessionSummaryGet: () => ipcRenderer.invoke('cmd:session-summary-get'),

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
  onActivityClear: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('agent:activity-clear', handler)
    return () => ipcRenderer.removeListener('agent:activity-clear', handler)
  },

  onActivity: (cb) => {
    const handler = (_: any, event: any) => cb(event)
    ipcRenderer.on('agent:activity', handler)
    return () => ipcRenderer.removeListener('agent:activity', handler)
  },

  onToolProgress: (cb) => {
    const handler = (_: any, event: any) => cb(event)
    ipcRenderer.on('agent:tool-progress', handler)
    return () => ipcRenderer.removeListener('agent:tool-progress', handler)
  },

  onSkillLoaded: (cb) => {
    const handler = (_: any, skillName: string) => cb(skillName)
    ipcRenderer.on('agent:skill-loaded', handler)
    return () => ipcRenderer.removeListener('agent:skill-loaded', handler)
  },

  isComputeEnabled: () => process.env.ENABLE_LOCAL_COMPUTE === '1',

  probeComputeEnvironment: () => ipcRenderer.invoke('compute:probe-environment'),

  onComputeRunUpdate: (cb) => {
    const handler = (_: any, event: any) => cb(event)
    ipcRenderer.on('compute:run-update', handler)
    return () => ipcRenderer.removeListener('compute:run-update', handler)
  },

  onComputeRunComplete: (cb) => {
    const handler = (_: any, event: any) => cb(event)
    ipcRenderer.on('compute:run-complete', handler)
    return () => ipcRenderer.removeListener('compute:run-complete', handler)
  },

  onComputeEnvironment: (cb) => {
    const handler = (_: any, event: any) => cb(event)
    ipcRenderer.on('compute:environment', handler)
    return () => ipcRenderer.removeListener('compute:environment', handler)
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
  writeFile: (path, content) => ipcRenderer.invoke('file:write', path, content),
  readFileBinary: (path) => ipcRenderer.invoke('file:read-binary', path),
  resolvePath: (path) => ipcRenderer.invoke('file:resolve-path', path),
  openFile: (path) => ipcRenderer.invoke('file:open-external', path),
  listRootFiles: () => ipcRenderer.invoke('file:list-root'),
  listTree: (options) => ipcRenderer.invoke('file:list-tree', options),
  searchTree: (query, options) => ipcRenderer.invoke('file:search-tree', query, options),
  createArtifactFromFile: (filePath) => ipcRenderer.invoke('file:create-artifact', filePath),
  createFile: (relativePath) => ipcRenderer.invoke('file:create', relativePath),
  createDir: (relativePath) => ipcRenderer.invoke('file:create-dir', relativePath),
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('file:rename', oldPath, newPath),

  trashFile: (filePath) => ipcRenderer.invoke('file:trash', filePath),
  dropToDir: (fileName, base64Content, targetDirRelPath) => ipcRenderer.invoke('file:drop-to-dir', fileName, base64Content, targetDirRelPath),

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

  getUsageTotals: () => ipcRenderer.invoke('usage:get-totals'),
  resetUsageTotals: () => ipcRenderer.invoke('usage:reset-totals'),

  loadPreferences: () => ipcRenderer.invoke('prefs:load'),
  savePreferences: (prefs) => ipcRenderer.invoke('prefs:save', prefs),

  // Unified settings
  hasLlmAuth: () => ipcRenderer.invoke('config:has-llm-auth'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  // Wiki agent
  wikiGetStatus: () => ipcRenderer.invoke('wiki:get-status'),
  wikiGetStats: () => ipcRenderer.invoke('wiki:get-stats'),
  wikiGetLog: () => ipcRenderer.invoke('wiki:get-log'),
  onWikiStatus: (cb) => {
    const handler = (_: any, status: any) => cb(status)
    ipcRenderer.on('wiki:status', handler)
    return () => ipcRenderer.removeListener('wiki:status', handler)
  },

  openFolderWith: (app) => ipcRenderer.invoke('folder:open-with', app),

  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list'),
  setEnabledSkills: (enabledSkills) => ipcRenderer.invoke('skills:set-enabled', enabledSkills),
  uploadSkill: (fileName, base64Data) => ipcRenderer.invoke('skills:upload', fileName, base64Data),

  convertFileToText: (fileName, base64Data) => ipcRenderer.invoke('file:convert-to-text', fileName, base64Data),

  checkForUpdate: () => ipcRenderer.invoke('app:check-update'),

  exportChat: () => ipcRenderer.invoke('chat:export'),
  onExportChat: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('menu:export-chat', handler)
    return () => ipcRenderer.removeListener('menu:export-chat', handler)
  },

  saveMessage: (sessionId, msg) => ipcRenderer.invoke('session:save-message', sessionId, msg),
  loadMessages: (sessionId, offset, limit) => ipcRenderer.invoke('session:load-messages', sessionId, offset, limit),
  getMessageCount: (sessionId) => ipcRenderer.invoke('session:get-total-count', sessionId),
  markMessageSaved: (sessionId, messageId) => ipcRenderer.invoke('session:mark-saved', sessionId, messageId),
  loadSavedMessageIds: (sessionId) => ipcRenderer.invoke('session:load-saved-ids', sessionId),

  // Terminal
  terminalSpawn: (cwd) => ipcRenderer.invoke('terminal:spawn', cwd),
  terminalInput: (data) => ipcRenderer.send('terminal:input', data),
  terminalResize: (cols, rows) => ipcRenderer.send('terminal:resize', cols, rows),
  terminalKill: () => ipcRenderer.invoke('terminal:kill'),
  onTerminalData: (cb) => {
    const handler = (_: any, data: string) => cb(data)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },
  onTerminalExit: (cb) => {
    const handler = (_: any, exitCode: number) => cb(exitCode)
    ipcRenderer.on('terminal:exit', handler)
    return () => ipcRenderer.removeListener('terminal:exit', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
