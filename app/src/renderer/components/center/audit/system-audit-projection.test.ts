import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AuditGraph, GraphEdge, GraphNode } from '../../../../../../lib/audit-graph/index'
import { buildSystemAuditProjection, classifyEdge } from './system-audit-projection'

function n(id: string, kind: GraphNode['kind'], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind, label: id, ...extra }
}

function e(source: string, target: string, rel: GraphEdge['rel']): GraphEdge {
  return { source, target, rel }
}

test('classifies edge relations by system provenance role', () => {
  assert.equal(classifyEdge('contains'), 'structure')
  assert.equal(classifyEdge('precedes'), 'temporal')
  assert.equal(classifyEdge('invokes'), 'control')
  assert.equal(classifyEdge('returns'), 'observation')
  assert.equal(classifyEdge('reads'), 'data-in')
  assert.equal(classifyEdge('writes'), 'data-out')
})

test('audit projection preserves spine, observations, material lineage, and recovered failures', () => {
  const graph: AuditGraph = {
    builtAt: 'now',
    source: 'test',
    counts: { nodes: 0, edges: 0, spans: 0, traces: 1, artifacts: 0 },
    nodes: [
      n('step:10', 'step', { traceId: 'trace-1', stepIndex: 10 }),
      n('tool:pdftoppm', 'tool', { traceId: 'trace-1', isError: true }),
      n('step:11', 'step', { traceId: 'trace-1', stepIndex: 11 }),
      n('tool:gs', 'tool', { traceId: 'trace-1', isError: false }),
      n('file:nicastro_b2.png', 'file'),
      n('tool:read', 'tool', { traceId: 'trace-1', isError: false }),
      n('step:12', 'step', { traceId: 'trace-1', stepIndex: 12 }),
      n('artifact:summary', 'artifact'),
      n('tool:artifact-create', 'tool', { traceId: 'trace-1', isError: false }),
    ],
    edges: [
      e('step:10', 'step:11', 'precedes'),
      e('step:11', 'step:12', 'precedes'),
      e('step:10', 'tool:pdftoppm', 'invokes'),
      e('tool:pdftoppm', 'step:11', 'returns'),
      e('step:11', 'tool:gs', 'invokes'),
      e('tool:gs', 'step:12', 'returns'),
      e('tool:gs', 'file:nicastro_b2.png', 'writes'),
      e('file:nicastro_b2.png', 'tool:read', 'reads'),
      e('tool:read', 'step:12', 'returns'),
      e('step:11', 'tool:artifact-create', 'invokes'),
      e('tool:artifact-create', 'step:12', 'returns'),
      e('tool:artifact-create', 'artifact:summary', 'creates'),
    ],
  }

  const projection = buildSystemAuditProjection(graph, 'step:12')

  assert.deepEqual(
    [...projection.spineNodes].sort(),
    ['step:10', 'step:11', 'step:12'],
  )
  assert.ok(projection.observationNodes.has('tool:gs'))
  assert.ok(projection.observationNodes.has('tool:read'))
  assert.ok(projection.observationNodes.has('tool:artifact-create'))
  assert.ok(projection.inputNodes.has('file:nicastro_b2.png'))
  assert.equal(projection.inputNodes.has('artifact:summary'), false)
  assert.ok(projection.productNodes.has('file:nicastro_b2.png'))
  assert.ok(projection.productNodes.has('artifact:summary'))
  assert.deepEqual([...projection.deliverable.products].sort(), ['artifact:summary', 'file:nicastro_b2.png'])
  assert.equal(projection.deliverable.claimsSource, 'step:12')
  assert.ok(projection.materialNodes.has('file:nicastro_b2.png'))
  assert.ok(projection.materialNodes.has('artifact:summary'))
  assert.ok(projection.auditNodes.has('step:10'))
  assert.ok(projection.auditNodes.has('tool:read'))
  assert.equal(projection.auditNodes.has('tool:pdftoppm'), false)
  assert.ok(projection.recoveredFailureNodes.has('tool:pdftoppm'))
})
