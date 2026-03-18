import type { MemoryNamespace, MemorySensitivity, MemoryItem, MemoryPutOptions, MemoryUpdateOptions, MemorySearchOptions, MemorySearchResult, MemoryListOptions } from '../types/memory.js'

export type V2Role = 'user' | 'assistant' | 'tool'

export interface KernelV2Config {
  enabled?: boolean
  profile?: 'minimal' | 'legacy'
  contextWindow?: number
  modelId?: string
  project?: {
    autoDetection?: {
      strategy?: 'explicit' | 'path-based' | 'first-goal'
      fallbackStrategy?: 'first-goal' | 'explicit'
      pathPatterns?: string[]
    }
  }
  continuity?: {
    injectPreviousSessionSummary?: boolean
    maxPreviousSessions?: number
    injectActiveTasks?: boolean
  }
  context?: {
    protectedRecentTurns?: number
    includeToolMessagesInProtectedZone?: boolean
    tailTaskAnchor?: boolean
    protectedMinTokens?: number
  }
  budget?: {
    reserveOutput?: {
      intermediate?: number
      final?: number
      extended?: number
    }
    softThreshold?: number
  }
  memory?: {
    writeGate?: {
      maxWritesPerTurn?: number
      maxWritesPerSession?: number
    }
  }
  compaction?: {
    enabled?: boolean
    preFlush?: {
      enabled?: boolean
      writeReserve?: number
    }
    requireReplayRefs?: boolean
    /**
     * Use an LLM to generate semantic summaries instead of heuristic truncation.
     * Requires `summarizeFn` to be injected into KernelV2Impl at construction time.
     * Default: false
     */
    llmSummarization?: boolean
  }
  retrieval?: {
    fallbackChain?: Array<'hybrid' | 'lexical' | 'vector-only' | 'raw-file-scan'>
    rawScanLimitTokens?: number
  }
  telemetry?: {
    baselineAlwaysOn?: boolean
    mode?: 'stderr' | 'file' | 'stderr+file'
    filePath?: string
  }
  lifecycle?: {
    autoWeekly?: boolean
    decayThresholdDays?: number
  }
  storage?: {
    integrity?: {
      verifyOnStartup?: boolean
    }
    recovery?: {
      autoTruncateToLastValidRecord?: boolean
      createRecoverySnapshot?: boolean
    }
  }
}

export interface KernelV2ResolvedConfig {
  enabled: boolean
  profile: 'minimal' | 'legacy'
  contextWindow: number
  modelId: string
  context: {
    protectedRecentTurns: number
    includeToolMessagesInProtectedZone: boolean
    tailTaskAnchor: boolean
    protectedMinTokens: number
  }
  budget: {
    reserveOutput: {
      intermediate: number
      final: number
      extended: number
    }
    softThreshold: number
  }
  continuity: {
    injectPreviousSessionSummary: boolean
    maxPreviousSessions: number
    injectActiveTasks: boolean
  }
  memory: {
    writeGate: {
      maxWritesPerTurn: number
      maxWritesPerSession: number
    }
  }
  compaction: {
    enabled: boolean
    preFlush: {
      enabled: boolean
      writeReserve: number
    }
    requireReplayRefs: boolean
    llmSummarization: boolean
  }
  retrieval: {
    fallbackChain: Array<'hybrid' | 'lexical' | 'vector-only' | 'raw-file-scan'>
    rawScanLimitTokens: number
  }
  telemetry: {
    baselineAlwaysOn: boolean
    mode: 'stderr' | 'file' | 'stderr+file'
    filePath: string
  }
  lifecycle: {
    autoWeekly: boolean
    decayThresholdDays: number
  }
  storage: {
    integrity: {
      verifyOnStartup: boolean
    }
    recovery: {
      autoTruncateToLastValidRecord: boolean
      createRecoverySnapshot: boolean
    }
  }
}

export interface V2TurnRecord {
  id: string
  sessionId: string
  index: number
  role: V2Role
  content: string
  createdAt: string
}

export interface V2ProjectRecord {
  projectId: string
  name: string
  rootPath: string
  detectionStrategy: 'explicit' | 'path-based' | 'first-goal'
  status: 'registered' | 'archived'
  defaultForWorkspace: boolean
  updatedAt: string
}

export interface V2TaskState {
  taskId: string
  projectId: string
  status: 'pending' | 'in_progress' | 'blocked' | 'done'
  currentGoal: string
  nowDoing: string
  blockedBy: string[]
  nextAction: string
  lastSessionId: string
  updatedAt: string
}

export interface V2ContinuityRecord {
  id: string
  projectId: string
  sessionId: string
  summary: string
  activeTaskIds: string[]
  carryOverNextActions: string[]
  knownBlockers: string[]
  createdAt: string
}

export type V2MemoryStatus = 'proposed' | 'active' | 'superseded' | 'deprecated'

