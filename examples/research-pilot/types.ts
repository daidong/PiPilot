/**
 * Research Pilot - Memory V2 Type Definitions (RFC-012)
 *
 * Canonical model:
 * - Artifact (authoritative source files/records)
 * - SessionSummary (lightweight cross-turn continuity)
 */

// ============================================================================
// Path Constants
// ============================================================================

// ============================================================================
// Agent.md Constants
// ============================================================================

export const AGENT_MD_ID = 'agent-md'
export const AGENT_MD_MAX_CHARS = 5000

export const PATHS = {
  root: '.research-pilot',

  // Artifact storage (authoritative files)
  artifactsRoot: '.research-pilot/artifacts',
  notes: '.research-pilot/artifacts/notes',
  papers: '.research-pilot/artifacts/papers',
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
  explainDir: '.research-pilot/memory-v2/explain',
  sessionSummaries: '.research-pilot/memory-v2/session-summaries'
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
  filePath?: string  // relative POSIX path to source file (when imported from workspace)
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
// Session Summary (replaces Focus + Task Anchor)
// ============================================================================

export interface SessionSummary {
  sessionId: string
  turnRange: [number, number]
  summary: string
  topicsDiscussed: string[]
  openQuestions: string[]
  createdAt: string
}

// ============================================================================
// Compatibility Aliases (legacy callers)
// ============================================================================

export type ResearchEntity = Artifact
export type Note = NoteArtifact
export type Literature = PaperArtifact
export type DataAttachment = DataArtifact
export type Entity = Artifact
