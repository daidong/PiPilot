/**
 * Tests for AgentRunHandle — steering/follow-up queues + PromiseLike wrapper
 */

import { describe, it, expect, vi, type Mock } from 'vitest'
import { AgentRunHandle } from '../../src/agent/agent-run-handle.js'
import type { AgentLoop } from '../../src/agent/agent-loop.js'
import type { AgentRunResult } from '../../src/types/agent.js'

function makeResult(output = 'done'): AgentRunResult {
  return { success: true, output, steps: 1, trace: [], durationMs: 0 }
}

function makeLoop(overrides: Partial<Record<'steer' | 'followUp' | 'stop', Mock>> = {}): AgentLoop {
  return {
    steer: overrides.steer ?? vi.fn(),
    followUp: overrides.followUp ?? vi.fn(),
    stop: overrides.stop ?? vi.fn()
  } as unknown as AgentLoop
}

describe('AgentRunHandle', () => {
  describe('PromiseLike — backward compatibility', () => {
    it('resolves when executor resolves', async () => {
      const handle = new AgentRunHandle(async () => makeResult('hello'))
      const result = await handle
      expect(result.output).toBe('hello')
    })

    it('rejects when executor rejects', async () => {
      const handle = new AgentRunHandle(async () => { throw new Error('oops') })
      await expect(handle).rejects.toThrow('oops')
    })

    it('.result() returns the same promise', async () => {
      const handle = new AgentRunHandle(async () => makeResult())
      const r1 = await handle
      const r2 = await handle.result()
      expect(r1).toBe(r2)
    })

    it('.then() works as expected', async () => {
      const handle = new AgentRunHandle(async () => makeResult('abc'))
      const output = await handle.then(r => r.output)
      expect(output).toBe('abc')
    })

    it('.catch() works as expected', async () => {
      const handle = new AgentRunHandle(async () => { throw new Error('fail') })
      const caught = await handle.catch(e => (e as Error).message)
      expect(caught).toBe('fail')
    })

    it('.finally() is called on success', async () => {
      const spy = vi.fn()
      const handle = new AgentRunHandle(async () => makeResult())
      await handle.finally(spy)
      expect(spy).toHaveBeenCalled()
    })

    it('.finally() is called on failure', async () => {
      const spy = vi.fn()
      const handle = new AgentRunHandle(async () => { throw new Error('x') })
      await handle.catch(() => {}).finally(spy)
      expect(spy).toHaveBeenCalled()
    })
  })

  describe('steer()', () => {
    it('returns this for chaining', () => {
      const handle = new AgentRunHandle(async () => makeResult())
      expect(handle.steer('msg')).toBe(handle)
    })

    it('buffers messages before loop attaches, then drains them', async () => {
      const steerMock = vi.fn()
      const loop = makeLoop({ steer: steerMock })

      const handle = new AgentRunHandle(async (attachLoop) => {
        // Simulate async delay before loop is created
        await Promise.resolve()
        attachLoop(loop)
        return makeResult()
      })

      // Called before attachLoop fires
      handle.steer('msg-a').steer('msg-b')

      await handle

      expect(steerMock).toHaveBeenCalledTimes(2)
      expect(steerMock).toHaveBeenCalledWith('msg-a')
      expect(steerMock).toHaveBeenCalledWith('msg-b')
    })

    it('forwards message directly if loop is already attached', async () => {
      const steerMock = vi.fn()
      const loop = makeLoop({ steer: steerMock })

      let resolveRun!: (r: AgentRunResult) => void
      const handle = new AgentRunHandle(async (attachLoop) => {
        attachLoop(loop)
        return new Promise<AgentRunResult>((res) => { resolveRun = res })
      })

      // Give attachLoop time to run
      await Promise.resolve()
      handle.steer('direct')
      expect(steerMock).toHaveBeenCalledWith('direct')

      resolveRun(makeResult())
      await handle
    })
  })

  describe('followUp()', () => {
    it('returns this for chaining', () => {
      const handle = new AgentRunHandle(async () => makeResult())
      expect(handle.followUp('msg')).toBe(handle)
    })

    it('buffers messages before loop attaches, then drains them', async () => {
      const followUpMock = vi.fn()
      const loop = makeLoop({ followUp: followUpMock })

      const handle = new AgentRunHandle(async (attachLoop) => {
        await Promise.resolve()
        attachLoop(loop)
        return makeResult()
      })

      handle.followUp('step-2').followUp('step-3')

      await handle

      expect(followUpMock).toHaveBeenCalledTimes(2)
      expect(followUpMock).toHaveBeenCalledWith('step-2')
      expect(followUpMock).toHaveBeenCalledWith('step-3')
    })

    it('forwards message directly if loop is already attached', async () => {
      const followUpMock = vi.fn()
      const loop = makeLoop({ followUp: followUpMock })

      let resolveRun!: (r: AgentRunResult) => void
      const handle = new AgentRunHandle(async (attachLoop) => {
        attachLoop(loop)
        return new Promise<AgentRunResult>((res) => { resolveRun = res })
      })

      await Promise.resolve()
      handle.followUp('next-task')
      expect(followUpMock).toHaveBeenCalledWith('next-task')

      resolveRun(makeResult())
      await handle
    })
  })

  describe('stop()', () => {
    it('no-ops when loop is not yet attached', () => {
      // Should not throw
      const handle = new AgentRunHandle(async () => makeResult())
      expect(() => handle.stop()).not.toThrow()
    })

    it('delegates to loop.stop() after attachment', async () => {
      const stopMock = vi.fn()
      const loop = makeLoop({ stop: stopMock })

      let resolveRun!: (r: AgentRunResult) => void
      const handle = new AgentRunHandle(async (attachLoop) => {
        attachLoop(loop)
        return new Promise<AgentRunResult>((res) => { resolveRun = res })
      })

      await Promise.resolve()
      handle.stop()
      expect(stopMock).toHaveBeenCalled()

      resolveRun(makeResult())
      await handle
    })
  })

  describe('chaining', () => {
    it('supports fluent chaining of steer + followUp + stop', async () => {
      const steerMock = vi.fn()
      const followUpMock = vi.fn()
      const loop = makeLoop({ steer: steerMock, followUp: followUpMock })

      const handle = new AgentRunHandle(async (attachLoop) => {
        await Promise.resolve()
        attachLoop(loop)
        return makeResult()
      })

      // All three chained before run completes
      handle
        .steer('redirect')
        .followUp('then-do-this')
        .followUp('then-do-that')

      await handle

      expect(steerMock).toHaveBeenCalledWith('redirect')
      expect(followUpMock).toHaveBeenCalledWith('then-do-this')
      expect(followUpMock).toHaveBeenCalledWith('then-do-that')
    })
  })
})
