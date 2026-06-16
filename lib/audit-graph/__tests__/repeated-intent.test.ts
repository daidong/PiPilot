import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pruneGraph } from '../prune.js'
import type { AuditGraph, EdgeRel, GraphEdge, GraphNode } from '../index.js'

function n(id: string, kind: GraphNode['kind'], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind, label: id, ...extra }
}
function e(s: string, t: string, rel: EdgeRel): GraphEdge {
  return { source: s, target: t, rel }
}
function tool(id: string, idx: number, result: string | null): GraphNode {
  const rawEvents: GraphNode['rawEvents'] = [{ name: 'pipilot.tool.args', body: JSON.stringify({ q: 'same' }) }]
  if (result !== null) rawEvents.push({ name: 'pipilot.tool.result', body: result })
  return n(id, 'tool', { traceId: 'T', toolName: 'search', startNs: String(100 + idx * 10), rawEvents })
}

// Trace T: steps 1..4; steps 1-3 each invoke the SAME tool+args (a 3× do-over
// cluster); step4 is the terminal. Each repeated tool returns to the next step.
function fixture(results: [string | null, string | null, string | null]): AuditGraph {
  const nodes: GraphNode[] = [
    n('trace:T', 'trace', { traceId: 'T' }),
    n('s1', 'step', { traceId: 'T', stepIndex: 1, startNs: '100' }),
    n('s2', 'step', { traceId: 'T', stepIndex: 2, startNs: '200' }),
    n('s3', 'step', { traceId: 'T', stepIndex: 3, startNs: '300' }),
    n('s4', 'step', { traceId: 'T', stepIndex: 4, startNs: '400' }),
    tool('t1', 1, results[0]),
    tool('t2', 2, results[1]),
    tool('t3', 3, results[2]),
  ]
  const edges: GraphEdge[] = [
    e('trace:T', 's1', 'contains'), e('trace:T', 's2', 'contains'),
    e('trace:T', 's3', 'contains'), e('trace:T', 's4', 'contains'),
    e('s1', 't1', 'invokes'), e('t1', 's2', 'returns'),
    e('s2', 't2', 'invokes'), e('t2', 's3', 'returns'),
    e('s3', 't3', 'invokes'), e('t3', 's4', 'returns'),
    e('s1', 's2', 'precedes'), e('s2', 's3', 'precedes'), e('s3', 's4', 'precedes'),
  ]
  return { builtAt: 'x', source: 'x', counts: { nodes: 0, edges: 0, spans: 0, traces: 1, artifacts: 0 }, nodes, edges }
}

test('identical-result cluster: supersedes are deterministically pruned, latest kept', () => {
  const r = pruneGraph(fixture(['RESULT', 'RESULT', 'RESULT']))
  const pruned = new Set(r.prunedNodes)
  assert.ok(pruned.has('t1') && pruned.has('t2'), 'earlier do-overs greyed')
  assert.ok(!pruned.has('t3'), 'latest invocation kept')
})

test('identical-result cluster: only the superseded carry the repeated_intent flag (keeper unflagged)', () => {
  const r = pruneGraph(fixture(['RESULT', 'RESULT', 'RESULT']))
  assert.deepEqual(r.flags['t1'], ['repeated_intent'])
  assert.deepEqual(r.flags['t2'], ['repeated_intent'])
  assert.equal(r.flags['t3'], undefined, 'keeper is never flagged')
})

test('divergent-result cluster: NOT deterministically pruned (deferred to §3.2), superseded flagged', () => {
  const r = pruneGraph(fixture(['A', 'B', 'C']))
  const pruned = new Set(r.prunedNodes)
  assert.ok(!pruned.has('t1') && !pruned.has('t2'), 'divergent results not det-pruned')
  assert.deepEqual(r.flags['t1'], ['repeated_intent'])
  assert.deepEqual(r.flags['t2'], ['repeated_intent'])
  assert.equal(r.flags['t3'], undefined)
})

test('redacted result blocks det-prune (cannot confirm identical) → divergent path', () => {
  const r = pruneGraph(fixture(['RESULT', null, 'RESULT']))
  const pruned = new Set(r.prunedNodes)
  assert.ok(!pruned.has('t1') && !pruned.has('t2'), 'unconfirmable identity → not det-pruned')
  assert.deepEqual(r.flags['t1'], ['repeated_intent'])
})

test('a non-repeated tool (only 2 invocations) is neither pruned nor flagged', () => {
  const g = fixture(['RESULT', 'RESULT', 'RESULT'])
  // drop the 3rd invocation so the cluster is only 2 → below the ≥3 threshold
  g.nodes = g.nodes.filter(x => x.id !== 't3')
  g.edges = g.edges.filter(x => x.source !== 't3' && x.target !== 't3' && x.source !== 's3' || x.rel === 'contains' || x.rel === 'precedes')
  const r = pruneGraph(g)
  assert.equal(r.flags['t1'], undefined)
  assert.equal(r.flags['t2'], undefined)
})
