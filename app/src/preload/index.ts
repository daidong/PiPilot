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

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version: string
  current: string
  progress?: number
  error?: string
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
  /**
   * Send a chat message to the agent.
   *
   * `envelope` carries the telemetry-trace IPC envelope (spec §4.1):
   *  - `clientMessageId` becomes the canonical `turnId` propagated through traces
   *    and ledgers. The renderer already mints a UUID per message, so we forward
   *    that same id to keep `turnId` deterministic across renderer/main/ledgers.
   *  - `clientTimestamp` records the ms-since-epoch when the user pressed send.
   *
   * Optional during P0 rollout — main falls back to minting the id if the
   * renderer hasn't been updated yet. P1 will require it.
   */
  sendMessage: (
    message: string,
    rawMentions?: string,
    model?: string,
    images?: Array<{ base64: string; mimeType: string }>,
    envelope?: { clientMessageId: string; clientTimestamp: number }
  ) => Promise<any>

  /** Telemetry: passive view-log push (spec §8.4). */
  telemetryViewLog: (payload: {
    viewId: string
    target: { kind: 'artifact' | 'memory' | 'trace' | 'session-summary'; id: string }
    op: 'view' | 'hover' | 'scroll' | 'dismiss'
    durationMs?: number
    turnId?: string
  }) => Promise<{ success: boolean; reason?: string; error?: string }>

  /** Telemetry: read project-scoped config + storage footprint (§10.2).
   *  `storageFootprintBytes` = persistedBytes (flushed to trace-storage-stats.jsonl)
   *  + inFlightBytes (current UTC day, not yet flushed). The split is exposed so
   *  the UI can label "live" totals when desired. */
  telemetryGetProjectConfig: (force?: boolean) => Promise<
    | {
        projectId: string
        tracingMode: 'enabled' | 'disabled'
        bufferCapacity: number
        storageFootprintBytes: number
        inFlightBytes: number
        persistedBytes: number
      }
    | { error: string }
    | null
  >

  /** Telemetry: toggle tracingMode at runtime. */
  telemetrySetTracingMode: (mode: 'enabled' | 'disabled') => Promise<{ success: boolean; error?: string }>

  /** Telemetry: subscribe to live span events. Returns an unsubscribe fn. */
  onTraceLive: (
    cb: (summary: {
      traceId: string
      spanId: string
      parentSpanId?: string
      name: string
      kind: number
      startTime: string
      endTime: string
      durationMs: number
      statusCode: number
      statusMessage?: string
      attributes: Record<string, string | number | boolean>
      events: Array<{ name: string; timestamp: string }>
    }) => void
  ) => () => void

  /** Telemetry: read all spans for a traceId from disk (remount recovery). */
  telemetryTraceSnapshot: (traceId: string) => Promise<{
    traceId: string
    spans: Array<{
      traceId: string
      spanId: string
      parentSpanId?: string
      name: string
      kind: number
      startTime: string
      endTime: string
      durationMs: number
      statusCode: number
      statusMessage?: string
      attributes: Record<string, string | number | boolean>
      events: Array<{ name: string; timestamp: string }>
    }>
    dropped?: boolean
    dropReason?: string
    error?: string
  }>
  onStreamChunk: (cb: (chunk: string) => void) => () => void
  onAgentDone: (cb: (result: any) => void) => () => void
  onUsage: (cb: (event: UsageEvent) => void) => () => void
  getAnthropicAuthStatus: () => Promise<any>
  onAnthropicAuthStatus: (cb: (status: any) => void) => () => void
  getOpenAIAuthStatus: () => Promise<{ hasApiKey: boolean }>

  // OpenAI Codex (ChatGPT Subscription) OAuth
  getOpenAICodexStatus: () => Promise<{ isLoggedIn: boolean; isExpired: boolean }>
  openaiCodexLogin: () => Promise<{ success: boolean; error?: string }>
  openaiCodexCancel: () => Promise<{ success: boolean; error?: string }>
  openaiCodexLogout: () => Promise<{ success: boolean }>

  // Anthropic Subscription (Claude Pro/Max) OAuth — enabled by default
  isClaudeSubEnabled: () => boolean
  getAnthropicSubStatus: () => Promise<{ isLoggedIn: boolean; isExpired: boolean }>
  anthropicSubLogin: () => Promise<{ success: boolean; error?: string }>
  anthropicSubCancel: () => Promise<{ success: boolean; error?: string }>
  anthropicSubLogout: () => Promise<{ success: boolean }>

  // Preferred-model resolver (picks highest-priority available auth)
  pickPreferredModel: () => Promise<string | null>

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

  // Auto-Memory (.research-pilot/memory/*.md, indexed in agent.md)
  memoryList: () => Promise<Array<{
    frontmatter: { name: string; description: string; type: 'user' | 'feedback' | 'project' | 'reference' }
    content: string
    filename: string
  }>>
  memoryGet: (filename: string) => Promise<{
    frontmatter: { name: string; description: string; type: 'user' | 'feedback' | 'project' | 'reference' }
    content: string
    filename: string
  } | null>
  memorySave: (input: {
    filename?: string
    name: string
    type: 'user' | 'feedback' | 'project' | 'reference'
    description: string
    content: string
  }) => Promise<{ success: boolean; filename?: string; error?: string }>
  memoryDelete: (filename: string) => Promise<{ success: boolean; error?: string }>

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
  /**
   * Auto-refresh hook for the workspace file tree.
   *
   * `parents` is a list of parent-directory relative paths whose contents
   * changed (empty string == project root). It's `null` when the underlying
   * fs.watch event arrived without a filename, in which case the renderer
   * should fall back to refreshing every expanded directory.
   */
  onExternalChange: (cb: (event: { parents: string[] | null }) => void) => () => void
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
  revealInFinder: (filePath: string) => Promise<{ success: boolean; error?: string }>
  copyItem: (srcRelPath: string, destDirRelPath: string) => Promise<{ success: boolean; destPath?: string; error?: string }>
  dropToDir: (fileName: string, base64Content: string, targetDirRelPath: string) => Promise<{ success: boolean; path?: string; error?: string }>

  // File drop
  dropFile: (fileName: string, content: string, tab: string) => Promise<any>

  // Enrichment
  enrichAllPapers: (paperIds?: string[]) => Promise<{ success: boolean; enriched: number; skipped: number; failed: number }>
  onEnrichProgress: (cb: (info: { paperId: string; status: string }) => void) => () => void

  // Session/Project
  getCurrentSession: () => Promise<{ sessionId: string; projectPath: string }>
  pickFolder: () => Promise<{ projectPath: string; sessionId: string } | null>
  openProjectPath: (projectPath: string) => Promise<{ projectPath: string; sessionId: string } | null>
  listRecentProjects: () => Promise<Array<{ path: string; openedAt: string; pinned?: boolean }>>
  removeRecentProject: (projectPath: string) => Promise<{ success: boolean }>
  projectStatsBatch: (paths: string[]) => Promise<Record<string, { papers: number; notes: number; data: number; initialized: boolean }>>
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
  wikiPause: () => Promise<any>
  wikiResume: () => Promise<any>
  wikiListPages: () => Promise<any>
  wikiReadPage: (slug: string) => Promise<any>
  wikiSlugForPaper: (artifactId: string, projectPath: string) => Promise<any>
  wikiPaperSlugMap: () => Promise<any>
  wikiListPaperMeta: () => Promise<any>
  wikiReconcileIdentity: (opts?: { dryRun?: boolean }) => Promise<any>
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

  // Settings (menu-triggered open)
  onOpenSettings: (cb: () => void) => () => void

  // Theme broadcast — set is invoked by the window that toggled; main fans
  // out via 'theme:changed' to every renderer (including the sender) so all
  // open windows re-apply the <html> class in lockstep.
  setTheme: (theme: 'light' | 'dark') => Promise<void>
  onThemeChanged: (cb: (theme: 'light' | 'dark') => void) => () => void

  // Auto-update (electron-updater backed by GitHub Releases)
  updateGetState: () => Promise<UpdateState>
  updateCheckNow: () => Promise<{ ok: boolean; reason?: string }>
  updateQuitAndInstall: () => Promise<{ ok: boolean; reason?: string }>
  onUpdateState: (cb: (state: UpdateState) => void) => () => void

  // Session history
  saveMessage: (sessionId: string, msg: any) => Promise<void>
  loadMessages: (sessionId: string, offset: number, limit: number) => Promise<any[]>
  getMessageCount: (sessionId: string) => Promise<number>
  markMessageSaved: (sessionId: string, messageId: string) => Promise<void>
  loadSavedMessageIds: (sessionId: string) => Promise<string[]>
}

