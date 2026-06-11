/**
 * Deterministic prune over the Audit Graph (zero LLM, bit-reproducible).
 *
 * The Audit tab shows the full provenance graph. Pressing "Prune" partitions
 * that graph into a KEPT set (the critical path + everything causally feeding
 * or produced by it) and a PRUNED set (scaffolding + abandoned / parallel
 * branches). The renderer greys the pruned set rather than deleting it, and
 * the critical-path highlight only routes through kept nodes/edges.
 *
 * Design decisions (locked, see docs/spec/audit-pipeline.md):
 *  - No deliverable identification. The terminal step of the focused trace is
 *    the natural sink; we never try to name an "output artifact" or extract
 *    claims here. A real deliverable is by construction a *product of a kept
 *    step's tool*, so it is always kept — it can never be greyed.
 *  - Causal edge classes only (Stage 0/1). `sub-llm` and `listed` are causal;
 *    `mentions` is not; `precedes`/`contains` are non-causal. There is no
 *    `derived_from` edge in the projection, so it is not in the causal set.
 *  - Span collapse (old Stage 2) is dropped: the projection emits a flat
 *    `trace contains span`, never a span→span tree, so there is nothing to fold.
 *  - Error markers are flagged, never pruned (the "is this abandoned / did it
 *    affect reasoning" judgement is deferred to the LLM stage).
 *
 * Determinism: the result holds sorted arrays (node ids, edge keys) and the
 * flag / metric records are built by iterating a sorted node list, so two runs
 * over the same graph serialize byte-for-byte. No wall clock, no Date.now.
 */

import type { EdgeRel, GraphEdge, GraphNode, NodeKind } from './types.js'
import { buildGraphIndex, edgeKey, type GraphLike } from './graph-utils.js'

// —— Stage 0: coarse causal classification ——————————————————————————————
//
// A 3-class coarsening of `classifyEdge`. Only `causal` edges survive Stage 1;
// `temporal` (the step timeline) is kept *separately* as the critical-path
// backbone within the focused trace, and `structural` scaffolding is greyed.

export type EdgeCausalClass = 'causal' | 'structural' | 'temporal'

export function edgeCausalClass(rel: EdgeRel): EdgeCausalClass {
  switch (rel) {
    case 'invokes': // step → tool
    case 'returns': // tool → step
    case 'reads': // file → tool
    case 'retrieved': // artifact → tool
    case 'writes': // tool → file
    case 'creates': // tool → artifact
    case 'sub-llm': // step → chat (the step's own reasoning)
    case 'listed': // dir → tool (tool observed this listing)
    case 'applies': // skill → step (skill guided this step's reasoning)
      return 'causal'
    case 'precedes': // step i → step i+1
      return 'temporal'
    case 'contains': // session/trace → span
    case 'mentions': // file path referenced but not read
      return 'structural'
  }
}

// —— Stage 0: node role classification —————————————————————————————————————
//
// The explicit role layer, decoupled from the projection's `kind`. It collapses
// the 9 node kinds into the 5 audit roles from the v2 plan (deliverable was
// dropped — we never name an output artifact). A `tool` node also carries the
// observation role (no separate observation node); `chat`/`span` are tool-like
// executions; `dir` is a filesystem object alongside `file`.

export type NodeRole = 'container' | 'step' | 'tool' | 'artifact' | 'file' | 'skill'

export function nodeRole(kind: NodeKind): NodeRole {
  switch (kind) {
    case 'session':
    case 'trace':
      return 'container'
    case 'step':
      return 'step'
    case 'tool':
    case 'chat':
    case 'span':
      return 'tool'
    case 'artifact':
      return 'artifact'
    case 'file':
    case 'dir':
      return 'file'
    case 'skill':
      return 'skill'
  }
}

// —— Result shape ————————————————————————————————————————————————————————

