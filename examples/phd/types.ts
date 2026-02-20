export type ProjectRuntimeState =
  | 'IDLE'
  | 'SCOPING'
  | 'EXECUTING'
  | 'AWAITING_REVIEW'
  | 'AWAITING_DECISION'
  | 'BLOCKED'
  | 'DELIVERING'

export type TaskStatus =
  | 'TODO'
  | 'DOING'
  | 'BLOCKED'
  | 'IN_REVIEW'
  | 'DONE'
  | 'DROPPED'

export type Priority = 'P0' | 'P1' | 'P2' | 'P3'
export type RiskLevel = 'low' | 'medium' | 'high'

export type RamEventType =
  | 'reviewable_artifact_ready'
  | 'decision_required'
  | 'blocked'
  | 'preflight_failed'
  | 'contradictory_evidence'
  | 'scope_drift'
  | 'milestone_completed'
  | 'risk_escalation'

export type ReviewAction = 'approve' | 'request_changes' | 'reject'

export type ReviewPacketType =
  | 'code_change'
  | 'experiment_result'
  | 'analysis_note'
  | 'decision_gate'
  | 'blocking_note'

export interface ProjectConstraints {
  budget: {
    max_cloud_cost_usd: number
    max_cpu_hours_per_batch: number
  }
  env: {
    allowed_exec: string[]
    forbidden_ops: string[]
  }
}

export interface TaskEstimate {
  time_hours: number
  risk: RiskLevel
}

export interface TaskItem {
  id: string
  title: string
  status: TaskStatus
  owner: 'agent' | 'user'
  priority: Priority
  estimate: TaskEstimate
  depends_on: string[]
  accept_criteria: string[]
  outputs: string[]
  blockers: string[]
  notes: string
}

export interface TaskBoard {
  project: {
    title: string
    topic: string
    constraints: ProjectConstraints
  }
  tasks: TaskItem[]
  metadata: {
    updated_at: string
    version: string
  }
}

export interface DeliverableItem {
  path: string
  kind: 'data' | 'figure' | 'script' | 'code' | 'note' | 'log' | 'other'
}

export interface ReviewAskItem {
  question: string
  type: 'choice' | 'text'
  options?: string[]
}

export interface PreflightCheck {
  name: string
  status: 'pass' | 'fail'
  log?: string
}

export interface ReviewPacket {
  packet_id: string
  type: ReviewPacketType
  title: string
  event_type: RamEventType
  created_at: string
  task_ids: string[]
  summary: string
  what_changed: string[]
  scope: {
    repo_changes: boolean
    data_paths: string[]
    env: string
    cost: {
      cpu_hours: number
      cloud_usd: number
    }
  }
  deliverables: DeliverableItem[]
  evidence_refs: string[]
  reproduce: {
    commands: string[]
    environment_capture?: string
  }
  preflight: {
    status: 'pass' | 'fail' | 'not_run'
    checks: PreflightCheck[]
  }
  risks: string[]
  ask: ReviewAskItem[]
  recommendation?: {
    suggested_user_action: ReviewAction
    rationale: string
  }
  rollback_plan: string[]
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected'
}

export interface EvidenceRecord {
  eid: string
  type: 'experiment_log' | 'tool_event' | 'artifact' | 'preflight_log' | 'analysis_note'
  title: string
  path: string
  packet_id: string
  timestamp: string
  provenance: {
    source: 'system' | 'agent' | 'tool'
    tool?: string
    cmd?: string
    commit?: string
    env_capture?: string
  }
}

export interface RuntimeLedgerState {
  project_state: ProjectRuntimeState
  last_event?: RamEventType
  next_packet_seq: number
  next_decision_seq: number
  next_evidence_seq: number
  last_run_mode: 'llm'
  updated_at: string
}

export interface DecisionRecord {
  decision_id: string
  created_at: string
  packet_id: string
  action: ReviewAction
  comment: string
  task_ids: string[]
  impacts: string[]
}

export interface EventRecord {
  timestamp: string
  type: RamEventType | 'review_action'
  packet_id?: string
  task_ids?: string[]
  message: string
}

export interface AgentTaskUpdate {
  task_id: string
  status: Extract<TaskStatus, 'DOING' | 'BLOCKED' | 'IN_REVIEW'>
  note?: string
  accept_criteria_add?: string[]
}

export interface ExploreTurnDraft {
  event_type: RamEventType
  type: ReviewPacketType
  title: string
  summary: string
  what_changed: string[]
  scope: {
    repo_changes: boolean
    data_paths: string[]
    env: string
    cost: {
      cpu_hours: number
      cloud_usd: number
    }
  }
  deliverables: DeliverableItem[]
  reproduce_commands: string[]
  preflight?: {
    status: 'pass' | 'fail' | 'not_run'
    checks: PreflightCheck[]
  }
  risks: string[]
  ask: ReviewAskItem[]
  recommendation?: {
    suggested_user_action: ReviewAction
    rationale: string
  }
  rollback_plan: string[]
  task_updates?: AgentTaskUpdate[]
  evidence_paths?: string[]
}

export interface ExploreTurnResult {
  draft: ExploreTurnDraft
  rawOutput: string
  toolEvents: ToolEvent[]
}

export interface ToolEvent {
  timestamp: string
  phase: 'call' | 'result'
  tool: string
  input?: unknown
  result?: unknown
  success?: boolean
  error?: string
}

export interface InboxEntry {
  packet_id: string
  title: string
  type: ReviewPacketType
  risk: RiskLevel
  scope_summary: string
  ask_summary: string
}

export type MemoryEntryType =
  | 'fact'
  | 'constraint'
  | 'decision'
  | 'artifact'
  | 'risk'
  | 'question'
  | 'note'

export interface MemoryEntry {
  id: string
  type: MemoryEntryType
  text: string
  packet_id?: string
  decision_id?: string
  task_ids: string[]
  evidence_paths: string[]
  created_at: string
}

export interface MemoryStoreState {
  next_seq: number
  updated_at: string
}

export interface MemoryDigest {
  latest_facts: string[]
  latest_constraints: string[]
  latest_decisions: string[]
  open_questions: string[]
  key_artifacts: string[]
}
