/**
 * Blackboard Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Blackboard, createBlackboard, getNestedPath } from '../../src/team/state/blackboard.js'
import type { StateTraceContext } from '../../src/team/state/blackboard.js'

describe('Blackboard', () => {
  let blackboard: Blackboard
  let traceEvents: unknown[]
  let traceCtx: StateTraceContext

  beforeEach(() => {
    blackboard = createBlackboard({
      storage: 'memory',
      namespace: 'test'
    })
    traceEvents = []
    traceCtx = {
      runId: 'run-001',
      trace: {
        record: (event) => traceEvents.push(event)
      }
    }
  })

  describe('basic operations', () => {
    it('should put and get values', () => {
      blackboard.put('key1', 'value1')
      expect(blackboard.get('key1')).toBe('value1')
    })

    it('should prepend namespace to paths', () => {
      blackboard.put('key1', 'value1')
      // Internal path should be test.key1
      expect(blackboard.has('key1')).toBe(true)
    })

    it('should return undefined for non-existent keys', () => {
      expect(blackboard.get('nonexistent')).toBeUndefined()
    })

    it('should check existence with has()', () => {
      expect(blackboard.has('key1')).toBe(false)
      blackboard.put('key1', 'value1')
      expect(blackboard.has('key1')).toBe(true)
    })

    it('should delete values', () => {
      blackboard.put('key1', 'value1')
      expect(blackboard.delete('key1')).toBe(true)
      expect(blackboard.has('key1')).toBe(false)
      expect(blackboard.delete('key1')).toBe(false)
    })
  })

  describe('versioning', () => {
    it('should increment version on put', () => {
      const entry1 = blackboard.put('key1', 'v1')
      expect(entry1.version).toBe(1)

      const entry2 = blackboard.put('key1', 'v2')
      expect(entry2.version).toBe(2)
    })

    it('should track global version', () => {
      expect(blackboard.getVersion()).toBe(0)
      blackboard.put('key1', 'v1')
      expect(blackboard.getVersion()).toBe(1)
      blackboard.put('key2', 'v2')
      expect(blackboard.getVersion()).toBe(2)
    })
  })

  describe('append operation', () => {
    it('should append to arrays', () => {
      blackboard.put('list', [1, 2])
      blackboard.append('list', 3)
      expect(blackboard.get('list')).toEqual([1, 2, 3])
    })

    it('should create array if path does not exist', () => {
      blackboard.append('newlist', 'first')
      expect(blackboard.get('newlist')).toEqual(['first'])
    })

    it('should throw on append to non-array', () => {
      blackboard.put('str', 'hello')
      expect(() => blackboard.append('str', 'world')).toThrow()
    })
  })

  describe('patch operation', () => {
    it('should patch objects', () => {
      blackboard.put('obj', { a: 1, b: 2 })
      blackboard.patch('obj', { b: 3, c: 4 })
      expect(blackboard.get('obj')).toEqual({ a: 1, b: 3, c: 4 })
    })

    it('should create object if path does not exist', () => {
      blackboard.patch('newobj', { key: 'value' })
      expect(blackboard.get('newobj')).toEqual({ key: 'value' })
    })

    it('should throw on patch to non-object', () => {
      blackboard.put('arr', [1, 2, 3])
      expect(() => blackboard.patch('arr', { key: 'value' })).toThrow()
    })
  })

  describe('query operation', () => {
    it('should query paths by prefix', () => {
      blackboard.put('users.alice', { name: 'Alice' })
      blackboard.put('users.bob', { name: 'Bob' })
      blackboard.put('items.item1', { id: 1 })

      const users = blackboard.query('users')
      expect(users.length).toBe(2)
      expect(users.map(e => e.value)).toContainEqual({ name: 'Alice' })
      expect(users.map(e => e.value)).toContainEqual({ name: 'Bob' })
    })

    it('should return empty array for no matches', () => {
      const results = blackboard.query('nonexistent')
      expect(results).toEqual([])
    })
  })

  describe('tracing', () => {
    it('should record read events', () => {
      blackboard.put('key1', 'value1')
      blackboard.get('key1', traceCtx)

      expect(traceEvents.length).toBe(1)
      expect(traceEvents[0]).toMatchObject({
        type: 'state.read',
        runId: 'run-001',
        path: 'test.key1'
      })
    })

    it('should record write events', () => {
      blackboard.put('key1', 'value1', traceCtx)

      expect(traceEvents.length).toBe(1)
      expect(traceEvents[0]).toMatchObject({
        type: 'state.write',
        runId: 'run-001',
        path: 'test.key1',
        op: 'put'
      })
    })

    it('should record append events', () => {
      blackboard.append('list', 'item', traceCtx)

      expect(traceEvents[0]).toMatchObject({
        type: 'state.write',
        op: 'append'
      })
    })

    it('should record delete events', () => {
      blackboard.put('key1', 'value1')
      blackboard.delete('key1', traceCtx)

      expect(traceEvents[0]).toMatchObject({
        type: 'state.write',
        op: 'delete'
      })
    })
  })

  describe('export/import', () => {
    it('should export and import state', () => {
      blackboard.put('key1', 'value1')
      blackboard.put('key2', { nested: true })

      const exported = blackboard.export()
      expect(exported.entries.length).toBe(2)
      expect(exported.version).toBe(2)

      const newBoard = createBlackboard({ storage: 'memory', namespace: 'test' })
      newBoard.import(exported)

      expect(newBoard.get('key1')).toBe('value1')
      expect(newBoard.get('key2')).toEqual({ nested: true })
      expect(newBoard.getVersion()).toBe(2)
    })
  })

  describe('toObject', () => {
    it('should convert flat state to nested object', () => {
      blackboard.put('a.b.c', 'value')
      const obj = blackboard.toObject()
      expect(obj).toHaveProperty('test')
    })
  })

  describe('clear', () => {
    it('should clear all state', () => {
      blackboard.put('key1', 'value1')
      blackboard.put('key2', 'value2')
      blackboard.clear()

      expect(blackboard.has('key1')).toBe(false)
      expect(blackboard.has('key2')).toBe(false)
      expect(blackboard.getVersion()).toBe(0)
    })
  })
})

describe('getNestedPath', () => {
  it('should get nested values', () => {
    const obj = { a: { b: { c: 'value' } } }
    expect(getNestedPath(obj, 'a.b.c')).toBe('value')
  })

  it('should return undefined for missing paths', () => {
    const obj = { a: { b: 1 } }
    expect(getNestedPath(obj, 'a.c.d')).toBeUndefined()
  })

  it('should handle null values', () => {
    const obj = { a: null }
    expect(getNestedPath(obj, 'a.b')).toBeUndefined()
  })
})
