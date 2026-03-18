/**
 * defineContextSource Factory Tests
 */

import { describe, it, expect, vi } from 'vitest'
import {
  defineContextSource,
  createSuccessResult,
  createErrorResult,
  withContextTimeout,
  withContextRetry,
  withContextDefault,
  composeContextSource
} from '../../src/factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../../src/types/context.js'
import type { Runtime } from '../../src/types/runtime.js'

// Helper: minimal runtime
function makeRuntime(): Runtime {
  return {} as any
}

// Helper: create a simple valid context source
function makeSource<T = string>(
  id = 'test.source',
  fetchResult?: ContextResult<T>
): ContextSource<unknown, T> {
  return defineContextSource<unknown, T>({
    id,
    kind: 'get',
    description: 'A test context source',
    costTier: 'cheap',
    fetch: async () => fetchResult ?? createSuccessResult('data' as any, 'rendered data')
  })
}

// Helper: source that always fails
function makeFailSource(id = 'test.fail', error = 'fetch failed'): ContextSource {
  return defineContextSource({
    id,
    kind: 'get',
    description: 'Always fails',
    costTier: 'cheap',
    fetch: async () => createErrorResult(error)
  })
}

describe('defineContextSource', () => {
  it('should create a valid context source', () => {
    const source = defineContextSource({
      id: 'docs.index',
      kind: 'index',
      description: 'Browse documentation structure',
      costTier: 'cheap',
      fetch: async () => createSuccessResult(null, 'index data')
    })

    expect(source.id).toBe('docs.index')
    expect(source.namespace).toBe('docs')
    expect(source.kind).toBe('index')
    expect(source.description).toBe('Browse documentation structure')
    expect(source.costTier).toBe('cheap')
    expect(typeof source.fetch).toBe('function')
  })

  it('should extract namespace from id', () => {
    const source = makeSource('session.trace')
    expect(source.namespace).toBe('session')
  })

  it('should auto-generate shortDescription from description', () => {
    const source = defineContextSource({
      id: 'docs.search',
      kind: 'search',
      description: 'Search the documentation index for relevant content. Supports keyword and semantic search.',
      costTier: 'medium',
      fetch: async () => createSuccessResult(null, '')
    })

    // First sentence should be used
    expect(source.shortDescription).toBe('Search the documentation index for relevant content')
  })

  it('should use provided shortDescription over auto-generated', () => {
    const source = defineContextSource({
      id: 'docs.search',
      kind: 'search',
      description: 'Search the documentation index.',
      shortDescription: 'Custom short description',
      costTier: 'medium',
      fetch: async () => createSuccessResult(null, '')
    })

    expect(source.shortDescription).toBe('Custom short description')
  })

  it('should default resourceTypes to empty array', () => {
    const source = makeSource()
    expect(source.resourceTypes).toEqual([])
  })

  it('should preserve optional fields', () => {
    const source = defineContextSource({
      id: 'docs.open',
      kind: 'open',
      description: 'Open a document',
      costTier: 'medium',
      resourceTypes: ['markdown', 'text'],
      params: [{ name: 'path', type: 'string', required: true, description: 'File path' }],
      examples: [{ description: 'Open readme', params: { path: 'README.md' } }],
      cache: { ttlMs: 60000 },
      render: { maxTokens: 4000, truncateStrategy: 'tail' },
      fetch: async () => createSuccessResult(null, '')
    })

    expect(source.resourceTypes).toEqual(['markdown', 'text'])
    expect(source.params).toHaveLength(1)
    expect(source.examples).toHaveLength(1)
    expect(source.cache!.ttlMs).toBe(60000)
    expect(source.render!.maxTokens).toBe(4000)
  })

  describe('validation', () => {
    it('should throw when id is missing', () => {
      expect(() => defineContextSource({
        id: '',
        kind: 'get',
        description: 'desc',
        costTier: 'cheap',
        fetch: async () => createSuccessResult(null, '')
      })).toThrow('Context source id is required')
    })

    it('should throw on invalid id format - no dot separator', () => {
      expect(() => defineContextSource({
        id: 'nodot',
        kind: 'get',
        description: 'desc',
        costTier: 'cheap',
        fetch: async () => createSuccessResult(null, '')
      })).toThrow('Invalid source ID format')
    })

    it('should throw on invalid id format - uppercase', () => {
      expect(() => defineContextSource({
        id: 'Docs.Index',
        kind: 'get',
        description: 'desc',
        costTier: 'cheap',
        fetch: async () => createSuccessResult(null, '')
      })).toThrow('Invalid source ID format')
    })

    it('should throw on invalid id format - special characters', () => {
      expect(() => defineContextSource({
        id: 'docs.my_source',
        kind: 'get',
        description: 'desc',
        costTier: 'cheap',
        fetch: async () => createSuccessResult(null, '')
      })).toThrow('Invalid source ID format')
    })

    it('should accept valid id formats', () => {
      const validIds = ['docs.index', 'session.trace', 'memory.search', 'ctx.catalog']
      for (const id of validIds) {
        expect(() => defineContextSource({
          id,
          kind: 'get',
          description: 'desc',
          costTier: 'cheap',
          fetch: async () => createSuccessResult(null, '')
        })).not.toThrow()
      }
    })

    it('should throw when kind is missing', () => {
      expect(() => defineContextSource({
        id: 'test.source',
        kind: '' as any,
        description: 'desc',
        costTier: 'cheap',
        fetch: async () => createSuccessResult(null, '')
      })).toThrow('kind is required')
    })

    it('should throw on invalid kind', () => {
      expect(() => defineContextSource({
        id: 'test.source',
        kind: 'invalid' as any,
        description: 'desc',
        costTier: 'cheap',
        fetch: async () => createSuccessResult(null, '')
      })).toThrow('Invalid kind')
    })

    it('should accept all valid kinds', () => {
      for (const kind of ['index', 'search', 'open', 'get'] as const) {
        expect(() => defineContextSource({
          id: 'test.source',
          kind,
          description: 'desc',
          costTier: 'cheap',
          fetch: async () => createSuccessResult(null, '')
        })).not.toThrow()
      }
    })

    it('should throw when description is missing', () => {
      expect(() => defineContextSource({
        id: 'test.source',
        kind: 'get',
        description: '',
        costTier: 'cheap',
        fetch: async () => createSuccessResult(null, '')
      })).toThrow('description is required')
    })

    it('should throw when fetch is missing', () => {
      expect(() => defineContextSource({
        id: 'test.source',
        kind: 'get',
        description: 'desc',
        costTier: 'cheap',
        fetch: undefined as any
      })).toThrow('fetch function is required')
    })

    it('should throw when costTier is missing', () => {
      expect(() => defineContextSource({
        id: 'test.source',
        kind: 'get',
        description: 'desc',
        costTier: '' as any,
        fetch: async () => createSuccessResult(null, '')
      })).toThrow('costTier is required')
    })
  })
})

