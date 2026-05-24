import { contextBridge, ipcRenderer } from 'electron'
import type { BibImportResult, BibImportProgressEvent } from '../../../lib/importers/bibtex'
import type {
  GenerateReportResult,
  ReportProgressEvent,
} from '../../../lib/reports/index'
import type { ReportPersistedState } from '../../../lib/reports/state'
import type {
  SharingPreflight,
  SharingStatus,
  ShareOptions,
  ShareResult,
  SyncResult,
  PollResult,
  MemberOpResult,
  AcceptInviteResult,
  RepoInvitation,
  ConflictFile,
  ConflictResolution,
} from '../../../lib/sharing/index'

// Re-export the bibtex importer types so renderer code can import them
// from the preload module rather than reaching into lib directly. Keeps
// the renderer's import graph stable across PR-3 / PR-4 churn.
export type { BibImportResult, BibImportProgressEvent }
export type { GenerateReportResult, ReportProgressEvent, ReportPersistedState }
// RFC-013 sharing types — surfaced for the renderer's sharing store / UI.
export type {
  SharingPreflight,
  SharingStatus,
  ShareOptions,
  ShareResult,
  SyncResult,
  PollResult,
  MemberOpResult,
  RepoInvitation,
  ConflictFile,
  ConflictResolution,
}

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

/** Auto-recap payload mirrored from lib/types.ts RecapRecord. */
export interface RecapPayload {
  sessionId: string
  did: string
  next: string
  createdAt: string
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
  /** Auto-recap pushed from the background "while away" generation (see generateRecap). */
  onRecap: (cb: (recap: RecapPayload) => void) => () => void
  /** Latest persisted recap for the current session, or null. Read on project open. */
  getLatestRecap: () => Promise<RecapPayload | null>
  /** Request a background recap (renderer calls this when the user goes away). */
  generateRecap: () => Promise<{ ok: boolean }>
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

  // Transient LLM-failure retry notice (e.g. 529 overloaded)
  onRetryNotice: (cb: (event: { attempt: number; nextDelayMs: number; error: string; timestamp: number }) => void) => () => void

  // Entity creation notifications
  onEntityCreated: (cb: (info: { type: string; id: string; title: string }) => void) => () => void

  // Compute (RFC-008 §7.6)
  hydrateCompute: () => Promise<{ runs: any[]; pendingPlans: any[] }>
  approveComputePlan: (backend: string, planId: string) => Promise<{ success: boolean; error?: string }>
  rejectComputePlan: (backend: string, planId: string, comments: string) => Promise<{ success: boolean; error?: string }>
  stopComputeRun: (runId: string) => Promise<{ success: boolean; error?: string }>
  refreshComputeAvailability: () => Promise<{ success: boolean; error?: string }>
  /** RFC-009 §3.3: AWS connection probe. STS + S3 + EC2 capability check. */
  testAwsConnection: () => Promise<{
    success: boolean
    error?: string
    source?: 'settings' | 'env' | 'profile' | 'instance-metadata'
    stsValid?: boolean
    stsError?: string
    accountId?: string
    arn?: string
    s3?: { ok: boolean; error?: string }
    ec2?: { ok: boolean; error?: string }
  }>
  onComputeEvent: (cb: (event: any) => void) => () => void

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

  // BibTeX import (RFC-006 PR-3)
  //
  // Two entry points:
  //   importBibtexFile(path)    — main reads from disk by absolute path
  //   importBibtexString(text)  — renderer already has the contents
  //                                (e.g. drag-and-drop or browser file API)
  //
  // pickBibtexFile() opens a native picker filtered to .bib/.bibtex.
  // onImportProgress() subscribes to per-entry progress events; the cb
  // is invoked once per entry parsed (added / merged / merged-no-change
  // / duplicate-in-file / failed). Returns an unsubscribe function.
  importBibtexFile: (bibPath: string) => Promise<
    | { success: true; result: BibImportResult }
    | { success: false; error: string }
  >
  importBibtexString: (contents: string) => Promise<
    | { success: true; result: BibImportResult }
    | { success: false; error: string }
  >
  pickBibtexFile: () => Promise<string | null>
  onImportProgress: (cb: (event: BibImportProgressEvent) => void) => () => void