export interface StepSupportMetric {
  /** Tool nodes in this step's backward causal closure. */
  nGroundingTools: number
  /** Distinct tool names among those grounding tools. */
  toolKindDiversity: number
  /** Upstream artifacts consumed by ≥2 distinct intent classes. */
  redundancy: number
  /** Fraction of upstream nodes carrying ≥1 flag (0 when closure empty). */
  suspiciousRatio: number
}

export interface PruneResult {
  terminalTraceId: string | null
  terminalStepId: string | null
  /** Kept nodes (critical path + causal support), sorted by id. */
  keptNodes: string[]
  /** Kept edges as `edgeKey` strings, sorted. */
  keptEdges: string[]
  /** Greyed nodes (scaffolding + abandoned / parallel branches), sorted. */
  prunedNodes: string[]
  /** Greyed edges as `edgeKey` strings, sorted. */
  prunedEdges: string[]
  /** The step backbone of the focused trace (critical-path spine), sorted. */
  spineNodes: string[]
  /** nodeId → sorted flag list. Only nodes with ≥1 flag appear. */
  flags: Record<string, string[]>
  /** stepId → support metrics, for each step of the focused trace. */
  supportMetrics: Record<string, StepSupportMetric>
  stageStats: {
    G0: { nodes: number; edges: number }
    causalEdges: number
    kept: { nodes: number; edges: number }
    pruned: { nodes: number; edges: number }
    /** Stage-0 edge typing breakdown over the full input graph. */
    edgeClasses: { causal: number; temporal: number; structural: number }
    /** Stage-0 node role breakdown over the full input graph. */
    nodeRoles: Record<NodeRole, number>
  }
}

// —— Helpers —————————————————————————————————————————————————————————————

function timeOf(n: GraphNode): number {
  const start = Number(n.startNs)
  if (Number.isFinite(start) && start > 0) return start
  return n.stepIndex ?? 0
}

/**
 * Pick the terminal step (the critical-path sink).
 *
 * NOT simply "latest step by time": real telemetry interleaves the main agent
 * loop with single-step background sub-agents (memory extractor, intent router,
 * title generator), each in its own 1-step trace. The chronologically-last step
 * is very often one of those trailing blips, whose causal closure is a single
 * node — collapsing the whole prune. So we prefer the latest step that lives in
 * a *multi-step* trace (a genuine agent turn), and only fall back to the global
 * latest step when no trace has more than one step.
 */
function chooseTerminalStep(nodes: GraphNode[]): GraphNode | undefined {
  const steps = nodes.filter(n => n.kind === 'step')
  if (steps.length === 0) return undefined
  const perTrace = new Map<string, number>()
  for (const s of steps) perTrace.set(s.traceId ?? '', (perTrace.get(s.traceId ?? '') ?? 0) + 1)
  const latest = (a: GraphNode, b: GraphNode) =>
    timeOf(b) - timeOf(a) ||
    (b.stepIndex ?? -1) - (a.stepIndex ?? -1) ||
    b.id.localeCompare(a.id)
  const multiStep = steps.filter(s => (perTrace.get(s.traceId ?? '') ?? 0) >= 2)
  return (multiStep.length > 0 ? multiStep : steps).slice().sort(latest)[0]
}

/** Nodes that belong to a single trace (and thus must not leak across traces
 *  through a shared file/artifact). file/dir/artifact nodes are shared. */
function isTraceScoped(n: GraphNode): boolean {
  return n.kind === 'step' || n.kind === 'tool' || n.kind === 'chat' || n.kind === 'span'
}

// djb2 — a tiny deterministic string hash for the intent-class proxy. We only
// need stable bucketing of (toolName, args-prefix), not cryptographic strength.
function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const ARGS_PREFIX = 200

/** Deterministic "intent class" for a tool node: tool name + a hash of the
 *  first N chars of its recorded args. Used as a redundancy proxy. */
function intentClass(n: GraphNode): string {
  const argsBody = n.rawEvents?.find(e => e.name === 'pipilot.tool.args')?.body ?? ''
  const name = n.toolName || n.label
  return `${name} ${djb2(argsBody.slice(0, ARGS_PREFIX))}`
}

