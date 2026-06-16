import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AuditGraph, EdgeRel, GraphEdge, GraphNode } from '../../types.js'
import { auditNodeWithClaims } from '../faithfulness.js'
import type { ExtractedClaim } from '../types.js'

function n(id: string, kind: GraphNode['kind'], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind, label: id, ...extra }
}
function e(source: string, target: string, rel: EdgeRel): GraphEdge {
  return { source, target, rel }
}
function ev(name: string, body: unknown): { name: string; body: string } {
  return { name, body: typeof body === 'string' ? body : JSON.stringify(body) }
}
function g(nodes: GraphNode[], edges: GraphEdge[]): AuditGraph {
  return { builtAt: 'x', source: 'x', counts: { nodes: 0, edges: 0, spans: 0, traces: 1, artifacts: 0 }, nodes, edges }
}

// ── result-value comparison (dimension: 'result') ──────────────────────────

function resultGraph(resultBody: unknown): AuditGraph {
  return g(
    [
      n('s2', 'step', { traceId: 'T', stepIndex: 2 }),
      n('analyze', 'tool', { traceId: 'T', toolName: 'data-analyze', rawEvents: [ev('pipilot.tool.result', resultBody)] }),
    ],
    [e('s2', 'analyze', 'invokes')],
  )
}

function valueClaim(value: number): ExtractedClaim {
  return { id: 'c1', sourceNodeId: 's2', text: 'The mean was reported.', quantities: [{ value, unit: 'mean' }], entities: [], scope: null }
}

test('result-value: claimed scalar matches a recorded result number (rounding-tolerant)', () => {
  const res = auditNodeWithClaims({ graph: resultGraph({ mean: 4.234 }), nodeId: 's2', claims: [valueClaim(4.2)] })
  assert.equal(res.findings[0].verdict, 'match')
  assert.equal(res.findings[0].dimension, 'result')
})

test('result-value: claimed scalar absent from results is a mismatch', () => {
  const res = auditNodeWithClaims({ graph: resultGraph({ mean: 9.9 }), nodeId: 's2', claims: [valueClaim(4.2)] })
  assert.equal(res.findings[0].verdict, 'mismatch')
  assert.equal(res.findings[0].dimension, 'result')
})

test('result-value: no numeric result is unverifiable', () => {
  const res = auditNodeWithClaims({ graph: resultGraph({ note: 'done' }), nodeId: 's2', claims: [valueClaim(4.2)] })
  assert.equal(res.findings[0].verdict, 'unverifiable')
  assert.equal(res.findings[0].dimension, 'result')
})

// ── ALL scope via listed denominator ───────────────────────────────────────

function listedGraph(readPaths: string[]): AuditGraph {
  const nodes: GraphNode[] = [
    n('s1', 'step', { traceId: 'T', stepIndex: 1 }),
    n('ls', 'tool', { traceId: 'T', toolName: 'ls', rawEvents: [ev('pipilot.tool.result', { files: ['a.csv', 'b.csv', 'c.csv'] })] }),
    n('analyze', 'tool', { traceId: 'T', toolName: 'data-analyze' }),
    n('dir:data', 'dir', { path: 'data' }),
    n('file:a.csv', 'file', { path: 'data/a.csv' }),
    n('file:b.csv', 'file', { path: 'data/b.csv' }),
    n('file:c.csv', 'file', { path: 'data/c.csv' }),
  ]
  const edges: GraphEdge[] = [
    e('dir:data', 'ls', 'listed'),
    e('ls', 's1', 'returns'),
    e('s1', 'analyze', 'invokes'),
    ...readPaths.map(p => e(`file:${p}`, 'analyze', 'reads' as EdgeRel)),
  ]
  return g(nodes, edges)
}

const allClaim: ExtractedClaim = {
  id: 'c1', sourceNodeId: 's1', text: 'I analyzed all the data files.', quantities: [], entities: [], scope: 'ALL',
}

test('ALL scope: read-set covering the listed inventory is a match', () => {
  const res = auditNodeWithClaims({ graph: listedGraph(['a.csv', 'b.csv', 'c.csv']), nodeId: 's1', claims: [allClaim] })
  assert.equal(res.findings[0].verdict, 'match')
  assert.equal(res.findings[0].dimension, 'scope')
})

test('ALL scope: read-set missing a listed entry is a mismatch', () => {
  const res = auditNodeWithClaims({ graph: listedGraph(['a.csv', 'b.csv']), nodeId: 's1', claims: [allClaim] })
  assert.equal(res.findings[0].verdict, 'mismatch')
  assert.equal(res.findings[0].dimension, 'scope')
  assert.match(res.findings[0].actual, /missed c\.csv/)
})

test('ordinal guard: "table 4 / row 4" is an identifier, NOT a 4-table count → no false mismatch', () => {
  const claim: ExtractedClaim = {
    id: 'c1', sourceNodeId: 's1', text: 'I wonder if row 4 has a title in table 4.',
    quantities: [{ value: 4, unit: 'table' }], entities: ['table 4'], scope: null,
  }
  const res = auditNodeWithClaims({ graph: listedGraph(['a.csv']), nodeId: 's1', claims: [claim] })
  // The ordinal "table 4" must not be compared against read edges as "4 tables".
  assert.notEqual(res.findings[0].verdict, 'mismatch')
})

