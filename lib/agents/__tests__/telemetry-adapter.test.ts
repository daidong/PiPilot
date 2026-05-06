/**
 * Tests for createCoordinatorTelemetryAdapter.
 *
 * Uses a real PipilotTracer writing to a tmpdir + a flush + JSONL inspection.
 * Each test exercises one of the adapter's responsibilities (step span,
 * tool span, wire capture, skill-load event) and verifies the spans landed
 * with the expected attributes and events.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PipilotTracer } from '../../telemetry/tracer.js'
import { PATHS } from '../../types.js'
import { createCoordinatorTelemetryAdapter } from '../telemetry-adapter.js'
import type {
  AgentEvent,
  BeforeToolCallContext,
  AfterToolCallContext,
  AgentToolResult
} from '@mariozechner/pi-agent-core'

function mkTracer(): { dir: string; tracer: PipilotTracer } {
  const dir = mkdtempSync(join(tmpdir(), 'rp-adapter-'))
  const tracer = new PipilotTracer({
    projectPath: dir,
    serviceVersion: '0.0.0-test',
    appBuildCommit: 'c1',
    projectId: 'P',
    sessionId: 'S'
  })
  return { dir, tracer }
}

async function readSpans(dir: string): Promise<any[]> {
  const stamp = new Date().toISOString().slice(0, 10)
  const file = join(dir, PATHS.traces, `spans.${stamp}.jsonl`)
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  const spans: any[] = []
  for (const line of lines) {
    const env = JSON.parse(line)
    for (const ss of env.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) spans.push(s)
    }
  }
  return spans
}

const findAttr = (s: any, k: string) =>
  s.attributes?.find((a: any) => a.key === k)?.value

/**
 * OTLP encodes int64 as string in JSON, but doubles as number. Helper
 * coerces either to a JS number for comparison.
 */
function attrAsNumber(s: any, k: string): number | undefined {
  const v = findAttr(s, k)
  if (v?.intValue !== undefined) return Number(v.intValue)
  if (v?.doubleValue !== undefined) return Number(v.doubleValue)
  return undefined
}

function turnStartEvent(): AgentEvent {
  return { type: 'turn_start' } as unknown as AgentEvent
}

function turnEndEvent(opts: {
  inputTokens?: number
  outputTokens?: number
  stopReason?: string
  errorMessage?: string
} = {}): AgentEvent {
  return {
    type: 'turn_end',
    message: {
      role: 'assistant',
      usage: opts.inputTokens !== undefined
        ? { input: opts.inputTokens, output: opts.outputTokens ?? 0 }
        : undefined,
      stopReason: opts.stopReason,
      errorMessage: opts.errorMessage
    },
    toolResults: []
  } as unknown as AgentEvent
}

function mkBeforeCtx(name: string, id: string, args: unknown): BeforeToolCallContext {
  return {
    assistantMessage: {} as never,
    toolCall: { id, name, arguments: args, type: 'tool_call' as const } as never,
    args,
    context: {} as never
  }
}

function mkAfterCtx(
  name: string,
  id: string,
  args: unknown,
  result: AgentToolResult<any>
): AfterToolCallContext {
  return {
    assistantMessage: {} as never,
    toolCall: { id, name, arguments: args, type: 'tool_call' as const } as never,
    args,
    result,
    isError: false,
    context: {} as never
  }
}

// ---------------------------------------------------------------------------
// processAgentEvent: step-span lifecycle
// ---------------------------------------------------------------------------

