import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AuditGraph, EdgeRel, GraphEdge, GraphNode } from '../../types.js'
import { nodeOutputText, runNodeAudit } from '../node-audit.js'

function n(id: string, kind: GraphNode['kind'], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind, label: id, ...extra }
}
function e(source: string, target: string, rel: EdgeRel): GraphEdge {
  return { source, target, rel }
}
function graph(): AuditGraph {
  return {
    builtAt: 'x', source: 'x', counts: { nodes: 0, edges: 0, spans: 0, traces: 1, artifacts: 0 },
    nodes: [
      n('s2', 'step', { traceId: 'T', stepIndex: 2, rawEvents: [{ name: 'pipilot.chat.response_text', body: JSON.stringify('I read 3 files.') }] }),
      n('read', 'tool', { traceId: 'T', toolName: 'read', rawEvents: [{ name: 'pipilot.tool.args', body: JSON.stringify({ files: ['a.csv', 'b.csv', 'c.csv'] }) }] }),
      n('file:a.csv', 'file', { path: 'a.csv' }),
      n('file:b.csv', 'file', { path: 'b.csv' }),
      n('file:c.csv', 'file', { path: 'c.csv' }),
    ],
    edges: [
      e('s2', 'read', 'invokes'),
      e('file:a.csv', 'read', 'reads'),
      e('file:b.csv', 'read', 'reads'),
      e('file:c.csv', 'read', 'reads'),
    ],
  }
}

test('runNodeAudit extracts claims via callLlm then deterministically compares', async () => {
  let prompts = 0
  const out = await runNodeAudit({
    projectPath: '/tmp/unused',
    graph: graph(),
    nodeId: 's2',
    persist: false,
    callLlm: async () => {
      prompts++
      return JSON.stringify([{ text: 'I read 3 files.', quantities: [{ value: 3, unit: 'files' }], entities: [], scope: null }])
    },
  })
  assert.equal(prompts, 1)
  assert.equal(out.result.findings.length, 1)
  assert.equal(out.result.findings[0].verdict, 'match')
  assert.equal(out.logPath, undefined)
})

test('runNodeAudit honours hand-fed claims without calling the LLM', async () => {
  let called = false
  const out = await runNodeAudit({
    projectPath: '/tmp/unused',
    graph: graph(),
    nodeId: 's2',
    persist: false,
    claims: [{ id: 'h1', sourceNodeId: 's2', text: 'I read 5 files.', quantities: [{ value: 5, unit: 'files' }], entities: [], scope: null }],
    callLlm: async () => { called = true; return '[]' },
  })
  assert.equal(called, false)
  assert.equal(out.result.findings[0].verdict, 'mismatch')
})

test('runNodeAudit returns empty for non-auditable kinds without an LLM call', async () => {
  let called = false
  const out = await runNodeAudit({
    projectPath: '/tmp/unused', graph: graph(), nodeId: 'file:a.csv', persist: false,
    callLlm: async () => { called = true; return '[]' },
  })
  assert.equal(called, false)
  assert.deepEqual(out.result.findings, [])
})

test('nodeOutputText reads response_text for steps and is empty for artifacts without supplied text', () => {
  assert.equal(nodeOutputText(graph().nodes[0]), 'I read 3 files.')
  assert.equal(nodeOutputText(n('art', 'artifact')), '')
  assert.equal(nodeOutputText(n('art', 'artifact'), { artifactText: 'body' }), 'body')
})
