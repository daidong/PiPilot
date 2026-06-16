import type { AuditGraph, GraphEdge, GraphNode, NodeKind } from '../types.js'
import { buildGraphIndex } from '../graph-utils.js'
import { edgeCausalClass } from '../prune.js'
import { tokenMatchesNode } from './claims.js'
import { stripBlobTokens } from './content.js'
import type { ExtractedClaim, FaithfulnessFinding, FaithfulnessVerdict, NodeAuditResult } from './types.js'

export const AUDITABLE_NODE_KINDS = new Set<NodeKind>(['step', 'chat', 'artifact', 'tool'])

export function isAuditableNodeKind(kind: NodeKind): boolean {
  return AUDITABLE_NODE_KINDS.has(kind)
}

function rawEventBody(n: GraphNode, eventName: string): string | null {
  return n.rawEvents?.find(e => e.name === eventName)?.body ?? null
}

function tryParseJson(s: string | null): unknown {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (Array.isArray(record.content)) return record.content.map(textOf).filter(Boolean).join('\n')
  return Object.values(record).map(textOf).filter(Boolean).join('\n')
}

const FILEISH_EXT = /\.(?:md|txt|json|jsonl|csv|tsv|yaml|yml|py|ts|tsx|js|jsx|html|css|pdf|png|jpg|jpeg|svg|bib|tex|docx|pptx|xlsx)$/i

function looksLikeFilePath(s: string): boolean {
  return FILEISH_EXT.test(s) || /[/\\].+\.[A-Za-z0-9]{1,8}$/.test(s)
}

function collectPathStrings(value: unknown, out = new Set<string>()): Set<string> {
  if (!value) return out
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (looksLikeFilePath(trimmed)) out.add(trimmed)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathStrings(item, out)
    return out
  }
  if (typeof value !== 'object') return out
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/file|path|filename|document/i.test(key)) collectPathStrings(child, out)
    else if (Array.isArray(child) || (child && typeof child === 'object')) collectPathStrings(child, out)
  }
  return out
}

function isFileQuantity(claim: ExtractedClaim, q: { value: number; unit?: string }): boolean {
  const unit = q.unit?.toLowerCase() ?? ''
  return /files?|paths?|documents?|pdfs?|csvs?|tables?/.test(unit) || /\bfiles?\b/i.test(claim.text)
}

// Deterministic safety net for the ordinal-vs-cardinal trap: "table 4" / "row 4"
// / "Figure 2" / "step 3" are IDENTIFIERS (the 4th table), not COUNTS (4 tables).
// A claim like "row 4 has a title in table 4" must not be read as "4 tables" and
// compared to read edges. We detect the "<label-noun> <N>" shape in the verbatim
// text and exclude that quantity from count/value comparison. Independent of
// whether the LLM extractor obeyed the same rule in the prompt.
const ORDINAL_LABEL = 'table|row|column|col|figure|fig|page|step|item|line|section|part|chapter|appendix|footnote|entry|question|q|no|number'
function isOrdinalQuantity(claim: ExtractedClaim, q: { value: number }): boolean {
  const v = q.value.toString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b(?:${ORDINAL_LABEL})\\.?\\s*#?\\s*${v}\\b`, 'i').test(claim.text)
}

function formatQuantity(q: { value: number; unit?: string }): string {
  return `${q.value}${q.unit ? ` ${q.unit}` : ''}`
}

function sourceInvokedTools(sourceNodeId: string, outgoing: Map<string, GraphEdge[]>, nodeById: Map<string, GraphNode>): GraphNode[] {
  return (outgoing.get(sourceNodeId) ?? [])
    .filter(e => e.rel === 'invokes')
    .map(e => nodeById.get(e.target))
    .filter((n): n is GraphNode => !!n && n.kind === 'tool')
    .sort((a, b) => a.id.localeCompare(b.id))
}

