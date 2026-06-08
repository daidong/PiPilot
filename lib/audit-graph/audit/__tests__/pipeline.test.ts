import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AuditGraph, GraphEdge, GraphNode } from '../../types.js'
import type { EvidencePacket } from '../types.js'
import { extractClaims } from '../claims.js'
import { buildEvidencePacket } from '../packet.js'
import { runAuditPipeline } from '../run.js'
import { collectAuditImages, judgeClaim, validateJudgeOutput } from '../judge.js'

function n(id: string, kind: GraphNode['kind'], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind, label: id, ...extra }
}

function e(source: string, target: string, rel: GraphEdge['rel']): GraphEdge {
  return { source, target, rel }
}

function graph(): AuditGraph {
  return {
    builtAt: 'now',
    source: 'test',
    counts: { nodes: 0, edges: 0, spans: 0, traces: 1, artifacts: 1 },
    nodes: [
      n('span:step-1', 'step', {
        traceId: 'trace-1',
        stepIndex: 1,
        rawEvents: [{ name: 'pipilot.chat.response_text', body: JSON.stringify([{ type: 'text', text: 'Updated results.csv with mean 4.2.' }]) }],
      }),
      n('span:tool-read', 'tool', {
        traceId: 'trace-1',
        toolName: 'read',
        rawEvents: [{ name: 'pipilot.tool.result', body: JSON.stringify({ content: [{ text: 'source rows n=10' }] }) }],
      }),
      n('span:tool-write', 'tool', {
        traceId: 'trace-1',
        toolName: 'write',
        rawEvents: [{ name: 'pipilot.tool.result', body: JSON.stringify({ content: [{ text: 'wrote results.csv with mean 4.2' }] }) }],
      }),
      n('file:data.csv', 'file', { path: 'data.csv', label: 'data.csv' }),
      n('file:results.csv', 'file', { path: 'results.csv', label: 'results.csv' }),
    ],
    edges: [
      e('file:data.csv', 'span:tool-read', 'reads'),
      e('span:tool-read', 'span:step-1', 'returns'),
      e('span:step-1', 'span:tool-write', 'invokes'),
      e('span:tool-write', 'span:step-1', 'returns'),
      e('span:tool-write', 'file:results.csv', 'writes'),
    ],
  }
}

test('extractClaims anchors a citation claim by author surname to the author-named file', () => {
  const g: AuditGraph = {
    builtAt: 'now',
    source: 'test',
    counts: { nodes: 0, edges: 0, spans: 0, traces: 1, artifacts: 0 },
    nodes: [
      n('file:/tmp/mereghetti_fig.png', 'file', { path: '/tmp/mereghetti_fig.png', label: 'tmp/mereghetti_fig.png' }),
      n('file:mereghetti2020.md', 'file', { path: '.research-pilot/cache/converted/mereghetti2020.md', label: 'converted/mereghetti2020.md' }),
    ],
    edges: [],
  }
  const claims = extractClaims(
    'Mereghetti et al. (ApJL 898, L29, July 2020), Figure 1 of burst-G: spans ~ 0.2-1.0 s.',
    g,
  )

  assert.ok(claims[0].anchors.length > 0, 'expected the author surname to anchor the claim')
  assert.ok(claims[0].anchors.some(a => a.nodeId.includes('mereghetti')))
})

test('extractClaims anchors any claim naming a graph node and leaves prose unanchored', () => {
  const g = graph()
  const claims = extractClaims(
    '- Updated results.csv with mean 4.2.\n- This is probably useful.',
    g,
    { productNodes: new Set(['file:results.csv']), inputNodes: new Set(['file:data.csv']) },
  )

  assert.deepEqual(claims[0].anchors.map(a => a.nodeId), ['file:results.csv'])
  assert.equal(claims[0].anchors[0].side, 'product')
  assert.equal(claims[1].anchors.length, 0)
})

test('buildEvidencePacket starts at claim anchors and includes local producer evidence', () => {
  const g = graph()
  const claim = extractClaims('Updated results.csv.', g, { productNodes: new Set(['file:results.csv']) })[0]
  const packet = buildEvidencePacket(claim, g)

  assert.ok(packet.nodes.some(node => node.id === 'file:results.csv'))
  assert.ok(packet.nodes.some(node => node.id === 'span:tool-write'))
  assert.ok(packet.edges.some(edge => edge.rel === 'writes'))
})

test('validateJudgeOutput rejects invented evidence ids and downgrades unsupported support', () => {
  const g = graph()
  const claim = extractClaims('Updated results.csv.', g, { productNodes: new Set(['file:results.csv']) })[0]
  const packet = buildEvidencePacket(claim, g)

  const invented = validateJudgeOutput(claim, packet, {
    verdict: 'supported',
    usedEvidenceIds: ['not-in-packet'],
    groundedInSession: true,
    explanation: 'bad',
  })
  assert.equal(invented.valid, false)

  const noEvidence = validateJudgeOutput(claim, packet, {
    verdict: 'supported',
    usedEvidenceIds: [],
    groundedInSession: true,
    explanation: 'bad',
  })
  assert.equal(noEvidence.verdict, 'ungrounded')
})

test('judgeClaim skips the LLM for a claim with no graph anchor', async () => {
  const g = graph()
  const claim = extractClaims('This is probably useful.', g, { productNodes: new Set(['file:results.csv']) })[0]
  const packet = buildEvidencePacket(claim, g)
  let calls = 0
  const verdict = await judgeClaim(claim, packet, { callLlm: async () => { calls++; return '{}' } })

  assert.equal(calls, 0)
  assert.equal(verdict.verdict, 'not_checkable')
  assert.equal(verdict.valid, true)
})

test('judgeClaim still judges an anchored interpretive claim', async () => {
  const g = graph()
  const claim = extractClaims('results.csv looks promising.', g, { productNodes: new Set(['file:results.csv']) })[0]
  assert.ok(claim.anchors.length > 0)
  const packet = buildEvidencePacket(claim, g)
  let calls = 0
  const verdict = await judgeClaim(claim, packet, {
    callLlm: async () => {
      calls++
      return JSON.stringify({
        verdict: 'not_checkable',
        claimType: 'synthesis',
        usedEvidenceIds: [],
        groundedInSession: false,
        explanation: 'subjective',
      })
    },
  })

  assert.equal(calls, 1)
  assert.equal(verdict.claimType, 'synthesis')
})

test('collectAuditImages reads figure bytes from a file-node path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipilot-audit-img-'))
  try {
    const imgPath = join(dir, 'fig.png')
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
      'hex',
    )
    writeFileSync(imgPath, png)
    const packet: EvidencePacket = {
      claimId: 'c1',
      nodes: [{ id: 'file:fig', kind: 'file', label: 'fig.png', excerpt: '', truncated: false, path: imgPath }],
      edges: [],
      expandable: [],
    }
    const images = await collectAuditImages(packet, dir)
    assert.equal(images.length, 1)
    assert.equal(images[0].mimeType, 'image/png')
    assert.ok(images[0].data.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runAuditPipeline writes isolated audit report under .research-pilot/audit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipilot-audit-pipeline-'))
  try {
    const result = await runAuditPipeline({
      projectPath: dir,
      graph: graph(),
      persist: true,
      callLlm: async () => JSON.stringify({
        verdict: 'supported',
        usedEvidenceIds: ['file:results.csv'],
        groundedInSession: true,
        explanation: 'product exists',
      }),
    })

    assert.equal(result.report.coverage.supported, 1)
    assert.ok(result.logPath?.includes('.research-pilot/audit/'))
    assert.ok(existsSync(result.logPath!))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