// —— Main —————————————————————————————————————————————————————————————————

export function pruneGraph(
  graph: GraphLike,
  opts: { terminalStepId?: string | null } = {},
): PruneResult {
  const { nodeById, incoming, outgoing } = buildGraphIndex(graph)

  const terminalStep = opts.terminalStepId
    ? nodeById.get(opts.terminalStepId)
    : chooseTerminalStep(graph.nodes)
  const terminalTraceId = terminalStep?.traceId ?? null
  const terminalStepId = terminalStep?.id ?? null

  // —— Stage 3: kept = focused trace's causal subgraph ——————————————————————
  // Seed from the whole step spine of the focused trace (not just the last
  // step — a pure-text terminal step has no causal predecessors and would
  // otherwise yield an empty closure). Then flood causal edges in BOTH
  // directions: backward pulls inputs (reads/returns/retrieved/listed/invokes),
  // forward pulls products (writes/creates) and sub-LLM children. A
  // trace-scoped node is only admitted if it belongs to the focused trace, so
  // a shared file can be kept without leaking the parallel trace that also
  // touched it.
  const kept = new Set<string>()
  const queue: string[] = []
  if (terminalTraceId) {
    for (const n of graph.nodes) {
      if (n.kind === 'step' && n.traceId === terminalTraceId) {
        kept.add(n.id)
        queue.push(n.id)
      }
    }
  }

  const canAdmit = (n: GraphNode): boolean =>
    !isTraceScoped(n) || n.traceId === terminalTraceId

  while (queue.length > 0) {
    const id = queue.shift() as string
    const neighbors = [...(incoming.get(id) ?? []), ...(outgoing.get(id) ?? [])]
    for (const e of neighbors) {
      if (edgeCausalClass(e.rel) !== 'causal') continue
      const other = e.source === id ? e.target : e.source
      if (kept.has(other)) continue
      const on = nodeById.get(other)
      if (!on || !canAdmit(on)) continue
      kept.add(other)
      queue.push(other)
    }
  }

  // —— Kept edges: ONLY causal edges inside the kept set. Temporal (`precedes`,
  // the step timeline) and structural (`contains`, `mentions`) edges are greyed
  // even between kept steps — the step ordering is scaffolding, and the causal
  // flow already threads the steps together via invokes→tool→returns. The step
  // NODES stay kept (they are closure seeds); only the temporal line greys.
  const keptEdgeKeys = new Set<string>()
  for (const e of graph.edges) {
    if (!kept.has(e.source) || !kept.has(e.target)) continue
    if (edgeCausalClass(e.rel) === 'causal') keptEdgeKeys.add(edgeKey(e))
  }

  // —— Stages 5/6: flags + support metrics ——————————————————————————————————
  const flags = computeFlags(graph, { nodeById, incoming, outgoing })
  const supportMetrics = computeSupportMetrics(graph, { nodeById, incoming }, terminalTraceId, flags)

  // —— Partition + sorted, serializable output —————————————————————————————
  const allEdgeKeys = graph.edges.map(edgeKey)
  const prunedNodes = graph.nodes.map(n => n.id).filter(id => !kept.has(id))
  const prunedEdges = allEdgeKeys.filter(k => !keptEdgeKeys.has(k))
  const spineNodes = [...kept].filter(id => {
    const n = nodeById.get(id)
    return n?.kind === 'step' && n.traceId === terminalTraceId
  })

  const sortedFlags: Record<string, string[]> = {}
  for (const id of [...flags.keys()].sort()) {
    sortedFlags[id] = [...new Set(flags.get(id))].sort()
  }
  const sortedMetrics: Record<string, StepSupportMetric> = {}
  for (const id of [...supportMetrics.keys()].sort()) {
    sortedMetrics[id] = supportMetrics.get(id) as StepSupportMetric
  }

  const edgeClasses = { causal: 0, temporal: 0, structural: 0 }
  for (const e of graph.edges) edgeClasses[edgeCausalClass(e.rel)]++
  const nodeRoles: Record<NodeRole, number> = { container: 0, step: 0, tool: 0, artifact: 0, file: 0, skill: 0 }
  for (const n of graph.nodes) nodeRoles[nodeRole(n.kind)]++

  return {
    terminalTraceId,
    terminalStepId,
    keptNodes: [...kept].sort(),
    keptEdges: [...keptEdgeKeys].sort(),
    prunedNodes: prunedNodes.sort(),
    prunedEdges: prunedEdges.sort(),
    spineNodes: spineNodes.sort(),
    flags: sortedFlags,
    supportMetrics: sortedMetrics,
    stageStats: {
      G0: { nodes: graph.nodes.length, edges: graph.edges.length },
      causalEdges: edgeClasses.causal,
      kept: { nodes: kept.size, edges: keptEdgeKeys.size },
      pruned: { nodes: prunedNodes.length, edges: prunedEdges.length },
      edgeClasses,
      nodeRoles,
    },
  }
}

