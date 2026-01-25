/**
 * ToolRegistry 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolRegistry } from '../../src/core/tool-registry.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { TraceCollector } from '../../src/core/trace-collector.js'
import { EventBus } from '../../src/core/event-bus.js'
import type { Tool } from '../../src/types/tool.js'
import type { Runtime } from '../../src/types/runtime.js'

describe('ToolRegistry', () => {
  let toolRegistry: ToolRegistry
  let policyEngine: PolicyEngine
  let trace: TraceCollector
  let eventBus: EventBus
  let mockRuntime: Runtime

  beforeEach(() => {
    eventBus = new EventBus()
    trace = new TraceCollector('test-session')
    policyEngine = new PolicyEngine({ trace, eventBus })
    toolRegistry = new ToolRegistry()

    mockRuntime = {
      projectPath: '/test/project',
      sessionId: 'test-session',
      agentId: 'test-agent',
      step: 0,
      io: {} as any,
      eventBus,
      trace,
      tokenBudget: {} as any,
      toolRegistry,
      policyEngine,
      contextManager: {} as any,
      sessionState: {} as any
    }

    toolRegistry.configure({ policyEngine, trace, runtime: mockRuntime })
  })

  describe('register', () => {
    it('should register a tool', () => {
      const tool: Tool = {
        name: 'test-tool',
        description: 'A test tool',
        parameters: {},
        execute: async () => ({ success: true, data: 'result' })
      }

      toolRegistry.register(tool)

      expect(toolRegistry.get('test-tool')).toBe(tool)
    })

    it('should register multiple tools', () => {
      const tools: Tool[] = [
        {
          name: 'tool1',
          description: 'Tool 1',
          parameters: {},
          execute: async () => ({ success: true })
        },
        {
          name: 'tool2',
          description: 'Tool 2',
          parameters: {},
          execute: async () => ({ success: true })
        }
      ]

      toolRegistry.registerAll(tools)

      expect(toolRegistry.get('tool1')).toBeDefined()
      expect(toolRegistry.get('tool2')).toBeDefined()
    })
  })

  describe('call', () => {
    it('should call tool successfully', async () => {
      toolRegistry.register({
        name: 'echo',
        description: 'Echo input',
        parameters: {
          message: { type: 'string', description: 'Message to echo', required: true }
        },
        execute: async (input: { message: string }) => ({
          success: true,
          data: input.message
        })
      })

      const result = await toolRegistry.call('echo', { message: 'Hello' })

      expect(result.success).toBe(true)
      expect(result.data).toBe('Hello')
    })

    it('should return error for unknown tool', async () => {
      const result = await toolRegistry.call('unknown', {})

      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown tool')
    })

    it('should respect policy decisions', async () => {
      toolRegistry.register({
        name: 'blocked-tool',
        description: 'A blocked tool',
        parameters: {},
        execute: async () => ({ success: true, data: 'executed' })
      })

      policyEngine.register({
        id: 'block-tool',
        phase: 'guard',
        match: (ctx) => ctx.tool === 'blocked-tool',
        decide: () => ({ action: 'deny', reason: 'Tool is blocked' })
      })

      const result = await toolRegistry.call('blocked-tool', {})

      expect(result.success).toBe(false)
      expect(result.error).toContain('Tool is blocked')
    })

    it('should apply input mutations from policies', async () => {
      toolRegistry.register({
        name: 'mutated-tool',
        description: 'A tool with mutated input',
        parameters: {
          value: { type: 'number', description: 'A value' }
        },
        execute: async (input: { value: number }) => ({
          success: true,
          data: input.value
        })
      })

      policyEngine.register({
        id: 'mutate-input',
        phase: 'mutate',
        match: (ctx) => ctx.tool === 'mutated-tool',
        decide: () => ({
          action: 'transform',
          transforms: [
            { op: 'set', path: 'value', value: 100 }
          ]
        })
      })

      const result = await toolRegistry.call('mutated-tool', { value: 50 })

      expect(result.success).toBe(true)
      expect(result.data).toBe(100) // Value was mutated
    })

    it('should handle tool execution errors', async () => {
      toolRegistry.register({
        name: 'error-tool',
        description: 'A tool that throws',
        parameters: {},
        execute: async () => {
          throw new Error('Tool error')
        }
      })

      const result = await toolRegistry.call('error-tool', {})

      expect(result.success).toBe(false)
      expect(result.error).toContain('Tool error')
    })
  })

  describe('getAll', () => {
    it('should return all registered tools', () => {
      toolRegistry.registerAll([
        {
          name: 'tool1',
          description: 'Tool 1',
          parameters: {},
          execute: async () => ({ success: true })
        },
        {
          name: 'tool2',
          description: 'Tool 2',
          parameters: {},
          execute: async () => ({ success: true })
        }
      ])

      const tools = toolRegistry.getAll()

      expect(tools).toHaveLength(2)
    })
  })

  describe('has', () => {
    it('should return true for registered tool', () => {
      toolRegistry.register({
        name: 'test',
        description: 'Test',
        parameters: {},
        execute: async () => ({ success: true })
      })

      expect(toolRegistry.has('test')).toBe(true)
    })

    it('should return false for unregistered tool', () => {
      expect(toolRegistry.has('unknown')).toBe(false)
    })
  })

  describe('clear', () => {
    it('should clear all tools', () => {
      toolRegistry.register({
        name: 'test',
        description: 'Test',
        parameters: {},
        execute: async () => ({ success: true })
      })

      toolRegistry.clear()

      expect(toolRegistry.getAll()).toHaveLength(0)
    })
  })
})
