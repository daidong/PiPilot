/**
 * IsolatedBlackboard Tests - Verify backward compatibility
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createBlackboard, type Blackboard } from '../../src/team/state/blackboard.js'
import {
  createIsolatedBlackboard,
  IsolatedBlackboard,
  SYSTEM_AGENT,
  isIsolatedBlackboard
} from '../../src/team/state/isolated-blackboard.js'

describe('IsolatedBlackboard', () => {
  let bb: Blackboard
  let ib: IsolatedBlackboard

  beforeEach(() => {
    bb = createBlackboard({ storage: 'memory', namespace: 'my-team' })
    ib = createIsolatedBlackboard({ namespace: 'my-team' })
  })

  describe('API Compatibility', () => {
    it('should have same put/get behavior as Blackboard', () => {
      bb.put('findings', [1, 2, 3])
      ib.put('findings', [1, 2, 3])

      expect(bb.get('findings')).toEqual([1, 2, 3])
      expect(ib.get('findings')).toEqual([1, 2, 3])
    })

    it('should have same has behavior as Blackboard', () => {
      bb.put('key', 'value')
      ib.put('key', 'value')

      expect(bb.has('key')).toBe(true)
      expect(ib.has('key')).toBe(true)
      expect(bb.has('nonexistent')).toBe(false)
      expect(ib.has('nonexistent')).toBe(false)
    })

    it('should have same append behavior as Blackboard', () => {
      bb.put('list', [1])
      ib.put('list', [1])

      bb.append('list', 2)
      ib.append('list', 2)

      expect(bb.get('list')).toEqual([1, 2])
      expect(ib.get('list')).toEqual([1, 2])
    })

    it('should have same patch behavior as Blackboard', () => {
      bb.put('obj', { a: 1 })
      ib.put('obj', { a: 1 })

      bb.patch('obj', { b: 2 })
      ib.patch('obj', { b: 2 })

      expect(bb.get('obj')).toEqual({ a: 1, b: 2 })
      expect(ib.get('obj')).toEqual({ a: 1, b: 2 })
    })

    it('should have same getTree behavior as Blackboard', () => {
      bb.put('research.findings', [1, 2])
      bb.put('research.summary', 'test')
      ib.put('research.findings', [1, 2])
      ib.put('research.summary', 'test')

      // getTree should assemble nested entries
      const bbTree = bb.getTree('research')
      const ibTree = ib.getTree('research')

      expect(bbTree).toEqual({ findings: [1, 2], summary: 'test' })
      expect(ibTree).toEqual({ findings: [1, 2], summary: 'test' })
    })
  })

  describe('toObject Structure (CRITICAL)', () => {
    it('toObject should return compatible structure for getStateWithoutNamespace', () => {
      bb.put('findings', [1, 2, 3])
      ib.put('findings', [1, 2, 3])

      const bbObj = bb.toObject()
      const ibObj = ib.toObject()

      console.log('Blackboard toObject():', JSON.stringify(bbObj, null, 2))
      console.log('IsolatedBlackboard toObject():', JSON.stringify(ibObj, null, 2))

      // getStateWithoutNamespace logic
      function getStateWithoutNamespace(state: { toObject?(): Record<string, unknown>, namespace?: string }) {
        const fullStateObj = state.toObject?.() ?? {}
        const namespace = state.namespace
        if (namespace && fullStateObj[namespace] && typeof fullStateObj[namespace] === 'object') {
          return fullStateObj[namespace] as Record<string, unknown>
        }
        return fullStateObj
      }

      const bbState = getStateWithoutNamespace(bb)
      const ibState = getStateWithoutNamespace(ib)

      console.log('getStateWithoutNamespace(bb):', JSON.stringify(bbState, null, 2))
      console.log('getStateWithoutNamespace(ib):', JSON.stringify(ibState, null, 2))

      // CRITICAL: Both should return { findings: [1, 2, 3] }
      // If IsolatedBlackboard returns { team: { findings: ... } }, branch conditions break!
      expect(bbState).toEqual({ findings: [1, 2, 3] })
      expect(ibState).toEqual({ findings: [1, 2, 3] }) // This might fail!
    })
  })

  describe('Agent Context', () => {
    it('should start with SYSTEM_AGENT', () => {
      expect(ib.getCurrentAgent()).toBe(SYSTEM_AGENT)
    })

    it('should switch agent context', () => {
      ib.setCurrentAgent('researcher')
      expect(ib.getCurrentAgent()).toBe('researcher')

      ib.resetAgent()
      expect(ib.getCurrentAgent()).toBe(SYSTEM_AGENT)
    })

    it('should support private data per agent', () => {
      ib.setCurrentAgent('researcher')
      ib.setPrivate('scratch', 'working')
      expect(ib.getPrivate('scratch')).toBe('working')

      ib.setCurrentAgent('writer')
      expect(ib.getPrivate('scratch')).toBeUndefined() // Different agent's private data

      ib.setPrivate('scratch', 'writing')
      expect(ib.getPrivate('scratch')).toBe('writing')

      ib.setCurrentAgent('researcher')
      expect(ib.getPrivate('scratch')).toBe('working') // Original agent's data intact
    })
  })

  describe('Type Guard', () => {
    it('isIsolatedBlackboard should correctly identify IsolatedBlackboard', () => {
      expect(isIsolatedBlackboard(ib)).toBe(true)
      expect(isIsolatedBlackboard(bb)).toBe(false)
      expect(isIsolatedBlackboard(null)).toBe(false)
      expect(isIsolatedBlackboard({})).toBe(false)
    })
  })

  describe('Executor Integration', () => {
    it('should support nested paths used by flow executor', () => {
      // Simulate flow executor writing output
      ib.put('research.findings', ['fact1', 'fact2'])
      ib.put('research.summary', 'A summary')
      ib.put('draft', { title: 'Article', content: 'Content' })

      // Verify individual gets
      expect(ib.get('research.findings')).toEqual(['fact1', 'fact2'])
      expect(ib.get('draft')).toEqual({ title: 'Article', content: 'Content' })

      // Verify getTree (used by resolveInput in executor)
      const research = ib.getTree('research')
      expect(research).toEqual({
        findings: ['fact1', 'fact2'],
        summary: 'A summary'
      })

      // Verify toObject for branch conditions
      const state = ib.toObject()
      expect(state['my-team']).toHaveProperty('research')
      expect(state['my-team']).toHaveProperty('draft')
    })

    it('should preserve data across agent context switches', () => {
      // Agent 1 writes
      ib.setCurrentAgent('researcher')
      ib.put('findings', ['research result'])

      // Agent 2 writes
      ib.setCurrentAgent('writer')
      ib.put('draft', 'article draft')

      // Verify both writes are visible (team namespace)
      ib.resetAgent()
      expect(ib.get('findings')).toEqual(['research result'])
      expect(ib.get('draft')).toBe('article draft')
    })
  })
})