describe('createSuccessResult', () => {
  it('should create a proper success result', () => {
    const result = createSuccessResult({ items: [1, 2, 3] }, 'Three items found')

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ items: [1, 2, 3] })
    expect(result.rendered).toBe('Three items found')
    expect(result.provenance.operations).toEqual([])
    expect(result.provenance.durationMs).toBe(0)
    expect(result.provenance.cached).toBe(false)
    expect(result.coverage.complete).toBe(true)
  })

  it('should include provenance when specified', () => {
    const result = createSuccessResult('data', 'rendered', {
      provenance: {
        operations: [{ type: 'search', target: 'docs', traceId: 'tr-1' }],
        durationMs: 150,
        cached: true
      }
    })

    expect(result.provenance.operations).toHaveLength(1)
    expect(result.provenance.durationMs).toBe(150)
    expect(result.provenance.cached).toBe(true)
  })

  it('should include coverage when specified', () => {
    const result = createSuccessResult('data', 'rendered', {
      coverage: {
        complete: false,
        limitations: ['Only first 100 results'],
        suggestions: ['Narrow your search']
      }
    })

    expect(result.coverage.complete).toBe(false)
    expect(result.coverage.limitations).toEqual(['Only first 100 results'])
    expect(result.coverage.suggestions).toEqual(['Narrow your search'])
  })

  it('should include kindEcho and next when specified', () => {
    const result = createSuccessResult('data', 'rendered', {
      kindEcho: { source: 'docs.search', kind: 'search', paramsUsed: { query: 'test' } },
      next: [{ source: 'docs.open', params: { id: 'doc-1' }, why: 'Read the top result' }]
    })

    expect(result.kindEcho!.source).toBe('docs.search')
    expect(result.next).toHaveLength(1)
    expect(result.next![0].why).toBe('Read the top result')
  })
})