test('processAgentEvent opens and closes invoke_agent step span on turn_start/turn_end', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer, getTurnId: () => 'turn-XYZ' })
    adapter.processAgentEvent(turnStartEvent())
    adapter.processAgentEvent(turnEndEvent({ inputTokens: 100, outputTokens: 50 }))
    await tracer.shutdown()

    const spans = await readSpans(dir)
    const step = spans.find(s => s.name === 'invoke_agent step')
    assert.ok(step, 'expected an invoke_agent step span')
    assert.equal(findAttr(step, 'gen_ai.operation.name')?.stringValue, 'invoke_agent')
    assert.equal(attrAsNumber(step, 'pipilot.step.index'), 1)
    assert.equal(findAttr(step, 'pipilot.turn.id')?.stringValue, 'turn-XYZ')
    assert.equal(attrAsNumber(step, 'gen_ai.usage.input_tokens'), 100)
    assert.equal(attrAsNumber(step, 'gen_ai.usage.output_tokens'), 50)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('processAgentEvent assigns ERROR status when stopReason is error', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.processAgentEvent(turnStartEvent())
    adapter.processAgentEvent(turnEndEvent({ stopReason: 'error', errorMessage: 'rate limit' }))
    await tracer.shutdown()

    const step = (await readSpans(dir)).find(s => s.name === 'invoke_agent step')
    assert.ok(step)
    // OTel status code: 0=UNSET, 1=OK, 2=ERROR
    assert.equal(step.status?.code, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('processAgentEvent increments step.index across turns', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.processAgentEvent(turnStartEvent())
    adapter.processAgentEvent(turnEndEvent())
    adapter.processAgentEvent(turnStartEvent())
    adapter.processAgentEvent(turnEndEvent())
    await tracer.shutdown()

    const steps = (await readSpans(dir)).filter(s => s.name === 'invoke_agent step')
    assert.equal(steps.length, 2)
    const indices = steps
      .map(s => attrAsNumber(s, 'pipilot.step.index'))
      .sort((a, b) => (a ?? 0) - (b ?? 0))
    assert.deepEqual(indices, [1, 2])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// beforeToolCall / afterToolCall
// ---------------------------------------------------------------------------

test('beforeToolCall + afterToolCall produce a closed execute_tool span with category and result', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.processAgentEvent(turnStartEvent())
    adapter.beforeToolCall(mkBeforeCtx('artifact-create', 'tc-1', { type: 'note', title: 'x' }))
    adapter.afterToolCall(mkAfterCtx('artifact-create', 'tc-1', { type: 'note', title: 'x' }, {
      content: [{ type: 'text', text: 'created' }],
      details: { success: true, tool_name: 'artifact-create' }
    }))
    adapter.processAgentEvent(turnEndEvent())
    await tracer.shutdown()

    const spans = await readSpans(dir)
    const tool = spans.find(s => s.name === 'execute_tool artifact-create')
    assert.ok(tool, 'expected execute_tool span')
    assert.equal(findAttr(tool, 'gen_ai.operation.name')?.stringValue, 'execute_tool')
    assert.equal(findAttr(tool, 'gen_ai.tool.name')?.stringValue, 'artifact-create')
    assert.equal(findAttr(tool, 'gen_ai.tool.call.id')?.stringValue, 'tc-1')
    assert.equal(findAttr(tool, 'pipilot.tool.category')?.stringValue, 'artifact')
    // OTel status code: 1=OK
    assert.equal(tool.status?.code, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('afterToolCall stamps error_class when result.isError is true', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.beforeToolCall(mkBeforeCtx('web-fetch', 'tc-2', { url: 'https://x' }))
    const result = {
      content: [{ type: 'text' as const, text: 'failed' }],
      details: { success: false, tool_name: 'web-fetch', error_code: 'NETWORK_TIMEOUT' },
      isError: true
    } as unknown as AgentToolResult<any>
    adapter.afterToolCall(mkAfterCtx('web-fetch', 'tc-2', { url: 'https://x' }, result))
    await tracer.shutdown()

    const tool = (await readSpans(dir)).find(s => s.name === 'execute_tool web-fetch')
    assert.ok(tool)
    assert.equal(findAttr(tool, 'pipilot.tool.error_class')?.stringValue, 'NETWORK_TIMEOUT')
    assert.equal(tool.status?.code, 2) // ERROR
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('afterToolCall is a no-op when no matching beforeToolCall opened a span', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.afterToolCall(mkAfterCtx('orphan', 'tc-orphan', {}, {
      content: [], details: { success: true, tool_name: 'orphan' }
    }))
    await tracer.shutdown()
    const spans = await readSpans(dir)
    const orphan = spans.find(s => s.name === 'execute_tool orphan')
    assert.equal(orphan, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parallel tool calls finalize independently by toolCallId', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.beforeToolCall(mkBeforeCtx('grep', 'tc-A', { pattern: 'foo' }))
    adapter.beforeToolCall(mkBeforeCtx('find', 'tc-B', { pattern: '*.ts' }))
    // close in reverse order
    adapter.afterToolCall(mkAfterCtx('find', 'tc-B', { pattern: '*.ts' }, {
      content: [], details: { success: true, tool_name: 'find' }
    }))
    adapter.afterToolCall(mkAfterCtx('grep', 'tc-A', { pattern: 'foo' }, {
      content: [], details: { success: true, tool_name: 'grep' }
    }))
    await tracer.shutdown()
    const spans = await readSpans(dir)
    assert.ok(spans.find(s => s.name === 'execute_tool grep'))
    assert.ok(spans.find(s => s.name === 'execute_tool find'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// recordSkillLoadOnActiveStep
// ---------------------------------------------------------------------------

test('recordSkillLoadOnActiveStep adds event to active step span', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.processAgentEvent(turnStartEvent())
    adapter.recordSkillLoadOnActiveStep('paper-writing', 'explicit-load')
    adapter.processAgentEvent(turnEndEvent())
    await tracer.shutdown()

    const step = (await readSpans(dir)).find(s => s.name === 'invoke_agent step')
    assert.ok(step)
    const skillEvent = step.events?.find((e: any) => e.name === 'pipilot.skill.load')
    assert.ok(skillEvent, 'expected skill.load span event')
    const findEventAttr = (k: string) =>
      skillEvent.attributes?.find((a: any) => a.key === k)?.value
    assert.equal(findEventAttr('skillName')?.stringValue, 'paper-writing')
    assert.equal(findEventAttr('trigger')?.stringValue, 'explicit-load')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordSkillLoadOnActiveStep is a no-op outside a turn', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    // No turn_start — no active step span
    adapter.recordSkillLoadOnActiveStep('x', 'router-match')
    await tracer.shutdown()
    // Either no spans, or no skill.load events on any span
    const spans = await readSpans(dir)
    for (const s of spans) {
      const evt = s.events?.find((e: any) => e.name === 'pipilot.skill.load')
      assert.equal(evt, undefined)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// onPayload / onResponse
// ---------------------------------------------------------------------------

test('onPayload attaches request_payload event to the active step span', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.processAgentEvent(turnStartEvent())
    await adapter.onPayload({ messages: [{ role: 'user', content: 'hi' }] })
    adapter.processAgentEvent(turnEndEvent())
    await tracer.shutdown()

    const step = (await readSpans(dir)).find(s => s.name === 'invoke_agent step')
    assert.ok(step)
    const payloadEvent = step.events?.find((e: any) => e.name === 'pipilot.chat.request_payload')
    assert.ok(payloadEvent, 'expected request_payload event')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('onResponse stamps http.response.status_code on active step span', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.processAgentEvent(turnStartEvent())
    await adapter.onResponse({
      status: 200,
      headers: { 'request-id': 'req-abc', 'anthropic-ratelimit-input-tokens-remaining': '99000' }
    })
    adapter.processAgentEvent(turnEndEvent())
    await tracer.shutdown()

    const step = (await readSpans(dir)).find(s => s.name === 'invoke_agent step')
    assert.ok(step)
    assert.equal(attrAsNumber(step, 'http.response.status_code'), 200)
    assert.equal(findAttr(step, 'http.response.header.request-id')?.stringValue, 'req-abc')
    assert.equal(findAttr(step, 'http.response.header.anthropic-ratelimit-input-tokens-remaining')?.stringValue, '99000')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('onPayload + onResponse without active step are silent no-ops', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    // No turn_start
    await adapter.onPayload({ x: 1 })
    await adapter.onResponse({ status: 500, headers: {} })
    // Should not throw, should not create spans
    await tracer.shutdown()
    const spans = await readSpans(dir)
    const stepSpans = spans.filter(s => s.name === 'invoke_agent step')
    assert.equal(stepSpans.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Null tracer: every method is a silent no-op
// ---------------------------------------------------------------------------

test('null tracer: all methods silently no-op (never throw)', async () => {
  const adapter = createCoordinatorTelemetryAdapter({ tracer: null })
  // None of these should throw
  adapter.processAgentEvent(turnStartEvent())
  adapter.processAgentEvent(turnEndEvent())
  adapter.beforeToolCall(mkBeforeCtx('x', 'tc', {}))
  adapter.afterToolCall(mkAfterCtx('x', 'tc', {}, { content: [], details: { success: true, tool_name: 'x' } }))
  adapter.recordSkillLoadOnActiveStep('y', 'router-match')
  await adapter.onPayload({})
  await adapter.onResponse({ status: 200, headers: {} })
  // success = no throw
  assert.ok(true)
})
