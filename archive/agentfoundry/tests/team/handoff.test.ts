/**
 * Handoff Tests
 */

import { describe, it, expect } from 'vitest'
import {
  isHandoffResult,
  createHandoff,
  parseHandoff,
  executeHandoffChain
} from '../../src/team/flow/handoff.js'
import type { HandoffResult } from '../../src/team/flow/handoff.js'

describe('Handoff', () => {
  describe('isHandoffResult', () => {
    it('should detect valid handoff result', () => {
      const handoff: HandoffResult = {
        type: 'handoff',
        target: 'agent2'
      }
      expect(isHandoffResult(handoff)).toBe(true)
    })

    it('should reject non-handoff objects', () => {
      expect(isHandoffResult({ type: 'complete', output: 'data' })).toBe(false)
      expect(isHandoffResult({ target: 'agent' })).toBe(false) // missing type
      expect(isHandoffResult(null)).toBe(false)
      expect(isHandoffResult(undefined)).toBe(false)
      expect(isHandoffResult('string')).toBe(false)
    })
  })

  describe('createHandoff', () => {
    it('should create handoff with target only', () => {
      const handoff = createHandoff('agent2')

      expect(handoff.type).toBe('handoff')
      expect(handoff.target).toBe('agent2')
      expect(handoff.data).toBeUndefined()
    })

    it('should create handoff with data', () => {
      const handoff = createHandoff('agent2', {
        data: { context: 'important' }
      })

      expect(handoff.data).toEqual({ context: 'important' })
    })

    it('should create handoff with reason', () => {
      const handoff = createHandoff('agent2', {
        reason: 'Need specialist'
      })

      expect(handoff.reason).toBe('Need specialist')
    })

    it('should create handoff with transfer spec', () => {
      const handoff = createHandoff('agent2', {
        transfer: { mode: 'minimal' }
      })

      expect(handoff.transfer).toEqual({ mode: 'minimal' })
    })
  })

  describe('parseHandoff', () => {
    it('should parse direct HandoffResult', () => {
      const input: HandoffResult = {
        type: 'handoff',
        target: 'agent2',
        data: { key: 'value' }
      }

      const result = parseHandoff(input)

      expect(result).toEqual(input)
    })

    it('should parse handoff_to format', () => {
      const input = {
        handoff_to: 'specialist',
        data: { context: 'data' },
        reason: 'needs expert'
      }

      const result = parseHandoff(input)

      expect(result?.type).toBe('handoff')
      expect(result?.target).toBe('specialist')
      expect(result?.data).toEqual({ context: 'data' })
      expect(result?.reason).toBe('needs expert')
    })

    it('should parse transfer_to format', () => {
      const input = {
        transfer_to: 'specialist',
        context: { info: 'data' }
      }

      const result = parseHandoff(input)

      expect(result?.type).toBe('handoff')
      expect(result?.target).toBe('specialist')
      expect(result?.data).toEqual({ info: 'data' })
    })

    it('should parse JSON string', () => {
      const input = JSON.stringify({
        type: 'handoff',
        target: 'agent2'
      })

      const result = parseHandoff(input)

      expect(result?.type).toBe('handoff')
      expect(result?.target).toBe('agent2')
    })

    it('should return null for non-handoff', () => {
      expect(parseHandoff({ output: 'data' })).toBeNull()
      expect(parseHandoff('not json')).toBeNull()
      expect(parseHandoff(123)).toBeNull()
      expect(parseHandoff(null)).toBeNull()
    })
  })

  describe('executeHandoffChain', () => {
    it('should complete without handoff', async () => {
      const result = await executeHandoffChain(
        'agent1',
        { input: 'data' },
        async (_agentId, agentInput) => {
          return { output: 'completed', received: agentInput }
        },
        { maxHandoffs: 5, trackHistory: true }
      )

      expect(result.completed).toBe(true)
      expect(result.finalAgent).toBe('agent1')
      expect(result.handoffHistory.length).toBe(0)
    })

    it('should follow handoff chain', async () => {
      const invoked: string[] = []

      const result = await executeHandoffChain(
        'agent1',
        { input: 'start' },
        async (agentId) => {
          invoked.push(agentId)
          if (agentId === 'agent1') {
            return createHandoff('agent2', { data: { step: 1 } })
          }
          if (agentId === 'agent2') {
            return createHandoff('agent3', { data: { step: 2 } })
          }
          return { output: 'done' }
        },
        { maxHandoffs: 5, trackHistory: true }
      )

      expect(result.completed).toBe(true)
      expect(result.finalAgent).toBe('agent3')
      expect(invoked).toEqual(['agent1', 'agent2', 'agent3'])
      expect(result.handoffHistory.length).toBe(2)
    })

    it('should respect maxHandoffs limit', async () => {
      const invoked: string[] = []

      const result = await executeHandoffChain(
        'agent1',
        {},
        async (agentId) => {
          invoked.push(agentId)
          // Always handoff to self
          return createHandoff(agentId)
        },
        { maxHandoffs: 3, trackHistory: true }
      )

      expect(result.completed).toBe(false)
      expect(invoked.length).toBe(4) // initial + 3 handoffs
    })

    it('should enforce allowed targets', async () => {
      await expect(
        executeHandoffChain(
          'agent1',
          {},
          async () => createHandoff('unauthorized'),
          { maxHandoffs: 5, allowedTargets: ['agent2', 'agent3'] }
        )
      ).rejects.toThrow('not allowed')
    })

    it('should track handoff history', async () => {
      const result = await executeHandoffChain(
        'agent1',
        {},
        async (agentId) => {
          if (agentId === 'agent1') {
            return createHandoff('agent2', { reason: 'Need expert' })
          }
          return { done: true }
        },
        { maxHandoffs: 5, trackHistory: true }
      )

      expect(result.handoffHistory.length).toBe(1)
      expect(result.handoffHistory[0].from).toBe('agent1')
      expect(result.handoffHistory[0].to).toBe('agent2')
      expect(result.handoffHistory[0].reason).toBe('Need expert')
    })

    it('should pass data through handoff chain', async () => {
      const receivedInputs: unknown[] = []

      await executeHandoffChain(
        'agent1',
        { original: 'input' },
        async (agentId, agentInput) => {
          receivedInputs.push(agentInput)
          if (agentId === 'agent1') {
            return createHandoff('agent2', { data: { modified: 'data' } })
          }
          return { done: true }
        },
        { maxHandoffs: 5 }
      )

      expect(receivedInputs[0]).toEqual({ original: 'input' })
      expect(receivedInputs[1]).toEqual({ modified: 'data' })
    })
  })
})
