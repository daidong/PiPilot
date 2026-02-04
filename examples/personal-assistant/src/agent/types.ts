/**
 * Personal Assistant - Type Definitions
 *
 * Entity types with provenance tracking.
 * Path constants for file storage.
 */

// ============================================================================
// Path Constants
// ============================================================================

export const PATHS = {
  root: '.personal-assistant',
  notes: '.personal-assistant/notes',
  docs: '.personal-assistant/docs',
  todos: '.personal-assistant/todos',
  sessions: '.personal-assistant/sessions',
  cache: '.personal-assistant/cache',
  documentCache: '.personal-assistant/cache/documents',
  project: '.personal-assistant/project.json',
  memory: '.personal-assistant/memory',
  memoryFile: '.personal-assistant/MEMORY.md',
  userProfile: '.personal-assistant/USER.md',
  scheduledTasks: '.personal-assistant/scheduled-tasks.json',
  notifications: '.personal-assistant/notifications.json'
} as const

// ============================================================================
// Scheduler Types
// ============================================================================

/**
 * A scheduled task persisted to disk
 */
export interface ScheduledTask {
  id: string
  /** Cron expression e.g. "0 2 * * *" */
  schedule: string
  /** What the agent should do when this fires */
  instruction: string
  enabled: boolean
  lastRunAt?: string
  nextRunAt?: string
  createdBy: 'user' | 'agent' | 'system'
  createdAt: string
}

/**
 * A notification from scheduled/proactive agent actions
 */
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
// Base Entity Types
// ============================================================================

/**
 * Provenance tracking for all entities
 */
export interface Provenance {
  /** How the entity was created */
  source: 'user' | 'agent' | 'import'
  /** Session where entity was created */
  sessionId: string
  /** Agent that created it (if source is 'agent') */
  agentId?: string
  /** Where content was extracted from */
  extractedFrom?: 'agent-response' | 'user-input' | 'file-import'
  /** Chat message ID this entity was derived from */
  messageId?: string
}

/**
 * Summary card generation method
 */
export type SummaryCardMethod = 'deterministic' | 'llm' | 'user'

/**
 * Base interface for all entities (RFC-009)
 */
export interface BaseEntity {
  id: string
  createdAt: string
  updatedAt: string
  tags: string[]

  /**
   * Project Card flag - marks entity for long-term memory inclusion
   * Replaces old 'pinned' field. Project Cards represent core decisions
   * and constraints that should persist across sessions.
   */
  projectCard: boolean

  /**
   * Summary card content (≤300 tokens)
   * Used for context assembly and retrieval.
   */
  summaryCard?: string

  /**
   * Method used to generate the summary card
   */
  summaryCardMethod?: SummaryCardMethod

  /**
   * Hash of content for summary card change detection
   */
  summaryCardHash?: string

  // Legacy fields (deprecated, for migration)
  /** @deprecated Use projectCard instead */
  pinned?: boolean
  /** @deprecated Selection is now runtime-only (WorkingSet) */
  selectedForAI?: boolean

  provenance: Provenance
}

// ============================================================================
// Entity Types
// ============================================================================

/**
 * Note - User-created notes
 */
export interface Note extends BaseEntity {
  type: 'note'
  title: string
  content: string
}

/**
 * Todo - Trackable task items
 */
export interface Todo extends BaseEntity {
  type: 'todo'
  title: string
  content: string
  status: 'pending' | 'completed'
  completedAt?: string
}

/**
 * Doc - Document references (files, converted docs, etc.)
 */
export interface Doc extends BaseEntity {
  type: 'doc'
  title: string
  filePath: string
  content?: string
  mimeType?: string
  description?: string
}

/**
 * Union type for all entity types
 */
export type Entity = Note | Todo | Doc

// ============================================================================
// Project Configuration
// ============================================================================

/**
 * User correction for terminology or preferences
 */
export interface UserCorrection {
  term: string
  meaning: string
  createdAt: string
}

/**
 * Project configuration (stored in project.json)
 */
export interface ProjectConfig {
  name: string
  description?: string
  questions: string[]
  userCorrections: UserCorrection[]
  createdAt: string
  updatedAt: string
}

// ============================================================================
// Session Types
// ============================================================================

/**
 * Session metadata
 */
export interface Session {
  id: string
  startedAt: string
  lastActivityAt: string
  messageCount: number
}

// ============================================================================
// CLI Context
// ============================================================================

/**
 * Context passed to CLI command handlers
 */
export interface CLIContext {
  sessionId: string
  projectPath: string
  lastAgentResponse?: string
  debug?: boolean
}
