import type { AgentRunResult } from '../../../src/index.js'
import type { BranchNode } from './branch-manager.js'

export interface AgentLike {
  ensureInit: () => Promise<void>
  run: (prompt: string) => Promise<AgentRunResult>
  destroy?: () => Promise<void>
}

export type YoloRuntimeMode = 'legacy' | 'lean_v2'

export type YoloStage = 'S1' | 'S2' | 'S3' | 'S4' | 'S5'

// Free-form string describing the turn's intent (e.g. 'explore', 'design_experiment',
// 'literature_review', 'run_experiment', 'analyze_results').
// Used for display/logging only — does NOT gate tool selection.
export type YoloTurnAction = string

export type YoloRuntimeState =
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

export interface YoloSessionOptions {
  budget: {
    maxTurns: number
    maxTokens: number
    maxCostUsd: number
    deadlineIso?: string
  }
  models: {
    planner: string
    coordinator: string
    reviewer?: string
  }
  mode?: YoloRuntimeMode
}

export interface TurnConstraints {
  maxToolCalls: number
  maxWallClockSec: number
  maxStepCount: number
  maxNewAssets: number
  maxDiscoveryOps: number
  maxReadBytes: number
  maxPromptTokens: number
  maxCompletionTokens: number
  maxTurnTokens: number
  maxTurnCostUsd: number
}

export interface TurnSpec {
  turnNumber: number
  stage: YoloStage
  branch: {
    activeBranchId: string
    activeNodeId: string
    action: 'advance' | 'fork' | 'revisit' | 'merge' | 'prune'
    targetNodeId?: string
  }
  objective: string
  expectedAssets: string[]
  constraints: TurnConstraints
}

export interface PlannerInput {
  sessionId: string
  turnNumber: number
  state: YoloRuntimeState
  stage: YoloStage
  goal: string
  activeBranchId: string
  activeNodeId: string
  nonProgressTurns: number
  requiresBranchDiversification: boolean
  gateFailureCountOnActiveNode: number
  requiresGateLoopBreak: boolean
  planSnapshotHash: string
  branchDossierHash: string
  planContent: string
  branchDossierContent: string
  researchContext: string
  previousStageGateStatus: Record<YoloStage, 'pass' | 'fail' | 'none'>
  lastTurnSummaries: Array<{
    turnNumber: number
    stage: YoloStage
    objective: string
    assetsCreated: number
    assetsUpdated: number
    summary: string
  }>
  assetInventory: Array<{
    id: string
    type: string
    createdByTurn: number
  }>
  mergedUserInputs: QueuedUserInput[]
  remainingBudget: {
    turns: number
    maxTurns: number
    tokens: number
    costUsd: number
  }
}

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
  action: YoloTurnAction
  tool_plan: PlannerToolPlanStep[]
  expected_output: string[]
  need_from_user: PlannerNeedFromUser
  done_definition: string
  risk_flags: string[]
}

export interface PlannerOutput {
  turnSpec: TurnSpec
  suggestedPrompt: string
  rationale: string
  uncertaintyNote: string
  planContract: PlannerContract
}

export interface TurnPlanner {
  generate(input: PlannerInput): Promise<PlannerOutput>
}

export interface AskUserRequest {
  id?: string
  question: string
  required?: boolean
  options?: string[]
  context?: string
  requiredFiles?: string[]
  referencedAssetIds?: string[]
  checkpoint?: 'problem-freeze' | 'baseline-freeze' | 'claim-freeze' | 'final-scope'
  blocking?: boolean
}