// —— Flags ———————————————————————————————————————————————————————————————

interface Index {
  nodeById: Map<string, GraphNode>
  incoming: Map<string, GraphEdge[]>
  outgoing: Map<string, GraphEdge[]>
}

/**
 * Per-node suspicion markers. These only *tag* — they never prune. Excluded by
 * design: `high_latency` / `long_output` (performance/storage signals, not
 * correctness — see auto-suspect.ts for the rationale this preserves).
 */
function computeFlags(graph: GraphLike, idx: Index): Map<string, string[]> {
  const { incoming, outgoing, nodeById } = idx
  const out = new Map<string, string[]>()
  const flag = (id: string, name: string) => {
    const list = out.get(id)
    if (list) { if (!list.includes(name)) list.push(name) }
    else out.set(id, [name])
  }

  const relCount = (edges: GraphEdge[] | undefined, rel: EdgeRel): number =>
    (edges ?? []).reduce((acc, e) => acc + (e.rel === rel ? 1 : 0), 0)
  const hasRel = (edges: GraphEdge[] | undefined, rel: EdgeRel): boolean =>
    (edges ?? []).some(e => e.rel === rel)

  // The first step of each trace legitimately has no upstream tool output —
  // it's the opening plan, not an ungrounded claim. Exclude it from the flag.
  const firstStepIds = new Set<string>()
  const minIdxByTrace = new Map<string, { id: string; idx: number }>()
  for (const n of graph.nodes) {
    if (n.kind !== 'step') continue
    const key = n.traceId ?? ''
    const cur = minIdxByTrace.get(key)
    const idx = n.stepIndex ?? 0
    if (!cur || idx < cur.idx) minIdxByTrace.set(key, { id: n.id, idx })
  }
  for (const { id } of minIdxByTrace.values()) firstStepIds.add(id)

  for (const n of graph.nodes) {
    if (n.kind === 'tool') {
      if (n.isError) flag(n.id, 'error')
      if (n.retryCount && n.retryCount > 0) flag(n.id, 'retried')
    }

    if (n.kind === 'file') {
      // reads: file → tool (file is the source); writes: tool → file (target).
      if (relCount(outgoing.get(n.id), 'reads') >= 2) flag(n.id, 'reread')
      if (relCount(incoming.get(n.id), 'writes') >= 2) flag(n.id, 'overwritten')
    }

    if (n.kind === 'artifact' && Array.isArray(n.versions) && n.versions.length > 1) {
      flag(n.id, 'overwritten')
    }

    // ungrounded_step: a NON-FIRST step that consumed no tool output (no
    // incoming returns). The first step of a trace is excluded — it has no
    // prior step to feed it, so "ungrounded" there is a guaranteed false positive.
    if (n.kind === 'step' && !firstStepIds.has(n.id) && !hasRel(incoming.get(n.id), 'returns')) {
      flag(n.id, 'ungrounded_step')
    }

    // unused_output: a product (written file / created artifact) that nothing
    // reads. The deliverable typically lands here — it is FLAGGED, not pruned.
    if (n.kind === 'file' || n.kind === 'artifact') {
      const isProduct = hasRel(incoming.get(n.id), 'writes') || hasRel(incoming.get(n.id), 'creates')
      const isRead = hasRel(outgoing.get(n.id), 'reads') || hasRel(outgoing.get(n.id), 'retrieved')
      if (isProduct && !isRead) flag(n.id, 'unused_output')
    }
  }

  // repeated_intent: same tool name invoked ≥3 times within a window of 3
  // consecutive step indices (K=3), per trace. Flags the clustered tool nodes.
  const byKey = new Map<string, { id: string; idx: number }[]>()
  for (const e of graph.edges) {
    if (e.rel !== 'invokes') continue
    const step = nodeById.get(e.source)
    const tool = nodeById.get(e.target)
    if (!step || !tool || tool.kind !== 'tool') continue
    const key = `${tool.traceId ?? ''} ${tool.toolName || tool.label}`
    const entry = { id: tool.id, idx: step.stepIndex ?? 0 }
    const list = byKey.get(key)
    if (list) list.push(entry); else byKey.set(key, [entry])
  }
  for (const list of byKey.values()) {
    if (list.length < 3) continue
    list.sort((a, b) => a.idx - b.idx || a.id.localeCompare(b.id))
    for (let i = 0; i < list.length; i++) {
      const window = list.filter(x => x.idx >= list[i].idx && x.idx <= list[i].idx + 2)
      if (window.length >= 3) for (const x of window) flag(x.id, 'repeated_intent')
    }
  }

  return out
}