  // Paper Pack Report (RFC-007 PR-B). The button state machine in
  // report-store reads from these three entry points + the progress
  // event stream.
  generatePaperReport: (opts?: { force?: boolean }) => Promise<GenerateReportResult>
  getPaperReportState: () => Promise<ReportPersistedState | null>
  openPaperReport: () => Promise<{ success: boolean; error?: string }>
  onPaperReportProgress: (cb: (event: ReportProgressEvent) => void) => () => void

  // Session/Project
  getCurrentSession: () => Promise<{ sessionId: string; projectPath: string }>
  pickFolder: () => Promise<{ projectPath: string; sessionId: string } | null>
  openProjectPath: (projectPath: string) => Promise<{ projectPath: string; sessionId: string } | null>
  listRecentProjects: () => Promise<Array<{ path: string; openedAt: string; pinned?: boolean }>>
  removeRecentProject: (projectPath: string) => Promise<{ success: boolean }>
  projectStatsBatch: (paths: string[]) => Promise<Record<string, { papers: number; notes: number; data: number; initialized: boolean; shared: boolean }>>

  // RFC-013 Shared Workspaces
  sharingPreflight: () => Promise<SharingPreflight>
  sharingStatus: () => Promise<SharingStatus>
  sharingShare: (opts: ShareOptions) => Promise<ShareResult>
  sharingSync: () => Promise<SyncResult>
  sharingPoll: () => Promise<PollResult>
  sharingInvite: (login: string) => Promise<MemberOpResult>
  sharingRemoveMember: (login: string) => Promise<MemberOpResult>
  sharingPromoteMember: (login: string) => Promise<MemberOpResult>
  sharingPickDestFolder: () => Promise<string | null>
  sharingListInvitations: () => Promise<RepoInvitation[]>
  sharingAcceptInvite: (opts: { repo: string; destFolder: string; displayName: string; invitationId?: number }) => Promise<AcceptInviteResult>
  sharingConflictDetails: () => Promise<ConflictFile[]>
  sharingAiMerge: (file: ConflictFile) => Promise<{ ok: boolean; content?: string; error?: string }>
  sharingResolveConflict: (resolutions: ConflictResolution[]) => Promise<SyncResult>
  sharingSnapshot: (label?: string) => Promise<{ ok: boolean; tag?: string; error?: string }>
  // Audit graph — provenance projection from telemetry. Read-only; returns
  // presence info so the renderer can decide whether to show the empty state.
  auditGetGraph: () => Promise<{
    presence: { present: boolean; reason?: 'no-root' | 'no-traces-dir' | 'no-span-files' | 'no-spans'; spanFileCount: number }
    graph: import('../../../lib/audit-graph/index').AuditGraph | null
  }>
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
  setTheme: (theme: 'light' | 'dark' | 'high-contrast' | 'system') => Promise<void>
  onThemeChanged: (cb: (theme: 'light' | 'dark' | 'high-contrast' | 'system') => void) => () => void

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

/**
 * IPC helpers — collapse the repetitive ipcRenderer.invoke / on+removeListener
 * boilerplate so adding a channel can't accidentally leak a listener or drop
 * the unsubscribe. `invoke` is a typed request/response passthrough;
 * `subscribe` wires an event listener and returns its disposer; `send` is a
 * fire-and-forget passthrough.
 */
function invoke<T = any>(channel: string, ...args: any[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args)
}

function subscribe<T = any>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler as (...args: unknown[]) => void)
  return () => ipcRenderer.removeListener(channel, handler as (...args: unknown[]) => void)
}

function send(channel: string, ...args: any[]): void {
  ipcRenderer.send(channel, ...args)
}