export interface ExternalWaitTask {
  id: string
  sessionId: string
  status: 'waiting' | 'satisfied' | 'canceled' | 'expired' | 'open' | 'resolved' | 'cancelled'
  stage?: YoloStage
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

export interface PendingResourceExtension {
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

export interface QueuedUserInput {
  id: string
  text: string
  priority: 'urgent' | 'normal'
  createdAt: string
  source: 'chat' | 'system'
}

export interface NewAssetInput {
  type: string
  payload: Record<string, unknown>
  supersedes?: string
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

export interface CoordinatorTurnMetrics {
  toolCalls: number
  wallClockSec: number
  stepCount: number
  readBytes: number
  promptTokens: number
  completionTokens: number
  turnTokens: number
  turnCostUsd: number
  discoveryOps: number
}

export interface CoordinatorToolCallSummary {
  tool: string
  argsPreview?: string
  resultPreview?: string
}

export interface CoordinatorToolingStatus {
  mode: 'full' | 'local-only'
  literatureEnabled: boolean
  enabledPacks: string[]
  degradeReason?: string
}

export interface CoordinatorExecutionTraceItem {
  tool: string
  reason: string
  result_summary: string
}

export interface CoordinatorTurnResult {
  action?: YoloTurnAction
  actionRationale?: string
  summary: string
  assets: NewAssetInput[]
  metrics: CoordinatorTurnMetrics
  askUser?: AskUserRequest
  executionTrace?: CoordinatorExecutionTraceItem[]
  toolCalls?: CoordinatorToolCallSummary[]
  tooling?: CoordinatorToolingStatus
}

export interface YoloCoordinator {
  runTurn(input: {
    turnSpec: TurnSpec
    stage: YoloStage
    goal: string
    mergedUserInputs: QueuedUserInput[]
    plannerOutput?: PlannerOutput
    reviewerOutput?: ReviewerProcessReview
    researchContext?: string
  }): Promise<CoordinatorTurnResult>
}

export interface SnapshotManifest {
  id: string
  stage: YoloStage
  assetIds: string[]
  evidenceLinkIds: string[]
  lean?: {
    experimentRequestCount: number
    experimentRequestExecutableCount: number
    experimentRequestValidationFailures: Array<{
      assetId: string
      missingFields: string[]
      warnings: string[]
    }>
    resultInsightCount: number
    resultInsightLinkedCount: number
    literatureNoteCount: number
  }
  claimCoverage?: {
    assertedPrimary: number
    assertedSecondary: number
    coveredPrimary: number
    coveredSecondary: number
  }
  claimGovernance?: {
    assertedClaims: number
    claimFreezeDecisionCount: number
  }
  claimDecisionBinding?: {
    assertedClaimCount: number
    assertedClaimWithFreezeRefCount: number
    missingFreezeRefClaimIds: string[]
  }
  reproducibility?: {
    keyRunRecordCount: number
    keyRunRecordWithCompleteTripleCount: number
    missingRunRecordRefs: string[]
    runRecordsMissingTriple: string[]
  }
  evidencePolicy?: {
    crossBranchCountableLinkIds: string[]
    keyRunMissingParityContractLinkIds: string[]
    invalidCountableLinkIds: string[]
  }
  causality?: {
    requiredClaims: number
    satisfiedClaims: number
    interventionLinkCount: number
    counterfactualLinkCount: number
    correlationOnlyLinkCount: number
    missingClaimIds: string[]
  }
  directEvidence?: {
    requiredClaims: number
    satisfiedClaims: number
    missingClaimIds: string[]
  }
  branchNodeId: string
  planSnapshotHash: string
  generatedAtTurn: number
}

export interface GateResult {
  stage: string
  passed: boolean
  structuralChecks: { name: string; passed: boolean; detail?: string }[]
  hardBlockers: { label: string; assetRefs: string[] }[]
  advisoryNotes: string[]
}

export interface GateEngine {
  evaluate(manifest: SnapshotManifest): GateResult
}

export type AnchoredHardBlockerLabel =
  | 'claim_without_direct_evidence'
  | 'causality_gap'
  | 'parity_violation_unresolved'
  | 'reproducibility_gap'
  | 'overclaim'

export type ReviewerPersona = 'Novelty' | 'System' | 'Evaluation' | 'Writing'

export interface ReviewerHardBlockerVote {
  label: AnchoredHardBlockerLabel
  citations: string[]
  assetRefs: string[]
}

export type ReviewerVerdict = 'pass' | 'revise' | 'block'

export interface ReviewerCriticalIssue {
  id: string
  severity: 'high' | 'medium' | 'low'
  message: string
}

export interface ReviewerFixPlanItem {
  issue_id: string
  action: string
}

export interface ReviewerRewritePatch {
  apply: boolean
  target: 'planner_output' | 'coordinator_output'
  patch: Record<string, unknown>
}

export interface ReviewerProcessReview {
  verdict: ReviewerVerdict
  critical_issues: ReviewerCriticalIssue[]
  fix_plan: ReviewerFixPlanItem[]
  rewrite_patch: ReviewerRewritePatch
  confidence: number
  notes_for_user: string
}

export interface ReviewerPass {
  persona: ReviewerPersona
  notes: string[]
  hardBlockers: ReviewerHardBlockerVote[]
  processReview?: ReviewerProcessReview
}

export interface ConsensusBlocker {
  label: AnchoredHardBlockerLabel
  voteCount: number
  personas: ReviewerPersona[]
  citations: string[]
  assetRefs: string[]
}

export interface SemanticReviewResult {
  enabled: boolean
  reviewerPasses: ReviewerPass[]
  consensusBlockers: ConsensusBlocker[]
  advisoryNotes: string[]
  processReview?: ReviewerProcessReview
}

export interface ReviewEngine {
  evaluate(input: {
    stage: YoloStage
    manifest: SnapshotManifest
    gateResult: GateResult
    plannerOutput?: PlannerOutput
    coordinatorOutput?: CoordinatorTurnResult
    researchContext?: string
  }): SemanticReviewResult | Promise<SemanticReviewResult>
  destroy?(): Promise<void>
}

export type YoloEventType =
  | 'turn_started'
  | 'turn_committed'
  | 'asset_created'
  | 'asset_updated'
  | 'branch_mutated'
  | 'gate_evaluated'
  | 'state_transition'
  | 'user_input_merged'
  | 'ask_user_emitted'
  | 'checkpoint_confirmed'
  | 'amendment_requested'
  | 'planner_spec_generated'
  | 'semantic_review_evaluated'
  | 'maintenance_alert'
  | 'crash_recovery'

export interface YoloEventPayloadByType {
  turn_started: { objective: string; stage: YoloStage }
  turn_committed: { turnNumber: number; attempt: number; createdAssetIds: string[]; snapshotManifestId: string }
  asset_created: { assetId: string; type: string }
  asset_updated: { assetId: string; supersedes: string }
  branch_mutated: { action: TurnSpec['branch']['action']; activeNodeId: string; branchId: string }
  gate_evaluated: { stage: YoloStage; passed: boolean; hardBlockerLabels: string[]; manifestId: string }
  state_transition: { from: YoloRuntimeState; to: YoloRuntimeState; reason?: string }
  user_input_merged: { mergedIds: string[] }
  ask_user_emitted: { questionId: string; blocking: boolean; checkpoint?: AskUserRequest['checkpoint'] }
  checkpoint_confirmed: { decisionAssetId: string; checkpoint: NonNullable<AskUserRequest['checkpoint']> }
  amendment_requested: { reason: string }
  planner_spec_generated: { objective: string; stage: YoloStage; action: TurnSpec['branch']['action'] }
  semantic_review_evaluated: {
    stage: YoloStage
    reviewerCount: number
    consensusBlockerLabels: AnchoredHardBlockerLabel[]
  }
  maintenance_alert: {
    kind:
      | 'asset_chain_integrity'
      | 'wait_task_reminder'
      | 'wait_task_escalation'
      | 'budget_drift_warning'
      | 'budget_drift_critical'
      | 'gate_regression'
      | 'readiness_gate_failure'
    severity: 'warning' | 'error'
    message: string
    refs?: string[]
  }
  crash_recovery: { cleanedStagingFiles: string[]; lastDurableTurn: number }
}

export interface YoloEvent<T extends YoloEventType = YoloEventType> {
  eventId: string
  sessionId: string
  turnNumber: number
  seq: number
  timestamp: string
  schemaVersion: number
  eventType: T
  payload: YoloEventPayloadByType[T]
}

export interface PlannerInputManifest {
  planSnapshotHash: string
  branchDossierHash: string
  selectedAssetSnapshotIds: string[]
}

export interface ReadinessSnapshot {
  checkedAt: string
  stage: YoloStage
  gates: Record<
    'TG0' | 'TG1' | 'TG2' | 'TG3' | 'TG4',
    {
      required: boolean
      passed: boolean
      detail: string
    }
  >
  requiredFailed: Array<'TG0' | 'TG1' | 'TG2' | 'TG3' | 'TG4'>
  pass: boolean
}

export interface TurnReport {
  turnNumber: number
  attempt: number
  startedAt: string
  finishedAt: string
  turnSpec: TurnSpec
  plannerSpec: PlannerOutput
  consumedBudgets: {
    toolCalls: number
    wallClockSec: number
    stepCount: number
    readBytes: number
    promptTokens: number
    completionTokens: number
    turnTokens: number
    turnCostUsd: number
    discoveryOps: number
  }
  assetDiff: {
    created: string[]
    updated: Array<{ newId: string; supersedes: string }>
    linked: string[]
  }
  branchDiff: {
    activeNode: string
    action: TurnSpec['branch']['action']
    createdNodes: string[]
    mergedNodes: string[]
    prunedNodes: string[]
  }
  gateImpact: {
    status: 'none' | 'pass' | 'fail' | 'rollback-needed'
    gateResult: GateResult
    snapshotManifest: SnapshotManifest
  }
  reviewerSnapshot:
    | {
        status: 'not-run'
        notes: string[]
      }
    | {
        status: 'completed'
        reviewerPasses: ReviewerPass[]
        consensusBlockers: ConsensusBlocker[]
        processReview?: ReviewerProcessReview
        notes: string[]
      }
  riskDelta: string[]
  nextStepRationale: string
  mergedUserInputIds: string[]
  nonProgress: boolean
  plannerInputManifest: PlannerInputManifest
  readinessSnapshot?: ReadinessSnapshot
  summary: string
  execution?: {
    action?: YoloTurnAction
    actionRationale?: string
    executionTrace?: CoordinatorExecutionTraceItem[]
    toolCalls?: CoordinatorToolCallSummary[]
    tooling?: CoordinatorToolingStatus
  }
}

export interface SessionPersistedState {
  sessionId: string
  goal: string
  state: YoloRuntimeState
  createdAt: string
  updatedAt: string
  currentTurn: number
  currentAttempt: number
  nonProgressTurns: number
  activeStage: YoloStage
  activeBranchId: string
  activeNodeId: string
  budgetUsed: {
    tokens: number
    costUsd: number
    turns: number
  }
  pendingQuestion?: AskUserRequest
  pendingExternalTaskId?: string
  pendingResourceExtension?: PendingResourceExtension
  gateFailureCounts?: Record<string, number>
  stageGateStatus?: Partial<Record<YoloStage, 'pass' | 'fail' | 'none'>>
  maintenance?: {
    lastAssetIntegrityHash?: string
    budgetAlertLevel?: 'none' | 'warning' | 'critical'
    waitTaskAlerts?: Record<
      string,
      {
        lastReminderAt?: string
        lastEscalationAt?: string
      }
    >
  }
}

export interface RuntimeLease {
  sessionId: string
  ownerId: string
  acquiredAt: string
  heartbeatAt: string
  staleAfterSec: number
  takeoverFromOwnerId?: string
  takeoverReason?: 'stale_lease' | 'restart_or_takeover' | 'heartbeat_reacquire'
}

export interface RuntimeCheckpoint {
  checkpointId: string
  createdAt: string
  trigger: 'init' | 'turn_complete' | 'state_transition' | 'crash_recovery' | 'periodic_rollup'
  turnNumber: number
  runtimeState: YoloRuntimeState
  activeStage: YoloStage
  activeBranchId: string
  activeNodeId: string
  pendingExternalTaskId?: string
  planSnapshotHash: string
  branchDossierHash: string
  sessionState: SessionPersistedState
}

export interface TurnExecutionResult {
  turnReport: TurnReport
  newState: YoloRuntimeState
  branchNode: BranchNode
}

export type ActivityEventKind =
  | 'planner_start'
  | 'planner_end'
  | 'coordinator_start'
  | 'coordinator_end'
  | 'reviewer_start'
  | 'reviewer_end'
  | 'tool_call'
  | 'tool_result'
  | 'llm_text'

export interface ActivityEvent {
  id: string
  timestamp: string
  kind: ActivityEventKind
  agent: 'planner' | 'coordinator' | 'reviewer'
  tool?: string
  preview?: string
}
