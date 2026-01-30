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
  cache: '.research-pilot/cache',
  documentCache: '.research-pilot/cache/documents',
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
  // Search metadata (added for local paper caching)
  /** Terms that led to this paper being discovered */
  searchKeywords?: string[]
  /** Source where paper was found: 'semantic_scholar' | 'arxiv' | 'openalex' | 'dblp' | 'local' */
  externalSource?: string
  /** Relevance score from reviewer (0-10) */
  relevanceScore?: number
  /** Citation count if available from source */
  citationCount?: number
  /** Digital Object Identifier for deduplication */
  doi?: string
  /** Full BibTeX entry for citation export */
  bibtex?: string
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
  /** Groups auto-generated outputs under the same analysis run */
  runId?: string
  /** Human-readable label for the analysis run */
  runLabel?: string
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

// ============================================================================
// Data Analysis Types (RFC-006)
// ============================================================================

/**
 * Detailed column schema with per-column statistics from rich inference
 */
export interface ColumnSchemaDetailed {
  name: string
  /** pandas dtype string */
  dtype: string
  /** Fraction of missing values (0.0–1.0) */
  missingRate: number
  /** Most frequent values with counts (categorical columns) */
  topKValues?: Array<{ value: string; count: number }>
  min?: number
  max?: number
  mean?: number
}

/**
 * Manifest describing all outputs produced by an analysis run
 */
export interface ResultsManifest {
  outputs: Array<{
    path: string
    type: 'figure' | 'table' | 'data'
    title: string
    description?: string
    tags?: string[]
  }>
  summary: Record<string, unknown>
  warnings: string[]
}