const api: ElectronAPI = {
  sendMessage: (message, rawMentions, model, images, envelope) =>
    invoke('agent:send', message, rawMentions, model, images, envelope),
  onStreamChunk: (cb) => subscribe('agent:stream-chunk', cb),
  onAgentDone: (cb) => subscribe('agent:done', cb),
  onUsage: (cb) => subscribe('agent:usage', cb),
  onRecap: (cb) => subscribe('recap:update', cb),
  getLatestRecap: () => invoke('recap:get-latest'),
  generateRecap: () => invoke('recap:generate'),
  getAnthropicAuthStatus: () => invoke('auth:get-anthropic-status'),
  onAnthropicAuthStatus: (cb) => subscribe('auth:anthropic-status', cb),
  getOpenAIAuthStatus: () => invoke('auth:get-openai-status'),

  // OpenAI Codex (ChatGPT Subscription) OAuth
  getOpenAICodexStatus: () => invoke('auth:get-openai-codex-status'),
  openaiCodexLogin: () => invoke('auth:openai-codex-login'),
  openaiCodexCancel: () => invoke('auth:openai-codex-cancel'),
  openaiCodexLogout: () => invoke('auth:openai-codex-logout'),

  // Anthropic Subscription (Claude Pro/Max) OAuth — enabled by default
  isClaudeSubEnabled: () => true,
  getAnthropicSubStatus: () => invoke('auth:get-anthropic-sub-status'),
  anthropicSubLogin: () => invoke('auth:anthropic-sub-login'),
  anthropicSubCancel: () => invoke('auth:anthropic-sub-cancel'),
  anthropicSubLogout: () => invoke('auth:anthropic-sub-logout'),

  pickPreferredModel: () => invoke('config:pick-preferred-model'),

  getApiKeyStatus: () => invoke('config:get-api-key-status'),
  saveApiKey: (keyName, value) => invoke('config:save-api-key', keyName, value),

  listNotes: () => invoke('cmd:list-notes'),
  listLiterature: () => invoke('cmd:list-literature'),
  listData: () => invoke('cmd:list-data'),
  search: (query) => invoke('cmd:search', query),
  deleteEntity: (id) => invoke('cmd:delete', id),
  artifactCreate: (input) => invoke('cmd:artifact-create', input),
  artifactUpdate: (id, patch) => invoke('cmd:artifact-update', id, patch),
  artifactGet: (id) => invoke('cmd:artifact-get', id),
  artifactList: (types) => invoke('cmd:artifact-list', types),
  artifactSearch: (query, types) => invoke('cmd:artifact-search', query, types),
  artifactDelete: (id) => invoke('cmd:artifact-delete', id),
  memoryList: () => invoke('cmd:memory-list'),
  memoryGet: (filename) => invoke('cmd:memory-get', filename),
  memorySave: (input) => invoke('cmd:memory-save', input),
  memoryDelete: (filename) => invoke('cmd:memory-delete', filename),

  stopAgent: () => invoke('agent:stop'),
  clearSessionMemory: () => invoke('agent:clear-memory'),
  getRealtimeSnapshot: () => invoke('agent:get-realtime-snapshot'),

  turnExplainGet: () => invoke('cmd:turn-explain-get'),
  sessionSummaryGet: () => invoke('cmd:session-summary-get'),

  getCandidates: (partial, type) => invoke('mention:candidates', partial, type),

  onTodoUpdate: (cb) => subscribe('agent:todo-update', cb),
  onTodoClear: (cb) => subscribe('agent:todo-clear', cb),
  onActivityClear: (cb) => subscribe('agent:activity-clear', cb),

  onActivity: (cb) => subscribe('agent:activity', cb),

  onToolProgress: (cb) => subscribe('agent:tool-progress', cb),

  onSkillLoaded: (cb) => subscribe('agent:skill-loaded', cb),

  onRetryNotice: (cb) => subscribe('agent:retry-notice', cb),

  hydrateCompute: () => invoke('compute:hydrate'),
  approveComputePlan: (backend: string, planId: string) =>
    invoke('compute:approve-plan', { backend, planId }),
  rejectComputePlan: (backend: string, planId: string, comments: string) =>
    invoke('compute:reject-plan', { backend, planId, comments }),
  stopComputeRun: (runId: string) =>
    invoke('compute:stop-run', { runId }),
  refreshComputeAvailability: () =>
    invoke('compute:refresh-availability'),
  testAwsConnection: () => invoke('compute:test-aws-connection'),

  onComputeEvent: (cb) => subscribe('compute:event', cb),

  onEntityCreated: (cb) => subscribe('agent:entity-created', cb),

  onExternalChange: (cb) =>
    subscribe<{ parents?: string[] | null } | undefined>('fs:external-change', (payload) => {
      // Older main payloads may be missing — treat as full refresh.
      const parents = payload && 'parents' in payload ? payload.parents ?? null : null
      cb({ parents })
    }),
  onFileCreated: (cb) => subscribe('agent:file-created', cb),
  readFile: (path) => invoke('file:read', path),
  writeFile: (path, content) => invoke('file:write', path, content),
  readFileBinary: (path) => invoke('file:read-binary', path),
  resolvePath: (path) => invoke('file:resolve-path', path),
  openFile: (path) => invoke('file:open-external', path),
  listRootFiles: () => invoke('file:list-root'),
  listTree: (options) => invoke('file:list-tree', options),
  searchTree: (query, options) => invoke('file:search-tree', query, options),
  createArtifactFromFile: (filePath) => invoke('file:create-artifact', filePath),
  createFile: (relativePath) => invoke('file:create', relativePath),
  createDir: (relativePath) => invoke('file:create-dir', relativePath),
  renameFile: (oldPath, newPath) => invoke('file:rename', oldPath, newPath),

  trashFile: (filePath) => invoke('file:trash', filePath),
  revealInFinder: (filePath) => invoke('file:reveal', filePath),
  copyItem: (srcRelPath, destDirRelPath) => invoke('file:copy-item', srcRelPath, destDirRelPath),
  dropToDir: (fileName, base64Content, targetDirRelPath) => invoke('file:drop-to-dir', fileName, base64Content, targetDirRelPath),

  dropFile: (fileName, content, tab) => invoke('file:drop', fileName, content, tab),

  enrichAllPapers: (paperIds) => invoke('cmd:enrich-papers', paperIds),
  onEnrichProgress: (cb) => subscribe('enrich:progress', cb),

  // BibTeX import (RFC-006 PR-3) — see ElectronAPI doc above.
  importBibtexFile: (bibPath) => invoke('cmd:import-bibtex', bibPath),
  importBibtexString: (contents) => invoke('cmd:import-bibtex-string', contents),
  pickBibtexFile: () => invoke('cmd:pick-bibtex-file'),
  onImportProgress: (cb) => subscribe('import:progress', cb),

  // Paper Pack Report (RFC-007 PR-B).
  generatePaperReport: (opts) => invoke('cmd:generate-paper-report', opts),
  getPaperReportState: () => invoke('cmd:get-paper-report-state'),
  openPaperReport: () => invoke('cmd:open-paper-report'),
  onPaperReportProgress: (cb) => subscribe('report:progress', cb),

  getCurrentSession: () => invoke('session:current'),

  // Telemetry view log (§8.4) — renderer pushes passive view events here.
  telemetryViewLog: (
    payload: {
      viewId: string
      target: { kind: 'artifact' | 'memory' | 'trace' | 'session-summary'; id: string }
      op: 'view' | 'hover' | 'scroll' | 'dismiss'
      durationMs?: number
      turnId?: string
    }
  ) => invoke('telemetry:view-log', payload),
  telemetryGetProjectConfig: (force?: boolean) =>
    invoke('telemetry:get-project-config', force),
  telemetrySetTracingMode: (mode: 'enabled' | 'disabled') =>
    invoke('telemetry:set-tracing-mode', mode),
  onTraceLive: (cb) => subscribe('trace:live', cb),
  telemetryTraceSnapshot: (traceId: string) =>
    invoke('telemetry:trace-snapshot', traceId),
  pickFolder: () => invoke('project:pick-folder'),
  openProjectPath: (projectPath: string) => invoke('project:open-path', projectPath),
  listRecentProjects: () => invoke('project:list-recents'),
  removeRecentProject: (projectPath: string) => invoke('project:remove-recent', projectPath),
  projectStatsBatch: (paths: string[]) => invoke('project:stats-batch', paths),

  // RFC-013 Shared Workspaces
  sharingPreflight: () => invoke('sharing:preflight'),
  sharingStatus: () => invoke('sharing:status'),
  sharingShare: (opts) => invoke('sharing:share', opts),
  sharingSync: () => invoke('sharing:sync'),
  sharingPoll: () => invoke('sharing:poll'),
  sharingInvite: (login) => invoke('sharing:invite', login),
  sharingRemoveMember: (login) => invoke('sharing:remove-member', login),
  sharingPromoteMember: (login) => invoke('sharing:promote-member', login),
  sharingPickDestFolder: () => invoke('sharing:pick-dest-folder'),
  sharingListInvitations: () => invoke('sharing:list-invitations'),
  sharingAcceptInvite: (opts) => invoke('sharing:accept-invite', opts),
  sharingConflictDetails: () => invoke('sharing:conflict-details'),
  sharingAiMerge: (file) => invoke('sharing:ai-merge', file),
  sharingResolveConflict: (resolutions) => invoke('sharing:resolve-conflict', resolutions),
  sharingSnapshot: (label) => invoke('sharing:snapshot', label),
  auditGetGraph: () => invoke('audit:get-graph'),
  closeProject: () => invoke('project:close'),
  onProjectClosed: (cb) => subscribe('project:closed', cb),

  getUsageTotals: () => invoke('usage:get-totals'),
  resetUsageTotals: () => invoke('usage:reset-totals'),

  loadPreferences: () => invoke('prefs:load'),
  savePreferences: (prefs) => invoke('prefs:save', prefs),

  // Unified settings
  hasLlmAuth: () => invoke('config:has-llm-auth'),
  loadSettings: () => invoke('settings:load'),
  saveSettings: (settings) => invoke('settings:save', settings),

  // Wiki agent
  wikiGetStatus: () => invoke('wiki:get-status'),
  wikiGetStats: () => invoke('wiki:get-stats'),
  wikiGetLog: () => invoke('wiki:get-log'),
  wikiPause: () => invoke('wiki:pause'),
  wikiResume: () => invoke('wiki:resume'),
  wikiListPages: () => invoke('wiki:list-pages'),
  wikiReadPage: (slug: string) => invoke('wiki:read-page', slug),
  wikiSlugForPaper: (artifactId: string, projectPath: string) => invoke('wiki:slug-for-paper', artifactId, projectPath),
  wikiPaperSlugMap: () => invoke('wiki:paper-slug-map'),
  wikiListPaperMeta: () => invoke('wiki:list-paper-meta'),
  wikiReconcileIdentity: (opts?: { dryRun?: boolean }) => invoke('wiki:reconcile-identity', opts),
  onWikiStatus: (cb) => subscribe('wiki:status', cb),

  openFolderWith: (app) => invoke('folder:open-with', app),

  // Skills
  listSkills: () => invoke('skills:list'),
  setEnabledSkills: (enabledSkills) => invoke('skills:set-enabled', enabledSkills),
  uploadSkill: (fileName, base64Data) => invoke('skills:upload', fileName, base64Data),

  convertFileToText: (fileName, base64Data) => invoke('file:convert-to-text', fileName, base64Data),

  updateGetState: () => invoke('update:get-state'),
  updateCheckNow: () => invoke('update:check-now'),
  updateQuitAndInstall: () => invoke('update:quit-and-install'),
  onUpdateState: (cb) => subscribe('update:state', cb),

  exportChat: () => invoke('chat:export'),
  onExportChat: (cb) => subscribe('menu:export-chat', cb),

  onOpenSettings: (cb) => subscribe('menu:open-settings', cb),

  setTheme: (theme) => invoke('theme:set', theme),
  onThemeChanged: (cb) => subscribe('theme:changed', cb),

  saveMessage: (sessionId, msg) => invoke('session:save-message', sessionId, msg),
  loadMessages: (sessionId, offset, limit) => invoke('session:load-messages', sessionId, offset, limit),
  getMessageCount: (sessionId) => invoke('session:get-total-count', sessionId),
  markMessageSaved: (sessionId, messageId) => invoke('session:mark-saved', sessionId, messageId),
  loadSavedMessageIds: (sessionId) => invoke('session:load-saved-ids', sessionId),

  // Terminal
  terminalSpawn: (cwd) => invoke('terminal:spawn', cwd),
  terminalInput: (data) => send('terminal:input', data),
  terminalResize: (cols, rows) => send('terminal:resize', cols, rows),
  terminalKill: () => invoke('terminal:kill'),
  onTerminalData: (cb) => subscribe('terminal:data', cb),
  onTerminalExit: (cb) => subscribe('terminal:exit', cb)
}

contextBridge.exposeInMainWorld('api', api)
