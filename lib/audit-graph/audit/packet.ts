import type { AuditGraph, GraphEdge, GraphNode } from '../types.js'
import { buildGraphIndex, classifyEdge } from '../graph-utils.js'
import type { Claim, EvidenceNode, EvidencePacket } from './types.js'

export interface BuildPacketOptions {
  maxNodes?: number
  radius?: number
}

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

function findBlobRef(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (typeof (value as { contentHash?: unknown }).contentHash === 'string') {
    return (value as { contentHash: string }).contentHash
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBlobRef(item)
      if (found) return found
    }
    return undefined
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findBlobRef(child)
    if (found) return found
  }
  return undefined
}

function isTruncated(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if ((value as { redactionLevel?: unknown }).redactionLevel === 'size-cap') return true
  if (Array.isArray(value)) return value.some(isTruncated)
  return Object.values(value as Record<string, unknown>).some(isTruncated)
}

function nodeExcerpt(n: GraphNode): { excerpt: string; truncated: boolean; blobHash?: string } {
  const bodies = n.rawEvents?.map(e => `[${e.name}] ${e.body}`).filter(Boolean) ?? []
  const excerpt = bodies.length > 0
    ? bodies.join('\n\n').slice(0, 4096)
    : [
        n.label,
        n.path ? `path: ${n.path}` : '',
        n.title ? `title: ${n.title}` : '',
        n.toolName ? `tool: ${n.toolName}` : '',
      ].filter(Boolean).join('\n')

  let truncated = false
  let blobHash: string | undefined
  for (const ev of n.rawEvents ?? []) {
    const parsed = tryParseJson(ev.body)
    if (isTruncated(parsed)) truncated = true
    blobHash = blobHash ?? findBlobRef(parsed)
  }
  return { excerpt, truncated, blobHash }
}

function toEvidenceNode(n: GraphNode): EvidenceNode {
  const { excerpt, truncated, blobHash } = nodeExcerpt(n)
  return {
    id: n.id,
    kind: n.kind,
    label: n.label,
    excerpt,
    truncated,
    ...(blobHash && { blobHash }),
    ...(n.path && { path: n.path }),
  }
}

function traversableFrom(nodeId: string, graph: AuditGraph): GraphEdge[] {
  const { nodeById, incoming, outgoing } = buildGraphIndex(graph)
  const node = nodeById.get(nodeId)
  if (!node) return []
  const edges: GraphEdge[] = []

  for (const e of incoming.get(nodeId) ?? []) {
    const cls = classifyEdge(e.rel)
    if (cls === 'data-out' || cls === 'data-in' || cls === 'control' || e.rel === 'returns') edges.push(e)
  }
  for (const e of outgoing.get(nodeId) ?? []) {
    const cls = classifyEdge(e.rel)
    if (cls === 'data-in' || cls === 'data-out' || cls === 'control' || e.rel === 'returns') edges.push(e)
  }
  return edges
}

export function buildEvidencePacket(
  claim: Claim,
  graph: AuditGraph,
  opts: BuildPacketOptions = {},
): EvidencePacket {
  const maxNodes = opts.maxNodes ?? 24
  const radius = opts.radius ?? 2
  const { nodeById } = buildGraphIndex(graph)
  // Start at every anchor and let the bidirectional traversal pull both the
  // input (reads/retrieved) and product (writes/creates) sides into the packet.
  // Type no longer routes evidence-side — the judge sees both and decides.
  const startIds = claim.anchors.map(a => a.nodeId)

  const selected = new Set<string>()
  const selectedEdges = new Map<string, GraphEdge>()
  const queue: Array<{ id: string; depth: number }> = []
  for (const id of startIds) {
    if (!nodeById.has(id)) continue
    selected.add(id)
    queue.push({ id, depth: 0 })
  }

  while (queue.length > 0 && selected.size < maxNodes) {
    const current = queue.shift()
    if (!current || current.depth >= radius) continue
    for (const edge of traversableFrom(current.id, graph)) {
      const other = edge.source === current.id ? edge.target as string : edge.source as string
      if (!nodeById.has(other)) continue
      selectedEdges.set(`${edge.source}\u0000${edge.target}\u0000${edge.rel}`, edge)
      if (!selected.has(other)) {
        if (selected.size >= maxNodes) break
        selected.add(other)
        queue.push({ id: other, depth: current.depth + 1 })
      }
    }
  }

  const nodes = [...selected]
    .map(id => nodeById.get(id))
    .filter((n): n is GraphNode => !!n)
    .map(toEvidenceNode)

  return {
    claimId: claim.id,
    nodes,
    edges: [...selectedEdges.values()].filter(e => selected.has(e.source as string) && selected.has(e.target as string)),
    expandable: nodes.filter(n => n.truncated && n.blobHash).map(n => n.id),
  }
}