export interface V2MemoryFact {
  id: string
  namespace: MemoryNamespace
  key: string
  value: unknown
  valueText?: string
  tags: string[]
  sensitivity: MemorySensitivity
  status: V2MemoryStatus
  confidence: number
  provenance: {
    sourceType: 'file' | 'url' | 'turn' | 'tool' | 'user'
    sourceRef: string
    traceId: string
    sessionId?: string
    createdBy: 'user' | 'model' | 'system'
  }
  createdAt: string
  updatedAt: string
}

export interface V2ArtifactRecord {
  id: string
  projectId: string
  type: 'document' | 'tool-output' | 'file-snapshot' | 'web-content'
  path: string
  mimeType: string
  summary: string
  sourceRef: string
  createdAt: string
}

export interface V2CompactSegment {
  id: string
  sessionId: string
  turnRange: [number, number]
  summary: string
  replayRefs: Array<{ type: 'path' | 'url' | 'id'; value: string }>
  createdAt: string
}

export interface V2LogicalTurn {
  user: V2TurnRecord
  followups: V2TurnRecord[]
  fromIndex: number
  toIndex: number
}

export interface V2TaskAnchor {
  currentGoal: string
  nowDoing: string
  blockedBy: string[]
  nextAction: string
}

export interface V2ContextAssemblyInput {
  systemPromptTokens: number
  toolSchemasTokens: number
  selectedContext?: string
  additionalInstructions?: string
  query?: string
}

export interface V2ContextAssemblyResult {
  workingContextBlock: string
  taskAnchor: V2TaskAnchor
  promptTokensEstimate: number
  protectedTurnsRequested: number
  protectedTurnsKept: number
  protectedTurnsDropped: number
  degradedZones: string[]
  failSafeMode: boolean
}

export interface V2BudgetPlanInput {
  contextWindow: number
  outputReserve: number
  fixedTokens: number
  requiredTokens: {
    protectedTurns: number
    taskAnchor: number
  }
  desiredOptionalTokens: {
    memoryCards: number
    evidenceCards: number
    nonProtectedTurns: number
    optionalExpansion: number
  }
}

export interface V2BudgetPlanResult {
  failSafeMode: boolean
  protectedTurnsTarget: number
  allocations: {
    memoryCards: number
    evidenceCards: number
    nonProtectedTurns: number
    optionalExpansion: number
  }
  degradedZones: string[]
}

export type V2WriteAction = 'PUT' | 'REPLACE' | 'SUPERSEDE' | 'IGNORE' | 'RATE_LIMITED'

export interface V2WriteResult {
  action: V2WriteAction
  item: MemoryItem | null
  reason?: string
}

export interface V2MemoryWriteCandidate {
  namespace: MemoryNamespace
  key: string
  value: unknown
  valueText?: string
  tags?: string[]
  sensitivity?: MemorySensitivity
  sourceType: 'file' | 'url' | 'turn' | 'tool' | 'user'
  sourceRef: string
  createdBy: 'user' | 'model' | 'system'
  confidence: number
  overwrite?: boolean
}

export interface KernelV2TelemetryEvent {
  event: string
  payload: Record<string, unknown>
  message: string
}

export interface KernelV2ReplayRef {
  type: 'path' | 'url' | 'id'
  value: string
}

export interface KernelV2ReplayPayload {
  found: boolean
  ref: KernelV2ReplayRef
  source: 'filesystem' | 'segment' | 'memory' | 'task' | 'url' | 'unknown'
  content: string
  truncated?: boolean
  metadata?: Record<string, unknown>
}

export interface KernelV2TurnInput {
  sessionId: string
  userPrompt: string
  systemPromptTokens: number
  toolSchemasTokens: number
  selectedContext?: string
  additionalInstructions?: string
}

export interface KernelV2TurnCompletionInput {
  messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>
  promptTokens: number
}

export interface KernelV2TurnResult {
  projectId: string
  task: V2TaskState
  context: V2ContextAssemblyResult
}

export interface KernelV2IntegrityIssue {
  path: string
  failureType: string
  lastValidOffset: number
}

export interface KernelV2IntegrityReport {
  ok: boolean
  checkedAt: string
  scope: 'workspace' | 'project' | 'file'
  issues: KernelV2IntegrityIssue[]
}

export interface KernelV2MemoryLike {
  init(): Promise<void>
  close(): Promise<void>
  get(namespace: MemoryNamespace, key: string): Promise<MemoryItem | null>
  put(options: MemoryPutOptions): Promise<MemoryItem>
  update(namespace: MemoryNamespace, key: string, options: MemoryUpdateOptions): Promise<MemoryItem | null>
  delete(namespace: MemoryNamespace, key: string, reason?: string): Promise<boolean>
  list(options?: MemoryListOptions): Promise<{ items: MemoryItem[]; total: number }>
  search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>
  has(namespace: MemoryNamespace, key: string): Promise<boolean>
  cleanExpired(): Promise<number>
  rebuildIndex(): Promise<void>
  getStats(): Promise<{ totalItems: number; byNamespace: Record<string, number>; bySensitivity: Record<MemorySensitivity, number> }>
}

export interface V2TurnUpsertInput {
  role: V2Role
  content: string
  createdAt?: string
}
