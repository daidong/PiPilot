export const PATHS = {
  root: '.yolo-researcher',
  papers: '.yolo-researcher/papers',
  reviews: '.yolo-researcher/reviews'
} as const

export interface Provenance {
  source: 'user' | 'agent' | 'import'
  sessionId: string
  agentId?: string
  extractedFrom?: 'agent-response' | 'user-input' | 'file-import' | 'tool-output'
  messageId?: string
}

export interface CLIContext {
  sessionId: string
  projectPath: string
  lastAgentResponse?: string
  debug?: boolean
}

export interface PaperArtifact {
  id: string
  type: 'paper'
  title: string
  tags: string[]
  summary?: string
  provenance: Provenance
  createdAt: string
  updatedAt: string
  citeKey: string
  bibtex: string
  doi: string
  authors: string[]
  abstract: string
  year?: number
  venue?: string
  url?: string
  pdfUrl?: string
  searchKeywords?: string[]
  externalSource?: string
  relevanceScore?: number
  citationCount?: number
  enrichmentSource?: string
  enrichedAt?: string
}

export type Literature = PaperArtifact

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