describe('createErrorResult', () => {
  it('should create a proper error result', () => {
    const result = createErrorResult('Something went wrong')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Something went wrong')
    expect(result.rendered).toBe('Error: Something went wrong')
    expect(result.provenance.cached).toBe(false)
    expect(result.coverage.complete).toBe(false)
  })

  it('should accept durationMs as legacy second argument', () => {
    const result = createErrorResult('timeout', 5000)

    expect(result.provenance.durationMs).toBe(5000)
  })

  it('should accept options object', () => {
    const result = createErrorResult('failed', {
      durationMs: 200,
      suggestions: ['Try again', 'Check your query'],
      kindEcho: { source: 'docs.search', kind: 'search', paramsUsed: { query: 'broken' } }
    })

    expect(result.provenance.durationMs).toBe(200)
    expect(result.coverage.suggestions).toEqual(['Try again', 'Check your query'])
    expect(result.kindEcho!.source).toBe('docs.search')
  })
})

describe('withContextTimeout', () => {
  it('should return result if fetch completes within timeout', async () => {
    const source = makeSource()
    const wrapped = withContextTimeout(source, 5000)

    const result = await wrapped.fetch({}, makeRuntime())

    expect(result.success).toBe(true)
  })

  it('should return error if fetch exceeds timeout', async () => {
    const slowSource = defineContextSource({
      id: 'test.slow',
      kind: 'get',
      description: 'Slow source',
      costTier: 'expensive',
      fetch: async () => {
        await new Promise(resolve => setTimeout(resolve, 5000))
        return createSuccessResult('data', 'rendered')
      }
    })

    const wrapped = withContextTimeout(slowSource, 50)
    const result = await wrapped.fetch({}, makeRuntime())

    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out')
    expect(result.error).toContain('50ms')
  })

  it('should preserve source metadata', () => {
    const source = makeSource('test.meta')
    const wrapped = withContextTimeout(source, 1000)

    expect(wrapped.id).toBe('test.meta')
    expect(wrapped.kind).toBe('get')
    expect(wrapped.namespace).toBe('test')
  })
})

