/**
 * Tests for session.trace context source
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sessionTrace } from '../../src/context-sources/session-trace.js'
import type { Runtime } from '../../src/types/runtime.js'

interface MockTraceEvent {
  type: string
  step: number
  timestamp: number
  data: Record<string, unknown>
}

function createMockRuntime(events: MockTraceEvent[] = [], step: number = 5): Runtime {
  return {
    projectPath: '/test/project',
    sessionId: 'test-session',
    agentId: 'test-agent',
    step,
    io: {} as any,
    eventBus: {} as any,
    trace: {
      getEvents: vi.fn().mockReturnValue(events)
    } as any,
    tokenBudget: {} as any,
    toolRegistry: {} as any,
    policyEngine: {} as any,
    contextManager: {} as any,
    sessionState: {} as any
  } as Runtime
}

describe('session.trace', () => {
  const sampleEvents: MockTraceEvent[] = [
    { type: 'tool.call', step: 1, timestamp: 1000, data: { tool: 'read' } },
    { type: 'tool.result', step: 1, timestamp: 1100, data: { success: true } },
    { type: 'io.readFile', step: 2, timestamp: 2000, data: { path: '/test/file.ts' } },
    { type: 'io.writeFile', step: 3, timestamp: 3000, data: { path: '/test/output.ts' } },
    { type: 'tool.call', step: 4, timestamp: 4000, data: { tool: 'grep' } },
    { type: 'io.exec', step: 4, timestamp: 4100, data: { command: 'npm test' } },
    { type: 'ctx.fetch_complete', step: 5, timestamp: 5000, data: { sourceId: 'docs.search' } },
    { type: 'custom.event', step: 5, timestamp: 5100, data: {} }
  ]

  it('should return trace events with default limit', async () => {
    const runtime = createMockRuntime(sampleEvents)

    const result = await sessionTrace.fetch({}, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.entries).toHaveLength(8)
    expect(result.data!.currentStep).toBe(5)
    expect(result.data!.totalSteps).toBe(5)
  })

  it('should respect limit parameter', async () => {
    const runtime = createMockRuntime(sampleEvents)

    const result = await sessionTrace.fetch({ limit: 3 }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.entries).toHaveLength(3)
    // Should return most recent entries (sorted by timestamp desc)
    expect(result.data!.entries[0]!.timestamp).toBeGreaterThanOrEqual(result.data!.entries[1]!.timestamp)
  })

  it('should filter by tool type', async () => {
    const runtime = createMockRuntime(sampleEvents)

    const result = await sessionTrace.fetch({ type: 'tool' }, runtime)

    expect(result.success).toBe(true)
    // tool.call and tool.result events
    expect(result.data!.entries.every(e => e.type.startsWith('tool.'))).toBe(true)
    expect(result.data!.entries).toHaveLength(3) // 2 tool.call + 1 tool.result
  })

  it('should filter by file type', async () => {
    const runtime = createMockRuntime(sampleEvents)

    const result = await sessionTrace.fetch({ type: 'file' }, runtime)

    expect(result.success).toBe(true)
    // io.readFile, io.writeFile, io.exec events
    expect(result.data!.entries.every(e => e.type.startsWith('io.'))).toBe(true)
    expect(result.data!.entries).toHaveLength(3)
  })

  it('should return all events when type is "all"', async () => {
    const runtime = createMockRuntime(sampleEvents)

    const result = await sessionTrace.fetch({ type: 'all' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.entries).toHaveLength(8)
  })

  it('should handle empty trace', async () => {
    const runtime = createMockRuntime([], 0)

    const result = await sessionTrace.fetch({}, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.entries).toHaveLength(0)
    expect(result.data!.currentStep).toBe(0)
  })

  it('should generate correct summaries for tool.call events', async () => {
    const events: MockTraceEvent[] = [
      { type: 'tool.call', step: 1, timestamp: 1000, data: { tool: 'read' } }
    ]
    const runtime = createMockRuntime(events)

    const result = await sessionTrace.fetch({}, runtime)

    expect(result.data!.entries[0]!.summary).toBe('Called tool: read')
  })

  it('should generate correct summaries for tool.result events', async () => {
    const events: MockTraceEvent[] = [
      { type: 'tool.result', step: 1, timestamp: 1000, data: { success: true } },
      { type: 'tool.result', step: 2, timestamp: 2000, data: { success: false } }
    ]
    const runtime = createMockRuntime(events)

    const result = await sessionTrace.fetch({}, runtime)

    // Sorted by timestamp desc
    expect(result.data!.entries[0]!.summary).toBe('Tool result: failed')
    expect(result.data!.entries[1]!.summary).toBe('Tool result: success')
  })

  it('should generate correct summaries for io events', async () => {
    const events: MockTraceEvent[] = [
      { type: 'io.readFile', step: 1, timestamp: 1000, data: { path: '/test/file.ts' } },
      { type: 'io.writeFile', step: 2, timestamp: 2000, data: { path: '/test/out.ts' } },
      { type: 'io.exec', step: 3, timestamp: 3000, data: { command: 'npm test --verbose' } }
    ]
    const runtime = createMockRuntime(events)

    const result = await sessionTrace.fetch({}, runtime)

    const summaries = result.data!.entries.map(e => e.summary)
    expect(summaries).toContain('Read file: /test/file.ts')
    expect(summaries).toContain('Wrote file: /test/out.ts')
    expect(summaries).toContain('Executed: npm test --verbose')
  })

  it('should generate summary for ctx.fetch_complete events', async () => {
    const events: MockTraceEvent[] = [
      { type: 'ctx.fetch_complete', step: 1, timestamp: 1000, data: { sourceId: 'docs.search' } }
    ]
    const runtime = createMockRuntime(events)

    const result = await sessionTrace.fetch({}, runtime)

    expect(result.data!.entries[0]!.summary).toBe('Fetched context: docs.search')
  })

  it('should use event type as summary for unknown event types', async () => {
    const events: MockTraceEvent[] = [
      { type: 'custom.unknown', step: 1, timestamp: 1000, data: {} }
    ]
    const runtime = createMockRuntime(events)

    const result = await sessionTrace.fetch({}, runtime)

    expect(result.data!.entries[0]!.summary).toBe('custom.unknown')
  })

  it('should render markdown output', async () => {
    const runtime = createMockRuntime(sampleEvents)

    const result = await sessionTrace.fetch({}, runtime)

    expect(result.rendered).toContain('# Session Trace')
    expect(result.rendered).toContain('Current step: 5')
    expect(result.rendered).toContain('[Step')
  })

  it('should mark coverage as incomplete when entries are limited', async () => {
    const runtime = createMockRuntime(sampleEvents)

    const result = await sessionTrace.fetch({ limit: 3 }, runtime)

    expect(result.coverage.complete).toBe(false)
    expect(result.coverage.limitations).toBeDefined()
  })

  it('should mark coverage as complete when all entries are shown', async () => {
    const runtime = createMockRuntime(sampleEvents)

    const result = await sessionTrace.fetch({ limit: 100 }, runtime)

    expect(result.coverage.complete).toBe(true)
  })

  it('should combine limit and type filters', async () => {
    const runtime = createMockRuntime(sampleEvents)

    const result = await sessionTrace.fetch({ type: 'tool', limit: 2 }, runtime)

    expect(result.data!.entries).toHaveLength(2)
    expect(result.data!.entries.every(e => e.type.startsWith('tool.'))).toBe(true)
  })

  it('should handle undefined params', async () => {
    const runtime = createMockRuntime(sampleEvents)

    const result = await sessionTrace.fetch(undefined as any, runtime)

    expect(result.success).toBe(true)
    // Defaults: limit=20, type='all'
    expect(result.data!.entries).toHaveLength(8)
  })

  it('should sort entries by timestamp descending (most recent first)', async () => {
    const runtime = createMockRuntime(sampleEvents)

    const result = await sessionTrace.fetch({}, runtime)

    for (let i = 1; i < result.data!.entries.length; i++) {
      expect(result.data!.entries[i - 1]!.timestamp).toBeGreaterThanOrEqual(
        result.data!.entries[i]!.timestamp
      )
    }
  })
})
