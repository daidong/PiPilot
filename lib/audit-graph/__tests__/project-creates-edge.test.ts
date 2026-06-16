/**
 * Creator attribution: a ledger row stamped with `toolCallId` joins straight to
 * the producing tool node, drawing a `creates` edge — even when the row has no
 * `spanId` (the common case for download tools whose write happens after the
 * tool span's context was lost). This is the generic, tool-agnostic source link
 * that makes downloaded artifacts (papers / web-content / data) stop being
 * sourceless in the provenance graph.
 *
 * Pure file-IO: a hand-authored tool span carrying `gen_ai.tool.call.id`, plus a
 * bare artifact ledger row carrying the matching `toolCallId`. No agent, no LLM.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectGraph } from '../project.js'
import { PATHS } from '../../types.js'

const HOME = process.env.HOME || '~'

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'pipilot-audit-creates-'))
}
function cleanup(p: string): void {
  try { rmSync(p, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 }) } catch { /* ignore */ }
}

function writeToolSpan(
  project: string,
  opts: { spanId: string; toolName: string; callId?: string; args?: Record<string, unknown> },
): void {
  const dir = join(project, PATHS.traces)
  mkdirSync(dir, { recursive: true })
  const attributes: Array<{ key: string; value: { stringValue: string } }> = [
    { key: 'gen_ai.tool.name', value: { stringValue: opts.toolName } },
    { key: 'gen_ai.conversation.id', value: { stringValue: 'sess-A' } },
  ]
  if (opts.callId) attributes.push({ key: 'gen_ai.tool.call.id', value: { stringValue: opts.callId } })
  const events = opts.args
    ? [{ name: 'pipilot.tool.args', attributes: [{ key: 'body', value: { stringValue: JSON.stringify(opts.args) } }] }]
    : []
  const span = {
    traceId: 't1', spanId: opts.spanId, name: `execute_tool ${opts.toolName}`,
    startTimeUnixNano: '1', endTimeUnixNano: '2',
    attributes,
    events,
  }
  // Append (one span per line) so multiple spans can coexist in a single test.
  appendFileSync(join(dir, 'spans.test.jsonl'), JSON.stringify({ scopeSpans: [{ spans: [span] }] }) + '\n', 'utf-8')
}

function writeLedgerRow(project: string, row: Record<string, unknown>): void {
  const file = join(project, PATHS.ledgerArtifact)
  mkdirSync(join(project, '.research-pilot/artifacts'), { recursive: true })
  writeFileSync(file, JSON.stringify(row) + '\n', 'utf-8')
}

function writeFileLedgerRow(project: string, row: Record<string, unknown>): void {
  const file = join(project, PATHS.ledgerFile)
  mkdirSync(join(project, '.research-pilot/files'), { recursive: true })
  writeFileSync(file, JSON.stringify(row) + '\n', 'utf-8')
}

test('projectGraph: ledger toolCallId joins a download to its tool (creates edge, no spanId needed)', async () => {
  const project = tmpProject()
  try {
    // A literature-search tool call; the paper write recorded only the toolCallId
    // (no spanId — the active span was lost before the write).
    writeToolSpan(project, { spanId: 's1', toolName: 'literature-search', callId: 'call-1' })
    writeLedgerRow(project, {
      artifactId: 'paper-1', version: 1, op: 'create', type: 'paper',
      path: 'papers/paper-1.md', contentHash: 'sha256:1', versionBefore: null,
      initiator: 'assistant', toolCallId: 'call-1', timestamp: '2026-01-01T00:00:00.000Z',
    })

    const graph = await projectGraph(project)
    const edge = graph.edges.find(e =>
      e.rel === 'creates' && e.source === 'span:s1' && e.target === 'artifact:paper-1')
    assert.ok(edge, 'a creates edge runs from the literature-search tool node to the paper artifact')
  } finally {
    cleanup(project)
  }
})

