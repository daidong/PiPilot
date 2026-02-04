/**
 * Memory Entity Types - RFC-009 Project Cards + WorkingSet
 *
 * Simplified entity schema that replaces overloaded pin semantics:
 * - projectCard: boolean - persistent flag for long-term alignment
 * - summaryCard: string - bounded summary for context assembly
 * - WorkingSet is runtime-only (not stored in entity)
 */

// ============ Provenance ============

/**
 * Provenance - tracks where an entity came from
 */
export interface EntityProvenance {
  /** How the entity was created */
  source: 'user' | 'agent' | 'import' | 'system'
  /** Session ID where entity was created */
  sessionId?: string
  /** Agent that created it (if source is 'agent') */
  agentId?: string
  /** Where content was extracted from */
  extractedFrom?: 'agent-response' | 'user-input' | 'file-import' | 'tool-result'
  /** Chat message ID this entity was derived from */
  messageId?: string
  /** Trace ID for audit */
  traceId?: string
}

// ============ Entity Links ============

/**
 * Link between entities
 */
export interface EntityLink {
  /** Target entity ID */
  targetId: string
  /** Link type */
  type: 'related' | 'derived-from' | 'supersedes' | 'references'
  /** Optional description of the relationship */
  description?: string
  /** When the link was created */
  createdAt: string
}

// ============ Summary Card ============

/**
 * Method used to generate summary card
 */
export type SummaryCardMethod = 'deterministic' | 'llm' | 'user'

/**
 * Summary card configuration
 */
export interface SummaryCardConfig {
  /** Maximum tokens for summary card (default: 300) */
  maxTokens: number
  /** Token threshold to trigger LLM summarization (default: 800) */
  llmThreshold: number
  /** Maximum output tokens for LLM summarization (default: 200) */
  llmMaxOutput: number
}

/**
 * Default summary card configuration
 */
export const DEFAULT_SUMMARY_CARD_CONFIG: SummaryCardConfig = {
  maxTokens: 300,
  llmThreshold: 800,
  llmMaxOutput: 200
}

// ============ Memory Entity ============

/**
 * Entity type
 */
export type MemoryEntityType = 'note' | 'literature' | 'data' | 'task'

/**
 * Memory Entity - the canonical schema for persistent entities
 *
 * Key design decisions:
 * - `projectCard` replaces `pinned` for long-term memory (core decisions/constraints)
 * - `summaryCard` is a bounded summary (≤300 tokens) for context assembly
 * - `selectedForAI` is removed - selection is now runtime-only (WorkingSet)
 */
export interface MemoryEntity {
  /** Unique entity ID */
  id: string

  /** Entity type */
  type: MemoryEntityType

  /** Revision number for conflict detection */
  revision: number

  /** Creation timestamp (ISO string) */
  createdAt: string

  /** Last update timestamp (ISO string) */
  updatedAt: string

  /** Entity title */
  title: string

  /** Tags for categorization and search */
  tags: string[]

  // ============ Project Cards (persistent) ============

  /**
   * Whether this entity is a Project Card
   *
   * Project Cards represent core decisions, constraints, and alignment.
   * They are always considered for context inclusion (subject to budget/shape degradation).
   *
   * Replaces the old `pinned` field.
   */
  projectCard: boolean

  // ============ Summary Card (persistent, bounded) ============

  /**
   * Summary card content (strict limit: ≤300 tokens)
   *
   * Generated deterministically for short content, via LLM for long/complex content,
   * or manually by user. Used for context assembly and retrieval.
   */
  summaryCard: string

  /**
   * Method used to generate the summary card
   */
  summaryCardMethod: SummaryCardMethod

  /**
   * Hash of content used to generate summary card (for change detection)
   */
  summaryCardHash?: string

  // ============ Canonical Content ============

  /**
   * Path to canonical content file (relative to project root)
   * e.g., "notes/abc123.md", "literature/paper-xyz.json"
   */
  canonicalPath: string