// —— Support metrics ——————————————————————————————————————————————————————

/** Backward causal closure (predecessors over causal edges) from a step. */
function backwardClosure(stepId: string, incoming: Map<string, GraphEdge[]>): Set<string> {
  const seen = new Set<string>([stepId])
  const queue = [stepId]
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const e of incoming.get(id) ?? []) {
      if (edgeCausalClass(e.rel) !== 'causal') continue
      if (seen.has(e.source)) continue
      seen.add(e.source)
      queue.push(e.source)
    }
  }
  seen.delete(stepId)
  return seen
}

function computeSupportMetrics(
  graph: GraphLike,
  idx: Pick<Index, 'nodeById' | 'incoming'>,
  terminalTraceId: string | null,
  flags: Map<string, string[]>,
): Map<string, StepSupportMetric> {
  const { nodeById, incoming } = idx
  const out = new Map<string, StepSupportMetric>()
  if (!terminalTraceId) return out

  for (const step of graph.nodes) {
    if (step.kind !== 'step' || step.traceId !== terminalTraceId) continue
    const upstream = backwardClosure(step.id, incoming)

    const tools: GraphNode[] = []
    const artifacts: GraphNode[] = []
    for (const id of upstream) {
      const n = nodeById.get(id)
      if (!n) continue
      if (n.kind === 'tool') tools.push(n)
      else if (n.kind === 'artifact') artifacts.push(n)
    }

    // redundancy: upstream artifacts consumed by ≥2 distinct intent classes.
    // A consumer of an artifact is a tool reached via `retrieved` (artifact →
    // tool) that is itself in the upstream set.
    let redundancy = 0
    for (const a of artifacts) {
      const classes = new Set<string>()
      for (const e of graph.edges) {
        if (e.rel !== 'retrieved' || e.source !== a.id) continue
        if (!upstream.has(e.target)) continue
        const consumer = nodeById.get(e.target)
        if (consumer) classes.add(intentClass(consumer))
      }
      if (classes.size >= 2) redundancy++
    }

    const flaggedUpstream = [...upstream].filter(id => flags.has(id)).length
    const suspiciousRatio = upstream.size > 0 ? flaggedUpstream / upstream.size : 0

    out.set(step.id, {
      nGroundingTools: tools.length,
      toolKindDiversity: new Set(tools.map(t => t.toolName || t.label)).size,
      redundancy,
      suspiciousRatio,
    })
  }

  return out
}
