/**
 * Audit graph projection — turns the raw provenance graph (bipartite:
 * files + computations + versions) into a user-readable graph (entity-only
 * nodes + transformation-labeled edges).
 *
 * Approach C from the v0.8 RFC discussion (locked in 2026-04-30):
 *   - The data model on disk stays bipartite (W3C PROV-DM compatible).
 *   - The renderer projects it: computations become edge labels, multiple
 *     versions of the same ref collapse into a single visual node with a
 *     ×N badge and a version timeline accessible via Inspector.
 *
 * Inputs:  raw nodes + edges from provenance:get-graph IPC.
 * Outputs: projected nodes + edges suitable for React Flow rendering.
 */

import type { ProvenanceNode, ProvenanceEdge } from '../../stores/provenance-store'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Stable key for grouping nodes that represent the same identity over time. */
export function refKey(ref: any): string {
  switch (ref?.kind) {
    case 'memory-artifact': return `memory-artifact:${ref.artifactType}/${ref.artifactId}`
    case 'workspace-file':  return `workspace-file:${ref.path}`
    case 'computation':     return `computation:${ref.toolCallId}`
    case 'draft':           return `draft:${ref.path}`
    case 'audit-report':    return `audit-report:${ref.path}`
    default:                return `unknown:${JSON.stringify(ref)}`
  }
}

/** A view-layer node — one per refKey, may aggregate multiple raw versions. */
export interface ViewNode {
  id: string                    // = refKey of the group
  kind: ProvenanceNode['kind']
  ref: any
  label: string                 // representative (newest) label
  versions: ProvenanceNode[]    // all raw nodes in this group, oldest → newest
  representative: ProvenanceNode
  /** True if any version reports drift (snapshot hash != observed hash). */
  hasDrift: boolean
  /** True if any version was oversize-skipped at capture. */
  hasOversize: boolean
  /** Tool name of the most-recent computation that produced this entity, if any. */
  producedBy?: string
}

/** A view-layer edge — one per (from, to, label) triple after dedup. */
export interface ViewEdge {
  id: string
  from: string                  // canonical (refKey) id
  to: string
  label: string                 // tool name when known, otherwise 'input' / 'version' / 'cited'
  category: EdgeCategory
}

export type EdgeCategory =
  | 'edit'        // write, edit
  | 'compute'     // data_analyze, generate_diagram, local-compute:*
  | 'fetch'       // web_fetch, literature-search, convert_document
  | 'memory'      // artifact-create, artifact-update
  | 'bash'        // bash (dashed)
  | 'version'     // same-ref version chain
  | 'cited'       // cited-by edges
  | 'input'       // fallback when producer is unknown

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

export interface AuditFilters {
  /** Hide nodes that are only producers/consumers of bash side effects. */
  hideBash: boolean
  /** Hide nodes whose only history is write/edit (no other tools touched them). */
  hideWriteEditOnly: boolean
  /** Hide computation nodes entirely (default true — that's the whole point). */
  hideComputations: boolean
}

