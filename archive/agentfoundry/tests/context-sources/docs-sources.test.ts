/**
 * Tests for docs.index, docs.search, and docs.open context sources
 *
 * These sources rely on FileDocsIndexer which is instantiated inside fetch().
 * We mock the module to control its behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { docsIndex } from '../../src/context-sources/docs-index.js'
import { docsSearch } from '../../src/context-sources/docs-search.js'
import { docsOpen } from '../../src/context-sources/docs-open.js'
import type { Runtime } from '../../src/types/runtime.js'

// Mock the FileDocsIndexer
vi.mock('../../src/core/docs-indexer.js', () => {
  const mockIndexer = {
    load: vi.fn(),
    search: vi.fn(),
    getDocument: vi.fn(),
    readContent: vi.fn()
  }
  return {
    FileDocsIndexer: vi.fn(() => mockIndexer),
    __mockIndexer: mockIndexer
  }
})

// Import the mock after mocking
import { FileDocsIndexer, __mockIndexer } from '../../src/core/docs-indexer.js'

const mockIndexer = __mockIndexer as {
  load: ReturnType<typeof vi.fn>
  search: ReturnType<typeof vi.fn>
  getDocument: ReturnType<typeof vi.fn>
  readContent: ReturnType<typeof vi.fn>
}

function createMockRuntime(): Runtime {
  return {
    projectPath: '/test/project',
    sessionId: 'test-session',
    agentId: 'test-agent',
    step: 1,
    io: {} as any,
    eventBus: {} as any,
    trace: {} as any,
    tokenBudget: {} as any,
    toolRegistry: {} as any,
    policyEngine: {} as any,
    contextManager: {} as any,
    sessionState: {} as any
  } as Runtime
}

function createMockIndex(documents: any[] = []) {
  return {
    documents,
    stats: {
      totalDocuments: documents.length,
      totalChunks: documents.reduce((sum: number, d: any) => sum + d.chunks.length, 0),
      byType: documents.reduce((acc: any, d: any) => {
        acc[d.type] = (acc[d.type] || 0) + 1
        return acc
      }, {})
    }
  }
}

function createMockDocument(overrides: any = {}) {
  return {
    id: 'doc-001',
    path: 'docs/guide.md',
    title: 'Getting Started Guide',
    type: 'markdown',
    size: 5120,
    modifiedAt: '2025-01-15T10:00:00Z',
    chunks: [
      { id: 'doc-001_chunk_001', startLine: 1, endLine: 50 },
      { id: 'doc-001_chunk_002', startLine: 51, endLine: 100 }
    ],
    metadata: { category: 'guide', tags: ['getting-started'] },
    outline: [
      { title: 'Introduction', level: 1, line: 1 },
      { title: 'Installation', level: 2, line: 10 }
    ],
    ...overrides
  }
}

// ============ docs.index ============

describe('docs.index', () => {
  let runtime: Runtime

  beforeEach(() => {
    runtime = createMockRuntime()
    vi.clearAllMocks()
  })

  it('should list all indexed documents', async () => {
    const doc1 = createMockDocument()
    const doc2 = createMockDocument({
      id: 'doc-002',
      path: 'docs/api.md',
      title: 'API Reference',
      type: 'markdown',
      size: 10240
    })
    const index = createMockIndex([doc1, doc2])
    mockIndexer.load.mockResolvedValue(index)

    const result = await docsIndex.fetch({}, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.documents).toHaveLength(2)
    expect(result.data!.total).toBe(2)
    expect(result.data!.stats.totalDocuments).toBe(2)
  })

  it('should return error when no index exists', async () => {
    mockIndexer.load.mockResolvedValue(null)

    const result = await docsIndex.fetch({}, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('No document index found')
  })

  it('should filter documents by type', async () => {
    const mdDoc = createMockDocument({ type: 'markdown' })
    const txtDoc = createMockDocument({ id: 'doc-002', path: 'readme.txt', title: 'README', type: 'txt' })
    mockIndexer.load.mockResolvedValue(createMockIndex([mdDoc, txtDoc]))

    const result = await docsIndex.fetch({ type: 'markdown' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.documents).toHaveLength(1)
    expect(result.data!.documents[0]!.type).toBe('markdown')
  })

  it('should include chunk count in document entries', async () => {
    const doc = createMockDocument()
    mockIndexer.load.mockResolvedValue(createMockIndex([doc]))

    const result = await docsIndex.fetch({}, runtime)

    expect(result.data!.documents[0]!.chunkCount).toBe(2)
  })

  it('should support pagination with offset and limit', async () => {
    const docs = Array.from({ length: 5 }, (_, i) =>
      createMockDocument({ id: `doc-${i}`, path: `docs/doc-${i}.md`, title: `Doc ${i}`, modifiedAt: `2025-01-${15 - i}T10:00:00Z` })
    )
    mockIndexer.load.mockResolvedValue(createMockIndex(docs))

    const result = await docsIndex.fetch({ offset: 1, limit: 2 }, runtime)

    expect(result.data!.documents).toHaveLength(2)
    expect(result.data!.total).toBe(5)
    expect(result.coverage.complete).toBe(false)
  })

  it('should render markdown output', async () => {
    const doc = createMockDocument()
    mockIndexer.load.mockResolvedValue(createMockIndex([doc]))

    const result = await docsIndex.fetch({}, runtime)

    expect(result.rendered).toContain('# Document Library')
    expect(result.rendered).toContain('Getting Started Guide')
    expect(result.rendered).toContain('## Stats')
  })

  it('should handle empty document library', async () => {
    mockIndexer.load.mockResolvedValue(createMockIndex([]))

    const result = await docsIndex.fetch({}, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.documents).toHaveLength(0)
    expect(result.rendered).toContain('No documents found')
  })

  it('should include kindEcho', async () => {
    mockIndexer.load.mockResolvedValue(createMockIndex([]))

    const result = await docsIndex.fetch({}, runtime)

    expect(result.kindEcho).toBeDefined()
    expect(result.kindEcho!.source).toBe('docs.index')
    expect(result.kindEcho!.kind).toBe('index')
  })
})

// ============ docs.search ============

describe('docs.search', () => {
  let runtime: Runtime

  beforeEach(() => {
    runtime = createMockRuntime()
    vi.clearAllMocks()
  })

  it('should search documents by query', async () => {
    const doc = createMockDocument()
    const index = createMockIndex([doc])
    mockIndexer.load.mockResolvedValue(index)
    mockIndexer.search.mockResolvedValue([
      {
        document: doc,
        score: 0.85,
        matchedKeywords: ['authentication', 'API'],
        matchingChunks: ['doc-001_chunk_001']
      }
    ])
    mockIndexer.readContent.mockResolvedValue('Sample content about API authentication...')

    const result = await docsSearch.fetch({ query: 'API authentication' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.results).toHaveLength(1)
    expect(result.data!.query).toBe('API authentication')
    expect(result.data!.results[0]!.score).toBeDefined()
    expect(result.data!.results[0]!.matchedKeywords).toContain('authentication')
  })

  it('should handle no search results', async () => {
    mockIndexer.load.mockResolvedValue(createMockIndex([]))
    mockIndexer.search.mockResolvedValue([])

    const result = await docsSearch.fetch({ query: 'nonexistent topic' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.results).toHaveLength(0)
    expect(result.rendered).toContain('No matching documents found')
  })

  it('should return error when query is missing', async () => {
    const result = await docsSearch.fetch({} as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "query"')
  })

  it('should return error when no index exists', async () => {
    mockIndexer.load.mockResolvedValue(null)

    const result = await docsSearch.fetch({ query: 'test' }, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('No document index found')
  })

  it('should include next step suggestion for top result', async () => {
    const doc = createMockDocument()
    mockIndexer.load.mockResolvedValue(createMockIndex([doc]))
    mockIndexer.search.mockResolvedValue([
      { document: doc, score: 0.9, matchedKeywords: ['test'], matchingChunks: [] }
    ])

    const result = await docsSearch.fetch({ query: 'test' }, runtime)

    expect(result.next).toBeDefined()
    expect(result.next![0]!.source).toBe('docs.open')
    expect(result.next![0]!.params).toEqual({ path: 'docs/guide.md' })
  })

  it('should respect limit parameter', async () => {
    const docs = Array.from({ length: 10 }, (_, i) =>
      createMockDocument({ id: `doc-${i}`, path: `docs/doc-${i}.md`, title: `Doc ${i}` })
    )
    const searchResults = docs.map(d => ({
      document: d, score: 0.5, matchedKeywords: ['test'], matchingChunks: []
    }))
    mockIndexer.load.mockResolvedValue(createMockIndex(docs))
    mockIndexer.search.mockResolvedValue(searchResults)

    const result = await docsSearch.fetch({ query: 'test', limit: 3 }, runtime)

    expect(result.data!.results.length).toBeLessThanOrEqual(3)
  })

  it('should include kindEcho', async () => {
    mockIndexer.load.mockResolvedValue(createMockIndex([]))
    mockIndexer.search.mockResolvedValue([])

    const result = await docsSearch.fetch({ query: 'test' }, runtime)

    expect(result.kindEcho).toBeDefined()
    expect(result.kindEcho!.source).toBe('docs.search')
    expect(result.kindEcho!.kind).toBe('search')
    expect(result.kindEcho!.paramsUsed).toHaveProperty('query', 'test')
  })

  it('should handle undefined params', async () => {
    const result = await docsSearch.fetch(undefined as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "query"')
  })
})

// ============ docs.open ============

describe('docs.open', () => {
  let runtime: Runtime

  beforeEach(() => {
    runtime = createMockRuntime()
    vi.clearAllMocks()
  })

  it('should open a document by path', async () => {
    const doc = createMockDocument()
    mockIndexer.getDocument.mockResolvedValue(doc)
    mockIndexer.readContent.mockResolvedValue('# Getting Started\n\nWelcome to the guide...')

    const result = await docsOpen.fetch({ path: 'docs/guide.md' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.path).toBe('docs/guide.md')
    expect(result.data!.title).toBe('Getting Started Guide')
    expect(result.data!.content).toContain('Getting Started')
    expect(result.data!.startLine).toBe(1)
  })

  it('should return error when path is missing', async () => {
    const result = await docsOpen.fetch({} as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "path"')
  })

  it('should return error when document is not found and file cannot be read', async () => {
    mockIndexer.getDocument.mockResolvedValue(null)
    mockIndexer.readContent.mockResolvedValue(null)

    const result = await docsOpen.fetch({ path: 'docs/nonexistent.md' }, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Document not found')
    expect(result.error).toContain('nonexistent.md')
  })

  it('should fall back to direct file read when document is not in index', async () => {
    mockIndexer.getDocument.mockResolvedValue(null)
    mockIndexer.readContent.mockResolvedValue('Some raw file content')

    const result = await docsOpen.fetch({ path: 'docs/unlisted.md' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.content).toBe('Some raw file content')
    expect(result.coverage.complete).toBe(false)
    expect(result.coverage.limitations).toBeDefined()
  })

  it('should read a specific chunk by chunkId', async () => {
    const doc = createMockDocument()
    mockIndexer.getDocument.mockResolvedValue(doc)
    mockIndexer.readContent.mockResolvedValue('Content of chunk 2...')

    const result = await docsOpen.fetch({ path: 'docs/guide.md', chunkId: 'doc-001_chunk_002' }, runtime)

    expect(result.success).toBe(true)
    // Should use chunk's startLine (51) and lineLimit based on chunk range
    expect(mockIndexer.readContent).toHaveBeenCalledWith('docs/guide.md', 51, 50)
  })

  it('should return error for unknown chunkId', async () => {
    const doc = createMockDocument()
    mockIndexer.getDocument.mockResolvedValue(doc)

    const result = await docsOpen.fetch({ path: 'docs/guide.md', chunkId: 'nonexistent' }, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Chunk not found')
  })

  it('should include outline when requested', async () => {
    const doc = createMockDocument()
    mockIndexer.getDocument.mockResolvedValue(doc)
    mockIndexer.readContent.mockResolvedValue('Content here')

    const result = await docsOpen.fetch({ path: 'docs/guide.md', includeOutline: true }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.outline).toBeDefined()
    expect(result.data!.outline).toHaveLength(2)
    expect(result.rendered).toContain('## Outline')
  })

  it('should include metadata when requested', async () => {
    const doc = createMockDocument()
    mockIndexer.getDocument.mockResolvedValue(doc)
    mockIndexer.readContent.mockResolvedValue('Content here')

    const result = await docsOpen.fetch({ path: 'docs/guide.md', includeMeta: true }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.metadata).toBeDefined()
    expect(result.rendered).toContain('## Metadata')
  })

  it('should suggest continuing read when content is incomplete', async () => {
    const doc = createMockDocument()
    mockIndexer.getDocument.mockResolvedValue(doc)
    // Return content that doesn't reach the end of the doc (totalLines=100 from chunks)
    mockIndexer.readContent.mockResolvedValue('Line 1\nLine 2\nLine 3')

    const result = await docsOpen.fetch({ path: 'docs/guide.md', startLine: 1, lineLimit: 3 }, runtime)

    expect(result.success).toBe(true)
    expect(result.next).toBeDefined()
    expect(result.next![0]!.source).toBe('docs.open')
  })

  it('should return error when readContent returns null for indexed doc', async () => {
    const doc = createMockDocument()
    mockIndexer.getDocument.mockResolvedValue(doc)
    mockIndexer.readContent.mockResolvedValue(null)

    const result = await docsOpen.fetch({ path: 'docs/guide.md' }, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Failed to read document')
  })

  it('should include kindEcho', async () => {
    const doc = createMockDocument()
    mockIndexer.getDocument.mockResolvedValue(doc)
    mockIndexer.readContent.mockResolvedValue('Content')

    const result = await docsOpen.fetch({ path: 'docs/guide.md' }, runtime)

    expect(result.kindEcho).toBeDefined()
    expect(result.kindEcho!.source).toBe('docs.open')
    expect(result.kindEcho!.kind).toBe('open')
    expect(result.kindEcho!.paramsUsed).toHaveProperty('path', 'docs/guide.md')
  })

  it('should handle undefined params', async () => {
    const result = await docsOpen.fetch(undefined as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "path"')
  })
})
