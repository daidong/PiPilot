export type FailureStatus = 'WARN' | 'BLOCKED' | 'UNBLOCKED'

export type PlanItemStatus = 'TODO' | 'ACTIVE' | 'DONE' | 'BLOCKED' | 'DROPPED'

export type OrchestrationMode = 'auto' | 'artifact_gravity_v3_paper'
export type ResolvedOrchestrationMode = 'artifact_gravity_v3_paper'

export interface NorthStarContract {
  filePath: string
  goal: string
  currentObjective: string
  objectiveId: string
  objectiveVersion: number
  artifactType: string
  artifactGate: 'any' | 'all'
  artifactPaths: string[]
  paperArtifactPathsEligible: boolean
  internalCheckCommands: string[]
  internalCheckGate: 'any' | 'all'
  internalCheckAllowlistValid: boolean
  externalCheckCommands: string[]
  externalCheckGate: 'any' | 'all'
  externalCheckAllowlistValid: boolean
  externalCheckRequireEvery: number
  scoreboardMetricPaths: string[]
  scoreboardMetricPathsValid: boolean
  scoreboardMetricPathsInvalid: string[]
  realityCheckCommands: string[]
  realityCheckGate: 'any' | 'all'
  realityCheckAllowlistValid: boolean
  verifyCmd?: string
  verifySuccessSignal?: string
  semanticReviewPolicy: {
    mode: NorthStarSemanticGateMode
    confidenceThreshold: number
    allowUpgrade: boolean
    requiredActionBudgetPerTurn: number
    mustActionMaxOpen: number
    recentWindowTurns: number
  }
  nextAction: string
}

export interface PlanBoardItem {
  id: string
  title: string
  status: PlanItemStatus
  doneDefinition: string[]
  evidencePaths: string[]
  nextMinStep?: string
  dropReason?: string
  replacedBy?: string | null
  priority: number
}

export interface PlannerCheckpointInfo {
  due: boolean
  reasons: string[]
}

export interface StagnationInfo {
  stagnant: boolean
  dominantAction: string
  count: number
  window: number
}

export type ResearchStage = 'S1' | 'S2' | 'S3' | 'S4' | 'S5'

export interface DeliverableRequirement {
  stage: ResearchStage
  label: string
  patterns: string[]  // at least one must match in artifact dirs
}

export interface StageStatus {
  currentStage: ResearchStage
  label: string
  missingDeliverables: string[]
  completedDeliverables: string[]
}

export interface ClaimEvidence {
  claim: string
  evidencePaths: string[]
  status: 'uncovered' | 'partial' | 'covered'
}

export interface EvidenceLine {
  text: string
  evidencePath: string
}

export interface ProjectControlPanel {
  title: string
  goal: string
  successCriteria: string[]
  planBoard: PlanBoardItem[]
  currentPlan: string[]
  facts: EvidenceLine[]
  archivedFacts: EvidenceLine[]
  done: EvidenceLine[]
  constraints: EvidenceLine[]
  hypotheses: string[]
  keyArtifacts: string[]
  defaultRuntime: string
  claims: ClaimEvidence[]
}

export interface FailureEntry {
  status: FailureStatus
  runtime: string
  cmd: string
  fingerprint: string
  errorLine: string
  was?: string
  resolved?: string
  evidencePath: string
  attempts: number
  alternatives: string[]
  updatedAt: string
}

export interface RecentTurnContext {
  turnNumber: number
  actionPath: string
  summary: string
}

export interface QueuedUserInput {
  id: string
  text: string
  submittedAt: string
}

export interface PendingUserInput extends QueuedUserInput {
  evidencePath: string
}

export type EvidenceTrustState = 'claimed_only' | 'stale_or_missing'

export interface EvidenceTrustHint {
  path: string
  state: EvidenceTrustState
  reason: string
  sourceTurn?: number
}

