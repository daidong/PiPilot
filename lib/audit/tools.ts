/**
 * Auditor toolset — restricted, read-only over the project.
 *
 * RFC §4.5: the auditor gets read+grep+find+ls (workspace), bash (sandboxed
 * Python for verification), web_fetch (citation grounding), and provenance
 * graph navigation. It does NOT get artifact-create/update or skill loading.
 *
 * The `submit_audit_report` tool is the auditor's single output channel —
 * called exactly once with the final report.
 */

import { Type } from '@sinclair/typebox'
import {
  createReadOnlyTools,
  createBashTool
} from '@mariozechner/pi-coding-agent'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { ProvenanceGraph } from '../provenance/index.js'
import { createWebFetchTool } from '../tools/web-tools.js'
import type { ResearchToolContext } from '../tools/types.js'
import type { Finding, FindingCategory, Severity } from './types.js'

// ---------------------------------------------------------------------------
// Provenance navigation tools (custom AgentTools)
// ---------------------------------------------------------------------------

function createProvenanceGetNodeTool(graph: ProvenanceGraph): AgentTool {
  return {
    name: 'provenance_get_node',
    label: 'provenance_get_node',
    description: 'Look up a provenance node by its graph-local id (e.g. "pn_abc123…"). Returns the node\'s full metadata: kind, ref, label, snapshot (hash + size), drift, toolCall, agentTurn.',
    parameters: Type.Object({
      id: Type.String({ description: 'The graph-local node id, e.g. "pn_xxx".' })
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult<any>> => {
      const id = String((params as { id: string }).id ?? '')
      const node = graph.getNode(id)
      const text = node ? JSON.stringify(node, null, 2) : `Node not found: ${id}`
      return {
        content: [{ type: 'text', text }],
        details: { ok: !!node }
      }
    }
  }
}

function createProvenanceGetUpstreamTool(graph: ProvenanceGraph): AgentTool {
  return {
    name: 'provenance_get_upstream',
    label: 'provenance_get_upstream',
    description: 'Get the upstream cone (ancestors) of one or more provenance nodes. Returns nodes + edges. Use this to trace where a draft / artifact / claim came from.',
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { description: 'Root node ids whose upstream to walk.' }),
      maxDepth: Type.Optional(Type.Number({ description: 'Optional depth cap; omit for unbounded walk.' }))
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult<any>> => {
      const p = params as { ids: string[]; maxDepth?: number }
      const sub = graph.getUpstreamCone(p.ids ?? [], p.maxDepth)
      const summary = {
        nodeCount: sub.nodes.length,
        edgeCount: sub.edges.length,
        nodes: sub.nodes.map(n => ({
          id: n.id, kind: n.kind, label: n.label,
          producedBy: n.toolCall?.name,
          hash: n.snapshot?.contentHash?.slice(0, 12)
        })),
        edges: sub.edges.map(e => ({ from: e.from, to: e.to, role: e.role }))
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        details: { ok: true }
      }
    }
  }
}

function createProvenanceReadBlobTool(projectPath: string): AgentTool {
  return {
    name: 'provenance_read_blob',
    label: 'provenance_read_blob',
    description: 'Read a content-addressed snapshot (the bytes that existed at capture time) by its sha256 hash. Use this when a workspace file has drifted and you need the as-captured version.',
    parameters: Type.Object({
      contentHash: Type.String({ description: 'Full sha256 hex.' }),
      maxBytes: Type.Optional(Type.Number({ description: 'Truncate to N bytes (default 200000).' }))
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult<any>> => {
      const p = params as { contentHash: string; maxBytes?: number }
      const { readBlob } = await import('../provenance/index.js')
      const buf = await readBlob(projectPath, String(p.contentHash))
      if (!buf) {
        return {
          content: [{ type: 'text', text: `Blob not found for hash ${p.contentHash}` }],
          details: { ok: false }
        }
      }
      const max = p.maxBytes ?? 200_000
      const text = buf.length > max
        ? buf.subarray(0, max).toString('utf-8') + `\n\n…[truncated ${buf.length - max} bytes]`
        : buf.toString('utf-8')
      return {
        content: [{ type: 'text', text }],
        details: { ok: true, sizeBytes: buf.length }
      }
    }
  }
}

/**
 * Read the canonical params JSON that was stored when a tool call ran.
 * Indispensable for verification work — without this the auditor would have
 * to guess at `provenance/params/{toolCallId}.json` and use `read`.
 *
 * Accepts either a `parametersRef` (path-form, as printed on a node) or a
 * `parametersHash` (sha256 over canonical params). Path is preferred when
 * available because it doesn't require a hash → file lookup.
 */
function createProvenanceGetParamsTool(projectPath: string): AgentTool {
  return {
    name: 'provenance_get_params',
    label: 'provenance_get_params',
    description: 'Fetch the canonical params JSON that a tool call was invoked with. Pass either parametersRef (path) or parametersHash from a node. Use this to verify whether a computation ran with the expected arguments — far more direct than reading the params file by hand.',
    parameters: Type.Object({
      parametersRef:  Type.Optional(Type.String({ description: 'Relative path of the params blob (preferred). e.g. ".research-pilot/provenance/params/<toolCallId>.json"' })),
      parametersHash: Type.Optional(Type.String({ description: 'sha256 of the canonical params (fallback when ref is unknown).' }))
    }),
    execute: async (_toolCallId, p): Promise<AgentToolResult<unknown>> => {
      const args = p as { parametersRef?: string; parametersHash?: string }
      const { readFile } = await import('node:fs/promises')
      const { existsSync } = await import('node:fs')
      const { join, isAbsolute } = await import('node:path')

      let candidatePath: string | null = null
      if (args.parametersRef) {
        candidatePath = isAbsolute(args.parametersRef)
          ? args.parametersRef
          : join(projectPath, args.parametersRef)
      }
      // Fallback: scan params/ for a file whose canonical-hash matches.
      if (!candidatePath || !existsSync(candidatePath)) {
        if (args.parametersHash) {
          const { provenancePaths, sha256 } = await import('../provenance/store.js')
          const dir = provenancePaths(projectPath).params
          if (existsSync(dir)) {
            const { readdirSync } = await import('node:fs')
            for (const name of readdirSync(dir)) {
              const fp = join(dir, name)
              try {
                const raw = await readFile(fp, 'utf-8')
                if (sha256(raw) === args.parametersHash) { candidatePath = fp; break }
              } catch { /* skip */ }
            }
          }
        }
      }

      if (!candidatePath || !existsSync(candidatePath)) {
        return {
          content: [{ type: 'text', text: `Params not found (ref=${args.parametersRef ?? 'n/a'}, hash=${args.parametersHash ?? 'n/a'})` }],
          details: { ok: false }
        }
      }
      const raw = await readFile(candidatePath, 'utf-8')
      return {
        content: [{ type: 'text', text: raw }],
        details: { ok: true, path: candidatePath }
      }
    }
  }
}

/**
 * Mechanical drift check across a set of nodes. For each id:
 *   - workspace-file/draft: re-hash the file at ref.path and compare with
 *     snapshot.contentHash on the node
 *   - memory-artifact: re-hash the Memory V2 JSON file
 *   - audit-report: same idea (re-hash if exists)
 *   - computation: skipped (no content)
 *
 * Returns a structured rollup the auditor can cite verbatim. This is how
 * "did the data files we relied on change since the analysis?" gets a
 * mechanical answer instead of a vibe.
 */
function createProvenanceCheckDriftTool(projectPath: string, graph: ProvenanceGraph): AgentTool {
  return {
    name: 'provenance_check_drift',
    label: 'provenance_check_drift',
    description: 'For each provenance node id, verify that the live store still matches the captured content hash. Returns a structured report (ok / drifted / missing). Use this BEFORE reading content to know which inputs are still trustworthy. Pass node ids you got from provenance_get_upstream.',
    parameters: Type.Object({
      nodeIds: Type.Array(Type.String(), { description: 'Provenance node ids to check.' })
    }),
    execute: async (_toolCallId, p): Promise<AgentToolResult<unknown>> => {
      const ids = (p as { nodeIds: string[] }).nodeIds ?? []
      const { sha256, statWorkspaceFile } = await import('../provenance/store.js')
      const { readFile } = await import('node:fs/promises')
      const { existsSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { PATHS } = await import('../types.js')

      type Row =
        | { id: string; status: 'ok'; label: string; hash: string }
        | { id: string; status: 'drifted'; label: string; capturedHash: string; currentHash: string }
        | { id: string; status: 'missing'; label: string; capturedHash?: string }
        | { id: string; status: 'no-snapshot'; label: string }
        | { id: string; status: 'skipped'; label: string; reason: string }

      const rows: Row[] = []

      for (const id of ids) {
        const node = graph.getNode(id)
        if (!node) {
          rows.push({ id, status: 'skipped', label: '(unknown id)', reason: 'node not found' })
          continue
        }
        const label = node.label
        const captured = node.snapshot?.contentHash
        // Compute live hash by ref kind.
        let liveHash: string | null = null
        try {
          if (node.ref.kind === 'workspace-file' || node.ref.kind === 'draft') {
            const stat = await statWorkspaceFile(projectPath, node.ref.path)
            liveHash = stat?.contentHash ?? null
          } else if (node.ref.kind === 'memory-artifact') {
            const r = node.ref
            const sub = r.artifactType === 'paper' ? PATHS.papers
              : r.artifactType === 'data'        ? PATHS.data
              : r.artifactType === 'web-content' ? PATHS.webContent
              : r.artifactType === 'tool-output' ? PATHS.toolOutputs
              :                                    PATHS.notes
            const fp = join(projectPath, sub, `${r.artifactId}.json`)
            if (existsSync(fp)) liveHash = sha256(await readFile(fp, 'utf-8'))
          } else if (node.ref.kind === 'audit-report') {
            const fp = node.ref.path.startsWith('/') ? node.ref.path : join(projectPath, node.ref.path)
            if (existsSync(fp)) liveHash = sha256(await readFile(fp, 'utf-8'))
          } else if (node.ref.kind === 'computation') {
            rows.push({ id, status: 'skipped', label, reason: 'computation has no content' })
            continue
          }
        } catch (err) {
          rows.push({ id, status: 'skipped', label, reason: `read error: ${(err as Error).message}` })
          continue
        }

        if (!captured) { rows.push({ id, status: 'no-snapshot', label }); continue }
        if (liveHash === null) { rows.push({ id, status: 'missing', label, capturedHash: captured }); continue }
        if (liveHash === captured) rows.push({ id, status: 'ok', label, hash: captured })
        else rows.push({ id, status: 'drifted', label, capturedHash: captured, currentHash: liveHash })
      }

      const summary = {
        checked: rows.length,
        ok:          rows.filter(r => r.status === 'ok').length,
        drifted:     rows.filter(r => r.status === 'drifted').length,
        missing:     rows.filter(r => r.status === 'missing').length,
        noSnapshot:  rows.filter(r => r.status === 'no-snapshot').length,
        skipped:     rows.filter(r => r.status === 'skipped').length
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ summary, rows }, null, 2) }],
        details: { ...summary, success: true }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// submit_audit_report — the auditor's single output channel
// ---------------------------------------------------------------------------

/**
 * Captures the report into the provided sink. The auditor calls this exactly
 * once at the end. Returning `terminate: true` signals to the pi-mono runtime
 * that the auditor should stop after this batch.
 */
export interface ReportSink {
  /** Set to the report payload when the auditor calls submit. */
  report: SubmittedReport | null
  /** Per-finding events streamed during the run. */
  onFinding?: (f: Finding) => void
}

export interface SubmittedReport {
  summary: string
  findings: Finding[]
  warnings?: string[]
}

const SEVERITIES: Severity[] = ['critical', 'major', 'minor', 'info']
const CATEGORIES: FindingCategory[] = [
  'data-misuse', 'method', 'citation', 'overreach', 'inconsistency', 'reproducibility'
]

function createSubmitAuditReportTool(sink: ReportSink): AgentTool {
  return {
    name: 'submit_audit_report',
    label: 'submit_audit_report',
    description: 'Submit the final audit report. Call this EXACTLY ONCE when you have completed your review. The auditor session terminates after this call.',
    parameters: Type.Object({
      summary: Type.String({ description: 'One-paragraph executive summary.' }),
      findings: Type.Array(Type.Object({
        severity: Type.Union(SEVERITIES.map(s => Type.Literal(s))),
        category: Type.Union(CATEGORIES.map(c => Type.Literal(c))),
        claim: Type.String({ description: 'One-line claim of what is wrong.' }),
        evidence: Type.String({ description: 'Multi-paragraph evidence: quotes, hash refs, reasoning.' }),
        implicatedNodeIds: Type.Array(Type.String(), { description: 'Provenance node ids implicated by this finding.' }),
        suggestedAction: Type.Optional(Type.String())
      })),
      warnings: Type.Optional(Type.Array(Type.String(), { description: 'Non-fatal issues encountered during the run.' }))
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult<any>> => {
      const p = params as {
        summary: string
        findings: Array<Omit<Finding, 'id'>>
        warnings?: string[]
      }
      const findings: Finding[] = p.findings.map((f, i) => ({
        id: `f_${Date.now().toString(36)}_${i}`,
        ...f
      }))
      sink.report = { summary: p.summary, findings, warnings: p.warnings }
      for (const f of findings) sink.onFinding?.(f)
      return {
        content: [{ type: 'text', text: `Audit report submitted with ${findings.length} finding(s).` }],
        details: { ok: true },
        terminate: true
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public assembly
// ---------------------------------------------------------------------------

export interface AuditorToolsArgs {
  projectPath: string
  graph: ProvenanceGraph
  sink: ReportSink
  /** Optional research-tools context for web_fetch (citation grounding). */
  researchCtx?: ResearchToolContext
}

export function createAuditorTools(args: AuditorToolsArgs): AgentTool[] {
  const tools: AgentTool[] = []

  // Read-only workspace tools (read, grep, find, ls).
  for (const t of createReadOnlyTools(args.projectPath)) {
    tools.push(t as AgentTool)
  }

  // Bash for spot-check Python execution. Note: this is the same pi-coding-agent
  // bash tool the coordinator uses; the auditor can run code, but cannot modify
  // project artifacts because we do not register write/edit tools.
  tools.push(createBashTool(args.projectPath) as AgentTool)

  // Citation grounding via web_fetch (optional — only when researchCtx is provided).
  if (args.researchCtx) {
    tools.push(createWebFetchTool(args.researchCtx))
  }

  // Provenance navigation + verification.
  tools.push(createProvenanceGetNodeTool(args.graph))
  tools.push(createProvenanceGetUpstreamTool(args.graph))
  tools.push(createProvenanceReadBlobTool(args.projectPath))
  tools.push(createProvenanceGetParamsTool(args.projectPath))
  tools.push(createProvenanceCheckDriftTool(args.projectPath, args.graph))

  // Output channel.
  tools.push(createSubmitAuditReportTool(args.sink))

  return tools
}
