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
  project: '.research-pilot/project.json',
  reviews: '.research-pilot/reviews'
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
 * Summary card generation method
 */
export type SummaryCardMethod = 'deterministic' | 'llm' | 'user'

/**
 * Base interface for all research entities (RFC-009)
 */
export interface ResearchEntity {
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
   * Source of Project Card status (auto vs manual)
   */
  projectCardSource?: 'auto' | 'manual'

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
  /** Direct link to the PDF */
  pdfUrl?: string
  /** Which API source provided enrichment (e.g. 'crossref', 'semantic_scholar') */
  enrichmentSource?: string
  /** ISO timestamp of when metadata enrichment was performed */
  enrichedAt?: string
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

// ============================================================================
// Literature Search v2 Types (RFC-008)
// ============================================================================

/**
 * Sub-topic within a search plan
 */
export interface SubTopic {
  name: string
  description: string
  priority: 'high' | 'medium' | 'low'
  expectedPaperCount: number
}

/**
 * A batch of queries targeting a specific sub-topic
 */
export interface QueryBatch {
  subTopic: string
  queries: string[]
  dblpQueries?: string[]
  sources: string[]
  priority: number
}

/**
 * Full search plan produced by the planner
 */
export interface SearchPlan {
  topic: string
  subTopics: SubTopic[]
  queryBatches: QueryBatch[]
  targetPaperCount: number
  minimumCoveragePerSubTopic: number
}

/**
 * Coverage tracker for cumulative review across batches
 */
export interface CoverageTracker {
  subTopics: Record<string, {
    papersFound: number
    targetMet: boolean
    bestPaperScore: number
    gaps: string[]
  }>
  totalRelevantPapers: number
  totalMarginalPapers: number
  coverageScore: number
}

/**
 * Filtered message from coordinator conversation
 */
export interface FilteredMessage {
  role: 'user' | 'assistant' | 'tool-result'
  content: string
  toolName?: string
}

/**
 * Context assembled for the planner agent
 */
export interface PlannerContext {
  request: string
  conversationHistory: FilteredMessage[]
  localLibrary: {
    totalPapers: number
    topicClusters: { topic: string; count: number; sampleTitles: string[] }[]
  }
}

/**
 * Compressed result returned from literature-search tool
 */
export interface LiteratureSearchResult {
  success: boolean
  data: {
    briefSummary: string
    coverage: {
      score: number
      subTopics: {
        name: string
        paperCount: number
        covered: boolean
        gaps: string[]
      }[]
      queriesExecuted: string[]
    }
    totalPapersFound: number
    papersAutoSaved: number
    fullReviewPath: string
    paperListPath: string
    durationMs: number
    llmCallCount: number
    apiCallCount: number
    apiFailureCount: number
  }
}
