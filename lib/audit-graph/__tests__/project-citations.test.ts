/**
 * Integration smoke for A1 citation resolvability wiring in projectGraph.
 *
 * Exercises the real path end to end: a note written via createArtifact (so it
 * lands as an RFC-014 .md the indexer reads with full content + a ledger row),
 * plus a hand-authored fetch-fulltext span whose args event carries one of the
 * two cited DOIs. Asserts the artifact node reports total=2, resolved=1, and
 * the un-fetched DOI on the watchlist.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArtifact } from '../../memory-v2/store.js'
import { projectGraph } from '../project.js'
import { PATHS, type CLIContext } from '../../types.js'

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'pipilot-audit-cite-'))
}
function cleanup(p: string): void {
  try { rmSync(p, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 }) } catch { /* ignore */ }
}
// createArtifact writes the .md synchronously but the ledger append is
// fire-and-forget; poll until the row lands before building the graph.
async function waitForLedger(project: string): Promise<void> {
  const file = join(project, PATHS.ledgerArtifact)
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    if (existsSync(file) && readFileSync(file, 'utf-8').trim()) return
    await new Promise(r => setTimeout(r, 20))
  }
}
function writeFetchFulltextSpan(project: string, doi: string): void {
  const dir = join(project, PATHS.traces)
  mkdirSync(dir, { recursive: true })
  const span = {
    traceId: 't1', spanId: 's1', name: 'execute_tool fetch-fulltext',
    startTimeUnixNano: '1', endTimeUnixNano: '2',
    attributes: [
      { key: 'gen_ai.tool.name', value: { stringValue: 'fetch-fulltext' } },
      { key: 'gen_ai.conversation.id', value: { stringValue: 'sess-A' } },
    ],
    events: [
      { name: 'pipilot.tool.args', attributes: [{ key: 'body', value: { stringValue: JSON.stringify({ doi }) } }] },
    ],
  }
  writeFileSync(join(dir, 'spans.test.jsonl'), JSON.stringify({ scopeSpans: [{ spans: [span] }] }) + '\n', 'utf-8')
}

test('projectGraph: note artifact gets citation resolvability (retrieved vs fabricated)', async () => {
  const project = tmpProject()
  try {
    const { artifact } = createArtifact(
      {
        type: 'note',
        title: 'Findings',
        content: 'Grounded in 10.1000/real. Also claims 10.2000/fake without a source.',
        provenance: { source: 'agent' },
      },
      { sessionId: 'sess-A', projectPath: project, turnId: 'turn-1' } as CLIContext
    )
    await waitForLedger(project)
    // The agent actually fetched only the first DOI.
    writeFetchFulltextSpan(project, '10.1000/real')

    const graph = await projectGraph(project)
    const node = graph.nodes.find(n => n.kind === 'artifact' && n.artifactId === artifact.id)
    assert.ok(node, 'artifact node exists in the graph')
    assert.equal(node!.citationsTotal, 2)
    assert.equal(node!.citationsResolved, 1)
    assert.equal(node!.citationResolutionRate, 0.5)
    assert.deepEqual(node!.unresolvedCitations, ['doi:10.2000/fake'])
  } finally {
    cleanup(project)
  }
})

test('projectGraph: artifact with no citations reports rate null', async () => {
  const project = tmpProject()
  try {
    const { artifact } = createArtifact(
      { type: 'note', title: 'Plain', content: 'No references here at all.', provenance: { source: 'agent' } },
      { sessionId: 'sess-A', projectPath: project, turnId: 'turn-1' } as CLIContext
    )
    await waitForLedger(project)
    const graph = await projectGraph(project)
    const node = graph.nodes.find(n => n.kind === 'artifact' && n.artifactId === artifact.id)
    assert.ok(node, 'artifact node exists')
    assert.equal(node!.citationsTotal, 0)
    assert.equal(node!.citationResolutionRate, null)
    assert.equal('unresolvedCitations' in node!, false)
  } finally {
    cleanup(project)
  }
})
