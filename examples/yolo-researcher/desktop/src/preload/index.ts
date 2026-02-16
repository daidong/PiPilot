import { contextBridge, ipcRenderer } from 'electron'

type Priority = 'urgent' | 'normal'

interface YoloSessionOptions {
  budget: { maxTurns: number; maxTokens: number; maxCostUsd: number; deadlineIso?: string }
  models: { planner: string; coordinator: string; reviewer?: string }
  mode?: 'legacy' | 'lean_v2'
}

interface QueuedUserInput {
  id: string
  text: string
  priority: Priority
  createdAt: string
  source: 'chat' | 'system'
}

interface ExternalWaitTask {
  id: string
  sessionId: string
  status: 'waiting' | 'satisfied' | 'canceled' | 'expired' | 'open' | 'resolved' | 'cancelled'
  stage?: 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
  branchId?: string
  nodeId?: string
  title: string
  reason?: string
  requiredArtifacts?: Array<{ kind: string; pathHint?: string; description: string }>
  completionRule: string
  resumeAction: string
  uploadDir?: string
  details?: string
  experimentRequestId?: string
  createdAt: string
  resolvedAt?: string
  resolutionNote?: string
}

interface AddedIngressFile {
  sourcePath: string
  storedPath: string
  sizeBytes: number
}

interface AddIngressFilesResult {
  uploadDir: string
  files: AddedIngressFile[]
}

interface WaitTaskValidationResult {
  taskId: string
  status: ExternalWaitTask['status']
  uploadDir?: string
  requiredUploads: string[]
  missingRequiredUploads: string[]
  hasAnyUpload: boolean
  checks: Array<{ name: string; passed: boolean; detail?: string }>
  ok: boolean
  reason?: string
}

interface ResourceExtensionRequest {
  id: string
  requestedAt: string
  requestedBy: 'user' | 'agent'
  rationale: string
  delta: {
    maxTurns: number
    maxTokens: number
    maxCostUsd: number
  }
}

interface BranchNode {
  nodeId: string
  branchId: string
  parentNodeId?: string
  stage: 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
  status: 'active' | 'paused' | 'merged' | 'pruned' | 'invalidated'
  summary: string
  mergedFrom?: string[]
  createdByTurn?: number
}

interface BranchSnapshot {
  activeBranchId: string
  activeNodeId: string
  rootNodeId: string
  nodes: BranchNode[]
}

interface AssetRecord {
  id: string
  type: string
  payload: Record<string, unknown>
  supersedes?: string
  createdAt: string
  createdByTurn: number
  createdByAttempt: number
}

interface DrawerChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

interface InteractionContext {
  interactionId: string
  kind: string
  title: string
  urgency: 'blocking' | 'advisory'
  sections: Array<{ label: string; content: string; collapsible?: boolean }>
  actions: Array<{ id: string; label: string; variant: string }>
  quickReplies?: string[]
}

interface DrawerState {
  interaction: InteractionContext | null
  chatHistory: DrawerChatMessage[]
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
  getCurrentSession: () => Promise<{ sessionId: string; projectPath: string }>
  pickFolder: () => Promise<{ projectPath: string; sessionId: string } | null>
  closeProject: () => Promise<void>
  onProjectClosed: (cb: () => void) => () => void

  yoloStart: (goal: string, options: YoloSessionOptions) => Promise<any>
  yoloPause: (payload?: { immediate?: boolean }) => Promise<any>
  yoloResume: () => Promise<any>
  yoloStop: () => Promise<any>
  yoloEnqueueInput: (text: string, priority?: Priority) => Promise<any>
  yoloGetInputQueue: () => Promise<QueuedUserInput[]>
  yoloQueueRemove: (id: string) => Promise<QueuedUserInput | null>
  yoloQueueReprioritize: (id: string, priority: Priority) => Promise<QueuedUserInput | null>
  yoloQueueMove: (id: string, toIndex: number) => Promise<QueuedUserInput[]>
  yoloGetSnapshot: () => Promise<any>
  yoloRestoreCheckpoint: () => Promise<{ restored: boolean; snapshot: any }>
  yoloGetTurnReports: () => Promise<any[]>
  yoloGetEvents: () => Promise<any[]>
  yoloGetBranchSnapshot: () => Promise<BranchSnapshot | null>
  yoloGetAssets: () => Promise<AssetRecord[]>
  yoloWaitExternal: (payload: { title: string; completionRule: string; resumeAction: string; details?: string }) => Promise<ExternalWaitTask>
  yoloRequestFullTextWait: (payload: {
    citation: string
    requiredFiles?: string[]
    reason?: string
  }) => Promise<ExternalWaitTask>
  yoloListWaitTasks: () => Promise<ExternalWaitTask[]>
  yoloValidateWaitTask: (payload: { taskId: string }) => Promise<WaitTaskValidationResult>
  yoloAddIngressFiles: (payload?: { taskId?: string; turnNumber?: number }) => Promise<AddIngressFilesResult>
  yoloCancelWaitTask: (payload: { taskId: string; reason: string }) => Promise<ExternalWaitTask>
  yoloResolveWaitTask: (payload: { taskId: string; resolutionNote: string }) => Promise<ExternalWaitTask>
  yoloRequestResourceExtension: (payload: {
    rationale: string
    delta: { maxTurns?: number; maxTokens?: number; maxCostUsd?: number }
    requestedBy?: 'user' | 'agent'
  }) => Promise<ResourceExtensionRequest>
  yoloResolveResourceExtension: (payload: { approved: boolean; note?: string }) => Promise<{
    approved: boolean
    requestId: string
    decisionAssetId: string
    budget: { maxTurns: number; maxTokens: number; maxCostUsd: number; deadlineIso?: string }
  }>
  yoloRecordOverrideDecision: (payload: {
    targetNodeId: string
    rationale: string
    riskAccepted?: string
  }) => Promise<{ decisionAssetId: string }>
  yoloExportSummary: () => Promise<{ path: string }>
  yoloExportClaimEvidenceTable: () => Promise<{ path: string }>
  yoloExportAssetInventory: () => Promise<{ path: string }>
  yoloExportFinalBundle: () => Promise<{
    manifestPath: string
    summaryPath: string
    claimEvidenceTablePath: string
    assetInventoryPath: string
  }>

