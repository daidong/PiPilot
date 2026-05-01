/**
 * In-memory provenance graph + queries.
 *
 * Loads all events from graph.jsonl on construction and folds them into a
 * working representation: nodes by id, edges in both directions, plus a few
 * indexes that make capture.ts and the Audit tab cheap.
 *
 * The class is mutable internally — capture.ts calls `applyEvent()` after
 * appending each event to disk so the in-memory state stays in sync — but
 * exposes only read-only queries to the outside world.
 */

import type {
  GraphEvent,
  NodeKind,
  NodeRef,
  ProvenanceEdge,
  ProvenanceNode
} from './types.js'
import { readAllEvents } from './store.js'

// ---------------------------------------------------------------------------
// Subgraph result shape (used by upstream/downstream cone queries)
// ---------------------------------------------------------------------------

export interface Subgraph {
  nodes: ProvenanceNode[]
  edges: ProvenanceEdge[]
}

// ---------------------------------------------------------------------------
// Reference identity — turn a NodeRef into a stable string key
// ---------------------------------------------------------------------------

/**
 * Canonical string key for a NodeRef. Two refs with equal `refKey` represent
 * the same identity (same Memory V2 artifact, same workspace path, etc.).
 * Note: contentHash is *not* part of the key — different content versions of
 * the same file share a refKey but produce distinct nodes.
 */
export function refKey(ref: NodeRef): string {
  switch (ref.kind) {
    case 'memory-artifact':
      return `memory-artifact:${ref.artifactType}/${ref.artifactId}`
    case 'workspace-file':
      return `workspace-file:${ref.path}`
    case 'computation':
      return `computation:${ref.toolCallId}`
    case 'draft':
      return `draft:${ref.path}`
    case 'audit-report':
      return `audit-report:${ref.path}`
  }
}

// ---------------------------------------------------------------------------
// ProvenanceGraph
// ---------------------------------------------------------------------------

export class ProvenanceGraph {
  private readonly nodes = new Map<string, ProvenanceNode>()
  /** All edges, in insertion order. */
  private readonly edges: ProvenanceEdge[] = []
  /** Adjacency: from → edges. */
  private readonly outByFrom = new Map<string, ProvenanceEdge[]>()
  /** Adjacency: to → edges. */
  private readonly inByTo = new Map<string, ProvenanceEdge[]>()
  /** refKey → node ids, in createdAt order (oldest first). */
  private readonly nodesByRef = new Map<string, string[]>()
  /** kind → node ids. */
  private readonly nodesByKind = new Map<NodeKind, string[]>()

  /** Construct from an event stream. Use `load()` for the common case. */
  constructor(events: Iterable<GraphEvent> = []) {
    for (const ev of events) this.applyEvent(ev)
  }

  /** Load the project's graph from disk. */
  static async load(projectPath: string): Promise<ProvenanceGraph> {
    const events = await readAllEvents(projectPath)
    return new ProvenanceGraph(events)
  }

  // -------------------------------------------------------------------------
  // Mutation (used by capture.ts after appending each event to disk)
  // -------------------------------------------------------------------------

  applyEvent(ev: GraphEvent): void {
    switch (ev.type) {
      case 'node':       return this.addNode(ev.node)
      case 'edge':       return this.addEdge(ev.edge)
      case 'node-update': return this.patchNode(ev.id, ev.patch)
    }
  }

  private addNode(node: ProvenanceNode): void {
    if (this.nodes.has(node.id)) return // append-only logs may replay; idempotent
    this.nodes.set(node.id, node)

    const rk = refKey(node.ref)
    const list = this.nodesByRef.get(rk) ?? []
    list.push(node.id)
    this.nodesByRef.set(rk, list)

    const klist = this.nodesByKind.get(node.kind) ?? []
    klist.push(node.id)
    this.nodesByKind.set(node.kind, klist)
  }

  private addEdge(edge: ProvenanceEdge): void {
    this.edges.push(edge)
    pushTo(this.outByFrom, edge.from, edge)
    pushTo(this.inByTo, edge.to, edge)
  }

  private patchNode(id: string, patch: Partial<Pick<ProvenanceNode, 'lastSeenAt' | 'drift'>>): void {
    const node = this.nodes.get(id)
    if (!node) return
    if (patch.lastSeenAt !== undefined) node.lastSeenAt = patch.lastSeenAt
    if (patch.drift !== undefined) node.drift = patch.drift
  }

  // -------------------------------------------------------------------------
  // Reads — nodes
  // -------------------------------------------------------------------------

  getNode(id: string): ProvenanceNode | null {
    return this.nodes.get(id) ?? null
  }

  /** Total node count. */
  nodeCount(): number {
    return this.nodes.size
  }

  /** Iterate all nodes. */
  allNodes(): ProvenanceNode[] {
    return Array.from(this.nodes.values())
  }

