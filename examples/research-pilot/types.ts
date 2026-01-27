/**
 * Research Pilot - Type Definitions
 *
 * Research entity types with provenance tracking.
 * Path constants for file storage.
 */

// ============================================================================
// Path Constants
// ============================================================================

export const PATHS = {
  root: '.research-pilot',
  notes: '.research-pilot/notes',
  literature: '.research-pilot/literature',
  data: '.research-pilot/data',
  sessions: '.research-pilot/sessions',
  project: '.research-pilot/project.json'
} as const

// ============================================================================
// Base Entity Types
// ============================================================================

/**
 * Provenance tracking for all research entities
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
 * Base interface for all research entities
 */
export interface ResearchEntity {
  id: string
  createdAt: string
  updatedAt: string
  tags: string[]
  /** Auto-include in every context (pinned phase) */
  pinned: boolean
  /** User-selected for current request (selected phase) */
  selectedForAI: boolean
  provenance: Provenance
}

// ============================================================================
// Entity Types
// ============================================================================

/**
 * Note - User-created research notes
 */
export interface Note extends ResearchEntity {
  type: 'note'
  title: string
  content: string
}

/**
 * Literature - Academic papers and references
 */
export interface Literature extends ResearchEntity {
  type: 'literature'
  title: string
  authors: string[]
  abstract: string
  year?: number
  venue?: string
  url?: string
  citeKey: string
}

/**
 * DataAttachment - Data files with schema
 */
export interface DataAttachment extends ResearchEntity {
  type: 'data'
  name: string
  filePath: string
  mimeType?: string
  schema?: DataSchema
}

/**
 * Schema for data files
 */
export interface DataSchema {
  columns?: Array<{
    name: string
    type: string
    description?: string
  }>
  rowCount?: number
  description?: string
}

/**
 * Union type for all entity types
 */
export type Entity = Note | Literature | DataAttachment

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
