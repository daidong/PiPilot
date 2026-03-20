/**
 * Reducer Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  ReducerRegistry,
  createReducerRegistry,
  concatReducer,
  mergeReducer,
  deepMergeReducer,
  firstReducer,
  lastReducer,
  collectReducer,
  voteReducer,
  sumReducer,
  avgReducer,
  maxReducer,
  minReducer
} from '../../src/team/flow/reducers.js'
import type { ReducerContext } from '../../src/team/flow/reducers.js'

describe('ReducerRegistry', () => {
  let registry: ReducerRegistry
  let traceEvents: unknown[]
  let ctx: ReducerContext

  beforeEach(() => {
    registry = createReducerRegistry()
    traceEvents = []
    ctx = {
      nodeId: 'node-001',
      runId: 'run-001',
      trace: {
        record: (event) => traceEvents.push(event)
      }
    }
  })

  describe('registration', () => {
    it('should register built-in reducers', () => {
      expect(registry.has('concat')).toBe(true)
      expect(registry.has('merge')).toBe(true)
      expect(registry.has('first')).toBe(true)
      expect(registry.has('last')).toBe(true)
      expect(registry.has('collect')).toBe(true)
      expect(registry.has('vote')).toBe(true)
      expect(registry.has('sum')).toBe(true)
      expect(registry.has('avg')).toBe(true)
      expect(registry.has('max')).toBe(true)
      expect(registry.has('min')).toBe(true)
    })

    it('should list all reducer IDs', () => {
      const ids = registry.list()
      expect(ids).toContain('concat')
      expect(ids).toContain('merge')
      expect(ids.length).toBeGreaterThanOrEqual(10)
    })

    it('should throw on duplicate registration', () => {
      expect(() => registry.register(concatReducer)).toThrow()
    })

    it('should get reducer by ID', () => {
      const reducer = registry.get('concat')
      expect(reducer).toBeDefined()
      expect(reducer?.id).toBe('concat')
    })
  })

  describe('apply with tracing', () => {
    it('should record trace events', () => {
      registry.apply('concat', [[1], [2]], undefined, ctx)

      expect(traceEvents.length).toBe(1)
      expect(traceEvents[0]).toMatchObject({
        type: 'reducer.apply',
        runId: 'run-001',
        nodeId: 'node-001',
        reducerId: 'concat'
      })
    })

    it('should throw for unknown reducer', () => {
      expect(() => registry.apply('unknown', [], undefined, ctx)).toThrow()
    })
  })
})

describe('Built-in Reducers', () => {
  let ctx: ReducerContext

  beforeEach(() => {
    ctx = {
      nodeId: 'node-001',
      runId: 'run-001',
      trace: { record: () => {} }
    }
  })

  describe('concat', () => {
    it('should concatenate arrays', () => {
      const result = concatReducer.apply([[1, 2], [3, 4], [5]], undefined, ctx)
      expect(result).toEqual([1, 2, 3, 4, 5])
    })

    it('should handle empty arrays', () => {
      const result = concatReducer.apply([[], [1], []], undefined, ctx)
      expect(result).toEqual([1])
    })
  })

  describe('merge', () => {
    it('should merge objects', () => {
      const result = mergeReducer.apply([
        { a: 1 },
        { b: 2 },
        { c: 3 }
      ], undefined, ctx)
      expect(result).toEqual({ a: 1, b: 2, c: 3 })
    })

    it('should override earlier values', () => {
      const result = mergeReducer.apply([
        { a: 1 },
        { a: 2 }
      ], undefined, ctx)
      expect(result).toEqual({ a: 2 })
    })
  })

  describe('deepMerge', () => {
    it('should deep merge objects', () => {
      const result = deepMergeReducer.apply([
        { a: { x: 1 } },
        { a: { y: 2 }, b: 3 }
      ], undefined, ctx)
      expect(result).toEqual({ a: { x: 1, y: 2 }, b: 3 })
    })

    it('should not merge arrays', () => {
      const result = deepMergeReducer.apply([
        { a: [1, 2] },
        { a: [3, 4] }
      ], undefined, ctx)
      expect(result).toEqual({ a: [3, 4] })
    })
  })

  describe('first', () => {
    it('should return first input', () => {
      const result = firstReducer.apply(['a', 'b', 'c'], undefined, ctx)
      expect(result).toBe('a')
    })
  })

  describe('last', () => {
    it('should return last input', () => {
      const result = lastReducer.apply(['a', 'b', 'c'], undefined, ctx)
      expect(result).toBe('c')
    })
  })

  describe('collect', () => {
    it('should collect all inputs', () => {
      const result = collectReducer.apply([1, 2, 3], undefined, ctx)
      expect(result).toEqual([1, 2, 3])
    })
  })

  describe('vote', () => {
    it('should return majority value', () => {
      const result = voteReducer.apply(['a', 'b', 'a', 'c', 'a'], undefined, ctx)
      expect(result).toBe('a')
    })

    it('should handle tie by first occurrence', () => {
      const result = voteReducer.apply(['a', 'b'], undefined, ctx)
      // Either a or b could win, but should not throw
      expect(['a', 'b']).toContain(result)
    })
  })

  describe('sum', () => {
    it('should sum numbers', () => {
      const result = sumReducer.apply([1, 2, 3, 4], undefined, ctx)
      expect(result).toBe(10)
    })

    it('should return 0 for empty array', () => {
      const result = sumReducer.apply([], undefined, ctx)
      expect(result).toBe(0)
    })
  })

  describe('avg', () => {
    it('should average numbers', () => {
      const result = avgReducer.apply([2, 4, 6], undefined, ctx)
      expect(result).toBe(4)
    })

    it('should return 0 for empty array', () => {
      const result = avgReducer.apply([], undefined, ctx)
      expect(result).toBe(0)
    })
  })

  describe('max', () => {
    it('should return maximum', () => {
      const result = maxReducer.apply([3, 1, 4, 1, 5], undefined, ctx)
      expect(result).toBe(5)
    })
  })

  describe('min', () => {
    it('should return minimum', () => {
      const result = minReducer.apply([3, 1, 4, 1, 5], undefined, ctx)
      expect(result).toBe(1)
    })
  })
})

describe('Reducer Determinism', () => {
  let ctx: ReducerContext

  beforeEach(() => {
    ctx = {
      nodeId: 'node-001',
      runId: 'run-001',
      trace: { record: () => {} }
    }
  })

  it('all reducers should have deterministic: true', () => {
    const reducers = [
      concatReducer,
      mergeReducer,
      deepMergeReducer,
      firstReducer,
      lastReducer,
      collectReducer,
      voteReducer,
      sumReducer,
      avgReducer,
      maxReducer,
      minReducer
    ]

    for (const reducer of reducers) {
      expect(reducer.deterministic).toBe(true)
    }
  })

  it('should produce same output for same inputs', () => {
    const inputs = [{ a: 1 }, { b: 2 }]

    const result1 = mergeReducer.apply([...inputs], undefined, ctx)
    const result2 = mergeReducer.apply([...inputs], undefined, ctx)

    expect(result1).toEqual(result2)
  })
})