const api: ElectronAPI = {
  sendMessage: (message, rawMentions, model, images, envelope) =>
    ipcRenderer.invoke('agent:send', message, rawMentions, model, images, envelope),
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
  openaiCodexCancel: () => ipcRenderer.invoke('auth:openai-codex-cancel'),
  openaiCodexLogout: () => ipcRenderer.invoke('auth:openai-codex-logout'),

  // Anthropic Subscription (Claude Pro/Max) OAuth — enabled by default
  isClaudeSubEnabled: () => true,
  getAnthropicSubStatus: () => ipcRenderer.invoke('auth:get-anthropic-sub-status'),
  anthropicSubLogin: () => ipcRenderer.invoke('auth:anthropic-sub-login'),
  anthropicSubCancel: () => ipcRenderer.invoke('auth:anthropic-sub-cancel'),
  anthropicSubLogout: () => ipcRenderer.invoke('auth:anthropic-sub-logout'),

  pickPreferredModel: () => ipcRenderer.invoke('config:pick-preferred-model'),

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
  memoryList: () => ipcRenderer.invoke('cmd:memory-list'),
  memoryGet: (filename) => ipcRenderer.invoke('cmd:memory-get', filename),
  memorySave: (input) => ipcRenderer.invoke('cmd:memory-save', input),
  memoryDelete: (filename) => ipcRenderer.invoke('cmd:memory-delete', filename),

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

  onExternalChange: (cb) => {
    const handler = (_: any, payload?: { parents?: string[] | null }) => {
      // Older main payloads may be missing — treat as full refresh.
      const parents = payload && 'parents' in payload ? payload.parents ?? null : null
      cb({ parents })
    }
    ipcRenderer.on('fs:external-change', handler)
    return () => ipcRenderer.removeListener('fs:external-change', handler)
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
  revealInFinder: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
  copyItem: (srcRelPath, destDirRelPath) => ipcRenderer.invoke('file:copy-item', srcRelPath, destDirRelPath),
  dropToDir: (fileName, base64Content, targetDirRelPath) => ipcRenderer.invoke('file:drop-to-dir', fileName, base64Content, targetDirRelPath),

  dropFile: (fileName, content, tab) => ipcRenderer.invoke('file:drop', fileName, content, tab),

  enrichAllPapers: (paperIds) => ipcRenderer.invoke('cmd:enrich-papers', paperIds),
  onEnrichProgress: (cb) => {
    const handler = (_: any, info: { paperId: string; status: string }) => cb(info)
    ipcRenderer.on('enrich:progress', handler)
    return () => ipcRenderer.removeListener('enrich:progress', handler)
  },

  getCurrentSession: () => ipcRenderer.invoke('session:current'),

  // Telemetry view log (§8.4) — renderer pushes passive view events here.
  telemetryViewLog: (
    payload: {
      viewId: string
      target: { kind: 'artifact' | 'memory' | 'trace' | 'session-summary'; id: string }
      op: 'view' | 'hover' | 'scroll' | 'dismiss'
      durationMs?: number
      turnId?: string
    }
  ) => ipcRenderer.invoke('telemetry:view-log', payload),
  telemetryGetProjectConfig: (force?: boolean) =>
    ipcRenderer.invoke('telemetry:get-project-config', force),
  telemetrySetTracingMode: (mode: 'enabled' | 'disabled') =>
    ipcRenderer.invoke('telemetry:set-tracing-mode', mode),
  onTraceLive: (cb) => {
    const handler = (_: unknown, summary: Parameters<typeof cb>[0]) => cb(summary)
    ipcRenderer.on('trace:live', handler as (...args: unknown[]) => void)
    return () => ipcRenderer.removeListener('trace:live', handler as (...args: unknown[]) => void)
  },
  telemetryTraceSnapshot: (traceId: string) =>
    ipcRenderer.invoke('telemetry:trace-snapshot', traceId),
  pickFolder: () => ipcRenderer.invoke('project:pick-folder'),
  openProjectPath: (projectPath: string) => ipcRenderer.invoke('project:open-path', projectPath),
  listRecentProjects: () => ipcRenderer.invoke('project:list-recents'),
  removeRecentProject: (projectPath: string) => ipcRenderer.invoke('project:remove-recent', projectPath),
  projectStatsBatch: (paths: string[]) => ipcRenderer.invoke('project:stats-batch', paths),
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
  wikiPause: () => ipcRenderer.invoke('wiki:pause'),
  wikiResume: () => ipcRenderer.invoke('wiki:resume'),
  wikiListPages: () => ipcRenderer.invoke('wiki:list-pages'),
  wikiReadPage: (slug: string) => ipcRenderer.invoke('wiki:read-page', slug),
  wikiSlugForPaper: (artifactId: string, projectPath: string) => ipcRenderer.invoke('wiki:slug-for-paper', artifactId, projectPath),
  wikiPaperSlugMap: () => ipcRenderer.invoke('wiki:paper-slug-map'),
  wikiListPaperMeta: () => ipcRenderer.invoke('wiki:list-paper-meta'),
  wikiReconcileIdentity: (opts?: { dryRun?: boolean }) => ipcRenderer.invoke('wiki:reconcile-identity', opts),
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

  updateGetState: () => ipcRenderer.invoke('update:get-state'),
  updateCheckNow: () => ipcRenderer.invoke('update:check-now'),
  updateQuitAndInstall: () => ipcRenderer.invoke('update:quit-and-install'),
  onUpdateState: (cb) => {
    const handler = (_: any, state: UpdateState) => cb(state)
    ipcRenderer.on('update:state', handler)
    return () => ipcRenderer.removeListener('update:state', handler)
  },

  exportChat: () => ipcRenderer.invoke('chat:export'),
  onExportChat: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('menu:export-chat', handler)
    return () => ipcRenderer.removeListener('menu:export-chat', handler)
  },

  onOpenSettings: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('menu:open-settings', handler)
    return () => ipcRenderer.removeListener('menu:open-settings', handler)
  },

  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  onThemeChanged: (cb) => {
    const handler = (_: any, theme: 'light' | 'dark') => cb(theme)
    ipcRenderer.on('theme:changed', handler)
    return () => ipcRenderer.removeListener('theme:changed', handler)
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
