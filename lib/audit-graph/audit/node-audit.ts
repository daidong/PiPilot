import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from '../../types.js'
import type { AuditGraph, GraphEdge, GraphNode } from '../types.js'
import { buildGraphIndex } from '../graph-utils.js'
import { extractResponseTextFromStep } from './claims.js'
import { extractClaimsLlm } from './extract-claims.js'
import { distillForExtraction } from './content.js'
import { auditNodeWithClaims, extractResultText, isAuditableNodeKind } from './faithfulness.js'
import type { AuditCallLlm } from './judge.js'
import type { ExtractedClaim, NodeAuditResult, TraceAuditSummary } from './types.js'

const NODE_AUDIT_CACHE_VERSION = 2

// The step that consumed a tool's result (`returns` tool → step). Its reasoning
// is where the narrative *about* the tool lives — a tool makes no claims of its
// own (§5.1: "compare the consuming step's claim about this tool").
function consumingStep(node: GraphNode, graph: AuditGraph): GraphNode | undefined {
  if (node.kind !== 'tool') return undefined
  const { nodeById, outgoing } = buildGraphIndex(graph)
  for (const e of outgoing.get(node.id) ?? []) {
    if (e.rel !== 'returns') continue
    const step = nodeById.get(e.target)
    if (step?.kind === 'step') return step
  }
  return undefined
}

// Resolve the natural-language output of a node for claim extraction (§5.1):
// step/chat → the LLM's response_text; tool → the CONSUMING step's reasoning
// (the narrative about the tool), falling back to its own result; artifact →
// content supplied by the caller (read from disk, the graph doesn't carry it).
export function nodeOutputText(node: GraphNode, opts: { artifactText?: string; graph?: AuditGraph } = {}): string {
  switch (node.kind) {
    case 'step':
    case 'chat':
      return extractResponseTextFromStep(node)
    case 'tool': {
      const step = opts.graph ? consumingStep(node, opts.graph) : undefined
      const stepText = step ? extractResponseTextFromStep(step) : ''
      return stepText || extractResultText(node)
    }
    case 'artifact':
      return opts.artifactText ?? ''
    default:
      return ''
  }
}

function rawEventBody(node: GraphNode, name: string): string {
  return node.rawEvents?.find(e => e.name === name)?.body ?? ''
}

// Async extractor-input resolver: like nodeOutputText, but resolves spilled
// blobs to their real bytes, distills verbose tool results, and drops gibberish
// (binary/mojibake) — so large reasoning steps become auditable, search/result
// noise is trimmed to its key fields, and a PDF-read-as-text never reaches the
// LLM. Returns '' when there is nothing auditable.
async function resolveExtractionText(node: GraphNode, opts: { projectPath: string; graph: AuditGraph; artifactText?: string }): Promise<string> {
  let raw = ''
  if (node.kind === 'step' || node.kind === 'chat') {
    raw = rawEventBody(node, 'pipilot.chat.response_text')
  } else if (node.kind === 'tool') {
    const step = consumingStep(node, opts.graph)
    raw = (step ? rawEventBody(step, 'pipilot.chat.response_text') : '') || rawEventBody(node, 'pipilot.tool.result')
  } else if (node.kind === 'artifact') {
    raw = opts.artifactText ?? ''
  }
  return distillForExtraction(raw, opts.projectPath)
}

function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120)
}

