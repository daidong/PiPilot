/**
 * defineTool Factory Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  defineTool,
  withErrorHandling,
  withTimeout,
  withRetry,
  composeTool
} from '../../src/factories/define-tool.js'
import type { Tool, ToolContext, ToolResult } from '../../src/types/tool.js'

// Helper: minimal tool context
function makeContext(): ToolContext {
  return {
    runtime: {} as any,
    sessionId: 'test-session',
    step: 1,
    agentId: 'test-agent'
  }
}

// Helper: simple tool that succeeds
function makeSuccessTool(): Tool<{ value: string }, string> {
  return defineTool({
    name: 'success-tool',
    description: 'Always succeeds',
    parameters: { value: { type: 'string', required: true } },
    execute: async (input) => ({ success: true, data: input.value })
  })
}

// Helper: simple tool that fails
function makeFailTool(message = 'boom'): Tool<unknown, unknown> {
  return defineTool({
    name: 'fail-tool',
    description: 'Always throws',
    parameters: {},
    execute: async () => { throw new Error(message) }
  })
}

describe('defineTool', () => {
  it('should create a valid tool from config', () => {
    const tool = defineTool({
      name: 'my-tool',
      description: 'A test tool',
      parameters: { input: { type: 'string', required: true } },
      execute: async () => ({ success: true, data: 'ok' })
    })

    expect(tool.name).toBe('my-tool')
    expect(tool.description).toBe('A test tool')
    expect(tool.parameters).toEqual({ input: { type: 'string', required: true } })
    expect(typeof tool.execute).toBe('function')
  })

  it('should preserve activity formatters', () => {
    const activity = {
      formatCall: (args: Record<string, unknown>) => ({ label: `call ${args.path}` }),
      formatResult: () => ({ label: 'done' })
    }

    const tool = defineTool({
      name: 'with-activity',
      description: 'Has activity',
      parameters: {},
      execute: async () => ({ success: true }),
      activity
    })

    expect(tool.activity).toBe(activity)
  })

  it('should throw when name is missing', () => {
    expect(() => defineTool({
      name: '',
      description: 'desc',
      parameters: {},
      execute: async () => ({ success: true })
    })).toThrow('Tool name is required')
  })

  it('should throw when description is missing', () => {
    expect(() => defineTool({
      name: 'tool',
      description: '',
      parameters: {},
      execute: async () => ({ success: true })
    })).toThrow('Tool description is required')
  })

  it('should throw when execute is missing', () => {
    expect(() => defineTool({
      name: 'tool',
      description: 'desc',
      parameters: {},
      execute: undefined as any
    })).toThrow('Tool execute function is required')
  })
})

describe('withErrorHandling', () => {
  it('should pass through successful results', async () => {
    const tool = withErrorHandling(makeSuccessTool())
    const result = await tool.execute({ value: 'hello' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.data).toBe('hello')
  })

  it('should wrap thrown errors into failed results', async () => {
    const tool = withErrorHandling(makeFailTool('something broke'))
    const result = await tool.execute({}, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toContain('something broke')
    expect(result.error).toContain('Tool execution failed')
  })

  it('should handle non-Error throws', async () => {
    const base = defineTool({
      name: 'string-throw',
      description: 'Throws a string',
      parameters: {},
      execute: async () => { throw 'raw string error' }
    })

    const tool = withErrorHandling(base)
    const result = await tool.execute({}, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toContain('raw string error')
  })

  it('should preserve tool name and description', () => {
    const base = makeSuccessTool()
    const wrapped = withErrorHandling(base)

    expect(wrapped.name).toBe(base.name)
    expect(wrapped.description).toBe(base.description)
  })
})

describe('withTimeout', () => {
  it('should return result if tool completes within timeout', async () => {
    const tool = withTimeout(makeSuccessTool(), 5000)
    const result = await tool.execute({ value: 'fast' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.data).toBe('fast')
  })

  it('should return error if tool exceeds timeout', async () => {
    const slowTool = defineTool({
      name: 'slow-tool',
      description: 'Takes too long',
      parameters: {},
      execute: async () => {
        await new Promise(resolve => setTimeout(resolve, 5000))
        return { success: true, data: 'done' }
      }
    })

    const tool = withTimeout(slowTool, 50)
    const result = await tool.execute({}, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out')
    expect(result.error).toContain('50ms')
  })

  it('should preserve tool name and description', () => {
    const base = makeSuccessTool()
    const wrapped = withTimeout(base, 1000)

    expect(wrapped.name).toBe(base.name)
    expect(wrapped.description).toBe(base.description)
  })
})

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('should return immediately on success', async () => {
    const executeFn = vi.fn().mockResolvedValue({ success: true, data: 'ok' })
    const base = defineTool({
      name: 'retry-tool',
      description: 'desc',
      parameters: {},
      execute: executeFn
    })

    const tool = withRetry(base, 3, 10)
    const promise = tool.execute({}, makeContext())
    const result = await promise

    expect(result.success).toBe(true)
    expect(executeFn).toHaveBeenCalledTimes(1)
  })

  it('should retry on failure and eventually succeed', async () => {
    let callCount = 0
    const executeFn = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount < 3) {
        return { success: false, error: 'not ready' }
      }
      return { success: true, data: 'ok' }
    })

    const base = defineTool({
      name: 'retry-tool',
      description: 'desc',
      parameters: {},
      execute: executeFn
    })

    // Use real timers for this test since retry involves setTimeout
    vi.useRealTimers()

    const tool = withRetry(base, 5, 1) // tiny delay for test speed
    const result = await tool.execute({}, makeContext())

    expect(result.success).toBe(true)
    expect(executeFn).toHaveBeenCalledTimes(3)
  })

  it('should respect max retries and fail', async () => {
    const executeFn = vi.fn().mockResolvedValue({ success: false, error: 'always fails' })

    const base = defineTool({
      name: 'always-fail',
      description: 'desc',
      parameters: {},
      execute: executeFn
    })

    vi.useRealTimers()

    const tool = withRetry(base, 2, 1) // 2 retries = 3 total attempts max
    const result = await tool.execute({}, makeContext())

    expect(result.success).toBe(false)
    // Should have attempted at most maxRetries + 1 times (budget may cut short)
    expect(executeFn.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('should handle thrown errors as retryable failures', async () => {
    let callCount = 0
    const executeFn = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount < 2) {
        throw new Error('transient')
      }
      return { success: true, data: 'recovered' }
    })

    const base = defineTool({
      name: 'throw-then-succeed',
      description: 'desc',
      parameters: {},
      execute: executeFn
    })

    vi.useRealTimers()

    const tool = withRetry(base, 3, 1)
    const result = await tool.execute({}, makeContext())

    expect(result.success).toBe(true)
    expect(result.data).toBe('recovered')
  })

  it('should preserve tool metadata', () => {
    const base = makeSuccessTool()
    const wrapped = withRetry(base, 3)

    expect(wrapped.name).toBe(base.name)
    expect(wrapped.description).toBe(base.description)
  })
})

describe('composeTool', () => {
  it('should apply enhancers in order', () => {
    const base = makeSuccessTool()

    const wrapped = composeTool(
      base,
      (t) => withErrorHandling(t),
      (t) => withTimeout(t, 5000)
    )

    expect(wrapped.name).toBe(base.name)
    expect(typeof wrapped.execute).toBe('function')
  })

  it('should return original tool when no enhancers provided', () => {
    const base = makeSuccessTool()
    const result = composeTool(base)

    expect(result).toBe(base)
  })

  it('should chain error handling and timeout together', async () => {
    vi.useRealTimers()

    const slowFail = defineTool({
      name: 'slow-fail',
      description: 'desc',
      parameters: {},
      execute: async () => {
        // Short but longer than timeout
        await new Promise(resolve => setTimeout(resolve, 200))
        return { success: true }
      }
    })

    const wrapped = composeTool(
      slowFail,
      (t) => withTimeout(t, 30),
      (t) => withErrorHandling(t)
    )

    const result = await wrapped.execute({}, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out')
  })
})
