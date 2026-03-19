/**
 * #4: Operations Interface DI — per-tool IO override tests
 *
 * Verifies the two-layer IO provider design:
 * - Agent-level: ioProvider on CreateAgentOptions
 * - Tool-level: createIO on Tool/ToolConfig
 * - Priority: tool.createIO > agent.ioProvider > default LocalRuntimeIO
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolRegistry } from '../../src/core/tool-registry.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { TraceCollector } from '../../src/core/trace-collector.js'
import { EventBus } from '../../src/core/event-bus.js'
import { TokenBudget } from '../../src/core/token-budget.js'
import type { Runtime, RuntimeIO } from '../../src/types/runtime.js'
import type { ToolResult } from '../../src/types/tool.js'
import { defineTool } from '../../src/factories/define-tool.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock RuntimeIO that tags its origin for assertions */
function createMockIO(tag: string): RuntimeIO {
  return {
    readFile: vi.fn(async () => ({ ok: true as const, value: `read-from-${tag}` })),
    writeFile: vi.fn(async () => ({ ok: true as const, value: undefined })),
    readdir: vi.fn(async () => ({ ok: true as const, value: [] })),
    exists: vi.fn(async () => ({ ok: true as const, value: true })),
    exec: vi.fn(async () => ({ ok: true as const, value: { stdout: `exec-from-${tag}`, stderr: '', exitCode: 0 } })),
    glob: vi.fn(async () => ({ ok: true as const, value: [] })),
    grep: vi.fn(async () => ({ ok: true as const, value: [] })),
    // Tag for identification in tests
    _tag: tag,
  } as unknown as RuntimeIO
}

