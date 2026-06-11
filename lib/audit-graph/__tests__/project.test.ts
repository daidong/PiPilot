import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { projectGraph } from '../project.js'
import { PATHS } from '../../types.js'

function attr(key: string, value: string | number | boolean) {
  const otlpValue =
    typeof value === 'string' ? { stringValue: value }
      : typeof value === 'number' ? { intValue: value }
        : { boolValue: value }
  return { key, value: otlpValue }
}

function event(name: string, body: unknown) {
  return {
    name,
    attributes: [attr('body', typeof body === 'string' ? body : JSON.stringify(body))],
  }
}

function span(opts: {
  traceId?: string
  spanId: string
  name: string
  start: number
  end: number
  attrs?: Array<ReturnType<typeof attr>>
  events?: Array<ReturnType<typeof event>>
}) {
  return {
    traceId: opts.traceId ?? 'trace-1',
    spanId: opts.spanId,
    name: opts.name,
    startTimeUnixNano: String(opts.start),
    endTimeUnixNano: String(opts.end),
    attributes: opts.attrs ?? [],
    events: opts.events ?? [],
  }
}

function hasEdge(
  graph: Awaited<ReturnType<typeof projectGraph>>,
  source: string,
  target: string,
  rel: string,
): boolean {
  return graph.edges.some(e => e.source === source && e.target === target && e.rel === rel)
}