  onYoloState: (cb: (payload: any) => void) => () => void
  onYoloTurnReport: (cb: (payload: any) => void) => () => void
  onYoloQuestion: (cb: (payload: any) => void) => () => void
  onYoloEvent: (cb: (payload: any) => void) => () => void
  onYoloActivity: (cb: (payload: any) => void) => () => void

  drawerGetState: () => Promise<DrawerState>
  drawerChat: (payload: { message: string; interactionId: string }) => Promise<DrawerChatMessage>
  drawerAction: (payload: { interactionId: string; actionId: string; text?: string }) => Promise<{ success: boolean }>
  drawerClearChat: () => Promise<void>
  onDrawerStateChanged: (cb: (payload: DrawerState) => void) => () => void

  // research.md operations
  readResearchMd: () => Promise<{ success: boolean; content?: string; exists?: boolean; error?: string }>
  saveResearchMd: (content: string) => Promise<{ success: boolean; error?: string }>

  // File tree operations
  listTree: (options?: { relativePath?: string; showIgnored?: boolean; limit?: number }) => Promise<FileTreeNode[]>
  searchTree: (query: string, options?: { showIgnored?: boolean; maxResults?: number }) => Promise<FileTreeNode[]>
  createFile: (relativePath: string) => Promise<{ success: boolean; error?: string; path?: string }>
  createDir: (relativePath: string) => Promise<{ success: boolean; error?: string; path?: string }>
  renameFile: (oldRelativePath: string, newName: string) => Promise<{ success: boolean; error?: string; path?: string }>
  trashFile: (filePath: string) => Promise<{ success: boolean; error?: string }>
  dropToDir: (fileName: string, base64Content: string, targetDirRelPath: string) => Promise<{ success: boolean; error?: string; path?: string }>
  openFile: (filePath: string) => Promise<{ success: boolean; error?: string }>
  readTextFile: (filePath: string) => Promise<{ success: boolean; error?: string; content?: string; path?: string }>
  openFolderWith: (app: 'finder' | 'zed' | 'cursor' | 'vscode') => Promise<{ success: boolean; error?: string }>

  // Paper library operations
  listPapers: () => Promise<any[]>
  listReviews: () => Promise<any[]>
  readReview: (reviewId: string) => Promise<{ content: string }>
}