function buildEnv(io?: RuntimeIO) {
  const eventBus = new EventBus()
  const trace = new TraceCollector('test-session')
  const policyEngine = new PolicyEngine({ trace, eventBus })
  const toolRegistry = new ToolRegistry()
  const tokenBudget = new TokenBudget({ total: 50_000 })
  const defaultIO = io ?? createMockIO('default')
  const mockRuntime: Runtime = {
    projectPath: '/test', sessionId: 'test-session', agentId: 'test-agent', step: 0,
    io: defaultIO, eventBus, trace, tokenBudget, toolRegistry, policyEngine,
    contextManager: {} as any,
    sessionState: { get: () => undefined, set: () => {}, delete: () => {}, has: () => false }
  }
  toolRegistry.configure({ policyEngine, trace, runtime: mockRuntime })
  return { eventBus, trace, policyEngine, toolRegistry, tokenBudget, mockRuntime, defaultIO }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('#4: Operations DI — per-tool IO override', () => {
  let env: ReturnType<typeof buildEnv>

  beforeEach(() => { env = buildEnv() })

  it('tool receives default IO when no createIO is defined', async () => {
    let receivedIO: RuntimeIO | undefined

    env.toolRegistry.register({
      name: 'basic-tool',
      description: 'A tool that checks its IO',
      parameters: {},
      execute: async (_input, context): Promise<ToolResult> => {
        receivedIO = context.runtime.io
        return { success: true, data: 'ok' }
      }
    })

    await env.toolRegistry.call('basic-tool', {})

    expect(receivedIO).toBe(env.defaultIO)
    expect((receivedIO as any)._tag).toBe('default')
  })

  it('tool receives custom IO when createIO is defined', async () => {
    let receivedIO: RuntimeIO | undefined
    const remoteIO = createMockIO('remote')

    env.toolRegistry.register({
      name: 'remote-tool',
      description: 'A tool that uses remote IO',
      parameters: {},
      execute: async (_input, context): Promise<ToolResult> => {
        receivedIO = context.runtime.io
        return { success: true, data: 'ok' }
      },
      createIO: (_defaultIO, _runtime) => remoteIO
    })

    await env.toolRegistry.call('remote-tool', {})

    expect(receivedIO).toBe(remoteIO)
    expect((receivedIO as any)._tag).toBe('remote')
  })

  it('createIO receives the default IO and runtime for composition', async () => {
    const createIOSpy = vi.fn((_defaultIO: RuntimeIO, _runtime: Runtime) => {
      return createMockIO('composed')
    })

    env.toolRegistry.register({
      name: 'composed-tool',
      description: 'A tool that composes IO',
      parameters: {},
      execute: async (): Promise<ToolResult> => ({ success: true, data: 'ok' }),
      createIO: createIOSpy
    })

    await env.toolRegistry.call('composed-tool', {})

    expect(createIOSpy).toHaveBeenCalledTimes(1)
    expect(createIOSpy).toHaveBeenCalledWith(env.defaultIO, env.mockRuntime)
  })

  it('async createIO is awaited', async () => {
    let receivedIO: RuntimeIO | undefined
    const asyncIO = createMockIO('async-remote')

    env.toolRegistry.register({
      name: 'async-io-tool',
      description: 'A tool with async createIO',
      parameters: {},
      execute: async (_input, context): Promise<ToolResult> => {
        receivedIO = context.runtime.io
        return { success: true, data: 'ok' }
      },
      createIO: async (_defaultIO, _runtime) => {
        // Simulate async setup (e.g., SSH connection)
        await new Promise(r => setTimeout(r, 5))
        return asyncIO
      }
    })

    await env.toolRegistry.call('async-io-tool', {})

    expect(receivedIO).toBe(asyncIO)
    expect((receivedIO as any)._tag).toBe('async-remote')
  })

  it('different tools in the same registry can use different IOs', async () => {
    const iosUsed: string[] = []
    const localIO = createMockIO('local-custom')
    const dockerIO = createMockIO('docker')

    env.toolRegistry.register({
      name: 'local-tool',
      description: 'Uses default IO',
      parameters: {},
      execute: async (_input, context): Promise<ToolResult> => {
        iosUsed.push((context.runtime.io as any)._tag)
        return { success: true, data: 'ok' }
      }
    })

    env.toolRegistry.register({
      name: 'docker-tool',
      description: 'Uses docker IO',
      parameters: {},
      execute: async (_input, context): Promise<ToolResult> => {
        iosUsed.push((context.runtime.io as any)._tag)
        return { success: true, data: 'ok' }
      },
      createIO: () => dockerIO
    })

    await env.toolRegistry.call('local-tool', {})
    await env.toolRegistry.call('docker-tool', {})

    expect(iosUsed).toEqual(['default', 'docker'])
  })

  it('createIO does not mutate the shared runtime', async () => {
    const customIO = createMockIO('custom')

    env.toolRegistry.register({
      name: 'override-tool',
      description: 'Overrides IO',
      parameters: {},
      execute: async (): Promise<ToolResult> => ({ success: true, data: 'ok' }),
      createIO: () => customIO
    })

    await env.toolRegistry.call('override-tool', {})

    // The shared runtime's IO should still be the default
    expect(env.mockRuntime.io).toBe(env.defaultIO)
    expect((env.mockRuntime.io as any)._tag).toBe('default')
  })

  it('defineTool passes createIO through to the tool', () => {
    const myCreateIO = (_io: RuntimeIO, _rt: Runtime) => createMockIO('factory')

    const tool = defineTool({
      name: 'factory-tool',
      description: 'Created with defineTool',
      parameters: {},
      execute: async (): Promise<ToolResult> => ({ success: true, data: 'ok' }),
      createIO: myCreateIO
    })

    expect(tool.createIO).toBe(myCreateIO)
  })

  it('defineTool without createIO produces tool without createIO', () => {
    const tool = defineTool({
      name: 'simple-tool',
      description: 'No createIO',
      parameters: {},
      execute: async (): Promise<ToolResult> => ({ success: true, data: 'ok' })
    })

    expect(tool.createIO).toBeUndefined()
  })

  it('createIO that delegates reads to remote but writes to local', async () => {
    const readCalls: string[] = []
    const writeCalls: string[] = []

    env.toolRegistry.register({
      name: 'hybrid-tool',
      description: 'Uses hybrid IO',
      parameters: {},
      execute: async (_input, context): Promise<ToolResult> => {
        await context.runtime.io.readFile('/remote/data.txt')
        await context.runtime.io.writeFile('/local/output.txt', 'result')
        return { success: true, data: 'ok' }
      },
      createIO: (defaultIO, _runtime) => {
        const remoteReadFile = vi.fn(async (path: string) => {
          readCalls.push(`remote:${path}`)
          return { ok: true as const, value: 'remote-data' }
        })
        // Compose: reads go to remote, writes stay local
        return {
          ...defaultIO,
          readFile: remoteReadFile,
          writeFile: vi.fn(async (path: string, content: string) => {
            writeCalls.push(`local:${path}`)
            return defaultIO.writeFile(path, content)
          })
        } as unknown as RuntimeIO
      }
    })

    await env.toolRegistry.call('hybrid-tool', {})

    expect(readCalls).toEqual(['remote:/remote/data.txt'])
    expect(writeCalls).toEqual(['local:/local/output.txt'])
  })
})
