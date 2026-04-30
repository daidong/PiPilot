/**
 * Provenance subsystem self-checking script.
 *
 * Covers the v0.8 RFC invariants without spinning up the desktop app:
 *   - tool-call hooks → graph events (nodes/edges/params)
 *   - find-or-create idempotence (same args + same content = no duplicate)
 *   - 10 MB snapshot cap (system-level; adapters cannot override)
 *   - automatic `derived-from` edge between versions of the same ref
 *   - bash/write/edit shape (computation node only for bash; +workspace-file for write/edit)
 *   - artifact-update produces a new memory-artifact node + derived-from edge
 *
 * Single-file self-checking script (matches the pattern in
 * lib/wiki/hash-isolation.test.ts). Run with:
 *
 *     npx tsx lib/provenance/provenance.test.ts
 *
 * Exits 0 on success, nonzero on failure.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CaptureContext } from './capture.js'
import { defaultAdapters } from './adapters/index.js'
import { ProvenanceGraph } from './graph.js'
import { provenancePaths, snapshotIfFits } from './store.js'
import { PATHS } from '../types.js'
import type { AgentTurnRecord } from './types.js'

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

const turn: AgentTurnRecord = { sessionId: 's1', turnIndex: 0, model: 'test:m' }
const successes: string[] = []

async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now()
  try {
    await fn()
    successes.push(`✓ ${name} (${Date.now() - start}ms)`)
  } catch (err) {
    console.error(`✗ ${name}`)
    console.error(err)
    process.exit(1)
  }
}

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), 'provenance-test-'))
}

/** Build an AgentToolResult-shaped object with stringified JSON in content[0].text. */
function jsonResult(payload: unknown): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: { success: true, tool_name: 'test' }
  }
}