export interface TurnContext {
  turnNumber: number
  projectRoot: string
  yoloRoot: string
  runsDir: string
  orchestrationMode?: ResolvedOrchestrationMode
  northStar?: NorthStarContract
  northStarPivotAllowed?: boolean
  workspaceGitRepos?: string[]
  project: ProjectControlPanel
  failures: FailureEntry[]
  recentTurns: RecentTurnContext[]
  pendingUserInputs: PendingUserInput[]
  trustedEvidencePaths?: string[]
  untrustedEvidenceHints?: EvidenceTrustHint[]
  stagnation?: StagnationInfo
  plannerCheckpoint?: PlannerCheckpointInfo
  northStarSemantic?: {
    lastVerdict: 'advance_confirmed' | 'advance_weak' | 'no_progress' | 'regress' | 'abstain' | 'none'
    reasonCodes: string[]
    openRequiredActions: NorthStarSemanticGateRequiredAction[]
    claimAuditDebt: string[]
    derivedVerdict?: 'advance_confirmed' | 'advance_weak' | 'no_progress' | 'regress' | 'abstain' | 'none'
  }
}

export interface ProjectUpdate {
  goal?: string
  successCriteria?: string[]
  planBoard?: PlanBoardItem[]
  currentPlan?: string[]
  facts?: EvidenceLine[]
  done?: EvidenceLine[]
  constraints?: EvidenceLine[]
  hypotheses?: string[]
  keyArtifacts?: string[]
  defaultRuntime?: string
  claims?: ClaimEvidence[]
}

export interface ToolEventRecord {
  timestamp: string
  phase: 'call' | 'result'
  tool: string
  input?: unknown
  result?: unknown
  success?: boolean
  error?: string
}

export type NorthStarSemanticGateMode = 'off' | 'shadow' | 'enforce_downgrade_only' | 'enforce_balanced'

export interface NorthStarSemanticGateConfig {
  mode?: NorthStarSemanticGateMode
  confidenceThreshold?: number
  model?: string
  maxInputChars?: number
  allowUpgrade?: boolean
  requiredActionBudgetPerTurn?: number
  mustActionMaxOpen?: number
  recentWindowTurns?: number
}

export interface NorthStarSemanticGateDimensionScores {
  goal_alignment: 0 | 1 | 2
  evidence_strength: 0 | 1 | 2
  novelty_delta: 0 | 1 | 2
  falsifiability: 0 | 1 | 2
  trajectory_health: 0 | 1 | 2
}

export interface NorthStarSemanticGateRequiredAction {
  tier: 'must_candidate' | 'must' | 'should' | 'suggest'
  code: string
  description: string
  due_turn?: number
  source_tier?: 'must_candidate' | 'should' | 'suggest'
  promotion_trigger_codes?: string[]
  promotion_notes?: string[]
}

