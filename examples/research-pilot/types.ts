/**
 * Research Pilot - Memory V2 Type Definitions (RFC-012)
 *
 * Canonical model:
 * - Artifact (authoritative source files/records)
 * - Fact (durable structured memory)
 * - Focus (session-scoped attention)
 * - TaskAnchor (minimal progress continuity)
 */

// ============================================================================
// Path Constants
// ============================================================================

export const PATHS = {
  root: '.research-pilot',

  // Artifact storage (authoritative files)
  artifactsRoot: '.research-pilot/artifacts',
  notes: '.research-pilot/artifacts/notes',
  papers: '.research-pilot/artifacts/papers',
  literature: '.research-pilot/artifacts/papers', // Compatibility alias
  data: '.research-pilot/artifacts/data',
  webContent: '.research-pilot/artifacts/web-content',
  toolOutputs: '.research-pilot/artifacts/tool-output',

  // Runtime and cache
  sessions: '.research-pilot/sessions',
  cache: '.research-pilot/cache',
  documentCache: '.research-pilot/cache/documents',
  project: '.research-pilot/project.json',
  reviews: '.research-pilot/reviews',

  // Memory V2 state (app-level)
  memoryRoot: '.research-pilot/memory-v2',
  focusDir: '.research-pilot/memory-v2/focus',
  artifactFactIndex: '.research-pilot/memory-v2/index/artifact-facts.json',
  explainDir: '.research-pilot/memory-v2/explain'
} as const

// ============================================================================
// Shared Types
// ============================================================================

export type ArtifactType = 'note' | 'paper' | 'data' | 'web-content' | 'tool-output'

export interface Provenance {
  source: 'user' | 'agent' | 'import'
  sessionId: string
  agentId?: string
  extractedFrom?: 'agent-response' | 'user-input' | 'file-import' | 'tool-output'
  messageId?: string
}

// ============================================================================
// Artifact Types (authoritative)
// ============================================================================

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

export interface PaperArtifact extends ArtifactBase {
  type: 'paper'
  citeKey: string
  bibtex: string
  doi: string
  authors: string[]
  abstract: string
  year?: number
  venue?: string
  url?: string
  pdfUrl?: string

  // Search metadata retained for literature-team quality/scoring.
  searchKeywords?: string[]
  externalSource?: string
  relevanceScore?: number
  citationCount?: number
  enrichmentSource?: string
  enrichedAt?: string
}

export interface DataSchema {
  columns?: Array<{
    name: string
    type: string
    description?: string
  }>
  rowCount?: number
  description?: string
}

export interface DataArtifact extends ArtifactBase {
  type: 'data'
  /** @deprecated Use title */
  name?: string
  filePath: string
  mimeType?: string
  schema?: DataSchema
  runId?: string
  runLabel?: string
}

export interface WebContentArtifact extends ArtifactBase {
  type: 'web-content'
  url: string
  content: string
  fetchedAt?: string
}

export interface ToolOutputArtifact extends ArtifactBase {
  type: 'tool-output'
  toolName: string
  outputPath?: string
  outputText?: string
}

export type Artifact = NoteArtifact | PaperArtifact | DataArtifact | WebContentArtifact | ToolOutputArtifact

// ============================================================================
// Fact / Focus / Task Anchor (Memory V2 semantics)
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
// Data Analysis Types (RFC-006)
// ============================================================================

export interface ColumnSchemaDetailed {
  name: string
  dtype: string
  missingRate: number
  topKValues?: Array<{ value: string; count: number }>
  min?: number
  max?: number
  mean?: number
}

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

export interface SubTopic {
  name: string
  description: string
  priority: 'high' | 'medium' | 'low'
  expectedPaperCount: number
}

export interface QueryBatch {
  subTopic: string
  queries: string[]
  dblpQueries?: string[]
  sources: string[]
  priority: number
}

export interface SearchPlan {
  topic: string
  subTopics: SubTopic[]
  queryBatches: QueryBatch[]
  targetPaperCount: number
  minimumCoveragePerSubTopic: number
}

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

export interface FilteredMessage {
  role: 'user' | 'assistant' | 'tool-result'
  content: string
  toolName?: string
}

export interface PlannerContext {
  request: string
  conversationHistory: FilteredMessage[]
  localLibrary: {
    totalPapers: number
    topicClusters: { topic: string; count: number; sampleTitles: string[] }[]
  }
}

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

// ============================================================================
// Compatibility Aliases (legacy callers)
// ============================================================================

export type ResearchEntity = Artifact
export type Note = NoteArtifact
export type Literature = PaperArtifact
export type DataAttachment = DataArtifact
export type Entity = Artifact
