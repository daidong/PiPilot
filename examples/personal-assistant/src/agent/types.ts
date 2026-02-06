/**
 * Personal Assistant - Memory V2 Type Definitions (RFC-013)
 *
 * Canonical model:
 * - Artifact (authoritative source records)
 * - Fact (durable structured memory)
 * - Focus (session attention)
 * - TaskAnchor (execution continuity)
 */

// ============================================================================
// Path Constants
// ============================================================================

export const PATHS = {
  root: '.personal-assistant-v2',

  // Artifact storage (authoritative)
  artifactsRoot: '.personal-assistant-v2/artifacts',
  notes: '.personal-assistant-v2/artifacts/notes',
  todos: '.personal-assistant-v2/artifacts/todos',
  docs: '.personal-assistant-v2/artifacts/docs',
  emailMessages: '.personal-assistant-v2/artifacts/email-messages',
  emailThreads: '.personal-assistant-v2/artifacts/email-threads',
  calendarEvents: '.personal-assistant-v2/artifacts/calendar-events',
  schedulerRuns: '.personal-assistant-v2/artifacts/scheduler-runs',
  toolOutputs: '.personal-assistant-v2/artifacts/tool-outputs',

  // Runtime and cache
  sessions: '.personal-assistant-v2/sessions',
  cache: '.personal-assistant-v2/cache',
  documentCache: '.personal-assistant-v2/cache/documents',
  project: '.personal-assistant-v2/project.json',

  // Memory V2 runtime state
  memoryRoot: '.personal-assistant-v2/memory-v2',
  focusDir: '.personal-assistant-v2/memory-v2/focus',
  tasksDir: '.personal-assistant-v2/memory-v2/tasks',
  taskAnchor: '.personal-assistant-v2/memory-v2/tasks/anchor.json',
  artifactFactIndex: '.personal-assistant-v2/memory-v2/index/artifact-facts.json',
  explainDir: '.personal-assistant-v2/memory-v2/explain',

  // Scheduler / notifications
  scheduledTasks: '.personal-assistant-v2/scheduled-tasks.json',
  notifications: '.personal-assistant-v2/notifications.json'
} as const

// ============================================================================
// Scheduler Types
// ============================================================================

export interface ScheduledTask {
  id: string
  schedule: string
  instruction: string
  enabled: boolean
  lastRunAt?: string
  nextRunAt?: string
  createdBy: 'user' | 'agent' | 'system'
  createdAt: string
}

export interface AgentNotification {
  id: string
  type: 'info' | 'alert' | 'reminder'
  title: string
  body: string
  scheduledTaskId?: string
  createdAt: string
  readAt?: string
}

// ============================================================================
// Shared Types
// ============================================================================

export type ArtifactType =
  | 'note'
  | 'todo'
  | 'doc'
  | 'email-message'
  | 'email-thread'
  | 'calendar-event'
  | 'scheduler-run'
  | 'tool-output'

export interface Provenance {
  source: 'user' | 'agent' | 'import'
  sessionId: string
  agentId?: string
  extractedFrom?: 'agent-response' | 'user-input' | 'file-import' | 'tool-output'
  messageId?: string
}

export interface ArtifactBase {
  id: string
  type: ArtifactType
  title: string
  tags: string[]
  summary?: string
  contentRef?: string
  provenance: Provenance
  createdAt: string
  updatedAt: string
}

export interface NoteArtifact extends ArtifactBase {
  type: 'note'
  content: string
}

export interface TodoArtifact extends ArtifactBase {
  type: 'todo'
  content: string
  status: 'pending' | 'completed'
  completedAt?: string
}

export interface DocArtifact extends ArtifactBase {
  type: 'doc'
  filePath: string
  content?: string
  mimeType?: string
  description?: string
}

export interface EmailMessageArtifact extends ArtifactBase {
  type: 'email-message'
  accountEmail?: string
  messageId?: string
  threadId?: string
  from?: string
  to?: string[]
  cc?: string[]
  subject?: string
  snippet?: string
  bodyText?: string
  sentAt?: string
}

export interface EmailThreadArtifact extends ArtifactBase {
  type: 'email-thread'
  accountEmail?: string
  threadId: string
  participants?: string[]
  latestSubject?: string
  latestSnippet?: string
  messageCount?: number
  unreadCount?: number
}

export interface CalendarEventArtifact extends ArtifactBase {
  type: 'calendar-event'
  eventId?: string
  calendarName?: string
  startAt?: string
  endAt?: string
  location?: string
  attendees?: string[]
  notes?: string
}

export interface SchedulerRunArtifact extends ArtifactBase {
  type: 'scheduler-run'
  scheduledTaskId?: string
  instruction: string
  status: 'success' | 'failed'
  output?: string
  error?: string
  triggeredAt: string
}

export interface ToolOutputArtifact extends ArtifactBase {
  type: 'tool-output'
  toolName: string
  outputPath?: string
  outputText?: string
}

export type Artifact =
  | NoteArtifact
  | TodoArtifact
  | DocArtifact
  | EmailMessageArtifact
  | EmailThreadArtifact
  | CalendarEventArtifact
  | SchedulerRunArtifact
  | ToolOutputArtifact

// ============================================================================
// Fact / Focus / Task Anchor
// ============================================================================

export type FactStatus = 'proposed' | 'active' | 'superseded' | 'deprecated'

export interface FactProvenance {
  sourceType: 'file' | 'url' | 'turn' | 'tool' | 'user'
  sourceRef: string
  traceId?: string
  sessionId?: string
  createdBy?: 'user' | 'model' | 'system'
}

export interface FactRecord {
  id: string
  namespace: string
  key: string
  value: unknown
  valueText?: string
  status: FactStatus
  confidence: number
  provenance: FactProvenance
  derivedFromArtifactIds: string[]
  createdAt: string
  updatedAt: string
}

export type FocusRefType = 'artifact' | 'fact' | 'task'

export interface FocusEntry {
  id: string
  sessionId: string
  refType: FocusRefType
  refId: string
  reason: string
  score: number
  source: 'manual' | 'auto'
  ttl: string
  expiresAt: string
  createdAt: string
  updatedAt: string
}

export interface TaskAnchor {
  currentGoal: string
  nowDoing: string
  blockedBy: string[]
  nextAction: string
  updatedAt: string
  sessionId?: string
}

export interface FocusCooldown {
  sessionId: string
  refType: FocusRefType
  refId: string
  until: string
  reason: 'expired-auto-focus'
}

export interface FocusStateFile {
  entries: FocusEntry[]
  cooldowns: FocusCooldown[]
  updatedAt: string
}

export interface ArtifactFactIndex {
  updatedAt: string
  byArtifactId: Record<string, string[]>
}

// ============================================================================
// Project / Session / CLI Types
// ============================================================================

export interface UserCorrection {
  term: string
  meaning: string
  createdAt: string
}

export interface ProjectConfig {
  name: string
  description?: string
  questions: string[]
  userCorrections: UserCorrection[]
  createdAt: string
  updatedAt: string
}

export interface Session {
  id: string
  startedAt: string
  lastActivityAt: string
  messageCount: number
}

export interface CLIContext {
  sessionId: string
  projectPath: string
  lastAgentResponse?: string
  debug?: boolean
}

// ============================================================================
// Compatibility aliases (legacy callers)
// ============================================================================

export type Note = NoteArtifact
export type Todo = TodoArtifact
export type Doc = DocArtifact
export type Entity = Artifact
