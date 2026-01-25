/**
 * ContextManager 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContextManager } from '../../src/core/context-manager.js'
import { TraceCollector } from '../../src/core/trace-collector.js'
import { TokenBudget } from '../../src/core/token-budget.js'
import type { ContextSource } from '../../src/types/context.js'
import type { Runtime } from '../../src/types/runtime.js'

describe('ContextManager', () => {
  let contextManager: ContextManager
  let trace: TraceCollector
  let tokenBudget: TokenBudget
  let mockRuntime: Runtime

  beforeEach(() => {
    trace = new TraceCollector('test-session')
    tokenBudget = new TokenBudget({ total: 10000 })
    contextManager = new ContextManager()

    mockRuntime = {
      projectPath: '/test/project',
      sessionId: 'test-session',
      agentId: 'test-agent',
      step: 0,
      io: {} as any,
      eventBus: {} as any,
      trace,
      tokenBudget,
      toolRegistry: {} as any,
      policyEngine: {} as any,
      contextManager,
      sessionState: {} as any
    }

    contextManager.configure({ trace, tokenBudget, runtime: mockRuntime })
  })

  describe('register', () => {
    it('should register context source', () => {
      const source: ContextSource = {
        id: 'test-source',
        name: 'Test Source',
        description: 'A test source',
        fetch: async () => ({
          rendered: 'Test content',
          provenance: { source: 'test-source' },
          coverage: { complete: true }
        })
      }

      contextManager.register(source)

      expect(contextManager.getSource('test-source')).toBe(source)
    })

    it('should register multiple sources', () => {
      contextManager.registerAll([
        {
          id: 'source1',
          name: 'Source 1',
          description: 'Source 1',
          fetch: async () => ({
            rendered: 'Content 1',
            provenance: { source: 'source1' },
            coverage: { complete: true }
          })
        },
        {
          id: 'source2',
          name: 'Source 2',
          description: 'Source 2',
          fetch: async () => ({
            rendered: 'Content 2',
            provenance: { source: 'source2' },
            coverage: { complete: true }
          })
        }
      ])

      expect(contextManager.get('source1')).toBeDefined()
      expect(contextManager.get('source2')).toBeDefined()
    })
  })

  describe('fetch', () => {
    it('should fetch context from source', async () => {
      contextManager.register({
        id: 'test-source',
        name: 'Test Source',
        description: 'A test source',
        fetch: async () => ({
          rendered: 'Test content',
          provenance: { source: 'test-source' },
          coverage: { complete: true }
        })
      })

      const result = await contextManager.get('test-source', {})

      expect(result.rendered).toBe('Test content')
    })

    it('should return error for unknown source', async () => {
      const result = await contextManager.get('unknown-source', {})

      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown source')
    })

    it('should handle fetch errors', async () => {
      contextManager.register({
        id: 'error-source',
        name: 'Error Source',
        description: 'A source that throws',
        fetch: async () => {
          throw new Error('Fetch failed')
        }
      })

      const result = await contextManager.get('error-source', {})

      expect(result.success).toBe(false)
      expect(result.error).toContain('Fetch failed')
    })
  })

  describe('caching', () => {
    it('should cache results when cache is set', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        rendered: 'Cached content',
        provenance: { source: 'cached-source' },
        coverage: { complete: true }
      })

      contextManager.register({
        id: 'cached-source',
        name: 'Cached Source',
        description: 'A cached source',
        cache: { ttlMs: 60000 },
        fetch: fetchFn
      })

      // 第一次调用
      await contextManager.get('cached-source', { key: 'value' })

      // 第二次调用（应该使用缓存）
      await contextManager.get('cached-source', { key: 'value' })

      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('should not cache when cache is not set', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        rendered: 'Content',
        provenance: { source: 'no-cache' },
        coverage: { complete: true }
      })

      contextManager.register({
        id: 'no-cache',
        name: 'No Cache',
        description: 'No caching',
        fetch: fetchFn
      })

      await contextManager.get('no-cache', { key: 'value' })
      await contextManager.get('no-cache', { key: 'value' })

      expect(fetchFn).toHaveBeenCalledTimes(2)
    })

    it('should clear cache', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        rendered: 'Content',
        provenance: { source: 'cached' },
        coverage: { complete: true }
      })

      contextManager.register({
        id: 'cached',
        name: 'Cached',
        description: 'Cached',
        cache: { ttlMs: 60000 },
        fetch: fetchFn
      })

      await contextManager.get('cached', {})

      contextManager.clearCache()

      await contextManager.get('cached', {})

      expect(fetchFn).toHaveBeenCalledTimes(2)
    })
  })

  describe('get multiple sources', () => {
    beforeEach(() => {
      contextManager.registerAll([
        {
          id: 'source1',
          name: 'Source 1',
          description: 'Source 1',
          fetch: async () => ({
            rendered: 'Content 1',
            provenance: { source: 'source1' },
            coverage: { complete: true }
          })
        },
        {
          id: 'source2',
          name: 'Source 2',
          description: 'Source 2',
          fetch: async () => ({
            rendered: 'Content 2',
            provenance: { source: 'source2' },
            coverage: { complete: true }
          })
        }
      ])
    })

    it('should get from multiple sources', async () => {
      const result1 = await contextManager.get('source1', {})
      const result2 = await contextManager.get('source2', {})

      expect(result1.rendered).toBe('Content 1')
      expect(result2.rendered).toBe('Content 2')
    })

    it('should handle partial failures', async () => {
      const result1 = await contextManager.get('source1', {})
      const result2 = await contextManager.get('unknown', {})

      expect(result1.rendered).toBe('Content 1')
      expect(result2.success).toBe(false)
    })
  })

  describe('getAllSources', () => {
    it('should return all registered sources', () => {
      contextManager.registerAll([
        {
          id: 'source1',
          name: 'Source 1',
          description: 'Source 1',
          fetch: async () => ({
            rendered: '',
            provenance: {},
            coverage: {}
          })
        },
        {
          id: 'source2',
          name: 'Source 2',
          description: 'Source 2',
          fetch: async () => ({
            rendered: '',
            provenance: {},
            coverage: {}
          })
        }
      ])

      const sources = contextManager.getAllSources()

      expect(sources).toHaveLength(2)
      expect(sources.map(s => s.id)).toContain('source1')
      expect(sources.map(s => s.id)).toContain('source2')
    })
  })

  describe('clear', () => {
    it('should clear all sources', () => {
      contextManager.register({
        id: 'test',
        name: 'Test',
        description: 'Test',
        fetch: async () => ({
          rendered: '',
          provenance: {},
          coverage: {}
        })
      })

      contextManager.clear()

      expect(contextManager.getAllSources()).toHaveLength(0)
    })
  })
})