async function persistNodeAudit(projectPath: string, result: NodeAuditResult): Promise<string> {
  const dir = join(projectPath, PATHS.audit, safeSegment(result.nodeId))
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${stamp}.json`)
  await fs.writeFile(file, JSON.stringify({ ...result, cacheVersion: NODE_AUDIT_CACHE_VERSION }, null, 2), 'utf8')
  return file
}

export interface NodeAuditRunResult {
  result: NodeAuditResult
  claims: ExtractedClaim[]
  logPath?: string
  /**
   * Observability for the empty case (§5.2 C.1). Without this, "0 claims" is a
   * black box — it could mean the node had no readable output, the extractor
   * was handed nothing, or the model genuinely found no checkable process
   * assertion. The UI uses these to render an honest empty state.
   */
  diagnostics: {
    /** Chars of node output fed to the extractor (0 = nothing to read). */
    outputChars: number
    /** True when the LLM extractor actually ran (text present, not hand-fed). */
    llmInvoked: boolean
    /** How many claims came back. */
    extracted: number
  }
}

/**
 * Full per-node audit (§5.2): extract claims via one LLM call (C.1), then run
 * the deterministic correspondence compare (C.2–C.4). `callLlm` MUST be
 * telemetry-free (§8). `auditFlags` is the prune-produced flag map so
 * `ungrounded_step` etc. can trigger their targeted checks (§5.3). When
 * `claims` are supplied they are used verbatim (no LLM) — the Phase-1
 * hand-fed path. Non-auditable kinds return an empty result without an LLM call.
 */
export async function runNodeAudit(opts: {
  projectPath: string
  graph: AuditGraph
  nodeId: string
  callLlm: AuditCallLlm
  auditFlags?: Record<string, string[]>
  artifactText?: string
  claims?: ExtractedClaim[]
  /** §3.2 abandoned-by-judgement node ids to remove from audit scope. */
  excludeNodeIds?: string[]
  persist?: boolean
}): Promise<NodeAuditRunResult> {
  const { nodeById } = buildGraphIndex(opts.graph)
  const node = nodeById.get(opts.nodeId)
  if (!node) throw new Error(`Audit node not found: ${opts.nodeId}`)

  if (!isAuditableNodeKind(node.kind)) {
    return {
      result: { nodeId: node.id, nodeKind: node.kind, findings: [], triggeredFlags: [] },
      claims: [],
      diagnostics: { outputChars: 0, llmInvoked: false, extracted: 0 },
    }
  }

  const outputText = await resolveExtractionText(node, {
    projectPath: opts.projectPath,
    graph: opts.graph,
    ...(opts.artifactText !== undefined && { artifactText: opts.artifactText }),
  })
  const handFed = !!opts.claims
  const outputChars = outputText.trim().length
  const llmInvoked = !handFed && outputChars > 0
  const claims = opts.claims ?? await extractClaimsLlm({
    sourceNodeId: node.id,
    outputText,
    callLlm: opts.callLlm,
  })

  const result = auditNodeWithClaims({
    graph: opts.graph,
    nodeId: node.id,
    claims,
    auditFlags: opts.auditFlags,
    ...(opts.excludeNodeIds && { excludeNodeIds: opts.excludeNodeIds }),
  })

  const logPath = opts.persist === false ? undefined : await persistNodeAudit(opts.projectPath, result)
  return {
    result,
    claims,
    diagnostics: { outputChars, llmInvoked, extracted: claims.length },
    ...(logPath && { logPath }),
  }
}

// —— Progressive backward claim-finding (the "Find claim" flow) ————————————————

// Time proxy for ordering: span start for steps/chats; for an artifact, the
// latest time of a tool that produced it (writes/creates); else stepIndex; else 0.
function timeOfNode(node: GraphNode, incoming: Map<string, GraphEdge[]>, nodeById: Map<string, GraphNode>): number {
  const start = Number(node.startNs)
  if (Number.isFinite(start) && start > 0) return start
  if (node.kind === 'artifact') {
    let t = 0
    for (const e of incoming.get(node.id) ?? []) {
      if (e.rel !== 'writes' && e.rel !== 'creates') continue
      const tool = nodeById.get(e.source)
      const ts = Number(tool?.startNs)
      if (Number.isFinite(ts) && ts > t) t = ts
    }
    if (t > 0) return t
  }
  return node.stepIndex ?? 0
}

/**
 * The auditable NARRATIVE nodes worth walking for claims, newest first. Steps
 * and chats of the focused trace plus artifacts it produced — tool nodes are
 * excluded (a tool carries no claim of its own; it is audited via its consuming
 * step). Pruned/abandoned and caller-excluded nodes are dropped. The descending
 * order is what makes "Find claim" walk backward from the answer.
 */
export function orderAuditCandidates(graph: AuditGraph, opts: {
  terminalTraceId: string | null
  prunedNodes?: string[]
  excludeNodeIds?: string[]
}): string[] {
  const { nodeById, incoming } = buildGraphIndex(graph)
  const skip = new Set([...(opts.prunedNodes ?? []), ...(opts.excludeNodeIds ?? [])])
  const inFocusedTrace = (n: GraphNode): boolean => {
    if (n.kind === 'step' || n.kind === 'chat') return !opts.terminalTraceId || n.traceId === opts.terminalTraceId
    // artifact: keep when a producing tool belongs to the focused trace
    if (!opts.terminalTraceId) return true
    return (incoming.get(n.id) ?? []).some(e =>
      (e.rel === 'writes' || e.rel === 'creates') && nodeById.get(e.source)?.traceId === opts.terminalTraceId)
  }
  return graph.nodes
    .filter(n => (n.kind === 'step' || n.kind === 'chat' || n.kind === 'artifact') && !skip.has(n.id) && inFocusedTrace(n))
    .map(n => ({ id: n.id, t: timeOfNode(n, incoming, nodeById) }))
    .sort((a, b) => b.t - a.t || b.id.localeCompare(a.id))
    .map(x => x.id)
}

/**
 * Latest persisted per-node audit (cache). Lets the backward walk skip a node
 * it already audited without spending another extraction LLM call. Returns null
 * when nothing is cached or the dir is unreadable.
 */
export async function readCachedNodeAudit(projectPath: string, nodeId: string): Promise<NodeAuditResult | null> {
  const dir = join(projectPath, PATHS.audit, safeSegment(nodeId))
  let entries: string[]
  try {
    entries = (await fs.readdir(dir)).filter(f => f.endsWith('.json'))
  } catch {
    return null
  }
  if (entries.length === 0) return null
  entries.sort() // ISO timestamps sort chronologically; last = newest
  try {
    const raw = await fs.readFile(join(dir, entries[entries.length - 1]), 'utf8')
    const parsed = JSON.parse(raw) as NodeAuditResult
    return parsed.cacheVersion === NODE_AUDIT_CACHE_VERSION ? parsed : null
  } catch {
    return null
  }
}

// —— Concurrent batch audit (the "Audit trace" one-shot) ————————————————————————

/**
 * Map `fn` over `items` with at most `limit` in flight. Per-node audits are
 * independent (stateless), so they parallelize safely. `onProgress` fires after
 * each item completes — drives the live `done/total` UI. Order of results
 * matches `items`; a worker that throws rejects the whole batch, so callers that
 * want per-item error isolation must catch inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const total = items.length
  const results = new Array<R>(total)
  let next = 0
  let done = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= total) return
      results[i] = await fn(items[i], i)
      done++
      onProgress?.(done, total)
    }
  }
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, total))
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

/**
 * Deterministic roll-up of per-node results across a focused trace. `coverage`
 * is computed against `focusedToolIds` (every tool operation in the trace): a
 * tool is "covered" when a claim finding anchored to it, "flaggedOnly" when an
 * audit-flag caught it without a claim, and "silent" when neither — the honest
 * blind spot. Pure; no graph or LLM needed beyond the supplied tool id list.
 */
export function summarizeNodeAudits(results: NodeAuditResult[], focusedToolIds: string[]): TraceAuditSummary {
  const claimFindings = results.flatMap(r => r.findings.filter(f => !f.flag).map(f => ({ r, f })))
  const flagFindings = results.flatMap(r => r.findings.filter(f => f.flag).map(f => ({ r, f })))

  const toolSet = new Set(focusedToolIds)
  const coveredByClaim = new Set<string>()
  for (const { f } of claimFindings) for (const id of f.anchorNodeIds) if (toolSet.has(id)) coveredByClaim.add(id)
  const flaggedTools = new Set<string>()
  for (const { f } of flagFindings) for (const id of f.anchorNodeIds) if (toolSet.has(id)) flaggedTools.add(id)

  let flaggedOnly = 0
  let silent = 0
  for (const id of toolSet) {
    if (coveredByClaim.has(id)) continue
    if (flaggedTools.has(id)) flaggedOnly++
    else silent++
  }

  return {
    nodesAudited: results.length,
    claims: claimFindings.length,
    mismatch: claimFindings.filter(x => x.f.verdict === 'mismatch').length,
    unverifiable: claimFindings.filter(x => x.f.verdict === 'unverifiable').length,
    match: claimFindings.filter(x => x.f.verdict === 'match').length,
    flags: flagFindings.length,
    // Every finding, claim + flag, tagged with its source node (for click-to-focus).
    findings: results.flatMap(r => r.findings.map(finding => ({ nodeId: r.nodeId, finding }))),
    coverage: {
      focusedTools: toolSet.size,
      coveredByClaim: coveredByClaim.size,
      flaggedOnly,
      silent,
    },
  }
}
