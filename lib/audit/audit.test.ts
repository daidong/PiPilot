/**
 * Audit subsystem self-checking script.
 *
 * Covers the v0.8 RFC invariants that don't require an actual LLM call:
 *   - getAuditorModel() pairing rule (vendor-matched, mini not nano, sub == API)
 *   - audit-reports store: write-once, read, list, finding state
 *   - prosecutor system prompt structure (key clauses present)
 *   - scope summary truncation
 *   - tool registry: write/edit/artifact-create/artifact-update are NOT in
 *     the auditor's tool list (RFC §4.5)
 *
 * The end-to-end runAudit path requires a live model and is not exercised
 * here; a real auditor run is verified manually with ENABLE_PROVENANCE=1
 * and a project containing some captured graph events.
 *
 * Run with: npx tsx lib/audit/audit.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAuditorModel, MODEL_TIERS } from '../models.js'
import {
  newAuditId,
  writeAuditReport,
  readAuditReport,
  listAuditReports,
  setFindingResolution,
  readAuditState,
  auditPaths
} from './store.js'
import { buildAuditorSystemPrompt, buildScopeSummary } from './prompt.js'
import { createAuditorTools, type ReportSink } from './tools.js'
import { ProvenanceGraph } from '../provenance/index.js'
import type { AuditReport } from './types.js'
import { PATHS } from '../types.js'

const successes: string[] = []
async function runCase(name: string, fn: () => Promise<void> | void): Promise<void> {
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
  return mkdtempSync(join(tmpdir(), 'audit-test-'))
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

await runCase('getAuditorModel — Anthropic flagship → Sonnet (NOT Haiku)', () => {
  assert.equal(getAuditorModel('anthropic'), 'claude-sonnet-4-6')
  assert.equal(getAuditorModel('anthropic-sub'), 'claude-sonnet-4-6')
  // Sanity: this should NOT be the routing tier.
  assert.notEqual(getAuditorModel('anthropic'), MODEL_TIERS.anthropic.light)
})

await runCase('getAuditorModel — OpenAI flagship → mini (NOT nano)', () => {
  assert.equal(getAuditorModel('openai'), 'gpt-5.4-mini')
  assert.equal(getAuditorModel('openai-codex'), 'gpt-5.4-mini')
  // Sanity: openai's light tier IS nano; ensure auditor diverges.
  assert.equal(MODEL_TIERS.openai.light, 'gpt-5.4-nano')
  assert.notEqual(getAuditorModel('openai'), MODEL_TIERS.openai.light)
})

await runCase('getAuditorModel — sub mode uses identical model id (RFC §4.1)', () => {
  // Locked decision #3: subscription mode uses the same model ids as API mode.
  assert.equal(getAuditorModel('anthropic'), getAuditorModel('anthropic-sub'))
})

await runCase('audit-reports store — write-once + read round-trip', async () => {
  const project = makeProject()
  const id = newAuditId()
  assert.ok(id.startsWith('aud_'), 'audit id should start with aud_')

  const report: AuditReport = {
    id,
    createdAt: new Date().toISOString(),
    scope: { rootNodeIds: ['pn_x'] },
    model: 'anthropic:claude-sonnet-4-6',
    scopeNodeCount: 5,
    summary: 'Reviewed scope. Found 1 method issue.',
    findings: [{
      id: 'f_1',
      severity: 'major',
      category: 'method',
      claim: 'Wrong test used',
      evidence: 'The data is paired but a two-sample t-test was applied.',
      implicatedNodeIds: ['pn_x']
    }],
    durationMs: 12345
  }

  const file = await writeAuditReport(project, report)
  assert.ok(existsSync(file), 'report file should exist')

  // Write-once enforcement.
  await assert.rejects(() => writeAuditReport(project, report), /write-once/)

  // Read round-trip.
  const read = await readAuditReport(project, id)
  assert.ok(read, 'report should be readable')
  assert.equal(read!.id, id)
  assert.equal(read!.findings.length, 1)
  assert.equal(read!.findings[0]!.severity, 'major')

  // List.
  const all = await listAuditReports(project)
  assert.equal(all.length, 1)

  rmSync(project, { recursive: true, force: true })
})

await runCase('audit-reports store — finding state lives in sibling file (immutable report)', async () => {
  const project = makeProject()
  const id = newAuditId()
  await writeAuditReport(project, {
    id, createdAt: new Date().toISOString(),
    scope: { rootNodeIds: ['pn_y'] },
    model: 'anthropic:claude-sonnet-4-6',
    scopeNodeCount: 1, summary: 'x', findings: [], durationMs: 1
  })
  const reportFile = join(auditPaths(project).root, `${id}.json`)
  const originalBytes = readFileSync(reportFile, 'utf-8')

  await setFindingResolution(project, id, 'f_1', 'dismissed', 'spurious')
  const state = await readAuditState(project, id)
  assert.equal(state.findings.length, 1)
  assert.equal(state.findings[0]!.resolution, 'dismissed')
  assert.equal(state.findings[0]!.reason, 'spurious')

  // Original report file must NOT have been modified.
  const afterBytes = readFileSync(reportFile, 'utf-8')
  assert.equal(afterBytes, originalBytes, 'audit report file must remain immutable after state change')

  rmSync(project, { recursive: true, force: true })
})

await runCase('prosecutor system prompt — contains required clauses', () => {
  const prompt = buildAuditorSystemPrompt({
    projectPath: '/tmp/p',
    scope: { rootNodeIds: ['pn_x'] },
    scopeNodeCount: 3,
    scopeSummary: '- [pn_x] draft · paper.md · hash=abc123…'
  })
  // Anchor clauses from RFC §4.6 — losing any of these would weaken the
  // adversarial posture and should fail loudly.
  assert.match(prompt, /prosecutor/i, 'must establish prosecutor posture')
  assert.match(prompt, /independent verification|INDEPENDENT verification/i, 'must require independent verification')
  assert.match(prompt, /\bcritical\b.*invalidates/is, 'must define `critical` severity')
  assert.match(prompt, /implicatedNodeIds|node ids/i, 'must require implicated node ids')
  assert.match(prompt, /submit_audit_report/, 'must reference the submit tool')
  assert.match(prompt, /pn_x/, 'must inline the scope summary')
  // Submission-urgency anchors — without these, deep audits chronically
  // exhaust the turn budget and never submit.
  assert.match(prompt, /MUST call .submit_audit_report. exactly once/i, 'must require submission before session end')
  assert.match(prompt, /imperfect report.*beats no report/i, 'must permit/encourage submitting with uncertainty')
  // Tool-hygiene anchors — prevent the bash-cd exploration failure mode.
  assert.match(prompt, /bash.*stateless|stateless.*bash/i, 'must warn that bash is stateless')
  assert.match(prompt, /workspace-relative path/i, 'must instruct using read with workspace-relative paths')
})

await runCase('scope summary — truncates at MAX_NODES + MAX_CHARS', () => {
  const nodes = Array.from({ length: 200 }, (_, i) => ({
    id: `pn_${i}`,
    kind: 'workspace-file',
    label: `file_${i}.txt`
  }))
  const summary = buildScopeSummary(nodes)
  assert.match(summary, /more nodes/, 'should mention truncated count')
  assert.ok(summary.length < 12000, 'summary must stay bounded')
})

await runCase('auditor tools — read-only over project state (RFC §4.5)', () => {
  const project = makeProject()
  // Empty graph is fine for tool-registry inspection.
  const graph = new ProvenanceGraph()
  const sink: ReportSink = { report: null }
  const tools = createAuditorTools({ projectPath: project, graph, sink })
  const names = new Set(tools.map(t => t.name))

  // Required tools — base set + verification suite.
  const required = [
    'read', 'grep', 'find', 'ls', 'bash',
    'provenance_get_node', 'provenance_get_upstream', 'provenance_read_blob',
    'provenance_get_params', 'provenance_check_drift',
    'submit_audit_report'
  ]
  for (const r of required) {
    assert.ok(names.has(r), `auditor must have ${r}`)
  }

  // Forbidden tools — never grant write access to project state.
  for (const forbidden of ['write', 'edit', 'artifact-create', 'artifact-update', 'load_skill']) {
    assert.ok(!names.has(forbidden), `auditor MUST NOT have ${forbidden} (RFC §4.5)`)
  }

  rmSync(project, { recursive: true, force: true })
})

await runCase('provenance_check_drift — detects ok / drifted / missing / no-snapshot', async () => {
  const project = makeProject()
  // Build a tiny graph with three nodes covering all interesting cases.
  const graph = new ProvenanceGraph()
  // Node 1: workspace-file with snapshot, file matches → ok
  const okPath = 'data/raw.csv'
  mkdirSync(join(project, 'data'), { recursive: true })
  writeFileSync(join(project, okPath), 'a,b\n1,2\n', 'utf-8')
  const { sha256 } = await import('../provenance/store.js')
  const okHash = sha256(readFileSync(join(project, okPath)))
  graph.applyEvent({ type: 'node', node: {
    id: 'pn_ok', kind: 'workspace-file', ref: { kind: 'workspace-file', path: okPath },
    label: okPath, createdAt: new Date().toISOString(),
    snapshot: { contentHash: okHash, sizeBytes: 8, snapshotted: true, oversizeSkipped: false }
  } })
  // Node 2: workspace-file with snapshot, file changed → drifted
  const driftPath = 'data/changed.csv'
  writeFileSync(join(project, driftPath), 'a,b\n3,4\n', 'utf-8')
  graph.applyEvent({ type: 'node', node: {
    id: 'pn_drift', kind: 'workspace-file', ref: { kind: 'workspace-file', path: driftPath },
    label: driftPath, createdAt: new Date().toISOString(),
    snapshot: { contentHash: '0'.repeat(64), sizeBytes: 8, snapshotted: true, oversizeSkipped: false }
  } })
  // Node 3: workspace-file pointing to non-existent path → missing
  graph.applyEvent({ type: 'node', node: {
    id: 'pn_missing', kind: 'workspace-file', ref: { kind: 'workspace-file', path: 'data/nope.csv' },
    label: 'data/nope.csv', createdAt: new Date().toISOString(),
    snapshot: { contentHash: '1'.repeat(64), sizeBytes: 0, snapshotted: false, oversizeSkipped: false }
  } })
  // Node 4: computation → skipped
  graph.applyEvent({ type: 'node', node: {
    id: 'pn_comp', kind: 'computation', ref: { kind: 'computation', toolCallId: 'tc-x' },
    label: 'tc-x', createdAt: new Date().toISOString()
  } })

  const sink: ReportSink = { report: null }
  const tools = createAuditorTools({ projectPath: project, graph, sink })
  const drift = tools.find(t => t.name === 'provenance_check_drift')!

  const result = await drift.execute('tc', { nodeIds: ['pn_ok', 'pn_drift', 'pn_missing', 'pn_comp', 'pn_unknown'] })
  const text = (result.content[0] as { text: string }).text
  const payload = JSON.parse(text) as { summary: { ok: number; drifted: number; missing: number; skipped: number }; rows: Array<{ status: string }> }
  assert.equal(payload.summary.ok, 1)
  assert.equal(payload.summary.drifted, 1)
  assert.equal(payload.summary.missing, 1)
  // computation + unknown id both classify as skipped
  assert.equal(payload.summary.skipped, 2)
  rmSync(project, { recursive: true, force: true })
})

await runCase('provenance_get_params — reads params blob via ref or hash', async () => {
  const project = makeProject()
  const graph = new ProvenanceGraph()
  // Manually persist a params blob so the tool has something to fetch.
  const { provenancePaths, writeParams, sha256 } = await import('../provenance/store.js')
  const paths = provenancePaths(project)
  const written = await writeParams(project, 'tc-1', { url: 'https://example.com', mode: 'markdown' })

  const sink: ReportSink = { report: null }
  const tools = createAuditorTools({ projectPath: project, graph, sink })
  const get = tools.find(t => t.name === 'provenance_get_params')!

  // By ref
  const r1 = await get.execute('tc', { parametersRef: written.parametersRef })
  const text1 = (r1.content[0] as { text: string }).text
  const parsed = JSON.parse(text1)
  assert.equal(parsed.url, 'https://example.com')

  // By hash (fallback path)
  const r2 = await get.execute('tc', { parametersHash: written.parametersHash })
  const text2 = (r2.content[0] as { text: string }).text
  assert.match(text2, /example\.com/)

  // Missing
  const r3 = await get.execute('tc', { parametersHash: 'deadbeef' })
  assert.equal((r3.details as { ok: boolean }).ok, false)
  // Suppress lint about unused paths
  void paths; void sha256
  rmSync(project, { recursive: true, force: true })
})

await runCase('submit_audit_report — captures payload + signals terminate', async () => {
  const project = makeProject()
  const graph = new ProvenanceGraph()
  const sink: ReportSink = { report: null }
  const tools = createAuditorTools({ projectPath: project, graph, sink })
  const submit = tools.find(t => t.name === 'submit_audit_report')
  assert.ok(submit, 'submit tool must exist')

  const params = {
    summary: 'all clear',
    findings: [{
      severity: 'minor' as const,
      category: 'inconsistency' as const,
      claim: 'count off by one',
      evidence: 'said 23, computed 22',
      implicatedNodeIds: ['pn_a']
    }]
  }
  const result = await submit!.execute('tc', params)
  assert.equal(result.terminate, true, 'submit must signal terminate=true')
  assert.ok(sink.report, 'sink should have captured the report')
  assert.equal(sink.report!.findings.length, 1)
  assert.equal(sink.report!.findings[0]!.severity, 'minor')
  assert.ok(sink.report!.findings[0]!.id.startsWith('f_'), 'submit must assign finding ids')

  rmSync(project, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

for (const s of successes) console.log(s)
console.log(`\n${successes.length} passed.`)