/** Build a plain-text result (pi-coding-agent style: bash/write/edit). */
function textResult(text: string): unknown {
  return {
    content: [{ type: 'text', text }],
    details: undefined
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

await runCase('web_fetch — persisted page becomes a workspace-file node + blob', async () => {
  const project = makeProject()
  // Set up the persisted file the tool would have written.
  const relPath = 'web-content/abc.md'
  const abs = join(project, relPath)
  mkdirSync(join(project, 'web-content'), { recursive: true })
  writeFileSync(abs, '# Fetched\n\nhello world\n', 'utf-8')

  const ctx = await CaptureContext.load(project, defaultAdapters)
  await ctx.recordToolCall(
    'tc-1',
    { url: 'https://example.com', mode: 'markdown' },
    jsonResult({ url: 'https://example.com', status_code: 200, content_path: relPath, chars: 24 }),
    { name: 'web_fetch', turn, isError: false }
  )

  // Reload from disk to verify persistence.
  const fresh = await ProvenanceGraph.load(project)
  const wsNodes = fresh.findByKind('workspace-file')
  assert.equal(wsNodes.length, 1, 'expected exactly one workspace-file node')
  const node = wsNodes[0]!
  assert.equal(node.ref.kind, 'workspace-file')
  assert.ok(node.snapshot, 'output should have a snapshot record')
  assert.equal(node.snapshot!.snapshotted, true, 'small output should be blob-snapshotted')
  assert.equal(node.snapshot!.oversizeSkipped, false)
  assert.ok(node.toolCall, 'node.toolCall must be set on outputs')
  assert.equal(node.toolCall!.name, 'web_fetch')

  // Blob should exist.
  const blobPath = join(project, PATHS.provenanceBlobs, node.snapshot!.contentHash)
  assert.ok(existsSync(blobPath), 'blob file must exist')

  // Params persisted.
  const paramsPath = join(project, PATHS.provenanceParams, 'tc-1.json')
  assert.ok(existsSync(paramsPath), 'params blob must exist')
  const persistedParams = JSON.parse(readFileSync(paramsPath, 'utf-8'))
  assert.equal(persistedParams.url, 'https://example.com')

  rmSync(project, { recursive: true, force: true })
})

await runCase('errored tool calls are skipped', async () => {
  const project = makeProject()
  const ctx = await CaptureContext.load(project, defaultAdapters)

  await ctx.recordToolCall(
    'tc-err',
    { url: 'https://example.com' },
    jsonResult({ error: 'something' }),
    { name: 'web_fetch', turn, isError: true }
  )

  const fresh = await ProvenanceGraph.load(project)
  assert.equal(fresh.nodeCount(), 0, 'errored calls must not produce nodes')
  assert.equal(fresh.edgeCount(), 0, 'errored calls must not produce edges')
  rmSync(project, { recursive: true, force: true })
})

await runCase('find-or-create is fully idempotent on identical (ref, contentHash) outputs', async () => {
  const project = makeProject()
  const relPath = 'web-content/abc.md'
  mkdirSync(join(project, 'web-content'), { recursive: true })
  writeFileSync(join(project, relPath), 'same content\n', 'utf-8')

  const ctx = await CaptureContext.load(project, defaultAdapters)
  // First call.
  await ctx.recordToolCall('tc-A', { url: 'https://x' }, jsonResult({ content_path: relPath }), { name: 'web_fetch', turn, isError: false })
  const afterFirst = ctx.graph.nodeCount()

  // Second call against the same file (unchanged content). With output dedup
  // by (ref, contentHash), this should NOT create a duplicate workspace-file
  // version. web_fetch adapter has no computation output, so no new nodes
  // are produced at all — full idempotence on a no-op re-fetch.
  await ctx.recordToolCall('tc-B', { url: 'https://x' }, jsonResult({ content_path: relPath }), { name: 'web_fetch', turn, isError: false })
  const afterSecond = ctx.graph.nodeCount()

  assert.equal(afterSecond, afterFirst, 'identical re-emission must not grow the node count')

  // Exactly one workspace-file version for the path.
  const wsNodes = ctx.graph.findByKind('workspace-file')
  const ours = wsNodes.filter(n => n.ref.kind === 'workspace-file' && n.ref.path === relPath)
  assert.equal(ours.length, 1, 'identical content must collapse to a single version')

  // No spurious derived-from edges either.
  const derivedFromEdges = wsNodes.flatMap(n => ctx.graph.getIncoming(n.id)).filter(e => e.role === 'derived-from')
  assert.equal(derivedFromEdges.length, 0, 'identical content must not produce derived-from edges')

  rmSync(project, { recursive: true, force: true })
})

await runCase('write produces computation + workspace-file; second write same path → derived-from', async () => {
  const project = makeProject()
  const relPath = 'src/foo.ts'
  mkdirSync(join(project, 'src'), { recursive: true })

  // First write: content v1.
  writeFileSync(join(project, relPath), 'export const x = 1\n', 'utf-8')
  const ctx = await CaptureContext.load(project, defaultAdapters)
  await ctx.recordToolCall(
    'tc-w1',
    { path: relPath, content: 'export const x = 1\n' },
    textResult(`Successfully wrote 20 bytes to ${relPath}`),
    { name: 'write', turn, isError: false }
  )

  // Second write: content v2 (same path).
  writeFileSync(join(project, relPath), 'export const x = 2\n', 'utf-8')
  await ctx.recordToolCall(
    'tc-w2',
    { path: relPath, content: 'export const x = 2\n' },
    textResult(`Successfully wrote 20 bytes to ${relPath}`),
    { name: 'write', turn, isError: false }
  )

  const compNodes = ctx.graph.findByKind('computation')
  const wsNodes = ctx.graph.findByKind('workspace-file')
  assert.equal(compNodes.length, 2, 'expected two computation nodes (one per write call)')
  assert.equal(wsNodes.length, 2, 'expected two workspace-file versions of the same path')

  // The newer workspace-file should have a derived-from edge from the older one.
  const sorted = wsNodes.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const newerIncoming = ctx.graph.getIncoming(sorted[1]!.id)
  assert.ok(newerIncoming.some(e => e.role === 'derived-from' && e.from === sorted[0]!.id),
    'newer workspace-file must have derived-from edge to older version')

  rmSync(project, { recursive: true, force: true })
})

await runCase('bash captures computation only — no workspace-file inferred', async () => {
  const project = makeProject()
  const ctx = await CaptureContext.load(project, defaultAdapters)
  await ctx.recordToolCall(
    'tc-bash',
    { command: 'python script.py > out.csv' },
    textResult('(stdout)'),
    { name: 'bash', turn, isError: false }
  )

  assert.equal(ctx.graph.findByKind('computation').length, 1)
  assert.equal(ctx.graph.findByKind('workspace-file').length, 0,
    'bash must not infer side-effect files')
  rmSync(project, { recursive: true, force: true })
})

await runCase('artifact-update creates new memory-artifact node + derived-from to prior', async () => {
  const project = makeProject()
  // Set up a Memory V2-style artifact file.
  const artId = 'art-1'
  const dir = join(project, PATHS.notes)
  mkdirSync(dir, { recursive: true })

  // Create.
  writeFileSync(join(dir, `${artId}.json`), JSON.stringify({ id: artId, type: 'note', title: 'v1', content: 'first' }), 'utf-8')
  const ctx = await CaptureContext.load(project, defaultAdapters)
  await ctx.recordToolCall(
    'tc-c',
    { type: 'note', title: 'v1', content: 'first' },
    jsonResult({ id: artId, type: 'note', title: 'v1', filePath: `${PATHS.notes}/${artId}.json` }),
    { name: 'artifact-create', turn, isError: false }
  )

  // Update with new content (rewrite the file to simulate Memory V2 update).
  writeFileSync(join(dir, `${artId}.json`), JSON.stringify({ id: artId, type: 'note', title: 'v2', content: 'second' }), 'utf-8')
  await ctx.recordToolCall(
    'tc-u',
    { id: artId, content: 'second' },
    jsonResult({ id: artId, type: 'note', title: 'v2', filePath: `${PATHS.notes}/${artId}.json` }),
    { name: 'artifact-update', turn, isError: false }
  )

  const memNodes = ctx.graph.findByKind('memory-artifact')
  assert.equal(memNodes.length, 2, 'expected two memory-artifact versions (create + update)')
  const sorted = memNodes.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const newerIncoming = ctx.graph.getIncoming(sorted[1]!.id)
  assert.ok(newerIncoming.some(e => e.role === 'derived-from' && e.from === sorted[0]!.id),
    'updated artifact must have derived-from edge to prior version')

  rmSync(project, { recursive: true, force: true })
})

await runCase('10 MB cap is enforced at system level — adapters cannot override', async () => {
  const project = makeProject()
  // Force the cap by feeding 11 MB to snapshotIfFits directly.
  const big = Buffer.alloc(11 * 1024 * 1024, 0x42)
  const rec = await snapshotIfFits(project, big)
  assert.equal(rec.snapshotted, false, 'oversize content must NOT be blob-stored')
  assert.equal(rec.oversizeSkipped, true)
  assert.ok(rec.contentHash.length === 64, 'hash must still be computed for drift detection')
  // No blob written.
  const blobPath = join(provenancePaths(project).blobs, rec.contentHash)
  assert.equal(existsSync(blobPath), false, 'oversize blob must not exist')

  // 5 MB should fit.
  const small = Buffer.alloc(5 * 1024 * 1024, 0x55)
  const recSmall = await snapshotIfFits(project, small)
  assert.equal(recSmall.snapshotted, true, 'within-cap content must be blob-stored')
  assert.equal(recSmall.oversizeSkipped, false)
  assert.ok(existsSync(join(provenancePaths(project).blobs, recSmall.contentHash)),
    'within-cap blob must exist')

  rmSync(project, { recursive: true, force: true })
})

await runCase('orphan workspace-file detection works end-to-end', async () => {
  const project = makeProject()
  // Manually write an "input" file (simulating bash-produced output).
  const datasetPath = 'data/processed.csv'
  mkdirSync(join(project, 'data'), { recursive: true })
  writeFileSync(join(project, datasetPath), 'a,b,c\n1,2,3\n', 'utf-8')

  // Now data_analyze consumes it (treating it as input).
  const ctx = await CaptureContext.load(project, defaultAdapters)
  // First, simulate that bash ran (computation only — no workspace-file inferred).
  await ctx.recordToolCall(
    'tc-bash-x', { command: 'python make_csv.py' }, textResult('(ok)'),
    { name: 'bash', turn, isError: false }
  )
  // Then data_analyze consumes the dataset.
  await ctx.recordToolCall(
    'tc-da',
    { file_path: datasetPath, instructions: 'summarize', task_type: 'analyze' },
    jsonResult({ runId: 'r-1', scriptPath: 'analysis/r-1/script.py', outputs: [], stdout: '' }),
    { name: 'data_analyze', turn, isError: false }
  )

  const orphans = ctx.graph.findOrphanWorkspaceFiles()
  const orphanPaths = orphans.map(n => n.ref.kind === 'workspace-file' ? n.ref.path : '').filter(Boolean)
  // The bash-side-effect dataset IS an orphan (no tracked producer).
  assert.ok(orphanPaths.includes(datasetPath),
    `expected ${datasetPath} to be flagged as orphan; got: ${orphanPaths.join(', ')}`)
  // The analysis script produced by data_analyze is NOT an orphan — the
  // computation node has a `derived-from` edge to it (added in capture.ts
  // for any non-computation output produced alongside a computation node).
  assert.ok(!orphanPaths.includes('analysis/r-1/script.py'),
    `script.py must NOT be orphan once data_analyze wires computation → output edges; got orphans: ${orphanPaths.join(', ')}`)

  rmSync(project, { recursive: true, force: true })
})

await runCase('draft drift hook — no-op when no draft node exists yet', async () => {
  const { recordDraftDrift } = await import('./draft.js')
  const project = makeProject()
  // Save a markdown file with no provenance graph yet.
  const draftPath = 'paper/draft.md'
  mkdirSync(join(project, 'paper'), { recursive: true })
  writeFileSync(join(project, draftPath), 'first version\n', 'utf-8')

  const result = await recordDraftDrift(project, draftPath)
  assert.equal(result, 'no-node', 'expected no-node when no draft node exists yet')

  // No graph events should have been written.
  const fresh = await ProvenanceGraph.load(project)
  assert.equal(fresh.nodeCount(), 0)
  assert.equal(fresh.edgeCount(), 0)
  rmSync(project, { recursive: true, force: true })
})

await runCase('draft drift hook — records drift on existing draft node when content changes', async () => {
  const { recordDraftDrift } = await import('./draft.js')
  const { appendEvent } = await import('./store.js')
  const project = makeProject()
  const draftPath = 'paper/draft.md'
  mkdirSync(join(project, 'paper'), { recursive: true })
  writeFileSync(join(project, draftPath), 'v1 content\n', 'utf-8')

  // Manually seed a draft node (simulating what the audit runner will do in Phase 2).
  await appendEvent(project, {
    type: 'node',
    node: {
      id: 'pn_seed',
      kind: 'draft',
      ref: { kind: 'draft', path: draftPath },
      label: draftPath,
      createdAt: new Date().toISOString(),
      snapshot: {
        contentHash: '0000000000000000000000000000000000000000000000000000000000000000',
        sizeBytes: 11,
        snapshotted: false,
        oversizeSkipped: false
      }
    }
  })

  // Now save changes the file. Drift should be recorded.
  writeFileSync(join(project, draftPath), 'v2 content\n', 'utf-8')
  const result = await recordDraftDrift(project, draftPath)
  assert.equal(result, 'drift', 'expected drift to be recorded')

  // Reload and assert drift on the seeded node.
  const fresh = await ProvenanceGraph.load(project)
  const node = fresh.getNode('pn_seed')
  assert.ok(node?.drift, 'drift record should be present')
  assert.ok(node!.drift!.observedAt.startsWith('20'), 'observedAt should be ISO timestamp')
  rmSync(project, { recursive: true, force: true })
})

await runCase('write same content twice — dedupes the workspace-file version (no phantom no-op version)', async () => {
  const project = makeProject()
  const relPath = 'paper/draft.md'
  mkdirSync(join(project, 'paper'), { recursive: true })
  // Both writes produce identical content.
  writeFileSync(join(project, relPath), 'same content\n', 'utf-8')

  const ctx = await CaptureContext.load(project, defaultAdapters)
  await ctx.recordToolCall(
    'tc-1',
    { path: relPath, content: 'same content\n' },
    textResult(`Successfully wrote 13 bytes to ${relPath}`),
    { name: 'write', turn, isError: false }
  )
  // Re-write same content. File on disk hasn't changed.
  await ctx.recordToolCall(
    'tc-2',
    { path: relPath, content: 'same content\n' },
    textResult(`Successfully wrote 13 bytes to ${relPath}`),
    { name: 'write', turn, isError: false }
  )

  // Two write calls → two computation nodes (tool call still recorded).
  const computations = ctx.graph.findByKind('computation')
  assert.equal(computations.length, 2, 'each write tool call gets its own computation node')

  // But: only ONE workspace-file version (deduped by content hash).
  const wsNodes = ctx.graph.findByKind('workspace-file')
  const drafts = wsNodes.filter(n => n.ref.kind === 'workspace-file' && n.ref.path === relPath)
  assert.equal(drafts.length, 1, 'identical-content writes must NOT produce a phantom version')

  // The reused workspace-file should have lastSeenAt updated by the second call.
  assert.ok(drafts[0]!.lastSeenAt, 'reused output should have lastSeenAt set after second write')

  rmSync(project, { recursive: true, force: true })
})

await runCase('@-mention turn context — adds cited edges from mentioned artifacts to outputs', async () => {
  const project = makeProject()
  // Set up two memory-artifact files so they exist when capture reads.
  const dir = join(project, PATHS.notes)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mentioned.json'), JSON.stringify({ id: 'mentioned', type: 'note', title: 'M', content: 'm' }), 'utf-8')

  // Set up workspace file for the write target.
  mkdirSync(join(project, 'src'), { recursive: true })
  writeFileSync(join(project, 'src/foo.ts'), 'export const x = 1\n', 'utf-8')

  const ctx = await CaptureContext.load(project, defaultAdapters)
  const cited = [{ kind: 'memory-artifact', artifactType: 'note', artifactId: 'mentioned' } as const]

  await ctx.recordToolCall(
    'tc-mw',
    { path: 'src/foo.ts', content: 'export const x = 1\n' },
    textResult(`Successfully wrote 20 bytes to src/foo.ts`),
    { name: 'write', turn, isError: false, citedFromTurn: cited }
  )

  // The write produced workspace-file foo.ts; cited edge should run from
  // mentioned note → foo.ts.
  const wsNodes = ctx.graph.findByKind('workspace-file')
  const fooNode = wsNodes.find(n => n.ref.kind === 'workspace-file' && n.ref.path === 'src/foo.ts')
  assert.ok(fooNode, 'foo.ts node should exist')
  const incoming = ctx.graph.getIncoming(fooNode!.id)
  const citedEdge = incoming.find(e => e.role === 'cited-by')
  assert.ok(citedEdge, 'expected a cited-by edge to the foo.ts output')

  const fromNode = ctx.graph.getNode(citedEdge!.from)
  assert.equal(fromNode?.kind, 'memory-artifact')
  assert.ok(fromNode?.ref.kind === 'memory-artifact' && fromNode.ref.artifactId === 'mentioned',
    'cited-by edge should originate from the mentioned memory-artifact')

  rmSync(project, { recursive: true, force: true })
})

await runCase('draft drift hook — no-change when content matches latest snapshot', async () => {
  const { recordDraftDrift } = await import('./draft.js')
  const { appendEvent, sha256 } = await import('./store.js')
  const project = makeProject()
  const draftPath = 'paper/draft.md'
  mkdirSync(join(project, 'paper'), { recursive: true })
  const content = 'unchanging\n'
  writeFileSync(join(project, draftPath), content, 'utf-8')
  const hash = sha256(content)

  await appendEvent(project, {
    type: 'node',
    node: {
      id: 'pn_match',
      kind: 'draft',
      ref: { kind: 'draft', path: draftPath },
      label: draftPath,
      createdAt: new Date().toISOString(),
      snapshot: { contentHash: hash, sizeBytes: content.length, snapshotted: true, oversizeSkipped: false }
    }
  })

  const result = await recordDraftDrift(project, draftPath)
  assert.equal(result, 'no-change', 'matching content should produce no-change')
  rmSync(project, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

for (const s of successes) console.log(s)
console.log(`\n${successes.length} passed.`)
