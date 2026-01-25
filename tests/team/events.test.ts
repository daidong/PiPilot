/**
 * Team Runtime Events Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  TeamEventEmitter,
  createEventEmitter,
  type TeamRuntimeEvents
} from '../../src/team/runtime/events.js'

describe('TeamEventEmitter', () => {
  let emitter: TeamEventEmitter

  beforeEach(() => {
    emitter = createEventEmitter()
  })

  describe('on() subscription', () => {
    it('should subscribe to events', () => {
      const handler = vi.fn()
      emitter.on('agent.started', handler)

      emitter.emit('agent.started', {
        agentId: 'test-agent',
        runId: 'run-1',
        input: { query: 'test' },
        step: 1,
        ts: Date.now()
      })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'test-agent',
          runId: 'run-1'
        })
      )
    })

    it('should support multiple handlers for same event', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      emitter.on('team.started', handler1)
      emitter.on('team.started', handler2)

      emitter.emit('team.started', {
        teamId: 'test-team',
        runId: 'run-1',
        input: {},
        ts: Date.now()
      })

      expect(handler1).toHaveBeenCalledTimes(1)
      expect(handler2).toHaveBeenCalledTimes(1)
    })

    it('should return unsubscribe function', () => {
      const handler = vi.fn()
      const unsubscribe = emitter.on('agent.completed', handler)

      emitter.emit('agent.completed', {
        agentId: 'test',
        runId: 'run-1',
        output: {},
        durationMs: 100,
        step: 1,
        ts: Date.now()
      })

      expect(handler).toHaveBeenCalledTimes(1)

      unsubscribe()

      emitter.emit('agent.completed', {
        agentId: 'test',
        runId: 'run-1',
        output: {},
        durationMs: 100,
        step: 1,
        ts: Date.now()
      })

      expect(handler).toHaveBeenCalledTimes(1) // Still 1, not called again
    })

    it('should handle events with different types', () => {
      const teamHandler = vi.fn()
      const agentHandler = vi.fn()

      emitter.on('team.started', teamHandler)
      emitter.on('agent.started', agentHandler)

      emitter.emit('team.started', {
        teamId: 'team-1',
        runId: 'run-1',
        input: {},
        ts: Date.now()
      })

      expect(teamHandler).toHaveBeenCalledTimes(1)
      expect(agentHandler).toHaveBeenCalledTimes(0)
    })
  })

  describe('once() subscription', () => {
    it('should only call handler once', () => {
      const handler = vi.fn()
      emitter.once('agent.failed', handler)

      const event = {
        agentId: 'test',
        runId: 'run-1',
        error: new Error('test error'),
        durationMs: 50,
        step: 1,
        ts: Date.now()
      }

      emitter.emit('agent.failed', event)
      emitter.emit('agent.failed', event)
      emitter.emit('agent.failed', event)

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('should return unsubscribe function that works before first emit', () => {
      const handler = vi.fn()
      const unsubscribe = emitter.once('team.completed', handler)

      unsubscribe()

      emitter.emit('team.completed', {
        teamId: 'team-1',
        runId: 'run-1',
        output: {},
        durationMs: 1000,
        steps: 5,
        ts: Date.now()
      })

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('off() removal', () => {
    it('should remove all handlers for an event', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      emitter.on('step.started', handler1)
      emitter.on('step.started', handler2)

      emitter.off('step.started')

      emitter.emit('step.started', {
        stepId: 'step-1',
        kind: 'invoke',
        runId: 'run-1',
        ts: Date.now()
      })

      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).not.toHaveBeenCalled()
    })
  })

  describe('offAll() removal', () => {
    it('should remove all handlers for all events', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      emitter.on('team.started', handler1)
      emitter.on('agent.started', handler2)

      emitter.offAll()

      emitter.emit('team.started', {
        teamId: 'team-1',
        runId: 'run-1',
        input: {},
        ts: Date.now()
      })

      emitter.emit('agent.started', {
        agentId: 'agent-1',
        runId: 'run-1',
        input: {},
        step: 1,
        ts: Date.now()
      })

      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).not.toHaveBeenCalled()
    })
  })

  describe('listenerCount()', () => {
    it('should return correct count', () => {
      expect(emitter.listenerCount('team.started')).toBe(0)

      emitter.on('team.started', () => {})
      expect(emitter.listenerCount('team.started')).toBe(1)

      emitter.on('team.started', () => {})
      expect(emitter.listenerCount('team.started')).toBe(2)
    })
  })

  describe('eventNames()', () => {
    it('should return all registered event names', () => {
      emitter.on('team.started', () => {})
      emitter.on('agent.started', () => {})
      emitter.on('step.completed', () => {})

      const names = emitter.eventNames()

      expect(names).toContain('team.started')
      expect(names).toContain('agent.started')
      expect(names).toContain('step.completed')
      expect(names.length).toBe(3)
    })
  })

  describe('error handling', () => {
    it('should not throw if handler throws', () => {
      const errorHandler = vi.fn().mockImplementation(() => {
        throw new Error('Handler error')
      })
      const goodHandler = vi.fn()

      emitter.on('team.started', errorHandler)
      emitter.on('team.started', goodHandler)

      // Should not throw
      expect(() => {
        emitter.emit('team.started', {
          teamId: 'team-1',
          runId: 'run-1',
          input: {},
          ts: Date.now()
        })
      }).not.toThrow()

      // Both handlers should have been called
      expect(errorHandler).toHaveBeenCalled()
      expect(goodHandler).toHaveBeenCalled()
    })
  })
})

describe('Event Types', () => {
  let emitter: TeamEventEmitter

  beforeEach(() => {
    emitter = createEventEmitter()
  })

  it('should handle team.started event', () => {
    const handler = vi.fn()
    emitter.on('team.started', handler)

    const event: TeamRuntimeEvents['team.started'] = {
      teamId: 'literature-team',
      runId: 'run-123',
      input: { query: 'Find papers on transformers' },
      ts: Date.now()
    }

    emitter.emit('team.started', event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('should handle team.completed event', () => {
    const handler = vi.fn()
    emitter.on('team.completed', handler)

    const event: TeamRuntimeEvents['team.completed'] = {
      teamId: 'literature-team',
      runId: 'run-123',
      output: { papers: [], summary: 'No results' },
      durationMs: 5000,
      steps: 10,
      ts: Date.now()
    }

    emitter.emit('team.completed', event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('should handle team.failed event', () => {
    const handler = vi.fn()
    emitter.on('team.failed', handler)

    const event: TeamRuntimeEvents['team.failed'] = {
      teamId: 'literature-team',
      runId: 'run-123',
      error: new Error('API rate limit exceeded'),
      durationMs: 2000,
      ts: Date.now()
    }

    emitter.emit('team.failed', event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('should handle agent.started event', () => {
    const handler = vi.fn()
    emitter.on('agent.started', handler)

    const event: TeamRuntimeEvents['agent.started'] = {
      agentId: 'planner',
      runId: 'run-123',
      input: { userRequest: 'Find papers' },
      step: 1,
      ts: Date.now()
    }

    emitter.emit('agent.started', event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('should handle agent.completed event with tokens', () => {
    const handler = vi.fn()
    emitter.on('agent.completed', handler)

    const event: TeamRuntimeEvents['agent.completed'] = {
      agentId: 'planner',
      runId: 'run-123',
      output: { queries: ['transformer architecture', 'attention mechanism'] },
      durationMs: 1500,
      tokens: {
        promptTokens: 500,
        completionTokens: 200,
        totalTokens: 700
      },
      step: 1,
      ts: Date.now()
    }

    emitter.emit('agent.completed', event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('should handle loop.iteration event', () => {
    const handler = vi.fn()
    emitter.on('loop.iteration', handler)

    const event: TeamRuntimeEvents['loop.iteration'] = {
      loopId: 'review-loop',
      runId: 'run-123',
      iteration: 2,
      maxIterations: 5,
      continuing: true,
      ts: Date.now()
    }

    emitter.emit('loop.iteration', event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('should handle loop.completed event', () => {
    const handler = vi.fn()
    emitter.on('loop.completed', handler)

    const event: TeamRuntimeEvents['loop.completed'] = {
      loopId: 'review-loop',
      runId: 'run-123',
      totalIterations: 3,
      reason: 'condition-met',
      ts: Date.now()
    }

    emitter.emit('loop.completed', event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('should handle state.updated event', () => {
    const handler = vi.fn()
    emitter.on('state.updated', handler)

    const event: TeamRuntimeEvents['state.updated'] = {
      path: 'review.approved',
      value: true,
      previousValue: false,
      runId: 'run-123',
      updatedBy: 'reviewer',
      ts: Date.now()
    }

    emitter.emit('state.updated', event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('should handle branch.decision event', () => {
    const handler = vi.fn()
    emitter.on('branch.decision', handler)

    const event: TeamRuntimeEvents['branch.decision'] = {
      branchId: 'approval-check',
      runId: 'run-123',
      taken: 'then',
      ts: Date.now()
    }

    emitter.emit('branch.decision', event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('should handle select.decision event', () => {
    const handler = vi.fn()
    emitter.on('select.decision', handler)

    const event: TeamRuntimeEvents['select.decision'] = {
      selectId: 'task-router',
      runId: 'run-123',
      selected: 'summarize',
      usedDefault: false,
      ts: Date.now()
    }

    emitter.emit('select.decision', event)
    expect(handler).toHaveBeenCalledWith(event)
  })
})
