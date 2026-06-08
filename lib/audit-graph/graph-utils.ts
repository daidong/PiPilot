import type { EdgeRel, GraphEdge, GraphNode } from './types.js'

export type EdgeClass =
  | 'structure'
  | 'temporal'
  | 'control'
  | 'observation'
  | 'data-in'
  | 'data-out'

export interface GraphLike {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface GraphIndex {
  nodeIds: Set<string>
  nodeById: Map<string, GraphNode>
  incoming: Map<string, GraphEdge[]>
  outgoing: Map<string, GraphEdge[]>
}

export function classifyEdge(rel: EdgeRel): EdgeClass {
  switch (rel) {
    case 'contains':
      return 'structure'
    case 'precedes':
      return 'temporal'
    case 'invokes':
    case 'sub-llm':
      return 'control'
    case 'returns':
      return 'observation'
    case 'reads':
    case 'retrieved':
    case 'listed':
    case 'mentions':
      return 'data-in'
    case 'writes':
    case 'creates':
      return 'data-out'
  }
}

export function edgeKey(e: Pick<GraphEdge, 'source' | 'target' | 'rel'>): string {
  return `${String(e.source)}\u0000${String(e.target)}\u0000${e.rel}`
}

export function buildGraphIndex(graph: GraphLike): GraphIndex {
  const nodeIds = new Set(graph.nodes.map(n => n.id))
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]))
  const incoming = new Map<string, GraphEdge[]>()
  const outgoing = new Map<string, GraphEdge[]>()

  for (const e of graph.edges) {
    if (!nodeIds.has(e.source as string) || !nodeIds.has(e.target as string)) continue
    const into = incoming.get(e.target as string)
    if (into) into.push(e); else incoming.set(e.target as string, [e])
    const out = outgoing.get(e.source as string)
    if (out) out.push(e); else outgoing.set(e.source as string, [e])
  }

  return { nodeIds, nodeById, incoming, outgoing }
}