  /** All nodes of a given kind. */
  findByKind(kind: NodeKind): ProvenanceNode[] {
    const ids = this.nodesByKind.get(kind) ?? []
    return ids.map(id => this.nodes.get(id)!).filter(Boolean)
  }

  /**
   * Find nodes matching a NodeRef, optionally filtered by contentHash.
   *
   * Used by the find-or-create resolver in capture.ts:
   *   - same ref + same contentHash → existing node (idempotent re-capture)
   *   - same ref + different contentHash → distinct node (a new version)
   *   - same ref + no contentHash on either → existing node (computation, audit-report)
   *
   * Returns matches in createdAt order (oldest first).
   */
  findByRef(ref: NodeRef, contentHash?: string): ProvenanceNode[] {
    const ids = this.nodesByRef.get(refKey(ref)) ?? []
    const matches: ProvenanceNode[] = []
    for (const id of ids) {
      const n = this.nodes.get(id)!
      if (contentHash === undefined) {
        // Caller doesn't care about content; refKey match is enough.
        matches.push(n)
        continue
      }
      // Caller has a content hash; require equality (or absence on the node).
      if (n.snapshot?.contentHash === contentHash) matches.push(n)
    }
    return matches
  }

  /**
   * Latest draft node, optionally for a specific file path. Returns the most
   * recently created draft (by createdAt) — used by Audit's default scope.
   */
  latestDraft(path?: string): ProvenanceNode | null {
    const drafts = this.findByKind('draft')
    const filtered = path === undefined
      ? drafts
      : drafts.filter(n => n.ref.kind === 'draft' && n.ref.path === path)
    if (filtered.length === 0) return null
    return filtered.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
  }

  // -------------------------------------------------------------------------
  // Reads — edges
  // -------------------------------------------------------------------------

  getOutgoing(id: string): ProvenanceEdge[] {
    return this.outByFrom.get(id) ?? []
  }

  getIncoming(id: string): ProvenanceEdge[] {
    return this.inByTo.get(id) ?? []
  }

  edgeCount(): number {
    return this.edges.length
  }

  // -------------------------------------------------------------------------
  // Cone queries (BFS over edges)
  // -------------------------------------------------------------------------

  /**
   * Upstream cone: all ancestors reachable by walking edges *backwards*
   * (descendant → ancestor). Includes the root nodes themselves.
   *
   * `maxDepth = undefined` walks until exhaustion (per axiom A1; the auditor
   * decides depth, not the system).
   */
  getUpstreamCone(rootIds: string[], maxDepth?: number): Subgraph {
    return this.cone(rootIds, 'upstream', maxDepth)
  }

  /** Downstream cone: descendants reachable by walking edges *forwards*. */
  getDownstreamCone(rootIds: string[], maxDepth?: number): Subgraph {
    return this.cone(rootIds, 'downstream', maxDepth)
  }

  private cone(rootIds: string[], direction: 'upstream' | 'downstream', maxDepth?: number): Subgraph {
    const visited = new Set<string>()
    const collectedEdges = new Set<ProvenanceEdge>()
    type Frame = { id: string; depth: number }
    const queue: Frame[] = []

    for (const id of rootIds) {
      if (this.nodes.has(id)) {
        visited.add(id)
        queue.push({ id, depth: 0 })
      }
    }

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!
      if (maxDepth !== undefined && depth >= maxDepth) continue
      const edges = direction === 'upstream' ? this.getIncoming(id) : this.getOutgoing(id)
      for (const e of edges) {
        collectedEdges.add(e)
        const next = direction === 'upstream' ? e.from : e.to
        if (!visited.has(next) && this.nodes.has(next)) {
          visited.add(next)
          queue.push({ id: next, depth: depth + 1 })
        }
      }
    }

    return {
      nodes: Array.from(visited).map(id => this.nodes.get(id)!),
      edges: Array.from(collectedEdges)
    }
  }

  // -------------------------------------------------------------------------
  // Audit-relevant queries
  // -------------------------------------------------------------------------

  /**
   * Workspace-file nodes with no incoming `derived-from` edge from a
   * `computation` node. These represent files whose origin is not tracked —
   * typically files written by `bash` subprocesses, files the user
   * produced manually outside the agent, or data prepared on another
   * machine. They are NOT findings by themselves; the auditor (paper-
   * centric since 2026-05) searches the workspace for evidence either way.
   * This API stays around for diagnostics and Audit-tab badging.
   */
  findOrphanWorkspaceFiles(): ProvenanceNode[] {
    const out: ProvenanceNode[] = []
    for (const node of this.findByKind('workspace-file')) {
      const incoming = this.getIncoming(node.id)
      const hasTrackedProducer = incoming.some(e => {
        if (e.role !== 'derived-from') return false
        const from = this.nodes.get(e.from)
        return from?.kind === 'computation'
      })
      if (!hasTrackedProducer) out.push(node)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? []
  list.push(value)
  map.set(key, list)
}
