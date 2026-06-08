import type { GraphEdge, GraphNode } from '../../../../../../lib/audit-graph/index'
import {
  buildGraphIndex,
  classifyEdge,
  edgeKey,
  type GraphLike,
} from '../../../../../../lib/audit-graph/graph-utils'

export interface SystemAuditProjection {
  targetStepId: string | null
  targetLabel: string | null
  spineNodes: Set<string>
  spineEdges: Set<string>
  observationNodes: Set<string>
  observationEdges: Set<string>
  inputNodes: Set<string>
  inputEdges: Set<string>
  productNodes: Set<string>
  productEdges: Set<string>
  materialNodes: Set<string>
  materialEdges: Set<string>
  deliverable: {
    claimsSource: string | null
    products: Set<string>
  }
  recoveredFailureNodes: Set<string>
  recoveredFailureEdges: Set<string>
  hiddenBranchNodes: Set<string>
  auditNodes: Set<string>
  auditEdges: Set<string>
}

export { classifyEdge, edgeKey }

function timeOf(n: GraphNode): number {
  const start = Number(n.startNs)
  if (Number.isFinite(start) && start > 0) return start
  return n.stepIndex ?? 0
}

function sameTrace(a: GraphNode | undefined, b: GraphNode | undefined): boolean {
  if (!a || !b) return false
  if (a.traceId && b.traceId) return a.traceId === b.traceId
  return false
}

export function chooseAuditTarget(graph: GraphLike): string | null {
  const steps = graph.nodes.filter(n => n.kind === 'step')
  if (steps.length === 0) return null
  steps.sort((a, b) =>
    timeOf(b) - timeOf(a) ||
    (b.stepIndex ?? -1) - (a.stepIndex ?? -1) ||
    b.id.localeCompare(a.id),
  )
  return steps[0]?.id ?? null
}

