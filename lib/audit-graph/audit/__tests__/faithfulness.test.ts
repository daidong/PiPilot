import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AuditGraph, EdgeRel, GraphEdge, GraphNode } from '../../types.js'
import { pruneGraph } from '../../prune.js'
import { auditNodeWithClaims, isAuditableNodeKind } from '../faithfulness.js'
import type { ExtractedClaim } from '../types.js'

function n(id: string, kind: GraphNode['kind'], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind, label: id, ...extra }
}

function e(source: string, target: string, rel: EdgeRel): GraphEdge {
  return { source, target, rel }
}

function args(paths: string[]): GraphNode['rawEvents'] {
  return [{ name: 'pipilot.tool.args', body: JSON.stringify({ files: paths }) }]
}

function graph(): AuditGraph {
  const nodes: GraphNode[] = [
    n('span:step1', 'step', { traceId: 'T', stepIndex: 1, startNs: '100' }),
    n('span:step2', 'step', { traceId: 'T', stepIndex: 2, startNs: '200' }),
    n('span:step3', 'step', { traceId: 'T', stepIndex: 3, startNs: '300' }),
    n('span:read-one', 'tool', { traceId: 'T', toolName: 'read', startNs: '120', rawEvents: args(['a.csv']) }),
    n('span:read-three', 'tool', { traceId: 'T', toolName: 'read', startNs: '220', rawEvents: args(['a.csv', 'b.csv', 'c.csv']) }),
    n('file:a.csv', 'file', { path: 'a.csv' }),
    n('file:b.csv', 'file', { path: 'b.csv' }),
    n('file:c.csv', 'file', { path: 'c.csv' }),
  ]
  const edges: GraphEdge[] = [
    e('span:step1', 'span:read-one', 'invokes'),
    e('file:a.csv', 'span:read-one', 'reads'),
    e('span:read-one', 'span:step2', 'returns'),
    e('span:step2', 'span:read-three', 'invokes'),
    e('file:a.csv', 'span:read-three', 'reads'),
    e('file:b.csv', 'span:read-three', 'reads'),
    e('file:c.csv', 'span:read-three', 'reads'),
    e('span:read-three', 'span:step3', 'returns'),
  ]
  return { builtAt: 'x', source: 'x', counts: { nodes: 0, edges: 0, spans: 0, traces: 1, artifacts: 0 }, nodes, edges }
}

test('auditNodeWithClaims matches a hand-fed file-count claim against read edges', () => {
  const g = graph()
  const claim: ExtractedClaim = {
    id: 'c1',
    sourceNodeId: 'span:step2',
    text: 'I read 3 files.',
    quantities: [{ value: 3, unit: 'files' }],
    entities: [],
    scope: null,
  }

  const result = auditNodeWithClaims({ graph: g, nodeId: 'span:step2', claims: [claim] })
  assert.equal(result.findings[0].verdict, 'match')
  assert.deepEqual(result.findings[0].anchorNodeIds, ['span:read-three'])
  assert.equal(result.findings[0].actual, '3 read edge(s)')
})

test('auditNodeWithClaims flags a deterministic file-count mismatch', () => {
  const g = graph()
  const claim: ExtractedClaim = {
    id: 'c1',
    sourceNodeId: 'span:step1',
    text: 'I read all 3 files.',
    quantities: [{ value: 3, unit: 'files' }],
    entities: [],
    scope: 'ALL',
  }

  const result = auditNodeWithClaims({ graph: g, nodeId: 'span:step1', claims: [claim] })
  assert.equal(result.findings[0].verdict, 'mismatch')
  assert.equal(result.findings[0].dimension, 'scope')
  assert.equal(result.findings[0].claimed, '3 files')
  assert.equal(result.findings[0].actual, '1 read edge(s)')
})

test('auditNodeWithClaims emits phantom mismatch for ungrounded_step claims', () => {
  const g: AuditGraph = {
    ...graph(),
    nodes: [
      ...graph().nodes,
      n('span:step4', 'step', { traceId: 'T', stepIndex: 4, startNs: '400' }),
    ],
    edges: graph().edges,
  }
  const prune = pruneGraph(g, { terminalStepId: 'span:step4' })
  const claim: ExtractedClaim = {
    id: 'c-phantom',
    sourceNodeId: 'span:step4',
    text: 'The analysis found three files.',
    quantities: [{ value: 3, unit: 'files' }],
    entities: [],
    scope: null,
  }

  const result = auditNodeWithClaims({
    graph: g,
    nodeId: 'span:step4',
    claims: [claim],
    auditFlags: prune.auditFlags,
  })

  assert.deepEqual(result.triggeredFlags, ['ungrounded_step'])
  assert.equal(result.findings[0].verdict, 'mismatch')
  assert.equal(result.findings[0].actual, 'no incoming tool result in the recorded trace')
})

test('auditNodeWithClaims keeps non-auditable file nodes disabled', () => {
  assert.equal(isAuditableNodeKind('file'), false)
  const result = auditNodeWithClaims({ graph: graph(), nodeId: 'file:a.csv', claims: [] })
  assert.deepEqual(result.findings, [])
})