  /**
   * Reference to payload file for large content
   * Used when content exceeds inline storage limits
   */
  payloadRef?: string

  // ============ Tracking ============

  /** Provenance tracking */
  provenance: EntityProvenance

  /**
   * Content hash for exact deduplication
   * Only used for exact match detection, not similarity
   */
  contentHash?: string

  /** Links to other entities */
  links?: EntityLink[]
}

// ============ Entity Operations ============

/**
 * Options for creating a new entity
 */
export interface CreateEntityOptions {
  type: MemoryEntityType
  title: string
  content: string
  tags?: string[]
  projectCard?: boolean
  provenance: EntityProvenance
  links?: EntityLink[]
}

/**
 * Options for updating an entity
 */
export interface UpdateEntityOptions {
  title?: string
  content?: string
  tags?: string[]
  projectCard?: boolean
  links?: EntityLink[]
}

// ============ WorkingSet (Runtime Only) ============

/**
 * Source of a WorkingSet item
 */
export type WorkingSetSource = 'explicit' | 'continuity' | 'retrieval' | 'index'

/**
 * Shape level for context inclusion
 */
export type EntityShape = 'full' | 'excerpt' | 'card' | 'index-line'

/**
 * A single item in the WorkingSet (runtime only, not persisted)
 *
 * WorkingSet is assembled per request from multiple signals:
 * 1. Explicit: @mention or UI "Add to Working Set"
 * 2. Continuity: recently used entities in this session
 * 3. Retrieval: relevance search over titles, tags, summaryCards
 * 4. Index: low-cost index lines for "potentially useful" items
 */
export interface WorkingSetItem {
  /** Entity ID */
  entityId: string

  /** How this item was selected for the WorkingSet */
  source: WorkingSetSource

  /** Requested shape for context inclusion */
  requestedShape: EntityShape

  /** Relevance score (0-1) */
  relevanceScore: number

  /** Human-readable reason for inclusion */
  reason: string
}

/**
 * WorkingSet plan - the full set of items for a request
 */
export interface WorkingSetPlan {
  /** Items to include in context */
  items: WorkingSetItem[]

  /** Total estimated tokens */
  estimatedTokens: number

  /** Timestamp when plan was created */
  createdAt: string
}

// ============ Migration Types ============

/**
 * Legacy entity fields (for migration)
 */
export interface LegacyEntityFields {
  /** Old pinned field (maps to projectCard) */
  pinned?: boolean
  /** Old selectedForAI field (dropped - runtime only now) */
  selectedForAI?: boolean
}

/**
 * Check if an entity has legacy fields that need migration
 */
export function hasLegacyFields(entity: Record<string, unknown>): boolean {
  return 'pinned' in entity || 'selectedForAI' in entity
}

/**
 * Migrate legacy entity fields to new schema
 */
export function migrateLegacyFields(
  entity: Record<string, unknown> & LegacyEntityFields
): Partial<MemoryEntity> {
  const migrated: Partial<MemoryEntity> = {}

  // Map pinned → projectCard
  if ('pinned' in entity) {
    migrated.projectCard = entity.pinned === true
  }

  // selectedForAI is dropped (runtime only now)
  // No migration needed - it's simply not included

  return migrated
}

// ============ Validation ============

/**
 * Maximum summary card tokens
 */
export const MAX_SUMMARY_CARD_TOKENS = 300

/**
 * Validate summary card length
 */
export function isValidSummaryCard(summaryCard: string): boolean {
  // Rough estimate: 1 token ≈ 4 characters
  const estimatedTokens = Math.ceil(summaryCard.length / 4)
  return estimatedTokens <= MAX_SUMMARY_CARD_TOKENS
}

/**
 * Validate entity type
 */
export function isValidEntityType(type: string): type is MemoryEntityType {
  return ['note', 'literature', 'data', 'task'].includes(type)
}
