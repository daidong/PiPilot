/**
 * Session Types - Session and Conversation Memory Type Definitions
 *
 * Provides types for:
 * - Message storage (conversation history)
 * - Session management
 * - Facts (learned preferences/constraints)
 * - Decisions (commitments with lifecycle)
 */

// ============ Message Types ============

/**
 * Message role in conversation
 */
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

/**
 * Tool call information attached to a message
 */
export interface MessageToolCall {
  /** Tool name */
  name: string
  /** Tool arguments */
  args: Record<string, unknown>
  /** Tool result (if completed) */
  result?: {
    success: boolean
    data?: unknown
    error?: string
  }
}

/**
 * A single message in the conversation
 */
export interface Message {
  /** Unique message ID */
  id: string
  /** Session this message belongs to */
  sessionId: string
  /** When the message was created */
  timestamp: string
  /** Message role */
  role: MessageRole
  /** Message content */
  content: string
  /** Tool call info (for tool messages) */
  toolCall?: MessageToolCall
  /** Trace ID for correlation */
  traceId?: string
  /** Step number in the session */
  step: number
  /** Estimated token count */
  tokens?: number
  /** Extracted keywords for search */
  keywords: string[]
}

/**
 * Session metadata
 */
export interface SessionMeta {
  /** Session ID */
  id: string
  /** When the session was created */
  createdAt: string
  /** When the session was last updated */
  updatedAt: string
  /** Total message count */
  messageCount: number
  /** Total token count */
  totalTokens: number
  /** Session title (extracted from first user message) */
  title?: string
  /** Session status */
  status: 'active' | 'archived'
}

/**
 * Sessions index file format (.agent-foundry/sessions/index.json)
 */
export interface SessionsIndex {
  version: string
  updatedAt: string
  currentSessionId: string | null
  sessions: Record<string, SessionMeta>
}

// ============ Fact Types ============

/**
 * Confidence level for facts
 */
export type FactConfidence = 'confirmed' | 'inferred' | 'speculative'

/**
 * Provenance for facts and decisions
 */
export interface SessionProvenance {
  /** Message ID that created this */
  messageId?: string
  /** Session ID where this was created */
  sessionId?: string
  /** When this was created */
  timestamp: string
  /** Who/what extracted this */
  extractedBy: 'user' | 'system' | 'model'
}

/**
 * A learned fact (preference, constraint, knowledge)
 */
export interface Fact {
  /** Unique fact ID */
  id: string
  /** Fact content */
  content: string
  /** Topics for categorization */
  topics: string[]
  /** Confidence level */
  confidence: FactConfidence
  /** Where this fact came from */
  provenance: SessionProvenance
  /** When created */
  createdAt: string
  /** When last updated */
  updatedAt: string
  /** Priority for sorting (higher = more important, default: 50) */
  priority?: number
  /** Time-to-live in milliseconds (null = permanent) */
  ttl?: number | null
  /** When this fact was last used (for LRU eviction) */
  lastUsedAt?: string
  /** Expiration timestamp (computed from createdAt + ttl) */
  expiresAt?: string
}

/**
 * Facts storage file format (.agent-foundry/memory/facts.json)
 */
export interface FactsData {
  version: string
  updatedAt: string
  facts: Fact[]
}

// ============ Decision Types ============

/**
 * Decision status lifecycle
 */
export type DecisionStatus = 'active' | 'deprecated' | 'superseded'

/**
 * A decision or commitment
 */
export interface Decision {
  /** Unique decision ID */
  id: string
  /** Decision content */
  content: string
  /** Current status */
  status: DecisionStatus
  /** ID of decision that supersedes this one */
  supersededBy?: string
  /** Where this decision came from */
  provenance: SessionProvenance
  /** When created */
  createdAt: string
  /** When deprecated (if applicable) */
  deprecatedAt?: string
  /** Reason for deprecation */
  deprecationReason?: string
}

/**
 * Decisions storage file format (.agent-foundry/memory/decisions.json)
 */