export const defaultFilters: AuditFilters = {
  hideBash: false,
  hideWriteEditOnly: false,
  hideComputations: true
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface Projection {
  nodes: ViewNode[]
  edges: ViewEdge[]
}

export function projectGraph(
  rawNodes: ProvenanceNode[],
  rawEdges: ProvenanceEdge[],
  filters: AuditFilters = defaultFilters
): Projection {
  // ── Step 1: group raw nodes by refKey ──────────────────────────────────
  const groups = new Map<string, ProvenanceNode[]>()
  for (const n of rawNodes) {
    const key = refKey(n.ref)
    const list = groups.get(key) ?? []
    list.push(n)
    groups.set(key, list)
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  // Map every raw node id → its group's canonical id (= refKey).
  const idToCanonical = new Map<string, string>()
  for (const [key, list] of groups) {
    for (const n of list) idToCanonical.set(n.id, key)
  }

  // ── Step 2: figure out which computation produced each output entity ──
  // For each non-computation refKey, find the most-recent computation that
  // has an outgoing `derived-from` edge into any version of it. The tool
  // name of that computation becomes the edge label later.
  const producerByOutput = new Map<string, ProvenanceNode>()  // canonicalOutputKey → computation node
  for (const e of rawEdges) {
    if (e.role !== 'derived-from') continue
    const fromNode = rawNodes.find(n => n.id === e.from)
    if (!fromNode || fromNode.kind !== 'computation') continue
    const toCanonical = idToCanonical.get(e.to)
    if (!toCanonical) continue
    const existing = producerByOutput.get(toCanonical)
    if (!existing || fromNode.createdAt > existing.createdAt) {
      producerByOutput.set(toCanonical, fromNode)
    }
  }

  // ── Step 3: build view nodes (skip computations when hideComputations) ─
  const viewNodes: ViewNode[] = []
  for (const [key, list] of groups) {
    const rep = list[list.length - 1]!  // newest
    if (filters.hideComputations && rep.kind === 'computation') continue
    const hasDrift = list.some(n => !!n.drift && n.drift.observedHash !== n.snapshot?.contentHash)
    const hasOversize = list.some(n => n.snapshot?.oversizeSkipped === true)
    const producer = producerByOutput.get(key)
    viewNodes.push({
      id: key,
      kind: rep.kind,
      ref: rep.ref,
      label: rep.label,
      versions: list,
      representative: rep,
      hasDrift,
      hasOversize,
      producedBy: producer?.toolCall?.name
    })
  }

  // ── Step 4: project edges ──────────────────────────────────────────────
  // Strategy:
  //   - Drop edges touching any hidden (computation) node.
  //   - For surviving `input` edges, look up the producer of the *target*
  //     and use its tool name as the edge label.
  //   - For `derived-from` edges between non-computations: it's a version
  //     chain → after collapsing, this becomes a self-loop → drop.
  //   - For `cited-by` edges: keep, label 'cited'.
  //   - Dedupe by (from, to, label).
  const visible = new Set<string>(viewNodes.map(n => n.id))
  const seen = new Set<string>()
  const viewEdges: ViewEdge[] = []

  for (const e of rawEdges) {
    const fromCanon = idToCanonical.get(e.from)
    const toCanon = idToCanonical.get(e.to)
    if (!fromCanon || !toCanon) continue
    // Both endpoints must survive the filter.
    if (!visible.has(fromCanon) || !visible.has(toCanon)) continue
    // Self-loops (same canonical group) = version chain after collapse → drop.
    if (fromCanon === toCanon) continue

    let label: string
    let category: EdgeCategory

    if (e.role === 'input') {
      const producer = producerByOutput.get(toCanon)
      const tool = producer?.toolCall?.name
      label = tool ?? 'input'
      category = tool ? categorize(tool) : 'input'
    } else if (e.role === 'cited-by') {
      label = 'cites'
      category = 'cited'
    } else if (e.role === 'derived-from') {
      // After dropping computations, only file→file derived-from edges remain.
      // Same-canonical was dropped above, so this is a cross-file derivation
      // (rare but possible — e.g. a draft derived from a paper). Treat as
      // a "version" link visually but distinct from input flow.
      label = 'version'
      category = 'version'
    } else {
      label = e.role
      category = 'input'
    }

    const key = `${fromCanon}|${toCanon}|${label}`
    if (seen.has(key)) continue
    seen.add(key)
    viewEdges.push({
      id: `e_${viewEdges.length}`,
      from: fromCanon,
      to: toCanon,
      label,
      category
    })
  }

  // ── Step 5: optional content filters ──────────────────────────────────
  let outNodes = viewNodes
  let outEdges = viewEdges
  if (filters.hideBash) {
    // Drop entities whose only producer is bash and which have no outgoing edges.
    const dropped = new Set<string>()
    for (const n of viewNodes) {
      if (n.producedBy === 'bash') {
        const hasOutgoing = viewEdges.some(e => e.from === n.id)
        if (!hasOutgoing) dropped.add(n.id)
      }
    }
    outNodes = outNodes.filter(n => !dropped.has(n.id))
    outEdges = outEdges.filter(e => !dropped.has(e.from) && !dropped.has(e.to))
  }
  if (filters.hideWriteEditOnly) {
    const dropped = new Set<string>()
    for (const n of viewNodes) {
      const allTools = new Set(n.versions.map(v => v.toolCall?.name).filter(Boolean) as string[])
      if (allTools.size > 0 && [...allTools].every(t => t === 'write' || t === 'edit')) {
        dropped.add(n.id)
      }
    }
    outNodes = outNodes.filter(n => !dropped.has(n.id))
    outEdges = outEdges.filter(e => !dropped.has(e.from) && !dropped.has(e.to))
  }

  return { nodes: outNodes, edges: outEdges }
}

// ---------------------------------------------------------------------------
// Tool name → edge category
// ---------------------------------------------------------------------------

export function categorize(toolName: string): EdgeCategory {
  if (toolName === 'write' || toolName === 'edit') return 'edit'
  if (toolName === 'bash') return 'bash'
  if (toolName === 'data_analyze' || toolName === 'generate_diagram' || toolName.startsWith('local-compute')) return 'compute'
  if (toolName === 'web_fetch' || toolName === 'literature-search' || toolName === 'convert_document') return 'fetch'
  if (toolName === 'artifact-create' || toolName === 'artifact-update') return 'memory'
  return 'input'
}

export const CATEGORY_COLOR: Record<EdgeCategory, string> = {
  edit:    '#f59e0b',
  compute: '#a78bfa',
  fetch:   '#60a5fa',
  memory:  '#34d399',
  bash:    '#94a3b8',
  version: '#a78bfa',
  cited:   '#60a5fa',
  input:   '#94a3b8'
}

export const CATEGORY_LABEL: Record<EdgeCategory, string> = {
  edit:    'edit',
  compute: 'compute',
  fetch:   'fetch',
  memory:  'memory',
  bash:    'bash',
  version: 'version',
  cited:   'cited',
  input:   'input'
}