export interface NorthStarSemanticGateInput {
  schema: 'yolo.northstar_semantic_gate.input.v1'
  turn: {
    id: string
    number: number
  }
  mode: NorthStarSemanticGateMode
  deterministic: {
    status: TurnStatus
    blocked_reason: string | null
    hard_violations: string[]
    northstar_gate_satisfied: boolean
  }
  northstar: {
    goal: string
    current_objective: string
    objective_id: string
    objective_version: number
    artifacts: string[]
    scoreboard_paths: string[]
  }
  delta: {
    artifact_changes: string[]
    scoreboard_before: Record<string, number>
    scoreboard_after: Record<string, number>
    change_proof: {
      patch_path: string | null
      patch_hunks_count: number
      placeholder_patch_detected: boolean
      touched_files: string[]
      file_deltas: Array<{
        path: string
        before_hash: string
        after_hash: string
        content_changed: boolean
        nontrivial_change_detected: boolean
        nontrivial_change_rules: string[]
        added_lines: number
        removed_lines: number
      }>
    }
  }
  content_snapshots: Array<{
    path: string
    kind: 'text' | 'binary' | 'directory' | 'other' | 'missing'
    source: 'runtime_snapshot'
    before_hash: string
    after_hash: string
    before_excerpt?: string
    after_excerpt?: string
    structured_summary?: Record<string, number>
  }>
  claim_quality: {
    claims_total: number
    claims_marked_verified: number
    claims_verified_with_valid_evidence: number
    claims_marked_verified_with_invalid_evidence: number
    evidence_valid_coverage: number
    source_metric_path: string
  }
  checks: {
    internal_executed: string[]
    internal_succeeded: string[]
    external_executed: string[]
    external_succeeded: string[]
  }
  recent_turns: Array<{
    turn: number
    status: string
    semantic_verdict: 'advance_confirmed' | 'advance_weak' | 'no_progress' | 'regress' | 'abstain' | 'none'
    summary: string
  }>
  recent_objectives: Array<{
    turn: number
    objective_id: string
    objective_version: number
    change_reason: 'pivot_due_to_regress' | 'scope_narrowing' | 'new_constraint' | 'external_feedback' | 'objective_stable'
  }>
  pivot_context: {
    is_explicit_pivot_turn: boolean
    pivot_reason: 'pivot_due_to_regress' | 'scope_narrowing' | 'new_constraint' | 'external_feedback' | 'objective_stable'
    pivot_evidence_paths: string[]
    pivot_approved_by_policy: boolean
  }
  evidence_refs: {
    trusted_paths: string[]
    business_artifacts: string[]
  }
}

export interface NorthStarSemanticGateOutput {
  schema?: 'yolo.northstar_semantic_gate.output.v1'
  confidence: number
  dimension_scores?: Partial<NorthStarSemanticGateDimensionScores>
  reason_codes?: string[]
  claim_audit?: {
    supported_ids?: string[]
    unsupported_ids?: string[]
    contradicted_ids?: string[]
  }
  required_actions?: NorthStarSemanticGateRequiredAction[]
  summary?: string
  verdict?: 'advance_confirmed' | 'advance_weak' | 'no_progress' | 'regress' | 'abstain'
}

export type NorthStarSemanticGateEvaluator = (input: NorthStarSemanticGateInput) => Promise<NorthStarSemanticGateOutput>

export interface TurnRunOutcome {
  intent: string
  status: 'success' | 'failure' | 'ask_user' | 'stopped'
  summary: string
  primaryAction?: string
  repoId?: string
  activePlanId?: string
  statusChange?: string
  delta?: string
  evidencePaths?: string[]
  dropReason?: string
  replacedBy?: string | null
  askQuestion?: string
  stopReason?: string
  projectUpdate?: ProjectUpdate
  updateSummary?: string[]
  toolEvents?: ToolEventRecord[]
  rawOutput?: string
}

export interface YoloSingleAgent {
  runTurn: (context: TurnContext) => Promise<TurnRunOutcome>
}

export type TurnStatus = 'success' | 'failure' | 'blocked' | 'ask_user' | 'stopped' | 'no_delta'

export interface TurnExecutionResult {
  turnNumber: number
  turnDir: string
  status: TurnStatus
  intent: string
  primaryAction: string
  activePlanId?: string
  toolEventsCount: number
  summary: string
  evidencePaths: string[]
  blockedBy?: FailureEntry
  stageStatus?: StageStatus
}

export interface CreateYoloSessionConfig {
  projectPath: string
  goal: string
  successCriteria?: string[]
  defaultRuntime?: string
  orchestrationMode?: OrchestrationMode
  recentTurnsToLoad?: number
  agent: YoloSingleAgent
  northStarSemanticGate?: NorthStarSemanticGateConfig
  northStarSemanticGateEvaluator?: NorthStarSemanticGateEvaluator
  pathAnchor?: {
    audit?: boolean
    mode?: 'recover' | 'fail'
  }
  requireRepoTarget?: boolean
  artifactUriPreferred?: boolean
  now?: () => Date
}
