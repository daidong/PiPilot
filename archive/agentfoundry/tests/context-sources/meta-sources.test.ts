/**
 * Tests for ctx.catalog and ctx.describe meta context sources
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ctxCatalog } from '../../src/context-sources/ctx-catalog.js'
import { ctxDescribe } from '../../src/context-sources/ctx-describe.js'
import type { Runtime } from '../../src/types/runtime.js'
import type { ContextSource } from '../../src/types/context.js'

function createMockSource(overrides: Partial<ContextSource> = {}): ContextSource {
  return {
    id: 'docs.search',
    namespace: 'docs',
    kind: 'search',
    description: 'Search documents by keyword query.',
    shortDescription: 'Search documents',
    resourceTypes: ['docs'],
    params: [
      { name: 'query', type: 'string', required: true, description: 'Search query' },
      { name: 'limit', type: 'number', required: false, description: 'Max results', default: 20 }
    ],
    examples: [
      { description: 'Search for API docs', params: { query: 'API authentication' }, resultSummary: 'Documents about API auth' }
    ],
    fetch: vi.fn(),
    costTier: 'medium',
    ...overrides
  }
}

function createMockRuntime(sources: ContextSource[] = []): Runtime {
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
    sessionState: {} as any,
    contextManager: {
      getAllSources: vi.fn().mockReturnValue(sources),
      getSource: vi.fn((id: string) => sources.find(s => s.id === id)),
      findSimilarSources: vi.fn().mockReturnValue([])
    } as any
  } as Runtime
}

describe('ctx.catalog', () => {
  let runtime: Runtime

  const mockSources: ContextSource[] = [
    createMockSource({ id: 'docs.index', namespace: 'docs', kind: 'index', shortDescription: 'List indexed documents', costTier: 'cheap' }),
    createMockSource({ id: 'docs.search', namespace: 'docs', kind: 'search', shortDescription: 'Search documents', costTier: 'medium' }),
    createMockSource({ id: 'docs.open', namespace: 'docs', kind: 'open', shortDescription: 'Read document content', costTier: 'cheap' }),
    createMockSource({ id: 'memory.get', namespace: 'memory', kind: 'get', shortDescription: 'Get memory item by key', costTier: 'cheap' }),
    createMockSource({ id: 'memory.search', namespace: 'memory', kind: 'search', shortDescription: 'Search memory items', costTier: 'medium' })
  ]

  beforeEach(() => {
    runtime = createMockRuntime(mockSources)
  })

  it('should return a list of all registered context sources', async () => {
    const result = await ctxCatalog.fetch({}, runtime)

    expect(result.success).toBe(true)
    expect(result.data).toBeDefined()
    expect(result.data!.total).toBe(5)
    expect(result.data!.sources).toHaveLength(5)
    expect(result.data!.namespaces).toEqual(['docs', 'memory'])
  })

  it('should include correct catalog entry fields', async () => {
    const result = await ctxCatalog.fetch({}, runtime)

    const docsSearch = result.data!.sources.find(s => s.id === 'docs.search')
    expect(docsSearch).toBeDefined()
    expect(docsSearch!.namespace).toBe('docs')
    expect(docsSearch!.kind).toBe('search')
    expect(docsSearch!.oneLiner).toBe('Search documents')
    expect(docsSearch!.costTier).toBe('medium')
  })

  it('should filter by namespace', async () => {
    const result = await ctxCatalog.fetch({ namespace: 'memory' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.sources).toHaveLength(2)
    expect(result.data!.sources.every(s => s.namespace === 'memory')).toBe(true)
  })

  it('should filter by kind', async () => {
    const result = await ctxCatalog.fetch({ kind: 'search' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.sources).toHaveLength(2)
    expect(result.data!.sources.every(s => s.kind === 'search')).toBe(true)
  })

  it('should filter by both namespace and kind', async () => {
    const result = await ctxCatalog.fetch({ namespace: 'docs', kind: 'search' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.sources).toHaveLength(1)
    expect(result.data!.sources[0]!.id).toBe('docs.search')
  })

  it('should return empty list when no sources match filter', async () => {
    const result = await ctxCatalog.fetch({ namespace: 'nonexistent' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.sources).toHaveLength(0)
    expect(result.data!.total).toBe(0)
  })

  it('should sort entries by namespace then kind order', async () => {
    const result = await ctxCatalog.fetch({}, runtime)

    const ids = result.data!.sources.map(s => s.id)
    // docs namespace first (index, search, open), then memory (get, search)
    expect(ids.indexOf('docs.index')).toBeLessThan(ids.indexOf('docs.search'))
    expect(ids.indexOf('docs.search')).toBeLessThan(ids.indexOf('docs.open'))
    expect(ids.indexOf('docs.open')).toBeLessThan(ids.indexOf('memory.get'))
  })

  it('should include rendered markdown output', async () => {
    const result = await ctxCatalog.fetch({}, runtime)

    expect(result.rendered).toContain('# Available Context Sources')
    expect(result.rendered).toContain('docs.*')
    expect(result.rendered).toContain('memory.*')
  })

  it('should include kindEcho', async () => {
    const result = await ctxCatalog.fetch({ namespace: 'docs' }, runtime)

    expect(result.kindEcho).toBeDefined()
    expect(result.kindEcho!.source).toBe('ctx.catalog')
    expect(result.kindEcho!.kind).toBe('index')
  })

  it('should handle undefined params gracefully', async () => {
    const result = await ctxCatalog.fetch(undefined as any, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.total).toBe(5)
  })

  it('should extract minParams from required parameters', async () => {
    const result = await ctxCatalog.fetch({}, runtime)

    const docsSearch = result.data!.sources.find(s => s.id === 'docs.search')
    expect(docsSearch!.minParams).toContain('query')
  })

  it('should generate example calls', async () => {
    const result = await ctxCatalog.fetch({}, runtime)

    const docsSearch = result.data!.sources.find(s => s.id === 'docs.search')
    expect(docsSearch!.example).toContain('ctx.get("docs.search"')
  })
})

describe('ctx.describe', () => {
  let runtime: Runtime

  const docsSearchSource = createMockSource({
    id: 'docs.search',
    namespace: 'docs',
    kind: 'search',
    description: 'Search documents by keyword query. Returns ranked results.',
    shortDescription: 'Search documents',
    costTier: 'medium',
    params: [
      { name: 'query', type: 'string', required: true, description: 'Search query' },
      { name: 'limit', type: 'number', required: false, description: 'Max results', default: 20 },
      { name: 'mode', type: 'string', required: false, description: 'Search mode', enum: ['keyword', 'semantic'] }
    ],
    examples: [
      { description: 'Search for API docs', params: { query: 'API authentication' }, resultSummary: 'Documents about API auth' }
    ]
  })

  const docsIndexSource = createMockSource({
    id: 'docs.index',
    namespace: 'docs',
    kind: 'index',
    shortDescription: 'List indexed documents'
  })

  const docsOpenSource = createMockSource({
    id: 'docs.open',
    namespace: 'docs',
    kind: 'open',
    shortDescription: 'Read document content'
  })

  const allSources = [docsSearchSource, docsIndexSource, docsOpenSource]

  beforeEach(() => {
    runtime = createMockRuntime(allSources)
  })

  it('should return full documentation for a known source', async () => {
    const result = await ctxDescribe.fetch({ id: 'docs.search' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data).toBeDefined()
    expect(result.data!.id).toBe('docs.search')
    expect(result.data!.namespace).toBe('docs')
    expect(result.data!.kind).toBe('search')
    expect(result.data!.description).toContain('Search documents')
  })

  it('should include parameter schema in response', async () => {
    const result = await ctxDescribe.fetch({ id: 'docs.search' }, runtime)

    expect(result.data!.params).toHaveLength(3)
    const queryParam = result.data!.params.find(p => p.name === 'query')
    expect(queryParam).toBeDefined()
    expect(queryParam!.required).toBe(true)
    expect(queryParam!.type).toBe('string')
  })

  it('should include examples in response', async () => {
    const result = await ctxDescribe.fetch({ id: 'docs.search' }, runtime)

    expect(result.data!.examples).toHaveLength(1)
    expect(result.data!.examples[0]!.description).toBe('Search for API docs')
  })

  it('should include common errors', async () => {
    const result = await ctxDescribe.fetch({ id: 'docs.search' }, runtime)

    expect(result.data!.commonErrors.length).toBeGreaterThan(0)
    const missingQuery = result.data!.commonErrors.find(e => e.error.includes('"query"'))
    expect(missingQuery).toBeDefined()
  })

  it('should include workflow suggestions', async () => {
    const result = await ctxDescribe.fetch({ id: 'docs.search' }, runtime)

    expect(result.data!.workflow).toBeTruthy()
    expect(typeof result.data!.workflow).toBe('string')
  })

  it('should include related sources from same namespace', async () => {
    const result = await ctxDescribe.fetch({ id: 'docs.search' }, runtime)

    expect(result.data!.relatedSources).toContain('docs.index')
    expect(result.data!.relatedSources).toContain('docs.open')
    expect(result.data!.relatedSources).not.toContain('docs.search')
  })

  it('should render markdown output', async () => {
    const result = await ctxDescribe.fetch({ id: 'docs.search' }, runtime)

    expect(result.rendered).toContain('# docs.search')
    expect(result.rendered).toContain('## Parameters')
    expect(result.rendered).toContain('## Examples')
    expect(result.rendered).toContain('## Common Errors')
    expect(result.rendered).toContain('## Workflow')
    expect(result.rendered).toContain('## Related')
  })

  it('should return error for unknown source', async () => {
    const result = await ctxDescribe.fetch({ id: 'nonexistent.source' }, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
    expect(result.error).toContain('nonexistent.source')
  })

  it('should suggest similar sources when source not found', async () => {
    ;(runtime.contextManager.findSimilarSources as any).mockReturnValue(['docs.search', 'docs.index'])

    const result = await ctxDescribe.fetch({ id: 'docs.serch' }, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Did you mean')
    expect(result.error).toContain('docs.search')
  })

  it('should return error when id param is missing', async () => {
    const result = await ctxDescribe.fetch({} as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "id"')
  })

  it('should return error when params are undefined', async () => {
    const result = await ctxDescribe.fetch(undefined as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "id"')
  })

  it('should include kindEcho', async () => {
    const result = await ctxDescribe.fetch({ id: 'docs.search' }, runtime)

    expect(result.kindEcho).toBeDefined()
    expect(result.kindEcho!.source).toBe('ctx.describe')
    expect(result.kindEcho!.kind).toBe('get')
    expect(result.kindEcho!.paramsUsed).toEqual({ id: 'docs.search' })
  })

  it('should set coverage.complete to true for successful lookups', async () => {
    const result = await ctxDescribe.fetch({ id: 'docs.search' }, runtime)

    expect(result.coverage.complete).toBe(true)
  })
})
