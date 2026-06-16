import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AuditGraph, EdgeRel, GraphEdge, GraphNode } from '../../types.js'
import { auditNodeWithClaims } from '../faithfulness.js'

function n(id: string, kind: GraphNode['kind'], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind, label: id, ...extra }
}
function e(source: string, target: string, rel: EdgeRel): GraphEdge {
  return { source, target, rel }
}
function g(nodes: GraphNode[], edges: GraphEdge[]): AuditGraph {
  return { builtAt: 'x', source: 'x', counts: { nodes: 0, edges: 0, spans: 0, traces: 1, artifacts: 0 }, nodes, edges }
}

test('A1 citation check: unresolved citations on an artifact are a flagged mismatch', () => {
  const node = n('artifact:report', 'artifact', { citationsTotal: 3, citationsResolved: 2, unresolvedCitations: ['smith2020'] })
  const res = auditNodeWithClaims({ graph: g([node], []), nodeId: 'artifact:report', claims: [] })
  assert.equal(res.findings.length, 1)
  assert.equal(res.findings[0].flag, 'citation')
  assert.equal(res.findings[0].verdict, 'mismatch')
  assert.match(res.findings[0].actual, /smith2020/)
})

test('A1 citation check: fully resolved citations are a flagged match', () => {
  const node = n('artifact:report', 'artifact', { citationsTotal: 2, citationsResolved: 2, unresolvedCitations: [] })
  const res = auditNodeWithClaims({ graph: g([node], []), nodeId: 'artifact:report', claims: [] })
  assert.equal(res.findings[0].verdict, 'match')
  assert.equal(res.findings[0].flag, 'citation')
})

test('flag check: a step that consumed a FAILED operation gets an error finding', () => {
  const graph = g(
    [n('s2', 'step', { traceId: 'T', stepIndex: 2 }), n('tool', 'tool', { traceId: 'T', toolName: 'data-analyze', isError: true })],
    [e('s2', 'tool', 'invokes'), e('tool', 's2', 'returns')],
  )
  const res = auditNodeWithClaims({ graph, nodeId: 's2', claims: [], auditFlags: { tool: ['error'] } })
  const errf = res.findings.find(f => f.flag === 'error')
  assert.ok(errf, 'expected an error flag finding')
  assert.equal(errf!.verdict, 'mismatch')
  assert.match(errf!.actual, /FAILED operation \(data-analyze\)/)
})

test('flag check: an unused product produced by the audited step is surfaced (2-hop)', () => {
  const graph = g(
    [
      n('s2', 'step', { traceId: 'T', stepIndex: 2 }),
      n('write', 'tool', { traceId: 'T', toolName: 'write' }),
      n('file:out.csv', 'file', { path: 'out.csv', label: 'out.csv' }),
    ],
    [e('s2', 'write', 'invokes'), e('write', 'file:out.csv', 'writes')],
  )
  const res = auditNodeWithClaims({ graph, nodeId: 's2', claims: [], auditFlags: { 'file:out.csv': ['unused_output'] } })
  const f = res.findings.find(ff => ff.flag === 'unused_output')
  assert.ok(f, 'expected an unused_output flag finding')
  assert.equal(f!.verdict, 'unverifiable')
})

test('flag check: ungrounded_step is NOT double-counted as a flag finding', () => {
  const graph = g([n('s4', 'step', { traceId: 'T', stepIndex: 4 })], [])
  const res = auditNodeWithClaims({ graph, nodeId: 's4', claims: [], auditFlags: { s4: ['ungrounded_step'] } })
  assert.equal(res.findings.filter(f => f.flag === 'ungrounded_step').length, 0)
  assert.deepEqual(res.triggeredFlags, ['ungrounded_step'])
})
