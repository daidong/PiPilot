// All shared types for the YOLO Researcher desktop UI

export interface ActivityItem {
  id: string
  timestamp: string
  kind: string
  agent?: string
  tool?: string
  preview?: string
}

export type YoloState =
  | 'IDLE'
  | 'PLANNING'
  | 'EXECUTING'
  | 'TURN_COMPLETE'
  | 'WAITING_FOR_USER'
  | 'WAITING_EXTERNAL'
  | 'PAUSED'
  | 'COMPLETE'
  | 'FAILED'
  | 'STOPPED'
  | 'CRASHED'

export type StageId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
export type GateStatus = 'pass' | 'fail' | 'none'
export type TabId = 'timeline' | 'branches' | 'assets' | 'evidence' | 'system' | 'events'

export interface YoloSnapshot {
  sessionId: string
  goal: string
  phase: 'P0' | 'P1' | 'P2' | 'P3'
  mode?: 'legacy' | 'lean_v2'
  state: YoloState
  currentTurn: number
  activeStage: StageId
  budgetUsed: { tokens: number; costUsd: number; turns: number }
  budgetCaps?: { maxTurns: number; maxTokens: number; maxCostUsd: number; deadlineIso?: string }
  pendingQuestion?: {
    id?: string
    question: string
    options?: string[]
    context?: string
    checkpoint?: 'problem-freeze' | 'baseline-freeze' | 'claim-freeze' | 'final-scope'
    blocking?: boolean
  }
  pendingExternalTaskId?: string
  pendingResourceExtension?: {
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
  runtimeStatus?: {
    lease?: {
      ownerId?: string
      acquiredAt?: string
      heartbeatAt?: string
      staleAfterSec?: number
      takeoverReason?: string
      takeoverFromOwnerId?: string
    }
    latestCheckpoint?: {
      checkpointId?: string
      fileName?: string
      createdAt?: string
      trigger?: string
      turnNumber?: number
      runtimeState?: YoloState
    }
    checkpointCount?: number
  }
}

// ─── Planner thinking types ─────────────────────────────────

export interface PlannerToolPlanStep {
  step: number
  tool: string
  goal: string
  output_contract: string
}

export interface PlannerNeedFromUser {
  required: boolean
  request: string
  required_files?: string[]
}

export interface PlannerContract {
  current_focus: string
  why_now: string
  action: string
  tool_plan: PlannerToolPlanStep[]
  expected_output: string[]
  need_from_user: PlannerNeedFromUser
  done_definition: string
  risk_flags: string[]
}

export interface PlannerSpec {
  turnSpec: { turnNumber: number; stage: string; objective: string }
  suggestedPrompt: string
  rationale: string
  uncertaintyNote: string
  planContract: PlannerContract
}

// ─── Execution trace types ──────────────────────────────────

export interface ExecutionTraceItem {
  tool: string
  reason: string
  result_summary: string
}

// ─── Reviewer process review types ──────────────────────────

export interface ReviewerCriticalIssue {
  id: string
  severity: 'high' | 'medium' | 'low'
  message: string
}

export interface ReviewerFixPlanItem {
  issue_id: string
  action: string
}

export interface ReviewerProcessReview {
  verdict: 'pass' | 'revise' | 'block'
  critical_issues: ReviewerCriticalIssue[]
  fix_plan: ReviewerFixPlanItem[]
  confidence: number
  notes_for_user: string
}

// ─── Turn report ────────────────────────────────────────────

export interface TurnReport {
  turnNumber: number
  turnSpec: { objective: string; stage: string }
  summary: string
  plannerSpec?: PlannerSpec
  nextStepRationale?: string
  execution?: {
    action?: 'explore' | 'refine_question' | 'issue_experiment_request' | 'digest_uploaded_results'
    actionRationale?: string
    executionTrace?: ExecutionTraceItem[]
    toolCalls?: Array<{
      tool: string
      argsPreview?: string
      resultPreview?: string
    }>
    tooling?: {
      mode: 'full' | 'local-only'
      literatureEnabled: boolean
      enabledPacks: string[]
      degradeReason?: string
    }
  }
  reviewerSnapshot?: {
    status?: 'not-run' | 'completed'
    notes?: string[]
    processReview?: ReviewerProcessReview
    reviewerPasses?: Array<{
      persona?: 'Novelty' | 'System' | 'Evaluation' | 'Writing'
      hardBlockers?: Array<{ label?: string }>
    }>
    consensusBlockers?: Array<{
      label?: string
      voteCount?: number
      personas?: Array<'Novelty' | 'System' | 'Evaluation' | 'Writing'>
    }>
  }
  gateImpact?: {
    status: string
    gateResult?: { passed: boolean }
    snapshotManifest?: {
      evidencePolicy?: {
        crossBranchCountableLinkIds?: string[]
        keyRunMissingParityContractLinkIds?: string[]
        invalidCountableLinkIds?: string[]
      }
      causality?: {
        requiredClaims?: number
        satisfiedClaims?: number
        interventionLinkCount?: number
        counterfactualLinkCount?: number
        correlationOnlyLinkCount?: number
        missingClaimIds?: string[]
      }
      claimDecisionBinding?: {
        assertedClaimCount?: number
        assertedClaimWithFreezeRefCount?: number
        missingFreezeRefClaimIds?: string[]
      }
      directEvidence?: {
        requiredClaims?: number
        satisfiedClaims?: number
        missingClaimIds?: string[]
      }
    }
  }
  reviewerSnapshot?: {
    status?: 'not-run' | 'completed'
    notes?: string[]
    reviewerPasses?: Array<{
      persona?: 'Novelty' | 'System' | 'Evaluation' | 'Writing'
      hardBlockers?: Array<{ label?: string }>
    }>
    consensusBlockers?: Array<{
      label?: string
      voteCount?: number
      personas?: Array<'Novelty' | 'System' | 'Evaluation' | 'Writing'>
    }>
  }
  readinessSnapshot?: {
    phase?: 'P0' | 'P1' | 'P2' | 'P3'
    stage?: StageId
    pass?: boolean
    requiredFailed?: Array<'TG0' | 'TG1' | 'TG2' | 'TG3' | 'TG4'>
  }
  riskDelta?: string[]
  consumedBudgets?: {
    turnCostUsd?: number
    turnTokens?: number
    toolCalls?: number
    wallClockSec?: number
    readBytes?: number
    discoveryOps?: number
    promptTokens?: number
    completionTokens?: number
    stepCount?: number
  }
  assetDiff?: { created: string[] }
  nonProgress?: boolean
}

export interface BranchNode {
  nodeId: string
  branchId: string
  parentNodeId?: string
  stage: StageId
  status: 'active' | 'paused' | 'merged' | 'pruned' | 'invalidated'
  summary: string
  mergedFrom?: string[]
  createdByTurn?: number
}

export interface BranchSnapshot {
  activeBranchId: string
  activeNodeId: string
  rootNodeId: string
  nodes: BranchNode[]
}

export interface AssetRecord {
  id: string
  type: string
  payload: Record<string, unknown>
  supersedes?: string
  createdAt: string
  createdByTurn: number
  createdByAttempt: number
}

export interface EventRecord {
  at: string
  type: string
  text: string
}

export interface QueuedUserInput {
  id: string
  text: string
  priority: 'urgent' | 'normal'
  createdAt: string
  source: 'chat' | 'system'
}

export interface ExternalWaitTask {
  id: string
  sessionId: string
  status: 'waiting' | 'satisfied' | 'canceled' | 'expired' | 'open' | 'resolved' | 'cancelled'
  stage?: StageId
  branchId?: string
  nodeId?: string
  title: string
  reason?: string
  requiredArtifacts?: Array<{ kind: string; pathHint?: string; description: string }>
  completionRule: string
  resumeAction: string
  uploadDir?: string
  details?: string
  createdAt: string
  resolvedAt?: string
  resolutionNote?: string
}

export interface WaitTaskValidationResult {
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

export type EvidenceGraphLane = 'claim' | 'link' | 'evidence' | 'decision'

export interface EvidenceGraphNode {
  id: string
  label: string
  lane: EvidenceGraphLane
  assetType: string
  external: boolean
  x: number
  y: number
}

export interface EvidenceGraphEdge {
  id: string
  from: string
  to: string
  kind: 'claim_link' | 'link_evidence' | 'supersedes'
}

export interface StageGateInfo {
  status: GateStatus
  lastTurn?: number
  objective?: string
  summary?: string
}

export interface BudgetUsageInfo {
  used: { tokens: number; costUsd: number; turns: number }
  costRatio: number
  turnRatio: number
  maxRatio: number
}

export interface BudgetTrendInfo {
  sampleSize: number
  avgTokensPerTurn: number
  avgCostPerTurn: number
  projectedTurnsLeftByTokens: number | null
  projectedTurnsLeftByCost: number | null
}

export interface FailureInfo {
  category: string
  reason: string
}

export interface GovernanceSummary {
  overrideDecisionCount: number
  claimFreezeDecisionCount: number
  invalidatedNodeCount: number
  maintenanceAlertCount: number
  maintenanceErrorCount: number
  readinessGateFailureAlertCount: number
  readinessRequiredFailedCount: number
  semanticReviewerCount: number
  semanticConsensusBlockerCount: number
  crossBranchDefaultedCount: number
  crossBranchAutoUpgradedCount: number
  invalidCountableLinkCount: number
  missingParityContractLinkCount: number
  causalityMissingClaimCount: number
  missingClaimDecisionBindingCount: number
  directEvidenceMissingClaimCount: number
}

export interface CoverageSummary {
  source: string
  assertedPrimary: number
  coveredPrimary: number
  primaryRatio: number | null
  assertedSecondary: number
  coveredSecondary: number
  secondaryRatio: number | null
  primaryPass: boolean
  secondaryPass: boolean
}

export interface ClaimMatrixRow {
  id: string
  summary: string
  tier: string
  state: string
  coverageStatus: string
  hasPrimaryGap: boolean
  countableIds: string[]
  citeOnlyIds: string[]
  needsRevalidateIds: string[]
}

export interface LatestClaimEvidenceTable {
  assetId: string
  createdByTurn: number
  rowCount: number
  assertedPrimary: number
  coveredPrimary: number
  assertedPrimaryCoverage: number | null
  assertedSecondary: number
  coveredSecondary: number
  assertedSecondaryCoverage: number | null
  primaryPass: boolean
  secondaryPass: boolean
  rows: ClaimMatrixRow[]
}

export interface EvidenceGraphData {
  nodes: EvidenceGraphNode[]
  nodeById: Map<string, EvidenceGraphNode>
  edges: EvidenceGraphEdge[]
  graphW: number
  graphH: number
  nodeW: number
  nodeH: number
  counts: {
    claims: number
    links: number
    evidence: number
    decisions: number
  }
}

// ─── InteractionDrawer types ─────────────────────────────

export type InteractionKind =
  | 'experiment_request'
  | 'fulltext_upload'
  | 'gate_blocker'
  | 'checkpoint_decision'
  | 'resource_extension'
  | 'general_question'
  | 'failure_recovery'

export interface InteractionContextSection {
  label: string
  content: string
  collapsible?: boolean
}

export interface InteractionAction {
  id: string
  label: string
  variant: 'primary' | 'secondary' | 'danger' | 'ghost'
}

export interface InteractionContext {
  interactionId: string
  kind: InteractionKind
  title: string
  urgency: 'blocking' | 'advisory'
  sections: InteractionContextSection[]
  actions: InteractionAction[]
  quickReplies?: string[]
}

export interface DrawerChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface DrawerState {
  interaction: InteractionContext | null
  chatHistory: DrawerChatMessage[]
}

// Actions interface returned by useYoloSession
export interface SessionActions {
  pickFolder: () => Promise<void>
  closeProject: () => Promise<void>
  startYolo: () => Promise<void>
  restartYolo: () => Promise<void>
  pauseYolo: () => Promise<void>
  resumeYolo: () => Promise<void>
  stopYolo: () => Promise<void>
  restoreFromCheckpoint: () => Promise<void>
  submitReply: (text: string) => Promise<void>
  submitQuickReply: (text: string) => Promise<void>
  yoloEnqueueInput: (text: string, priority?: 'urgent' | 'normal') => Promise<void>
  exportSummary: () => Promise<void>
  exportClaimEvidenceTable: () => Promise<void>
  exportAssetInventory: () => Promise<void>
  exportFinalBundle: () => Promise<void>
  requestWaitExternal: (params: {
    title: string
    completionRule: string
    resumeAction: string
    details: string
  }) => Promise<void>
  requestFullTextWait: (params: {
    citation: string
    requiredFiles: string
    reason: string
  }) => Promise<void>
  resolveWaitTask: (resolutionNote: string) => Promise<void>
  validateWaitTask: () => Promise<void>
  cancelWaitTask: (reason: string) => Promise<void>
  addIngressFiles: (taskId?: string) => Promise<void>
  requestResourceExtension: (params: {
    rationale: string
    deltaTurns: string
    deltaTokens: string
    deltaCostUsd: string
  }) => Promise<void>
  resolveResourceExtension: (approved: boolean, note: string) => Promise<void>
  recordOverrideDecision: (params: {
    targetNodeId: string
    rationale: string
    riskAccepted: string
  }) => Promise<void>
  setQueuePriority: (id: string, priority: 'urgent' | 'normal') => Promise<void>
  moveQueueItem: (id: string, toIndex: number) => Promise<void>
  removeQueueItem: (id: string) => Promise<void>
  saveResearchMd: (content: string) => Promise<void>
  saveGoalToResearchMd: (goal: string) => Promise<void>
  setGoal: (goal: string) => void
  setSelectedPhase: (phase: 'P0' | 'P1' | 'P2' | 'P3') => void
  setActiveTab: (tab: TabId) => void
  setSelectedStage: (stage: StageId) => void
  setTimelineStageFilter: (filter: 'ALL' | StageId) => void
  setTimelineGateFilter: (filter: 'ALL' | GateStatus) => void
  setTimelineProgressFilter: (filter: 'ALL' | 'PROGRESS' | 'NON_PROGRESS') => void
  setSelectedTurnNumber: (turnNumber: number | null) => void
  setSelectedGraphNodeId: (nodeId: string | null) => void
  setShowSupersedesEdges: (show: boolean | ((prev: boolean) => boolean)) => void
  setQueueOpen: (open: boolean | ((prev: boolean) => boolean)) => void
  openDrawer: () => Promise<void>
  closeDrawer: () => void
  sendDrawerChat: (message: string) => Promise<void>
  executeDrawerAction: (actionId: string, text?: string) => Promise<void>
}
