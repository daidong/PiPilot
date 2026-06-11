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
import { createCoordinatorTelemetryAdapter, diffPayloadMessages } from '../telemetry-adapter.js'
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
  result: AgentToolResult<any>,
  isError = false
): AfterToolCallContext {
  return {
    assistantMessage: {} as never,
    toolCall: { id, name, arguments: args, type: 'tool_call' as const } as never,
    args,
    result,
    isError,
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

test('afterToolCall marks ERROR when ctx.isError is true even if result has no isError field', async () => {
  // Pi sets ctx.isError when the tool throws or fails before the user-level
  // result is built; result may not carry an isError field. The adapter
  // must trust ctx.isError as the primary failure signal — otherwise the
  // span gets stamped OK and pipilot.tool.error_class is missed.
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.beforeToolCall(mkBeforeCtx('bash', 'tc-throw', { command: 'bad' }))
    // Result with no isError field — would fool the previous result-only check
    const minimalResult = {
      content: [{ type: 'text' as const, text: 'tool threw' }],
      details: { success: false, tool_name: 'bash' }
    } as unknown as AgentToolResult<any>
    adapter.afterToolCall(mkAfterCtx('bash', 'tc-throw', { command: 'bad' }, minimalResult, true))
    await tracer.shutdown()

    const tool = (await readSpans(dir)).find(s => s.name === 'execute_tool bash')
    assert.ok(tool)
    assert.equal(tool.status?.code, 2, 'expected ERROR status from ctx.isError')
    // error_class falls back to 'unknown' when result.details.error_code is absent
    assert.equal(findAttr(tool, 'pipilot.tool.error_class')?.stringValue, 'unknown')
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
// diffPayloadMessages + per-step input_delta
// ---------------------------------------------------------------------------

test('diffPayloadMessages: normal growth yields appended only', () => {
  const prev = { messages: [{ role: 'user', content: 'A' }] }
  const curr = {
    messages: [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' }
    ]
  }
  const d = diffPayloadMessages(prev, curr)
  assert.equal(d.removed.length, 0)
  assert.deepEqual(d.appended, [
    { role: 'assistant', content: 'B' },
    { role: 'user', content: 'C' }
  ])
  assert.equal(d.carriedOver, 1)
})

test('diffPayloadMessages: OpenAI Responses input array yields appended only', () => {
  const prev = {
    input: [
      { role: 'developer', content: 'System' },
      { role: 'user', content: [{ type: 'input_text', text: 'A' }] }
    ],
    model: 'gpt-5.5',
    instructions: 'extra non-conversation field'
  }
  const curr = {
    input: [
      { role: 'developer', content: 'System' },
      { role: 'user', content: [{ type: 'input_text', text: 'A' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'B', annotations: [] }],
        status: 'completed'
      }
    ],
    model: 'gpt-5.5',
    instructions: 'extra non-conversation field'
  }
  const d = diffPayloadMessages(prev, curr)
  assert.equal(d.removed.length, 0)
  assert.deepEqual(d.appended, [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'B', annotations: [] }],
      status: 'completed'
    }
  ])
  assert.equal(d.carriedOver, 2)
})

test('diffPayloadMessages: Google contents array yields appended only', () => {
  const prev = {
    contents: [{ role: 'user', parts: [{ text: 'A' }] }],
    config: { systemInstruction: 'System' }
  }
  const curr = {
    contents: [
      { role: 'user', parts: [{ text: 'A' }] },
      { role: 'model', parts: [{ text: 'B' }] }
    ],
    config: { systemInstruction: 'System' }
  }
  const d = diffPayloadMessages(prev, curr)
  assert.equal(d.removed.length, 0)
  assert.deepEqual(d.appended, [{ role: 'model', parts: [{ text: 'B' }] }])
  assert.equal(d.carriedOver, 1)
})

test('diffPayloadMessages: scalar input is ignored rather than treated as conversation', () => {
  const d = diffPayloadMessages(
    { input: 'A' },
    { input: 'A plus B' }
  )
  assert.deepEqual(d.appended, [])
  assert.deepEqual(d.removed, [])
  assert.equal(d.carriedOver, 0)
})

test('diffPayloadMessages: compaction shows removed prefix + summary, keeps surviving suffix', () => {
  const prev = {
    messages: [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' }
    ]
  }
  // Early chunk (A, B) replaced by a summary; the recent tail (C) survives.
  const curr = {
    messages: [
      { role: 'user', content: 'SUMMARY' },
      { role: 'user', content: 'C' }
    ]
  }
  const d = diffPayloadMessages(prev, curr)
  assert.deepEqual(d.removed, [
    { role: 'user', content: 'A' },
    { role: 'assistant', content: 'B' }
  ])
  assert.deepEqual(d.appended, [{ role: 'user', content: 'SUMMARY' }])
  assert.equal(d.carriedOver, 1) // trailing C carried over, excluded from both
})

test('diffPayloadMessages: a cache_control marker shift is not a content change', () => {
  const prev = { messages: [{ role: 'user', content: 'A', cache_control: { type: 'ephemeral' } }] }
  const curr = {
    messages: [
      { role: 'user', content: 'A' }, // same message, marker gone
      { role: 'assistant', content: 'B' }
    ]
  }
  const d = diffPayloadMessages(prev, curr)
  assert.equal(d.removed.length, 0)
  assert.deepEqual(d.appended, [{ role: 'assistant', content: 'B' }])
})

test('onPayload records pipilot.chat.input_delta on steps after the first', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    // Step 1: full payload anchor, no delta (no prior payload).
    adapter.processAgentEvent(turnStartEvent())
    await adapter.onPayload({ messages: [{ role: 'user', content: 'A' }] })
    adapter.processAgentEvent(turnEndEvent())
    // Step 2: input grew by one message → delta with that message appended.
    adapter.processAgentEvent(turnStartEvent())
    await adapter.onPayload({
      messages: [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }]
    })
    adapter.processAgentEvent(turnEndEvent())
    await tracer.shutdown()

    const steps = (await readSpans(dir)).filter(s => s.name === 'invoke_agent step')
    const step1 = steps.find(s => attrAsNumber(s, 'pipilot.step.index') === 1)
    const step2 = steps.find(s => attrAsNumber(s, 'pipilot.step.index') === 2)
    assert.ok(step1 && step2)
    // Step 1: request_payload present, input_delta absent.
    assert.ok(step1.events?.find((e: any) => e.name === 'pipilot.chat.request_payload'))
    assert.equal(step1.events?.find((e: any) => e.name === 'pipilot.chat.input_delta'), undefined)
    // Step 2: input_delta present (and request_payload suppressed by v0.12 gate).
    const deltaEvent = step2.events?.find((e: any) => e.name === 'pipilot.chat.input_delta')
    assert.ok(deltaEvent, 'expected input_delta on step 2')
    assert.equal(step2.events?.find((e: any) => e.name === 'pipilot.chat.request_payload'), undefined)
    const body = JSON.parse(
      deltaEvent.attributes?.find((a: any) => a.key === 'body')?.value?.stringValue
    )
    assert.equal(body.appended.length, 1)
    assert.equal(body.removed.length, 0)
    assert.deepEqual(body.appended[0], { role: 'assistant', content: 'B' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('onPayload records pipilot.chat.input_delta for OpenAI Responses input arrays', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.processAgentEvent(turnStartEvent())
    await adapter.onPayload({ input: [{ role: 'user', content: 'A' }] })
    adapter.processAgentEvent(turnEndEvent())

    adapter.processAgentEvent(turnStartEvent())
    await adapter.onPayload({
      input: [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }]
    })
    adapter.processAgentEvent(turnEndEvent())
    await tracer.shutdown()

    const step2 = (await readSpans(dir))
      .filter(s => s.name === 'invoke_agent step')
      .find(s => attrAsNumber(s, 'pipilot.step.index') === 2)
    assert.ok(step2)
    const deltaEvent = step2.events?.find((e: any) => e.name === 'pipilot.chat.input_delta')
    assert.ok(deltaEvent, 'expected input_delta for Responses input arrays')
    const body = JSON.parse(
      deltaEvent.attributes?.find((a: any) => a.key === 'body')?.value?.stringValue
    )
    assert.deepEqual(body.appended, [{ role: 'assistant', content: 'B' }])
    assert.deepEqual(body.removed, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Null tracer: every method is a silent no-op
// ---------------------------------------------------------------------------

test('processAgentEvent stamps pipilot.thinking_level on step span when accessor returns a value', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({
      tracer,
      getThinkingLevel: () => 'high'
    })
    adapter.processAgentEvent(turnStartEvent())
    adapter.processAgentEvent(turnEndEvent())
    await tracer.shutdown()

    const step = (await readSpans(dir)).find(s => s.name === 'invoke_agent step')
    assert.ok(step)
    assert.equal(findAttr(step, 'pipilot.thinking_level')?.stringValue, 'high')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('processAgentEvent omits pipilot.thinking_level when accessor returns undefined', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({
      tracer,
      getThinkingLevel: () => undefined
    })
    adapter.processAgentEvent(turnStartEvent())
    adapter.processAgentEvent(turnEndEvent())
    await tracer.shutdown()

    const step = (await readSpans(dir)).find(s => s.name === 'invoke_agent step')
    assert.ok(step)
    assert.equal(findAttr(step, 'pipilot.thinking_level'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('turn_end captures assistant content as pipilot.chat.response_text event', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.processAgentEvent(turnStartEvent())
    // Build a turn_end with non-empty assistant content.
    const event = {
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the answer.' }],
        usage: { input: 10, output: 5 }
      },
      toolResults: []
    } as unknown as AgentEvent
    adapter.processAgentEvent(event)
    await tracer.shutdown()

    const step = (await readSpans(dir)).find(s => s.name === 'invoke_agent step')
    assert.ok(step)
    const responseEvent = step.events?.find((e: any) => e.name === 'pipilot.chat.response_text')
    assert.ok(responseEvent, 'expected pipilot.chat.response_text event on step span')
    const body = responseEvent.attributes?.find((a: any) => a.key === 'body')?.value?.stringValue
    assert.ok(body && body.includes('Here is the answer.'),
      `expected response body to contain assistant text, got: ${body}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('turn_end with empty/missing content does not emit response_text event', async () => {
  const { dir, tracer } = mkTracer()
  try {
    const adapter = createCoordinatorTelemetryAdapter({ tracer })
    adapter.processAgentEvent(turnStartEvent())
    // event.message has no content array (defensive case)
    adapter.processAgentEvent(turnEndEvent())
    await tracer.shutdown()

    const step = (await readSpans(dir)).find(s => s.name === 'invoke_agent step')
    assert.ok(step)
    const responseEvent = step.events?.find((e: any) => e.name === 'pipilot.chat.response_text')
    assert.equal(responseEvent, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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
