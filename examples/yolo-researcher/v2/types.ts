export type FailureStatus = 'WARN' | 'BLOCKED' | 'UNBLOCKED'

export type PlanItemStatus = 'TODO' | 'ACTIVE' | 'DONE' | 'BLOCKED' | 'DROPPED'

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

export interface TurnContext {
  turnNumber: number
  projectRoot: string
  yoloRoot: string
  runsDir: string
  workspaceGitRepos?: string[]
  project: ProjectControlPanel
  failures: FailureEntry[]
  recentTurns: RecentTurnContext[]
  pendingUserInputs: PendingUserInput[]
  stagnation?: StagnationInfo
  plannerCheckpoint?: PlannerCheckpointInfo
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

export type SemanticGateMode = 'off' | 'shadow' | 'enforce_touch_only' | 'enforce_success'

export interface SemanticGateConfig {
  mode?: SemanticGateMode
  confidenceThreshold?: number
  model?: string
  maxInputChars?: number
}

export interface SemanticGateTouchedDeliverable {
  id: string
  evidence_refs: string[]
  reason_codes?: string[]
}

export interface SemanticGateInput {
  schema: 'yolo.semantic_gate.input.v1'
  turn: {
    id: string
    number: number
  }
  active_plan_id: string | null
  deterministic: {
    status: TurnStatus
    blocked_reason: string | null
  }
  plan: {
    done_definition: string[]
    deliverables: string[]
  }
  evidence_summary: {
    explicit_evidence_paths: string[]
    business_artifacts: string[]
    workspace_write_touches: string[]
    changed_files_count: number
    has_patch: boolean
    cmd_exit_code: number
  }
  repo_constraints: {
    hard_violations: string[]
    coding_large_repo_required: boolean
  }
}

export interface SemanticGateOutput {
  schema?: 'yolo.semantic_gate.output.v1'
  verdict: 'touched' | 'not_touched' | 'abstain'
  confidence: number
  touched_deliverables?: SemanticGateTouchedDeliverable[]
  notes?: string
}

export type SemanticGateEvaluator = (input: SemanticGateInput) => Promise<SemanticGateOutput>

export interface TurnRunOutcome {
  intent: string
  status: 'success' | 'failure' | 'ask_user' | 'stopped'
  summary: string
  primaryAction?: string
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
  recentTurnsToLoad?: number
  agent: YoloSingleAgent
  semanticGate?: SemanticGateConfig
  semanticGateEvaluator?: SemanticGateEvaluator
  now?: () => Date
}