function anchorClaim(claim: ExtractedClaim, graph: AuditGraph): string[] {
  const { nodeById, outgoing } = buildGraphIndex(graph)
  const source = nodeById.get(claim.sourceNodeId)
  const anchors = new Set<string>()

  for (const entity of claim.entities) {
    for (const n of graph.nodes) {
      if (tokenMatchesNode(entity, n)) anchors.add(n.id)
    }
  }

  if (anchors.size === 0 && (source?.kind === 'step' || source?.kind === 'chat')) {
    for (const tool of sourceInvokedTools(source.id, outgoing, nodeById)) anchors.add(tool.id)
  } else if (anchors.size === 0 && (source?.kind === 'tool' || source?.kind === 'artifact')) {
    anchors.add(source.id)
  }

  return [...anchors].sort()
}

function causalBackwardNeighborhood(startIds: string[], graph: AuditGraph): { nodeIds: Set<string>; edges: GraphEdge[] } {
  const { incoming, nodeById } = buildGraphIndex(graph)
  const nodeIds = new Set<string>()
  const edges: GraphEdge[] = []
  const queue = [...startIds]

  for (const id of startIds) if (nodeById.has(id)) nodeIds.add(id)

  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const e of incoming.get(id) ?? []) {
      if (edgeCausalClass(e.rel) !== 'causal') continue
      edges.push(e)
      if (!nodeIds.has(e.source)) {
        nodeIds.add(e.source)
        queue.push(e.source)
      }
    }
  }

  return { nodeIds, edges }
}