export function buildSystemAuditProjection(
  graph: GraphLike,
  targetStepId = chooseAuditTarget(graph),
): SystemAuditProjection {
  const { nodeById, incoming, outgoing } = buildGraphIndex(graph)

  const target = targetStepId ? nodeById.get(targetStepId) : undefined
  const targetStepIndex = target?.stepIndex ?? Number.MAX_SAFE_INTEGER

  const spineNodes = new Set<string>()
  const spineEdges = new Set<string>()
  if (target?.kind === 'step') {
    for (const n of graph.nodes) {
      if (
        n.kind === 'step' &&
        sameTrace(n, target) &&
        (n.stepIndex ?? Number.MAX_SAFE_INTEGER) <= targetStepIndex
      ) {
        spineNodes.add(n.id)
      }
    }
    for (const e of graph.edges) {
      if (e.rel === 'precedes' && spineNodes.has(e.source as string) && spineNodes.has(e.target as string)) {
        spineEdges.add(edgeKey(e))
      }
    }
  }

  const observationNodes = new Set<string>()
  const observationEdges = new Set<string>()
  const inputNodes = new Set<string>()
  const inputEdges = new Set<string>()
  const productNodes = new Set<string>()
  const productEdges = new Set<string>()
  const materialNodes = new Set<string>()
  const materialEdges = new Set<string>()
  const recoveredFailureNodes = new Set<string>()
  const recoveredFailureEdges = new Set<string>()

  const stepByObservation = new Map<string, GraphNode>()
  for (const stepId of spineNodes) {
    const step = nodeById.get(stepId)
    if (!step) continue
    for (const e of incoming.get(stepId) ?? []) {
      if (e.rel !== 'returns') continue
      const tool = nodeById.get(e.source as string)
      if (!tool || (tool.kind !== 'tool' && tool.kind !== 'chat' && tool.kind !== 'span')) continue
      stepByObservation.set(tool.id, step)
    }
  }

  const hasConsumedMaterialOutput = (toolId: string): boolean => {
    for (const out of outgoing.get(toolId) ?? []) {
      if (classifyEdge(out.rel) !== 'data-out') continue
      const objectId = out.target as string
      for (const consumed of outgoing.get(objectId) ?? []) {
        if (classifyEdge(consumed.rel) === 'data-in') return true
      }
    }
    return false
  }

  const hasLaterSuccessfulObservation = (step: GraphNode): boolean => {
    const idx = step.stepIndex ?? -1
    for (const [toolId, returnedStep] of stepByObservation) {
      if ((returnedStep.stepIndex ?? -1) <= idx) continue
      const tool = nodeById.get(toolId)
      if (tool && !tool.isError) return true
    }
    return false
  }

  for (const [toolId, returnedStep] of stepByObservation) {
    const tool = nodeById.get(toolId)
    if (!tool) continue
    const isRecoveredFailure =
      tool.kind === 'tool' &&
      !!tool.isError &&
      !hasConsumedMaterialOutput(tool.id) &&
      hasLaterSuccessfulObservation(returnedStep)

    const returnEdge = (outgoing.get(tool.id) ?? []).find(e => e.rel === 'returns' && e.target === returnedStep.id)
    const invokeEdge = (incoming.get(tool.id) ?? []).find(e => e.rel === 'invokes' && spineNodes.has(e.source as string))

    if (isRecoveredFailure) {
      recoveredFailureNodes.add(tool.id)
      if (returnEdge) recoveredFailureEdges.add(edgeKey(returnEdge))
      if (invokeEdge) recoveredFailureEdges.add(edgeKey(invokeEdge))
      continue
    }

    observationNodes.add(tool.id)
    if (returnEdge) observationEdges.add(edgeKey(returnEdge))
    if (invokeEdge) observationEdges.add(edgeKey(invokeEdge))

    for (const e of incoming.get(tool.id) ?? []) {
      if (classifyEdge(e.rel) !== 'data-in') continue
      const objectId = e.source as string
      inputNodes.add(objectId)
      inputEdges.add(edgeKey(e))
      materialNodes.add(objectId)
      materialEdges.add(edgeKey(e))
    }
    for (const e of outgoing.get(tool.id) ?? []) {
      if (classifyEdge(e.rel) !== 'data-out') continue
      const objectId = e.target as string
      productNodes.add(objectId)
      productEdges.add(edgeKey(e))
      materialNodes.add(objectId)
      materialEdges.add(edgeKey(e))
    }
  }

  // If a material object is displayed, also show its producer/consumer edges
  // when they are inside this trace's observed surface.
  for (const objectId of [...materialNodes]) {
    for (const e of incoming.get(objectId) ?? []) {
      if (classifyEdge(e.rel) === 'data-out' && observationNodes.has(e.source as string)) {
        materialEdges.add(edgeKey(e))
      }
    }
    for (const e of outgoing.get(objectId) ?? []) {
      if (classifyEdge(e.rel) === 'data-in' && observationNodes.has(e.target as string)) {
        materialEdges.add(edgeKey(e))
      }
    }
  }

  const auditNodes = new Set<string>([
    ...spineNodes,
    ...observationNodes,
    ...materialNodes,
  ])
  const auditEdges = new Set<string>([
    ...spineEdges,
    ...observationEdges,
    ...materialEdges,
  ])

  const hiddenBranchNodes = new Set<string>()
  for (const n of graph.nodes) {
    if (!auditNodes.has(n.id) && !recoveredFailureNodes.has(n.id)) hiddenBranchNodes.add(n.id)
  }

  return {
    targetStepId: targetStepId ?? null,
    targetLabel: target?.label ?? targetStepId ?? null,
    spineNodes,
    spineEdges,
    observationNodes,
    observationEdges,
    inputNodes,
    inputEdges,
    productNodes,
    productEdges,
    materialNodes,
    materialEdges,
    deliverable: {
      claimsSource: targetStepId ?? null,
      products: productNodes,
    },
    recoveredFailureNodes,
    recoveredFailureEdges,
    hiddenBranchNodes,
    auditNodes,
    auditEdges,
  }
}
