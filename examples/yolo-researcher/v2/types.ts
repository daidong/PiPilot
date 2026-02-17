export type AtomicActionKind = 'Read' | 'Exec' | 'Edit' | 'Write' | 'Ask' | 'Stop'

export type FailureStatus = 'WARN' | 'BLOCKED' | 'UNBLOCKED'

export interface EvidenceLine {
  text: string
  evidencePath: string
}

export interface ProjectControlPanel {
  title: string
  goal: string
  successCriteria: string[]
  currentPlan: string[]
  facts: EvidenceLine[]
  archivedFacts: EvidenceLine[]
  constraints: EvidenceLine[]
  hypotheses: string[]
  keyArtifacts: string[]
  defaultRuntime: string
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

export interface TurnContext {
  turnNumber: number
  projectRoot: string
  yoloRoot: string
  runsDir: string
  project: ProjectControlPanel
  failures: FailureEntry[]
  recentTurns: RecentTurnContext[]
}

export interface ReadAction {
  kind: 'Read'
  targetPath: string
}

export interface ExecAction {
  kind: 'Exec'
  cmd: string
  runtime?: string
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
  alternatives?: string[]
  blockedOverrideReason?: string
}

export interface EditAction {
  kind: 'Edit'
  targetPath: string
  newContent: string
}

export interface WriteAction {
  kind: 'Write'
  targetPath: string
  content: string
}

export interface AskAction {
  kind: 'Ask'
  question: string
}

export interface StopAction {
  kind: 'Stop'
  reason: string
}

export type AtomicAction = ReadAction | ExecAction | EditAction | WriteAction | AskAction | StopAction

export interface ProjectUpdate {
  goal?: string
  successCriteria?: string[]
  currentPlan?: string[]
  facts?: EvidenceLine[]
  constraints?: EvidenceLine[]
  hypotheses?: string[]
  keyArtifacts?: string[]
  defaultRuntime?: string
}

export interface TurnDecision {
  intent: string
  expectedOutcome?: string
  action: AtomicAction
  projectUpdate?: ProjectUpdate
  updateSummary?: string[]
}

export interface YoloSingleAgent {
  decide(context: TurnContext): Promise<TurnDecision>
}

export interface ExecRequest {
  cmd: string
  runtime: string
  cwd: string
  timeoutMs?: number
  env?: Record<string, string>
}

export interface ExecOutcome {
  cmd: string
  runtime: string
  cwd: string
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  startedAt: string
  endedAt: string
}

export interface ToolRunner {
  runExec(input: ExecRequest): Promise<ExecOutcome>
}

export type TurnStatus = 'success' | 'failure' | 'blocked' | 'ask_user' | 'stopped'

export interface TurnExecutionResult {
  turnNumber: number
  turnDir: string
  status: TurnStatus
  intent: string
  action: AtomicAction
  summary: string
  evidencePaths: string[]
  blockedBy?: FailureEntry
}

export interface CreateYoloSessionConfig {
  projectPath: string
  projectId: string
  goal: string
  successCriteria?: string[]
  defaultRuntime?: string
  recentTurnsToLoad?: number
  agent: YoloSingleAgent
  toolRunner?: ToolRunner
  now?: () => Date
}