describe('withContextRetry', () => {
  it('should return immediately on success', async () => {
    const fetchFn = vi.fn().mockResolvedValue(createSuccessResult('ok', 'ok'))
    const source = defineContextSource({
      id: 'test.retry',
      kind: 'get',
      description: 'Retry source',
      costTier: 'cheap',
      fetch: fetchFn
    })

    const wrapped = withContextRetry(source, 3, 1)
    const result = await wrapped.fetch({}, makeRuntime())

    expect(result.success).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('should retry on failure and eventually succeed', async () => {
    let callCount = 0
    const fetchFn = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount < 3) {
        return createErrorResult('not ready')
      }
      return createSuccessResult('ok', 'ok')
    })

    const source = defineContextSource({
      id: 'test.retry',
      kind: 'get',
      description: 'Retry source',
      costTier: 'cheap',
      fetch: fetchFn
    })

    const wrapped = withContextRetry(source, 5, 1)
    const result = await wrapped.fetch({}, makeRuntime())

    expect(result.success).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('should fail after exhausting retries', async () => {
    const fetchFn = vi.fn().mockResolvedValue(createErrorResult('always fails'))

    const source = defineContextSource({
      id: 'test.retry',
      kind: 'get',
      description: 'Always fails',
      costTier: 'cheap',
      fetch: fetchFn
    })

    const wrapped = withContextRetry(source, 2, 1)
    const result = await wrapped.fetch({}, makeRuntime())

    expect(result.success).toBe(false)
    // May stop early due to retry budget, but should have tried at least twice
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('should preserve source metadata', () => {
    const source = makeSource('test.meta')
    const wrapped = withContextRetry(source, 3)

    expect(wrapped.id).toBe('test.meta')
    expect(wrapped.kind).toBe('get')
  })
})

describe('withContextDefault', () => {
  it('should return actual result on success', async () => {
    const source = makeSource()
    const defaultResult = createSuccessResult('fallback', 'fallback rendered')

    const wrapped = withContextDefault(source, defaultResult)
    const result = await wrapped.fetch({}, makeRuntime())

    expect(result.success).toBe(true)
    expect(result.data).not.toBe('fallback')
  })

  it('should return default on failure result', async () => {
    const source = makeFailSource()
    const defaultResult = createSuccessResult('fallback', 'fallback rendered')

    const wrapped = withContextDefault(source, defaultResult)
    const result = await wrapped.fetch({}, makeRuntime())

    expect(result.success).toBe(true)
    expect(result.data).toBe('fallback')
    expect(result.rendered).toBe('fallback rendered')
  })

  it('should return default when fetch throws', async () => {
    const source = defineContextSource({
      id: 'test.throws',
      kind: 'get',
      description: 'Throws',
      costTier: 'cheap',
      fetch: async () => { throw new Error('kaboom') }
    })
    const defaultResult = createSuccessResult('safe', 'safe rendered')

    const wrapped = withContextDefault(source, defaultResult)
    const result = await wrapped.fetch({}, makeRuntime())

    expect(result.success).toBe(true)
    expect(result.data).toBe('safe')
  })

  it('should preserve source metadata', () => {
    const source = makeSource('test.default')
    const wrapped = withContextDefault(source, createSuccessResult(null, ''))

    expect(wrapped.id).toBe('test.default')
    expect(wrapped.kind).toBe('get')
  })
})

describe('composeContextSource', () => {
  it('should apply enhancers in order', () => {
    const source = makeSource('test.compose')

    const composed = composeContextSource(
      source,
      (s) => withContextDefault(s, createSuccessResult('fallback', '')),
      (s) => withContextTimeout(s, 5000)
    )

    expect(composed.id).toBe('test.compose')
    expect(typeof composed.fetch).toBe('function')
  })

  it('should return original source when no enhancers provided', () => {
    const source = makeSource()
    const result = composeContextSource(source)

    expect(result).toBe(source)
  })

  it('should chain timeout and default together', async () => {
    const slowSource = defineContextSource({
      id: 'test.slow',
      kind: 'get',
      description: 'Slow source',
      costTier: 'expensive',
      fetch: async () => {
        await new Promise(resolve => setTimeout(resolve, 5000))
        return createSuccessResult('slow data', 'slow')
      }
    })

    const composed = composeContextSource(
      slowSource,
      (s) => withContextTimeout(s, 50),
      (s) => withContextDefault(s, createSuccessResult('default', 'default rendered'))
    )

    const result = await composed.fetch({}, makeRuntime())

    // Timeout fires, then default catches the failure
    expect(result.success).toBe(true)
    expect(result.data).toBe('default')
  })
})