test('projectGraph links tool calls by toolCallId and creates artifacts from ledger spanId', async () => {
  const dir = join(tmpdir(), `pipilot-audit-graph-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  try {
    mkdirSync(join(dir, PATHS.traces), { recursive: true })
    mkdirSync(dirname(join(dir, PATHS.ledgerArtifact)), { recursive: true })

    const spans = [
      span({
        spanId: 'step-1',
        name: 'invoke_agent step',
        start: 100,
        end: 200,
        attrs: [attr('pipilot.step.index', 1), attr('pipilot.turn.id', 'turn-1')],
        events: [event('pipilot.chat.response_text', [
          { type: 'text', text: 'I will call two tools.' },
          { type: 'toolCall', id: 'call-a', name: 'read' },
          { type: 'toolCall', id: 'call-b', name: 'artifact-create' },
        ])],
      }),
      span({
        spanId: 'tool-a',
        name: 'execute_tool read',
        start: 250,
        end: 300,
        attrs: [
          attr('gen_ai.tool.name', 'read'),
          attr('gen_ai.tool.call.id', 'call-a'),
          attr('pipilot.turn.id', 'turn-1'),
        ],
      }),
      span({
        spanId: 'tool-b',
        name: 'execute_tool artifact-create',
        start: 260,
        end: 310,
        attrs: [
          attr('gen_ai.tool.name', 'artifact-create'),
          attr('gen_ai.tool.call.id', 'call-b'),
          attr('pipilot.turn.id', 'turn-1'),
        ],
        events: [event('pipilot.tool.result', { content: [{ type: 'text', text: 'created without an id in text' }] })],
      }),
      span({
        spanId: 'step-2',
        name: 'invoke_agent step',
        start: 400,
        end: 500,
        attrs: [attr('pipilot.step.index', 2), attr('pipilot.turn.id', 'turn-1')],
      }),
      span({
        spanId: 'step-3',
        name: 'invoke_agent step',
        start: 1000,
        end: 1050,
        attrs: [attr('pipilot.step.index', 3), attr('pipilot.turn.id', 'turn-2')],
        events: [event('pipilot.chat.response_text', [
          { type: 'toolCall', id: 'call-c', name: 'write' },
        ])],
      }),
      span({
        spanId: 'tool-c',
        name: 'execute_tool write',
        start: 1100,
        end: 1150,
        attrs: [
          attr('gen_ai.tool.name', 'write'),
          attr('gen_ai.tool.call.id', 'call-c'),
          attr('pipilot.turn.id', 'turn-2'),
        ],
      }),
      span({
        spanId: 'step-4',
        name: 'invoke_agent step',
        start: 1200,
        end: 1300,
        attrs: [attr('pipilot.step.index', 4), attr('pipilot.turn.id', 'turn-3')],
      }),
    ]

    writeFileSync(
      join(dir, PATHS.traces, 'spans.2026-06-01.jsonl'),
      JSON.stringify({ scopeSpans: [{ spans }] }) + '\n',
    )
    writeFileSync(
      join(dir, PATHS.ledgerArtifact),
      JSON.stringify({
        artifactId: 'artifact-1',
        version: 1,
        op: 'create',
        type: 'note',
        path: '.research-pilot/artifacts/artifact-1.md',
        contentHash: 'sha256:test',
        versionBefore: null,
        initiator: 'tool',
        traceId: 'trace-1',
        spanId: 'tool-b',
        turnId: 'turn-1',
        timestamp: '2026-06-01T00:00:00.000Z',
      }) + '\n',
    )

    const graph = await projectGraph(dir)

    assert.ok(hasEdge(graph, 'span:step-1', 'span:tool-a', 'invokes'))
    assert.ok(hasEdge(graph, 'span:step-1', 'span:tool-b', 'invokes'))
    assert.ok(hasEdge(graph, 'span:tool-a', 'span:step-2', 'returns'))
    assert.ok(hasEdge(graph, 'span:tool-b', 'span:step-2', 'returns'))
    assert.equal(hasEdge(graph, 'span:tool-c', 'span:step-4', 'returns'), false)
    assert.ok(hasEdge(graph, 'span:tool-b', 'artifact:artifact-1', 'creates'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('projectGraph turns skill.load events into shared skill nodes + applies edges', async () => {
  const dir = join(tmpdir(), `pipilot-audit-skill-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  try {
    mkdirSync(join(dir, PATHS.traces), { recursive: true })

    const skillEvent = (skillName: string, trigger: string) => ({
      name: 'pipilot.skill.load',
      attributes: [attr('skillName', skillName), attr('trigger', trigger)],
    })

    const spans = [
      // Root span carries the router-match skill (no step exists yet).
      span({
        spanId: 'root-1',
        name: 'invoke_agent chat',
        start: 50,
        end: 600,
        events: [skillEvent('paper-writing', 'router-match')],
      }),
      span({
        spanId: 'step-1',
        name: 'invoke_agent step',
        start: 100,
        end: 200,
        attrs: [attr('pipilot.step.index', 1)],
      }),
      // Explicit load mid-turn rides the step span that called load_skill.
      span({
        spanId: 'step-2',
        name: 'invoke_agent step',
        start: 300,
        end: 400,
        attrs: [attr('pipilot.step.index', 2)],
        events: [skillEvent('matplotlib', 'explicit-load')],
      }),
    ]

    writeFileSync(
      join(dir, PATHS.traces, 'spans.2026-06-01.jsonl'),
      JSON.stringify({ scopeSpans: [{ spans }] }) + '\n',
    )

    const graph = await projectGraph(dir)

    const paperWriting = graph.nodes.find(n => n.id === 'skill:paper-writing')
    const matplotlib = graph.nodes.find(n => n.id === 'skill:matplotlib')
    assert.ok(paperWriting && paperWriting.kind === 'skill', 'paper-writing skill node exists')
    assert.equal(paperWriting?.skillTrigger, 'router-match')
    assert.ok(matplotlib && matplotlib.kind === 'skill', 'matplotlib skill node exists')
    assert.equal(matplotlib?.skillTrigger, 'explicit-load')

    // router-match attaches to the trace's FIRST step; explicit-load to its own step.
    assert.ok(hasEdge(graph, 'skill:paper-writing', 'span:step-1', 'applies'), 'router-match → first step')
    assert.ok(hasEdge(graph, 'skill:matplotlib', 'span:step-2', 'applies'), 'explicit-load → loading step')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
