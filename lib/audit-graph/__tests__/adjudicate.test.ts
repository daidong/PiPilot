import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AuditGraph, EdgeRel, GraphEdge, GraphNode } from '../types.js'
import type { AdjudicationCandidate } from '../adjudicate.js'
import { adjudicateCandidate, adjudicateFlaggedNodes, selectAdjudicationCandidates } from '../adjudicate.js'

function candidate(reasoning: string): AdjudicationCandidate {
  return { nodeId: 'span:tool1', flags: ['repeated_intent'], reasoning, context: 'tool read flagged repeated_intent' }
}

test('adjudicateCandidate greys only on a verbatim rejection quote', async () => {
  const reasoning = 'That first read failed, let me ignore it and retry with the full path.'
  const d = await adjudicateCandidate(candidate(reasoning), async () =>
    JSON.stringify({ decision: 'abandoned', reason: 'agent retried', quotedReasoning: 'let me ignore it and retry' }))
  assert.equal(d.decision, 'abandoned')
  assert.equal(d.quotedReasoning, 'let me ignore it and retry')
})

test('adjudicateCandidate downgrades abandoned to used when the quote is not in the reasoning (safety bias)', async () => {
  const d = await adjudicateCandidate(candidate('The result looked fine, building on it.'), async () =>
    JSON.stringify({ decision: 'abandoned', reason: 'hallucinated', quotedReasoning: 'this is wrong' }))
  assert.equal(d.decision, 'used')
})

test('adjudicateCandidate keeps on unparseable output and on empty reasoning', async () => {
  assert.equal((await adjudicateCandidate(candidate('some reasoning'), async () => 'not json')).decision, 'used')
  assert.equal((await adjudicateCandidate(candidate('   '), async () => '{"decision":"abandoned"}')).decision, 'used')
})

test('selectAdjudicationCandidates includes a consumed error node, carrying the consuming step reasoning', () => {
  const n = (id: string, kind: GraphNode['kind'], extra: Partial<GraphNode> = {}): GraphNode => ({ id, kind, label: id, ...extra })
  const e = (s: string, t: string, rel: EdgeRel): GraphEdge => ({ source: s, target: t, rel })
  const graph: AuditGraph = {
    builtAt: 'x', source: 'x', counts: { nodes: 0, edges: 0, spans: 0, traces: 1, artifacts: 0 },
    nodes: [
      n('span:bash', 'tool', { traceId: 'T', toolName: 'bash', isError: true }),
      n('span:s3', 'step', { traceId: 'T', stepIndex: 3, rawEvents: [{ name: 'pipilot.chat.response_text', body: JSON.stringify('the bash command failed, so I computed it manually instead.') }] }),
    ],
    edges: [e('span:bash', 'span:s3', 'returns')],
  }
  const candidates = selectAdjudicationCandidates(graph, { flags: { 'span:bash': ['error'] }, prunedNodes: [] })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].nodeId, 'span:bash')
  assert.match(candidates[0].reasoning, /bash command failed/)
  assert.match(candidates[0].context, /errored/)
})

test('selectAdjudicationCandidates skips an error node already deterministically pruned', () => {
  const candidates = selectAdjudicationCandidates(
    { builtAt: 'x', source: 'x', counts: { nodes: 0, edges: 0, spans: 0, traces: 0, artifacts: 0 }, nodes: [], edges: [] },
    { flags: { 'span:bash': ['error'] }, prunedNodes: ['span:bash'] },
  )
  assert.equal(candidates.length, 0)
})

test('adjudicateFlaggedNodes returns greyed ids alongside every decision', async () => {
  const cands: AdjudicationCandidate[] = [
    { nodeId: 'a', flags: ['reread'], reasoning: 'discard the previous output, redoing', context: '' },
    { nodeId: 'b', flags: ['reread'], reasoning: 'looks good, keeping', context: '' },
  ]
  const out = await adjudicateFlaggedNodes({
    candidates: cands,
    callLlm: async (_s, user) => user.includes('discard the previous output')
      ? JSON.stringify({ decision: 'abandoned', reason: 'r', quotedReasoning: 'discard the previous output' })
      : JSON.stringify({ decision: 'used', reason: 'r', quotedReasoning: '' }),
  })
  assert.deepEqual(out.greyed, ['a'])
  assert.equal(out.decisions.length, 2)
})