test('projectGraph: file-ledger toolCallId joins a downloaded file to its tool (writes edge)', async () => {
  const project = tmpProject()
  try {
    // fetch-fulltext downloaded a .tex; the file ledger recorded the producing
    // tool-call id. The file is read by nobody here — it must still appear with
    // an incoming `writes` edge from the tool (its recorded source).
    writeToolSpan(project, { spanId: 's1', toolName: 'fetch-fulltext', callId: 'call-f1' })
    const filePath = '/var/data/cache/arxiv2103/universe-1140473.tex'
    writeFileLedgerRow(project, {
      path: filePath, op: 'write', toolCallId: 'call-f1', tool: 'fetch-fulltext',
      contentHash: 'sha256:abc', timestamp: '2026-01-01T00:00:00.000Z',
    })

    const graph = await projectGraph(project)
    const fileId = `file:${filePath.replace(HOME, '~')}`
    const edge = graph.edges.find(e => e.rel === 'writes' && e.source === 'span:s1' && e.target === fileId)
    assert.ok(edge, 'a writes edge runs from the fetch-fulltext tool node to the downloaded file')
    assert.ok(graph.nodes.some(n => n.id === fileId && n.kind === 'file'), 'the file node was materialized')
  } finally {
    cleanup(project)
  }
})

test('projectGraph: an in-project ABSOLUTE ledger path joins the relative-path node read/grep made', async () => {
  const project = tmpProject()
  try {
    // convert_document produced Ascherio1997.md; the file ledger recorded the
    // ABSOLUTE path (older rows do this), while read referenced it by the
    // project-RELATIVE path. Both must resolve to ONE node, so the writes edge
    // (from the tool) and the reads edge (to read) share the same file — the
    // exact path-normalization bug this guards against.
    writeToolSpan(project, { spanId: 's1', toolName: 'convert_document', callId: 'call-c1' })
    writeToolSpan(project, { spanId: 's2', toolName: 'read', callId: 'call-r1', args: { path: 'Ascherio1997.md' } })
    writeFileLedgerRow(project, {
      path: join(project, 'Ascherio1997.md'), // ledger has the ABSOLUTE path
      op: 'write', toolCallId: 'call-c1', tool: 'convert_document',
      timestamp: '2026-01-01T00:00:00.000Z',
    })

    const graph = await projectGraph(project)
    const fileNodes = graph.nodes.filter(n => n.kind === 'file' && n.id.includes('Ascherio1997'))
    assert.equal(fileNodes.length, 1, 'exactly one Ascherio1997 file node (no absolute/relative split)')
    const fileId = fileNodes[0].id
    assert.equal(fileId, 'file:Ascherio1997.md', 'keyed by the relative path')
    assert.ok(graph.edges.some(e => e.rel === 'writes' && e.source === 'span:s1' && e.target === fileId),
      'convert_document writes the file')
    assert.ok(graph.edges.some(e => e.rel === 'reads' && e.source === fileId && e.target === 'span:s2'),
      'read reads the same file node')
  } finally {
    cleanup(project)
  }
})

test('projectGraph: an unmatched toolCallId draws no creates edge', async () => {
  const project = tmpProject()
  try {
    // Tool span exists but with a DIFFERENT call id; nothing should join.
    writeToolSpan(project, { spanId: 's1', toolName: 'literature-search', callId: 'call-OTHER' })
    writeLedgerRow(project, {
      artifactId: 'paper-1', version: 1, op: 'create', type: 'paper',
      path: 'papers/paper-1.md', contentHash: 'sha256:1', versionBefore: null,
      initiator: 'assistant', toolCallId: 'call-1', timestamp: '2026-01-01T00:00:00.000Z',
    })

    const graph = await projectGraph(project)
    const creates = graph.edges.filter(e => e.rel === 'creates' && e.target === 'artifact:paper-1')
    assert.equal(creates.length, 0, 'no creates edge when no tool node matches the toolCallId')
    // The artifact node itself still exists (materialized from the ledger row).
    assert.ok(graph.nodes.some(n => n.id === 'artifact:paper-1'), 'artifact node still present')
  } finally {
    cleanup(project)
  }
})