export interface DecisionsData {
  version: string
  updatedAt: string
  decisions: Decision[]
}

// ============ Store Interfaces ============

/**
 * Message store interface
 */
export interface MessageStore {
  // Lifecycle
  init(): Promise<void>
  close(): Promise<void>

  // Write operations
  appendMessage(message: Omit<Message, 'id' | 'keywords'>): Promise<Message>

  // Read operations
  getRecentMessages(sessionId: string, limit: number): Promise<Message[]>
  getMessage(messageId: string): Promise<Message | null>
  getMessageRange(sessionId: string, startIdx: number, endIdx: number): Promise<Message[]>
  searchMessages(sessionId: string, query: string, limit?: number): Promise<Message[]>

  // Session management
  createSession(): Promise<string>
  getCurrentSessionId(): Promise<string | null>
  setCurrentSession(sessionId: string): Promise<void>
  getSession(sessionId: string): Promise<SessionMeta | null>
  listSessions(): Promise<SessionMeta[]>
  archiveSession(sessionId: string): Promise<void>
}

/**
 * Session index interface for search
 */
export interface SessionIndex {
  // Index operations
  indexMessage(message: Message): Promise<void>
  rebuildIndex(sessionId: string): Promise<void>

  // Search operations
  search(sessionId: string, query: string, options?: SessionSearchOptions): Promise<SessionSearchResult[]>

  // Keyword extraction
  extractKeywords(content: string): string[]
}

/**
 * Search options for session search
 */
export interface SessionSearchOptions {
  /** Max results to return */
  limit?: number
  /** Recency bias: higher = prefer recent messages */
  recencyBias?: 'high' | 'medium' | 'low'
  /** Include tool messages */
  includeTools?: boolean
  /** Time range filter */
  timeRange?: {
    from?: string
    to?: string
  }
}

/**
 * Session search result
 */
export interface SessionSearchResult {
  /** The matching message */
  message: Message
  /** Relevance score (0-1) */
  score: number
  /** Matched keywords */
  matchedKeywords: string[]
  /** Snippet of matching content */
  snippet: string
}

// ============ Facts/Decisions Store Interface ============

/**
 * Filter options for facts
 */
export interface FactFilter {
  /** Filter by topics */
  topics?: string[]
  /** Search query */
  query?: string
  /** Filter by confidence */
  confidence?: FactConfidence | 'all'
  /** Max results */
  limit?: number
}

/**
 * Filter options for decisions
 */
export interface DecisionFilter {
  /** Search query */
  query?: string
  /** Filter by status */
  status?: DecisionStatus | 'all'
  /** Max results */
  limit?: number
}

/**
 * Facts and decisions store interface
 */
export interface FactsDecisionsStore {
  // Lifecycle
  init(): Promise<void>
  close(): Promise<void>

  // Facts CRUD
  addFact(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>): Promise<Fact>
  updateFact(id: string, updates: Partial<Pick<Fact, 'content' | 'topics' | 'confidence'>>): Promise<Fact | null>
  getFact(id: string): Promise<Fact | null>
  getFacts(filter?: FactFilter): Promise<Fact[]>
  deleteFact(id: string): Promise<boolean>

  // Decisions CRUD
  addDecision(decision: Omit<Decision, 'id' | 'createdAt'>): Promise<Decision>
  updateDecision(id: string, updates: Partial<Pick<Decision, 'content' | 'status'>>): Promise<Decision | null>
  deprecateDecision(id: string, reason: string, supersededBy?: string): Promise<Decision | null>
  getDecision(id: string): Promise<Decision | null>
  getDecisions(filter?: DecisionFilter): Promise<Decision[]>
}

// ============ Validation ============

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`
}

/**
 * Generate a unique fact ID
 */
export function generateFactId(): string {
  return `fact_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`
}

/**
 * Generate a unique decision ID
 */
export function generateDecisionId(): string {
  return `dec_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`
}