// Resolve the tool node(s) an anchor stands for: a tool anchor IS the tool; an
// artifact/file anchor maps to the tool(s) that produced it (`writes`/`creates`
// ← tool) — the production chain in §5.1. Deduplicated and sorted for
// determinism.
function anchorTools(anchorIds: string[], graph: AuditGraph): GraphNode[] {
  const { nodeById, incoming } = buildGraphIndex(graph)
  const seen = new Map<string, GraphNode>()
  for (const id of anchorIds) {
    const node = nodeById.get(id)
    if (!node) continue
    const tools: GraphNode[] = node.kind === 'tool'
      ? [node]
      : (incoming.get(id) ?? [])
          .filter(e => e.rel === 'writes' || e.rel === 'creates')
          .map(e => nodeById.get(e.source))
          .filter((n): n is GraphNode => !!n && n.kind === 'tool')
    for (const tool of tools) seen.set(tool.id, tool)
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function toolScopeEvidence(
  anchorIds: string[],
  graph: AuditGraph,
): { count: number | null; actual: string; evidence: FaithfulnessFinding['evidence'] } {
  const { incoming } = buildGraphIndex(graph)
  const readFileIds = new Set<string>()
  const argPaths = new Set<string>()
  const evidence: FaithfulnessFinding['evidence'] = []

  for (const tool of anchorTools(anchorIds, graph)) {
    const reads = (incoming.get(tool.id) ?? []).filter(e => e.rel === 'reads')
    for (const e of reads) readFileIds.add(e.source)
    const args = tryParseJson(rawEventBody(tool, 'pipilot.tool.args'))
    for (const p of collectPathStrings(args)) argPaths.add(p)
    if (reads.length > 0) evidence.push({ nodeId: tool.id, detail: `${reads.length} read edge(s)` })
    if (argPaths.size > 0) evidence.push({ nodeId: tool.id, detail: `${argPaths.size} file path(s) in args` })
  }

  if (readFileIds.size > 0) {
    return { count: readFileIds.size, actual: `${readFileIds.size} read edge(s)`, evidence }
  }
  if (argPaths.size > 0) {
    return { count: argPaths.size, actual: `${argPaths.size} file path(s) in args`, evidence }
  }
  return { count: null, actual: 'no enumerable file reads or file-path args', evidence }
}

const NUMBER_RX = /-?\d+(?:\.\d+)?/g

function basename(p: string): string {
  return p.trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? ''
}

// §5.2 C.4 result-value comparison: numbers parsed from the anchor tool(s)'
// recorded `result`. A claimed scalar ("mean 4.2") is checked against these.
function resultNumbers(anchorIds: string[], graph: AuditGraph): { numbers: number[]; evidence: FaithfulnessFinding['evidence'] } {
  const numbers: number[] = []
  const evidence: FaithfulnessFinding['evidence'] = []
  for (const tool of anchorTools(anchorIds, graph)) {
    // Scan the raw result body string (JSON or text) — flattening via textOf
    // would drop bare numeric values inside objects (`{"mean":4.2}`). Strip
    // blob/hash plumbing first so a `sha256:…` digest's hex digits are never
    // parsed as a result value (the contentHash false-mismatch).
    const text = stripBlobTokens(rawEventBody(tool, 'pipilot.tool.result') ?? '')
    if (!text.trim()) continue
    const nums = [...text.matchAll(NUMBER_RX)].map(m => Number(m[0])).filter(Number.isFinite)
    if (nums.length > 0) {
      numbers.push(...nums)
      evidence.push({ nodeId: tool.id, detail: `result values: ${[...new Set(nums)].slice(0, 8).join(', ')}` })
    }
  }
  return { numbers, evidence }
}

const ACTION_VERB_RX = /\b(?:read(?:ing)?|search(?:ed|ing)?|find|found|fetch(?:ed|ing)?|get|download(?:ed|ing)?|open(?:ed|ing)?|convert(?:ed|ing)?|analy[sz](?:e|ed|ing)|inspect(?:ed|ing)?|check(?:ed|ing)?|look(?:ing)?\s+at|list(?:ed|ing)?|extract(?:ed|ing)?|writ(?:e|ing)|wrote|create(?:d|ing)?|save(?:d|ing)?|compare(?:d|ing)?|access(?:ed|ing)?|retrieve(?:d|ing)?)\b/i

function actionEvidence(
  claim: ExtractedClaim,
  anchorIds: string[],
  graph: AuditGraph,
): { actual: string; evidence: FaithfulnessFinding['evidence'] } | null {
  if (!ACTION_VERB_RX.test(claim.text)) return null
  const { nodeById, incoming, outgoing } = buildGraphIndex(graph)
  const toolIds = new Set<string>()
  const evidence: FaithfulnessFinding['evidence'] = []

  for (const id of anchorIds) {
    const node = nodeById.get(id)
    if (!node) continue
    if (node.kind === 'tool') {
      toolIds.add(node.id)
      continue
    }
    for (const e of [...(incoming.get(id) ?? []), ...(outgoing.get(id) ?? [])]) {
      if (edgeCausalClass(e.rel) !== 'causal') continue
      const otherId = e.source === id ? e.target : e.source
      const other = nodeById.get(otherId)
      if (other?.kind === 'tool') toolIds.add(other.id)
    }
  }

  for (const id of [...toolIds].sort()) {
    const tool = nodeById.get(id)
    if (!tool) continue
    evidence.push({ nodeId: id, detail: tool.toolName ? `recorded tool action: ${tool.toolName}` : 'recorded tool action' })
  }
  if (evidence.length === 0) return null
  return {
    actual: evidence.map(e => e.detail).join('; '),
    evidence,
  }
}

// A claimed value matches an actual one if they are equal exactly OR equal once
// the actual is rounded to the claim's decimal precision (so "mean 4.2" matches
// a recorded 4.234). Keeps the deterministic compare tolerant of display rounding.
function valueMatches(claimed: number, actual: number): boolean {
  if (claimed === actual) return true
  const decimals = (String(claimed).split('.')[1] ?? '').length
  if (decimals === 0) return Math.round(actual) === claimed
  const factor = 10 ** decimals
  return Math.round(actual * factor) / factor === claimed
}

// §5.2/§5.4 + Phase 3 `ALL` denominator. The `listed` inventory of the target
// dir is the file set an `ls`/`find` enumerated (parsed from that tool's
// result); the read-set is what was actually consumed (`reads`). An `ALL` claim
// is faithful iff read-set ⊇ listed-set (by basename). Returns null when no
// `listed` inventory is reachable — then the claim is genuinely unverifiable.
function listedDenominator(anchorIds: string[], graph: AuditGraph): {
  listed: Set<string>
  read: Set<string>
  evidence: FaithfulnessFinding['evidence']
} | null {
  const { nodeById } = buildGraphIndex(graph)
  const neighborhood = causalBackwardNeighborhood(anchorIds, graph)
  const listedEdges = neighborhood.edges.filter(e => e.rel === 'listed')
  if (listedEdges.length === 0) return null

  const listed = new Set<string>()
  const evidence: FaithfulnessFinding['evidence'] = []
  for (const e of listedEdges) {
    // `listed`: dir → tool. The inventory lives in the listing tool's result;
    // scan the STRUCTURED body (arrays/objects) so file lists tokenize — the
    // flattened text would not (same args-enumerate granularity as §5.4).
    const tool = nodeById.get(e.target)
    if (!tool) continue
    const rawResult = tryParseJson(rawEventBody(tool, 'pipilot.tool.result')) ?? rawEventBody(tool, 'pipilot.tool.result')
    for (const p of collectPathStrings(rawResult)) listed.add(basename(p))
    if (listed.size > 0) evidence.push({ nodeId: tool.id, detail: `${listed.size} entries listed` })
  }
  if (listed.size === 0) return null

  const read = new Set<string>()
  for (const tool of anchorTools(anchorIds, graph)) {
    for (const re of (buildGraphIndex(graph).incoming.get(tool.id) ?? [])) {
      if (re.rel !== 'reads') continue
      const f = nodeById.get(re.source)
      if (f?.path) read.add(basename(f.path))
    }
  }
  evidence.push({ nodeId: anchorIds[0] ?? '', detail: `${read.size} of ${listed.size} listed entries read` })
  return { listed, read, evidence }
}

function phantomFinding(claim: ExtractedClaim, node: GraphNode, flag: string): FaithfulnessFinding {
  return {
    claimId: claim.id,
    claimText: claim.text,
    anchorNodeIds: [],
    verdict: 'mismatch',
    claimed: claim.text,
    actual: 'no incoming tool result in the recorded trace',
    evidence: [{ nodeId: node.id, detail: flag }],
  }
}

function compareClaim(claim: ExtractedClaim, graph: AuditGraph, triggeredFlags: string[]): FaithfulnessFinding {
  const { nodeById } = buildGraphIndex(graph)
  const source = nodeById.get(claim.sourceNodeId)
  const anchorNodeIds = anchorClaim(claim, graph)

  if (triggeredFlags.includes('ungrounded_step') && source?.kind === 'step' && anchorNodeIds.length === 0) {
    return phantomFinding(claim, source, 'ungrounded_step')
  }

  const fileQuantity = claim.quantities.find(q => isFileQuantity(claim, q) && !isOrdinalQuantity(claim, q))
  if (fileQuantity) {
    const scope = toolScopeEvidence(anchorNodeIds, graph)
    if (scope.count === null) {
      return {
        claimId: claim.id,
        claimText: claim.text,
        anchorNodeIds,
        verdict: 'unverifiable',
        dimension: 'scope',
        claimed: formatQuantity(fileQuantity),
        actual: scope.actual,
        evidence: scope.evidence,
      }
    }
    return {
      claimId: claim.id,
      claimText: claim.text,
      anchorNodeIds,
      verdict: scope.count === fileQuantity.value ? 'match' : 'mismatch',
      dimension: 'scope',
      claimed: formatQuantity(fileQuantity),
      actual: scope.actual,
      evidence: scope.evidence,
    }
  }

  // Result-value comparison (§5.2 C.4, `dimension: 'result'`): a non-file
  // scalar claim ("mean 4.2") checked against numbers parsed from the anchor
  // tool's recorded result. equal → match; numbers present but none equal →
  // mismatch; no numeric result → unverifiable.
  const valueQuantity = claim.quantities.find(q => !isFileQuantity(claim, q) && !isOrdinalQuantity(claim, q))
  if (valueQuantity) {
    const { numbers, evidence } = resultNumbers(anchorNodeIds, graph)
    if (numbers.length === 0) {
      return {
        claimId: claim.id,
        claimText: claim.text,
        anchorNodeIds,
        verdict: 'unverifiable',
        dimension: 'result',
        claimed: formatQuantity(valueQuantity),
        actual: 'no numeric value in the anchor tool result',
        evidence,
      }
    }
    const hit = numbers.find(n => valueMatches(valueQuantity.value, n))
    return {
      claimId: claim.id,
      claimText: claim.text,
      anchorNodeIds,
      verdict: hit !== undefined ? 'match' : 'mismatch',
      dimension: 'result',
      claimed: formatQuantity(valueQuantity),
      actual: hit !== undefined ? `result value ${hit}` : `result values ${[...new Set(numbers)].slice(0, 8).join(', ')} (no match)`,
      evidence,
    }
  }

  // `ALL` scope coverage (§5.2 / Phase 3): with a `listed` inventory we can
  // settle whether the read-set covers it; without one it stays unverifiable.
  if (claim.scope === 'ALL') {
    const denom = listedDenominator(anchorNodeIds, graph)
    if (!denom) {
      return {
        claimId: claim.id,
        claimText: claim.text,
        anchorNodeIds,
        verdict: 'unverifiable',
        dimension: 'scope',
        claimed: 'ALL',
        actual: 'no listed denominator in the recorded trace',
        evidence: anchorNodeIds.map(id => ({ nodeId: id, detail: 'anchor without listed inventory' })),
      }
    }
    const missing = [...denom.listed].filter(b => !denom.read.has(b))
    return {
      claimId: claim.id,
      claimText: claim.text,
      anchorNodeIds,
      verdict: missing.length === 0 ? 'match' : 'mismatch',
      dimension: 'scope',
      claimed: `ALL (${denom.listed.size} listed)`,
      actual: missing.length === 0
        ? `read all ${denom.listed.size} listed entries`
        : `read ${denom.read.size} of ${denom.listed.size}; missed ${missing.slice(0, 5).join(', ')}`,
      evidence: denom.evidence,
    }
  }

  const action = actionEvidence(claim, anchorNodeIds, graph)
  if (action) {
    return {
      claimId: claim.id,
      claimText: claim.text,
      anchorNodeIds,
      verdict: 'match',
      dimension: 'action',
      claimed: claim.text,
      actual: action.actual,
      evidence: action.evidence,
    }
  }

  return {
    claimId: claim.id,
    claimText: claim.text,
    anchorNodeIds,
    verdict: 'unverifiable',
    claimed: claim.quantities.map(formatQuantity).join(', ') || claim.text,
    actual: 'no comparable deterministic feature in v1',
    evidence: anchorNodeIds.map(id => ({ nodeId: id, detail: 'anchor' })),
  }
}

// A1 citation correspondence (§2 / §5.1): an artifact node carries
// deterministic citation-resolvability fields from `citations.ts`. An
// unresolved citation is a cited source that was never retrieved in-session —
// the fabrication watchlist. Surfaced as a flag finding, no LLM.
function citationFinding(node: GraphNode): FaithfulnessFinding | null {
  if (node.kind !== 'artifact' || !node.citationsTotal) return null
  const unresolved = node.unresolvedCitations ?? []
  const resolved = node.citationsResolved ?? 0
  return {
    claimId: `citation:${node.id}`,
    claimText: `cites ${node.citationsTotal} source(s)`,
    anchorNodeIds: [node.id],
    verdict: unresolved.length === 0 ? 'match' : 'mismatch',
    claimed: `${node.citationsTotal} cited`,
    actual: unresolved.length === 0
      ? `all ${node.citationsTotal} resolved to retrieved sources`
      : `${resolved}/${node.citationsTotal} resolved; unretrieved: ${unresolved.slice(0, 5).join(', ')}`,
    evidence: [{ nodeId: node.id, detail: `citation resolution ${resolved}/${node.citationsTotal}` }],
    flag: 'citation',
  }
}

// §5.3 audit-flags as targeted triggers (graph-up). Each flag in the audited
// node's causal neighborhood points the audit at a specific thing to verify.
// `ungrounded_step` is excluded here — it is handled claim-down via the phantom
// path in compareClaim, so surfacing it again would double-count.
const FLAG_CHECK: Record<string, { verdict: FaithfulnessVerdict; detail: (n: GraphNode) => string }> = {
  error: {
    verdict: 'mismatch',
    detail: n => `the answer consumed a FAILED operation${n.toolName ? ` (${n.toolName})` : ''}`,
  },
  unused_output: {
    verdict: 'unverifiable',
    detail: n => `produced ${n.label}, but nothing downstream reads it — is it claimed as the result?`,
  },
  overwritten: {
    verdict: 'unverifiable',
    detail: n => `${n.label} was written/versioned ≥3×; a claim may reference a stale, non-final value`,
  },
}

function flagTriggeredFindings(node: GraphNode, graph: AuditGraph, auditFlags: Record<string, string[]>): FaithfulnessFinding[] {
  const { nodeById, incoming, outgoing } = buildGraphIndex(graph)
  // The node + its causal neighborhood out to radius 2 — far enough for a step
  // to reach the products of the tools it invoked (step → tool → product), the
  // locus a flag on a neighbor implicates. Bounded so the audit stays local.
  const neighborhood = new Set<string>([node.id])
  let frontier = [node.id]
  for (let depth = 0; depth < 2; depth++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const e of [...(incoming.get(id) ?? []), ...(outgoing.get(id) ?? [])]) {
        if (edgeCausalClass(e.rel) !== 'causal') continue
        for (const adj of [e.source, e.target]) {
          if (!neighborhood.has(adj)) { neighborhood.add(adj); next.push(adj) }
        }
      }
    }
    frontier = next
  }
  const findings: FaithfulnessFinding[] = []
  for (const id of [...neighborhood].sort()) {
    const neighbor = nodeById.get(id)
    if (!neighbor) continue
    for (const flag of (auditFlags[id] ?? []).filter(f => f in FLAG_CHECK)) {
      const spec = FLAG_CHECK[flag]
      findings.push({
        claimId: `flag:${flag}:${id}`,
        claimText: spec.detail(neighbor),
        anchorNodeIds: [id],
        verdict: spec.verdict,
        claimed: flag,
        actual: spec.detail(neighbor),
        evidence: [{ nodeId: id, detail: flag }],
        flag,
      })
    }
  }
  return findings
}