const api: ElectronAPI = {
  getCurrentSession: () => ipcRenderer.invoke('session:current'),
  pickFolder: () => ipcRenderer.invoke('project:pick-folder'),
  closeProject: () => ipcRenderer.invoke('project:close'),
  onProjectClosed: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('project:closed', handler)
    return () => ipcRenderer.removeListener('project:closed', handler)
  },

  yoloStart: (goal, options) => ipcRenderer.invoke('yolo:start', goal, options),
  yoloPause: (payload) => ipcRenderer.invoke('yolo:pause', payload),
  yoloResume: () => ipcRenderer.invoke('yolo:resume'),
  yoloStop: () => ipcRenderer.invoke('yolo:stop'),
  yoloEnqueueInput: (text, priority) => ipcRenderer.invoke('yolo:enqueue-input', text, priority),
  yoloGetInputQueue: () => ipcRenderer.invoke('yolo:get-input-queue'),
  yoloQueueRemove: (id) => ipcRenderer.invoke('yolo:queue-remove', id),
  yoloQueueReprioritize: (id, priority) => ipcRenderer.invoke('yolo:queue-reprioritize', id, priority),
  yoloQueueMove: (id, toIndex) => ipcRenderer.invoke('yolo:queue-move', id, toIndex),
  yoloGetSnapshot: () => ipcRenderer.invoke('yolo:get-snapshot'),
  yoloRestoreCheckpoint: () => ipcRenderer.invoke('yolo:restore-checkpoint'),
  yoloGetTurnReports: () => ipcRenderer.invoke('yolo:get-turn-reports'),
  yoloGetEvents: () => ipcRenderer.invoke('yolo:get-events'),
  yoloGetBranchSnapshot: () => ipcRenderer.invoke('yolo:get-branch-snapshot'),
  yoloGetAssets: () => ipcRenderer.invoke('yolo:get-assets'),
  yoloWaitExternal: (payload) => ipcRenderer.invoke('yolo:wait-external', payload),
  yoloRequestFullTextWait: (payload) => ipcRenderer.invoke('yolo:request-fulltext-wait', payload),
  yoloListWaitTasks: () => ipcRenderer.invoke('yolo:list-wait-tasks'),
  yoloValidateWaitTask: (payload) => ipcRenderer.invoke('yolo:validate-wait-task', payload),
  yoloAddIngressFiles: (payload) => ipcRenderer.invoke('yolo:add-ingress-files', payload),
  yoloCancelWaitTask: (payload) => ipcRenderer.invoke('yolo:cancel-wait-task', payload),
  yoloResolveWaitTask: (payload) => ipcRenderer.invoke('yolo:resolve-wait-task', payload),
  yoloRequestResourceExtension: (payload) => ipcRenderer.invoke('yolo:request-resource-extension', payload),
  yoloResolveResourceExtension: (payload) => ipcRenderer.invoke('yolo:resolve-resource-extension', payload),
  yoloRecordOverrideDecision: (payload) => ipcRenderer.invoke('yolo:record-override-decision', payload),
  yoloExportSummary: () => ipcRenderer.invoke('yolo:export-summary'),
  yoloExportClaimEvidenceTable: () => ipcRenderer.invoke('yolo:export-claim-evidence-table'),
  yoloExportAssetInventory: () => ipcRenderer.invoke('yolo:export-asset-inventory'),
  yoloExportFinalBundle: () => ipcRenderer.invoke('yolo:export-final-bundle'),

  onYoloState: (cb) => {
    const handler = (_: any, payload: any) => cb(payload)
    ipcRenderer.on('yolo:state', handler)
    return () => ipcRenderer.removeListener('yolo:state', handler)
  },
  onYoloTurnReport: (cb) => {
    const handler = (_: any, payload: any) => cb(payload)
    ipcRenderer.on('yolo:turn-report', handler)
    return () => ipcRenderer.removeListener('yolo:turn-report', handler)
  },
  onYoloQuestion: (cb) => {
    const handler = (_: any, payload: any) => cb(payload)
    ipcRenderer.on('yolo:question', handler)
    return () => ipcRenderer.removeListener('yolo:question', handler)
  },
  onYoloEvent: (cb) => {
    const handler = (_: any, payload: any) => cb(payload)
    ipcRenderer.on('yolo:event', handler)
    return () => ipcRenderer.removeListener('yolo:event', handler)
  },
  onYoloActivity: (cb) => {
    const handler = (_: any, payload: any) => cb(payload)
    ipcRenderer.on('yolo:activity', handler)
    return () => ipcRenderer.removeListener('yolo:activity', handler)
  },

  drawerGetState: () => ipcRenderer.invoke('drawer:get-state'),
  drawerChat: (payload) => ipcRenderer.invoke('drawer:chat', payload),
  drawerAction: (payload) => ipcRenderer.invoke('drawer:action', payload),
  drawerClearChat: () => ipcRenderer.invoke('drawer:clear-chat'),
  onDrawerStateChanged: (cb) => {
    const handler = (_: any, payload: any) => cb(payload)
    ipcRenderer.on('drawer:state-changed', handler)
    return () => ipcRenderer.removeListener('drawer:state-changed', handler)
  },

  // research.md operations
  readResearchMd: () => ipcRenderer.invoke('research:read'),
  saveResearchMd: (content) => ipcRenderer.invoke('research:save', content),

  // File tree operations
  listTree: (options) => ipcRenderer.invoke('file:list-tree', options),
  searchTree: (query, options) => ipcRenderer.invoke('file:search-tree', query, options),
  createFile: (relativePath) => ipcRenderer.invoke('file:create', relativePath),
  createDir: (relativePath) => ipcRenderer.invoke('file:create-dir', relativePath),
  renameFile: (oldRelativePath, newName) => ipcRenderer.invoke('file:rename', oldRelativePath, newName),
  trashFile: (filePath) => ipcRenderer.invoke('file:trash', filePath),
  dropToDir: (fileName, base64Content, targetDirRelPath) => ipcRenderer.invoke('file:drop-to-dir', fileName, base64Content, targetDirRelPath),
  openFile: (filePath) => ipcRenderer.invoke('file:open-external', filePath),
  readTextFile: (filePath) => ipcRenderer.invoke('file:read-text', filePath),
  openFolderWith: (app) => ipcRenderer.invoke('folder:open-with', app),

  // Paper library operations
  listPapers: () => ipcRenderer.invoke('papers:list'),
  listReviews: () => ipcRenderer.invoke('papers:list-reviews'),
  readReview: (reviewId) => ipcRenderer.invoke('papers:read-review', reviewId),
}

contextBridge.exposeInMainWorld('api', api)
