import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mapWithConcurrency, summarizeNodeAudits, orderAuditCandidates } from '../node-audit.js'
import type { AuditGraph, EdgeRel, GraphEdge, GraphNode } from '../../types.js'
import type { NodeAuditResult } from '../types.js'

function gn(id: string, kind: GraphNode['kind'], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind, label: id, ...extra }
}
function ge(s: string, t: string, rel: EdgeRel): GraphEdge {
  return { source: s, target: t, rel }
}

test('orderAuditCandidates returns step/chat/artifact newest-first, excluding tool/pruned/excluded', () => {
  const graph: AuditGraph = {
    builtAt: 'x', source: 'x', counts: { nodes: 0, edges: 0, spans: 0, traces: 1, artifacts: 0 },
    nodes: [
      gn('s1', 'step', { traceId: 'T', startNs: '100' }),
      gn('s2', 'step', { traceId: 'T', startNs: '300' }),
      gn('c1', 'chat', { traceId: 'T', startNs: '200' }),
      gn('tool1', 'tool', { traceId: 'T', startNs: '250', toolName: 'read' }),
      gn('s-other', 'step', { traceId: 'OTHER', startNs: '999' }),
    ],
    edges: [ge('s1', 's2', 'precedes')],
  }
  const order = orderAuditCandidates(graph, { terminalTraceId: 'T', prunedNodes: ['c1'], excludeNodeIds: [] })
  assert.ok(!order.includes('tool1'), 'tool excluded')
  assert.ok(!order.includes('c1'), 'pruned excluded')
  assert.ok(!order.includes('s-other'), 'other trace excluded')
  assert.ok(order.indexOf('s2') < order.indexOf('s1'), 'newest-first')
})

test('mapWithConcurrency respects the limit and preserves order', async () => {
  let inFlight = 0
  let peak = 0
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise(r => setTimeout(r, 5))
    inFlight--
    return x * 2
  })
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14])
  assert.ok(peak <= 3, `peak concurrency ${peak} should be ≤ 3`)
})

test('mapWithConcurrency reports progress for every item', async () => {
  const seen: number[] = []
  await mapWithConcurrency([1, 2, 3], 2, async x => x, (done, total) => { assert.equal(total, 3); seen.push(done) })
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3])
})

function r(nodeId: string, findings: NodeAuditResult['findings']): NodeAuditResult {
  return { nodeId, nodeKind: 'step', findings, triggeredFlags: [] }
}
function claim(verdict: 'match' | 'mismatch' | 'unverifiable', anchor: string): NodeAuditResult['findings'][number] {
  return { claimId: 'c', claimText: 't', anchorNodeIds: [anchor], verdict, claimed: 'x', actual: 'y', evidence: [] }
}
function flag(name: string, anchor: string): NodeAuditResult['findings'][number] {
  return { claimId: `flag:${name}`, claimText: name, anchorNodeIds: [anchor], verdict: 'mismatch', claimed: name, actual: 'consumed a failed op', evidence: [], flag: name }
}

test('summarizeNodeAudits aggregates counts and lists mismatches + flags', () => {
  const s = summarizeNodeAudits([
    r('s1', [claim('mismatch', 'tool:a'), claim('match', 'tool:b')]),
    r('s2', [claim('unverifiable', 'tool:c'), flag('error', 'tool:d')]),
  ], ['tool:a', 'tool:b', 'tool:c', 'tool:d', 'tool:e'])

  assert.equal(s.nodesAudited, 2)
  assert.equal(s.claims, 3)
  assert.equal(s.mismatch, 1)
  assert.equal(s.match, 1)
  assert.equal(s.unverifiable, 1)
  assert.equal(s.flags, 1)
  // All findings carried, tagged with source node.
  assert.equal(s.findings.length, 4)
  assert.equal(s.findings.filter(x => !x.finding.flag && x.finding.verdict === 'mismatch').length, 1)
  assert.ok(s.findings.some(x => x.finding.flag === 'error'))
  assert.ok(s.findings.every(x => typeof x.nodeId === 'string'))
})

test('summarizeNodeAudits coverage gap: covered vs flagged-only vs silent', () => {
  // 5 focused tools. a,b covered by claims; d caught by a flag; c,e silent.
  const s = summarizeNodeAudits([
    r('s1', [claim('match', 'tool:a'), claim('mismatch', 'tool:b')]),
    r('s2', [flag('error', 'tool:d')]),
  ], ['tool:a', 'tool:b', 'tool:c', 'tool:d', 'tool:e'])

  assert.equal(s.coverage.focusedTools, 5)
  assert.equal(s.coverage.coveredByClaim, 2) // a, b
  assert.equal(s.coverage.flaggedOnly, 1)    // d
  assert.equal(s.coverage.silent, 2)         // c, e — no claim, no flag
})
