import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AuditGraph, GraphNode } from '../../types.js'
import { escalateFinding, isEscalatable } from '../escalate.js'
import type { FaithfulnessFinding } from '../types.js'

function finding(extra: Partial<FaithfulnessFinding> = {}): FaithfulnessFinding {
  return {
    claimId: 'c1', claimText: 'Figure 7 shows a shorter burst.', anchorNodeIds: ['file:fig7.png'],
    verdict: 'unverifiable', claimed: 'shorter burst', actual: 'no comparable deterministic feature in v1', evidence: [],
    ...extra,
  }
}

function graph(): AuditGraph {
  const nodes: GraphNode[] = [n('file:fig7.png', 'file', { path: 'fig7.png' })]
  return { builtAt: 'x', source: 'x', counts: { nodes: 0, edges: 0, spans: 0, traces: 0, artifacts: 0 }, nodes, edges: [] }
}
function n(id: string, kind: GraphNode['kind'], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind, label: id, ...extra }
}

test('isEscalatable only targets unverifiable visual/semantic findings', () => {
  assert.equal(isEscalatable(finding()), true)
  assert.equal(isEscalatable(finding({ claimText: 'I read 3 files.' })), false)
  assert.equal(isEscalatable(finding({ verdict: 'mismatch' })), false)
})

test('escalateFinding leaves the finding unchanged when no image evidence is reachable', async () => {
  // No blob/file bytes on disk → collectAuditImages returns [] → unchanged.
  let called = false
  const out = await escalateFinding({
    finding: finding(), graph: graph(),
    callLlm: async () => { called = true; return '{}' },
  })
  assert.equal(out.verdict, 'unverifiable')
  assert.equal(called, false)
})

test('escalateFinding returns the input unchanged for an anchorless finding', async () => {
  const f = finding({ anchorNodeIds: [] })
  const out = await escalateFinding({ finding: f, graph: graph(), callLlm: async () => '{}' })
  assert.deepEqual(out, f)
})
