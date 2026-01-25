/**
 * Docs Types - Document Indexing Type Definitions
 *
 * Provides types for:
 * - Document index format (docs_index.json)
 * - Document entries and chunks
 * - Search and retrieval interfaces
 */

// ============ Document Types ============

/**
 * Supported document types
 */
export type DocType = 'markdown' | 'txt' | 'pdf' | 'html'

/**
 * Document outline entry (heading)
 */
export interface DocOutlineEntry {
  /** Heading level (1-6) */
  level: number
  /** Heading title */
  title: string
  /** Line number in document */
  line: number
}

/**
 * Document chunk information
 */
export interface DocChunk {
  /** Unique chunk ID */
  id: string
  /** Start line in document */
  startLine: number
  /** End line in document */
  endLine: number
  /** Estimated token count */
  tokens: number
  /** Keywords extracted from chunk */
  keywords: string[]
}

/**
 * Document metadata (user-defined)
 */
export interface DocMetadata {
  /** Tags for categorization */
  tags?: string[]
  /** Category */
  category?: string
  /** Any other metadata */
  [key: string]: unknown
}

/**
 * A single document entry in the index
 */
export interface DocumentEntry {
  /** Unique document ID */
  id: string
  /** Relative path from project root */
  path: string
  /** Document title (extracted from first heading or filename) */
  title: string
  /** Document type */
  type: DocType
  /** File size in bytes */
  size: number
  /** Content hash for change detection */
  hash: string
  /** Last modified timestamp */
  modifiedAt: string
  /** User-defined metadata (from frontmatter) */
  metadata: DocMetadata
  /** Document chunks */
  chunks: DocChunk[]
  /** Document outline (headings) */
  outline: DocOutlineEntry[]
  /** All keywords from document */
  keywords: string[]
}

// ============ Index Types ============

/**
 * Indexer configuration
 */
export interface DocsIndexConfig {
  /** Root paths to scan */
  rootPaths: string[]
  /** File extensions to include */
  extensions: string[]
  /** Glob patterns to exclude */
  excludePatterns?: string[]
  /** Target chunk size in tokens */
  chunkSize: number
  /** Overlap between chunks in tokens */
  chunkOverlap: number
}

/**
 * Index statistics
 */
export interface DocsIndexStats {
  /** Total document count */
  totalDocuments: number
  /** Total chunk count */
  totalChunks: number
  /** Total estimated tokens */
  totalTokens: number
  /** Documents by type */
  byType: Record<string, number>
}

/**
 * Document index file format (.agent-foundry/docs_index.json)
 */
export interface DocsIndex {
  /** Schema version */
  version: string
  /** When index was created */
  createdAt: string
  /** When index was last updated */
  updatedAt: string
  /** Indexer configuration used */
  config: DocsIndexConfig
  /** Index statistics */
  stats: DocsIndexStats
  /** All indexed documents */
  documents: DocumentEntry[]
  /** Inverted keyword index: keyword -> document IDs */
  keywords: Record<string, string[]>
}

// ============ Search Types ============

/**
 * Search mode
 */
export type DocsSearchMode = 'keyword' | 'semantic' | 'hybrid'

/**
 * Document search result
 */
export interface DocsSearchResult {
  /** The matching document */
  document: DocumentEntry
  /** Relevance score (0-1) */
  score: number
  /** Matched keywords */
  matchedKeywords: string[]
  /** Preview snippet */
  preview?: string
  /** Matching chunk IDs */
  matchingChunks?: string[]
}

// ============ Indexer Interface ============

/**
 * Options for building the index
 */
export interface DocsIndexerOptions {
  /** Root paths to scan */
  paths: string[]
  /** File extensions to include */
  extensions?: string[]
  /** Glob patterns to exclude */
  exclude?: string[]
  /** Target chunk size in tokens */
  chunkSize?: number
  /** Overlap between chunks in tokens */
  chunkOverlap?: number
  /** Output directory for index */
  outputDir?: string
  /** Incremental update mode */
  incremental?: boolean
  /** Verbose output */
  verbose?: boolean
}

/**
 * Document indexer interface
 */
export interface DocsIndexer {
  /** Build or update the index */
  build(options: DocsIndexerOptions): Promise<DocsIndex>

  /** Load existing index */
  load(): Promise<DocsIndex | null>

  /** Get index statistics */
  getStats(): Promise<DocsIndexStats | null>

  /** Search documents */
  search(query: string, limit?: number): Promise<DocsSearchResult[]>

  /** Get document by path */
  getDocument(path: string): Promise<DocumentEntry | null>

  /** Read document content */
  readContent(path: string, startLine?: number, lineLimit?: number): Promise<string | null>
}

// ============ Utilities ============

/**
 * Generate a unique document ID
 */
export function generateDocId(): string {
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`
}

/**
 * Generate a unique chunk ID
 */
export function generateChunkId(docId: string, index: number): string {
  return `${docId}_chunk_${index.toString().padStart(3, '0')}`
}

/**
 * Detect document type from file extension
 */
export function detectDocType(filePath: string): DocType {
  const ext = filePath.toLowerCase().split('.').pop()
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'txt':
      return 'txt'
    case 'pdf':
      return 'pdf'
    case 'html':
    case 'htm':
      return 'html'
    default:
      return 'txt'
  }
}
