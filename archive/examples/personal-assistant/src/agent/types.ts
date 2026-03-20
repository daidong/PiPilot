/**
 * Personal Assistant - Memory V2 Type Definitions (Minimal)
 *
 * Canonical model:
 * - Artifact (authoritative source records)
 * - SessionSummary (lightweight cross-turn continuity)
 */

// ============================================================================
// Agent.md Constants
// ============================================================================

export const AGENT_MD_ID = 'agent-md'
export const AGENT_MD_MAX_CHARS = 5000

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

  // Memory runtime state
  memoryRoot: '.personal-assistant-v2/memory-v2',
  sessionSummaries: '.personal-assistant-v2/memory-v2/session-summaries',
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

export interface SessionSummary {
  sessionId: string
  turnRange: [number, number]
  summary: string
  topicsDiscussed: string[]
  openQuestions: string[]
  createdAt: string
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