test('cardinal still works: "4 files" IS a count and is compared', () => {
  const claim: ExtractedClaim = {
    id: 'c1', sourceNodeId: 's1', text: 'I read 4 files.',
    quantities: [{ value: 4, unit: 'files' }], entities: [], scope: null,
  }
  const res = auditNodeWithClaims({ graph: listedGraph(['a.csv', 'b.csv', 'c.csv']), nodeId: 's1', claims: [claim] })
  // 3 reads vs claimed 4 → genuine scope mismatch (cardinal not suppressed).
  assert.equal(res.findings[0].verdict, 'mismatch')
  assert.equal(res.findings[0].dimension, 'scope')
})

test('excludeNodeIds (§3.2): a greyed tool drops out of scope, changing the verdict', () => {
  // step reads 3 files via `read`; claim "3 files" matches. Grey the read tool
  // → it leaves scope → the count can no longer be confirmed (unverifiable).
  const graph = listedGraph(['a.csv', 'b.csv', 'c.csv'])
  const claim: ExtractedClaim = { id: 'c1', sourceNodeId: 's1', text: 'I read 3 files.', quantities: [{ value: 3, unit: 'files' }], entities: [], scope: null }

  const before = auditNodeWithClaims({ graph, nodeId: 's1', claims: [claim] })
  assert.equal(before.findings[0].verdict, 'match')

  const after = auditNodeWithClaims({ graph, nodeId: 's1', claims: [claim], excludeNodeIds: ['analyze'] })
  assert.equal(after.findings[0].verdict, 'unverifiable')
})

test('excludeNodeIds (§3.2): never greys away the node under audit itself', () => {
  const graph = g(
    [n('s2', 'step', { traceId: 'T', stepIndex: 2 }), n('analyze', 'tool', { traceId: 'T', toolName: 'data-analyze', rawEvents: [ev('pipilot.tool.result', { mean: 4.2 })] })],
    [e('s2', 'analyze', 'invokes')],
  )
  const claim: ExtractedClaim = { id: 'c1', sourceNodeId: 's2', text: 'mean', quantities: [{ value: 4.2, unit: 'mean' }], entities: [], scope: null }
  // Excluding the audited node is a no-op (kept), so the result still computes.
  const res = auditNodeWithClaims({ graph, nodeId: 's2', claims: [claim], excludeNodeIds: ['s2'] })
  assert.equal(res.findings[0].verdict, 'match')
})

test('ALL scope: no listed inventory stays unverifiable', () => {
  const bare = g(
    [n('s1', 'step', { traceId: 'T', stepIndex: 1 }), n('analyze', 'tool', { traceId: 'T', toolName: 'data-analyze' })],
    [e('s1', 'analyze', 'invokes')],
  )
  const res = auditNodeWithClaims({ graph: bare, nodeId: 's1', claims: [allClaim] })
  assert.equal(res.findings[0].verdict, 'unverifiable')
})

test('action claim: a narrated operation matches when a causal tool action is recorded', () => {
  const graph = g(
    [
      n('s1', 'step', { traceId: 'T', stepIndex: 1 }),
      n('fetch', 'tool', { traceId: 'T', toolName: 'web-fetch' }),
    ],
    [e('s1', 'fetch', 'invokes')],
  )
  const claim: ExtractedClaim = {
    id: 'c1',
    sourceNodeId: 's1',
    text: 'I will fetch and inspect the PDF.',
    quantities: [],
    entities: ['PDF'],
    scope: null,
  }
  const res = auditNodeWithClaims({ graph, nodeId: 's1', claims: [claim] })
  assert.equal(res.findings[0].verdict, 'match')
  assert.equal(res.findings[0].dimension, 'action')
})

test('action claim: standalone extracted URLs are not auto-matched', () => {
  const graph = g(
    [
      n('s1', 'step', { traceId: 'T', stepIndex: 1 }),
      n('fetch', 'tool', { traceId: 'T', toolName: 'web-fetch' }),
    ],
    [e('s1', 'fetch', 'invokes')],
  )
  const claim: ExtractedClaim = {
    id: 'c1',
    sourceNodeId: 's1',
    text: 'https://example.com/report.pdf',
    quantities: [],
    entities: ['https://example.com/report.pdf'],
    scope: null,
  }
  const res = auditNodeWithClaims({ graph, nodeId: 's1', claims: [claim] })
  assert.equal(res.findings[0].verdict, 'unverifiable')
})

test('action claim: artifact claims fall back to the production tool chain', () => {
  const graph = g(
    [
      n('convert', 'tool', { traceId: 'T', toolName: 'convert-document' }),
      n('artifact:report', 'artifact', { path: 'report.md' }),
    ],
    [e('convert', 'artifact:report', 'writes')],
  )
  const claim: ExtractedClaim = {
    id: 'c1',
    sourceNodeId: 'artifact:report',
    text: 'I converted the PDF into report.md.',
    quantities: [],
    entities: [],
    scope: null,
  }
  const res = auditNodeWithClaims({ graph, nodeId: 'artifact:report', claims: [claim] })
  assert.equal(res.findings[0].verdict, 'match')
  assert.equal(res.findings[0].dimension, 'action')
})