// §3.2: nodes greyed as *abandoned* are removed from audit scope — the
// correspondence checks must not see them. We materialize a filtered view of
// the graph (greyed nodes + every edge touching them dropped) and run the whole
// comparison on it. The audited node itself is always kept, even if it was
// greyed, so re-selecting it still yields an (empty-scope) result rather than
// throwing.
function excludeFromGraph(graph: AuditGraph, exclude: Set<string>): AuditGraph {
  if (exclude.size === 0) return graph
  return {
    ...graph,
    nodes: graph.nodes.filter(n => !exclude.has(n.id)),
    edges: graph.edges.filter(e => !exclude.has(e.source) && !exclude.has(e.target)),
  }
}

export function auditNodeWithClaims(opts: {
  graph: AuditGraph
  nodeId: string
  claims: ExtractedClaim[]
  auditFlags?: Record<string, string[]>
  /** §3.2 abandoned-by-judgement node ids to remove from scope. */
  excludeNodeIds?: string[]
}): NodeAuditResult {
  const baseIndex = buildGraphIndex(opts.graph)
  const node = baseIndex.nodeById.get(opts.nodeId)
  if (!node) throw new Error(`Audit node not found: ${opts.nodeId}`)
  if (!isAuditableNodeKind(node.kind)) {
    return { nodeId: node.id, nodeKind: node.kind, findings: [], triggeredFlags: [] }
  }

  const exclude = new Set(opts.excludeNodeIds ?? [])
  exclude.delete(node.id) // never grey away the node under audit
  const graph = excludeFromGraph(opts.graph, exclude)

  const auditFlags = opts.auditFlags ?? {}
  const triggeredFlags = [...new Set(auditFlags[node.id] ?? [])].sort()
  const nodeClaims = opts.claims
    .filter(c => c.sourceNodeId === node.id)
    .sort((a, b) => a.id.localeCompare(b.id))

  const claimFindings = nodeClaims.map(claim => compareClaim(claim, graph, triggeredFlags))
  const citation = citationFinding(node)
  const findings = [
    ...claimFindings,
    ...(citation ? [citation] : []),
    ...flagTriggeredFindings(node, graph, auditFlags),
  ]
  return {
    nodeId: node.id,
    nodeKind: node.kind,
    findings,
    triggeredFlags,
  }
}

export function extractResultText(node: GraphNode): string {
  return textOf(tryParseJson(rawEventBody(node, 'pipilot.tool.result')) ?? rawEventBody(node, 'pipilot.tool.result') ?? '')
}
