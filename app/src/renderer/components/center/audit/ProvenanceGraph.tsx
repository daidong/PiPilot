/**
 * Timeline render of the provenance projection.
 *
 * The math here (support slice BFS, taint propagation, importance scoring,
 * zoom-gated labels, tinted contamination) is identical to the prototype
 * proven on real telemetry; the chrome around it is rewritten to match
 * the project's theme tokens (no custom OKLCH neutrals, no hardcoded
 * dark-only colors).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, Maximize2 } from 'lucide-react'
import ForceGraph2D from 'react-force-graph-2d'
import type {
  AuditGraph,
  EdgeRel,
  GraphEdge,
  GraphNode,
  NodeKind,
} from '../../../../../../lib/audit-graph/index'
import { useAuditPalette, tintToward } from './audit-theme'
import { pruneGraph, edgeCausalClass } from '../../../../../../lib/audit-graph/prune'
import type { StepSupportMetric } from '../../../../../../lib/audit-graph/prune'
import { edgeKey } from '../../../../../../lib/audit-graph/graph-utils'

// —— Importance + radius priors ————————————————————————————————————————

const BASE_RADIUS: Record<NodeKind, number> = {
  session: 8, trace: 7, step: 4, tool: 4, chat: 3, artifact: 6, file: 4, dir: 3.5, span: 3, skill: 5,
}
const KIND_WEIGHT: Record<NodeKind, number> = {
  artifact: 6, file: 4, tool: 2.5, trace: 2, dir: 1.5, step: 0.5, chat: 0.2, session: 1, span: 0.5, skill: 3,
}
const CAUSAL: ReadonlySet<EdgeRel> = new Set([
  'precedes', 'invokes', 'returns', 'sub-llm', 'reads', 'writes', 'creates', 'retrieved', 'mentions', 'listed', 'applies',
])

type RenderNode = GraphNode & {
  x?: number
  y?: number
  fx?: number
  fy?: number
  __layoutTraceId?: string
}

type RenderLink = Omit<GraphEdge, 'source' | 'target'> & {
  source: string | RenderNode
  target: string | RenderNode
}

interface RenderGraph {
  nodes: RenderNode[]
  links: RenderLink[]
}

const STEP_GAP = 86
const TRACK_GAP = 58
const TRACE_ROW_GAP = 390

function nodeTime(n: GraphNode): number {
  const t = Number(n.startNs)
  return Number.isFinite(t) && t > 0 ? t : Number.MAX_SAFE_INTEGER
}

function edgeSourceId(e: RenderLink): string {
  return typeof e.source === 'object' ? e.source.id : e.source
}

function edgeTargetId(e: RenderLink): string {
  return typeof e.target === 'object' ? e.target.id : e.target
}

function fixedNode(n: RenderNode, x: number, y: number): RenderNode {
  return { ...n, x, y, fx: x, fy: y }
}

function layoutProvenanceGraph(filtered: RenderGraph): RenderGraph {
  const links = filtered.links.map(e => ({ ...e }))
  const connected = new Map<string, RenderLink[]>()
  for (const e of links) {
    const s = edgeSourceId(e)
    const t = edgeTargetId(e)
    const a = connected.get(s); if (a) a.push(e); else connected.set(s, [e])
    const b = connected.get(t); if (b) b.push(e); else connected.set(t, [e])
  }

  const inferredTrace = new Map<string, string>()
  for (const n of filtered.nodes) {
    if (n.traceId) inferredTrace.set(n.id, n.traceId)
    else if (n.kind === 'trace') inferredTrace.set(n.id, n.id.replace(/^trace:/, ''))
  }
  let changed = true
  while (changed) {
    changed = false
    for (const e of links) {
      const s = edgeSourceId(e)
      const t = edgeTargetId(e)
      const st = inferredTrace.get(s)
      const tt = inferredTrace.get(t)
      if (st && !tt) { inferredTrace.set(t, st); changed = true }
      if (tt && !st) { inferredTrace.set(s, tt); changed = true }
    }
  }

  const traceIds = [...new Set([...inferredTrace.values()])]
    .sort((a, b) => {
      const ta = Math.min(...filtered.nodes.filter(n => inferredTrace.get(n.id) === a).map(nodeTime))
      const tb = Math.min(...filtered.nodes.filter(n => inferredTrace.get(n.id) === b).map(nodeTime))
      return ta - tb || a.localeCompare(b)
    })
  if (traceIds.length === 0) traceIds.push('__untraced__')

  const placed = new Map<string, RenderNode>()
  const toolOwnerStep = new Map<string, string>()
  for (const e of links) {
    if (e.rel === 'invokes') toolOwnerStep.set(edgeTargetId(e), edgeSourceId(e))
  }

  for (const [traceOrdinal, traceId] of traceIds.entries()) {
    const traceNodes = filtered.nodes
      .filter(n => (inferredTrace.get(n.id) ?? '__untraced__') === traceId)
      .sort((a, b) => nodeTime(a) - nodeTime(b) || a.id.localeCompare(b.id))
    const steps = traceNodes
      .filter(n => n.kind === 'step')
      .sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0) || nodeTime(a) - nodeTime(b))
    const baseY = (traceOrdinal - (traceIds.length - 1) / 2) * TRACE_ROW_GAP
    const stepIndex = new Map<string, number>()
    const stepX = new Map<string, number>()
    steps.forEach((step, i) => {
      const x = (i - Math.max(0, steps.length - 1) / 2) * STEP_GAP
      stepIndex.set(step.id, i)
      stepX.set(step.id, x)
      placed.set(step.id, fixedNode(step, x, baseY))
    })

    const fallbackColumn = (n: RenderNode) => {
      if (steps.length === 0) {
        const i = traceNodes.indexOf(n)
        return (i - Math.max(0, traceNodes.length - 1) / 2) * STEP_GAP
      }
      const byTime = steps.findIndex(s => nodeTime(s) >= nodeTime(n))
      const i = byTime >= 0 ? byTime : steps.length - 1
      return stepX.get(steps[i].id) ?? 0
    }

    const laneUse = new Map<string, number>()
    const nextLane = (x: number, lanes: number[]) => {
      const key = String(Math.round(x / 18))
      const used = laneUse.get(key) ?? 0
      laneUse.set(key, used + 1)
      return lanes[used % lanes.length] + Math.trunc(used / lanes.length) * Math.sign(lanes[used % lanes.length] || 1)
    }

    for (const n of traceNodes) {
      if (placed.has(n.id)) continue
      if (n.kind === 'trace' || n.kind === 'session') {
        const x = (steps.length ? -((steps.length - 1) / 2) * STEP_GAP : 0) - 115
        placed.set(n.id, fixedNode(n, x, baseY - TRACK_GAP * 1.7))
      }
    }

    const tools = traceNodes
      .filter(n => n.kind === 'tool' || n.kind === 'chat' || n.kind === 'span')
      .sort((a, b) => nodeTime(a) - nodeTime(b) || a.id.localeCompare(b.id))
    for (const n of tools) {
      if (placed.has(n.id)) continue
      const owner = toolOwnerStep.get(n.id)
      const x = owner && stepX.has(owner) ? (stepX.get(owner) ?? 0) + STEP_GAP * 0.38 : fallbackColumn(n)
      const lanes = n.kind === 'chat' ? [-2.3, 2.3, -3.2, 3.2] : [-1, 1, -1.9, 1.9]
      const lane = nextLane(x, lanes)
      placed.set(n.id, fixedNode(n, x, baseY + lane * TRACK_GAP))
    }

    const outer = traceNodes
      .filter(n => !placed.has(n.id))
      .sort((a, b) => {
        const aTool = (connected.get(a.id) ?? []).map(e => placed.get(edgeSourceId(e)) ?? placed.get(edgeTargetId(e))).find(Boolean)
        const bTool = (connected.get(b.id) ?? []).map(e => placed.get(edgeSourceId(e)) ?? placed.get(edgeTargetId(e))).find(Boolean)
        return (aTool?.x ?? 0) - (bTool?.x ?? 0) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
      })
    for (const n of outer) {
      const anchorEdge = (connected.get(n.id) ?? []).find(e => placed.has(edgeSourceId(e)) || placed.has(edgeTargetId(e)))
      const anchor = anchorEdge ? (placed.get(edgeSourceId(anchorEdge)) ?? placed.get(edgeTargetId(anchorEdge))) : undefined
      const rel = anchorEdge?.rel
      const direction =
        rel === 'writes' || rel === 'creates'
          ? 1
          : rel === 'reads' || rel === 'retrieved' || rel === 'listed' || rel === 'mentions'
            ? -1
            : 0
      const x = (anchor?.x ?? fallbackColumn(n)) + direction * STEP_GAP * 0.62
      const lanes = n.kind === 'artifact'
        ? [2.9, 3.8, -3.8]
        : n.kind === 'file' || n.kind === 'dir'
          ? [-2.9, 2.9, -3.8, 3.8]
          : [-2.4, 2.4, -3.2, 3.2]
      const lane = nextLane(x, lanes)
      placed.set(n.id, fixedNode(n, x, baseY + lane * TRACK_GAP))
    }
  }

  for (const n of filtered.nodes) {
    if (placed.has(n.id)) continue
    const i = placed.size
    placed.set(n.id, fixedNode(n, (i % 8) * STEP_GAP, TRACE_ROW_GAP + Math.floor(i / 8) * TRACK_GAP))
  }

  return {
    nodes: filtered.nodes.map(n => ({
      ...(placed.get(n.id) ?? n),
      __layoutTraceId: inferredTrace.get(n.id),
    })),
    links,
  }
}

// —— Public props ————————————————————————————————————————————————————

export interface ProvenanceGraphProps {
  graph: AuditGraph
  selected: GraphNode | null
  onSelect: (node: GraphNode | null) => void
  taint: Record<string, { reason: string; ts: number }>
  /** Machine-derived suspicion scores — nodes flagged without user action. */
  autoSuspect?: Map<string, string[]>
  filters: {
    hideContains: boolean
    hideWikiBg: boolean
    selectedTraceId: string | null
    kinds: Set<NodeKind>
  }
  /** Imperative focus — parent calls this when user picks a node from a list. */
  focusRef?: React.MutableRefObject<((node: GraphNode) => void) | null>
  /** Nodes with current provenance search hits. Purely visual. */
  searchMatchNodeIds?: Set<string>
  /** Active provenance search hit node. Purely visual. */
  activeSearchNodeId?: string | null
  /** Bubble support/critical membership up so the side panel can show stats. */
  onSliceChange?: (slice: {
    nodes: Set<string>
    derivedTaint: Set<string>
    prune?: {
      on: boolean
      terminalStepId: string | null
      terminalLabel: string | null
      keptNodes: number
      prunedNodes: number
      flaggedNodes: number
      spineNodes: number
      metric: StepSupportMetric | null
      edgeClasses: { causal: number; temporal: number; structural: number }
      nodeRoles: { container: number; step: number; tool: number; artifact: number; file: number; skill: number }
    }
  }) => void
}

// —— Component ————————————————————————————————————————————————————————

export function ProvenanceGraph({
  graph, selected, onSelect, taint, autoSuspect, filters, focusRef, onSliceChange, searchMatchNodeIds, activeSearchNodeId,
}: ProvenanceGraphProps) {
  const palette = useAuditPalette()
  const fgRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  // Prune is a *view toggle* on the full graph: off → the graph as-is; on →
  // the deterministically-pruned set is greyed (never removed) and the critical
  // path is highlighted. Default off so the user first sees everything.
  const [prune, setPrune] = useState(false)

  // —— Resize observer ——
  useLayoutEffect(() => {
    if (!containerRef.current) return
    const el = containerRef.current
    const measure = () => {
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) setSize({ w, h })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  // —— Filter view ——
  // Background traces (wiki-bg etc.) are noise for audit and they wreck the
  // force layout because they're disconnected from the main lineage cluster —
  // zoomToFit then pulls way out to fit them, leaving the real graph tiny.
  const filtered = useMemo(() => {
    const traceLabelOf = (id: string) =>
      graph.nodes.find(n => n.id === `trace:${id}`)?.label || ''
    const isBg = (n: GraphNode) =>
      filters.hideWikiBg &&
      ((n.kind === 'trace' && /wiki-bg/.test(n.label)) ||
        ((n.kind === 'chat' || n.kind === 'step' || n.kind === 'tool') && n.traceId && /wiki-bg/.test(traceLabelOf(n.traceId))))
    const inTrace = (n: GraphNode) => {
      if (!filters.selectedTraceId) return true
      if (n.kind === 'session') return false
      return n.traceId === filters.selectedTraceId
    }
    let visible = graph.nodes.filter(n => filters.kinds.has(n.kind) && !isBg(n) && inTrace(n))
    // "Telemetry has data → it must display." The default Hide-background-traces
    // filter can hide *everything* for a project whose telemetry is all
    // background (wiki / literature) activity — leaving a confusing blank canvas
    // even though presence reported data. If the active filters would blank the
    // canvas while the graph actually has nodes, fall back to showing the graph
    // (background included) rather than nothing.
    if (visible.length === 0 && graph.nodes.length > 0) {
      visible = graph.nodes.filter(n => filters.kinds.has(n.kind))
    }
    const visibleIds = new Set(visible.map(n => n.id))
    const links = graph.edges.filter(e => {
      if (filters.hideContains && e.rel === 'contains') return false
      return visibleIds.has(e.source as string) && visibleIds.has(e.target as string)
    })
    // react-force-graph mutates source/target into node refs at runtime, so we
    // hand it shallow clones to avoid corrupting the upstream data.
    return { nodes: visible.map(n => ({ ...n })), links: links.map(e => ({ ...e })) } as RenderGraph
  }, [graph, filters])

  // Deterministic prune of the *currently filtered* graph. Computed regardless
  // of the toggle so the side panel can show before/after counts; the toggle
  // only controls whether the partition is painted.
  const pruneResult = useMemo(
    () => pruneGraph({ nodes: filtered.nodes, edges: filtered.links as GraphEdge[] }),
    [filtered],
  )
  const prunedNodeSet = useMemo(() => new Set(pruneResult.prunedNodes), [pruneResult])
  const keptEdgeSet = useMemo(() => new Set(pruneResult.keptEdges), [pruneResult])

  const layouted = useMemo(() => layoutProvenanceGraph(filtered), [filtered])
  // Prune never removes nodes — the full filtered graph is always displayed.
  const displayed = layouted

  // —— Force tuning ——
  // Provenance is a causal timeline, so nodes are fixed onto tracks instead
  // of left to settle into a force-directed knot. Link force remains present
  // only so react-force-graph can run its lifecycle and draw arrows.
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    fg.d3Force('charge')?.strength(-20)
    fg.d3Force('link')?.distance((l: any) => (l.rel === 'contains' ? 90 : 58))
  }, [displayed])

  // Largest causal-connected component. zoomToFit fits only these nodes so
  // a couple of stragglers don't shrink the main graph into a postage stamp.
  const mainComponentIds = useMemo(() => {
    const nodeIds = new Set<string>(displayed.nodes.map(n => n.id))
    const adj = new Map<string, Set<string>>()
    for (const id of nodeIds) adj.set(id, new Set())
    for (const e of displayed.links as any[]) {
      if (e.rel === 'contains') continue
      const s = typeof e.source === 'object' ? e.source.id : e.source
      const t = typeof e.target === 'object' ? e.target.id : e.target
      adj.get(s)?.add(t)
      adj.get(t)?.add(s)
    }
    const seen = new Set<string>()
    let largest = new Set<string>()
    for (const id of nodeIds) {
      if (seen.has(id)) continue
      const comp = new Set<string>()
      const stack = [id]
      while (stack.length) {
        const cur = stack.pop()!
        if (comp.has(cur)) continue
        comp.add(cur); seen.add(cur)
        for (const nb of adj.get(cur) ?? []) if (!comp.has(nb)) stack.push(nb)
      }
      if (comp.size > largest.size) largest = comp
    }
    // If the "largest component" is small relative to the whole, fall back to
    // fitting everything — this dataset just doesn't have one dominant cluster.
    if (largest.size < Math.max(8, nodeIds.size * 0.25)) return null
    return largest
  }, [displayed])

  // Auto-fit on initial settle and on filter changes. Triggered when the
  // user enters the tab (size > 0 for the first time) and again whenever
  // the filtered set changes substantively. We fit on every onEngineStop
  // for the *first* fit after a filter change — flag resets each time.
  const needsFitRef = useRef(true)
  useEffect(() => { needsFitRef.current = true }, [displayed])
  // Pass a node filter to zoomToFit so the camera only frames the largest
  // causal-connected component — stragglers don't dominate the calculation.
  const fitFilter = useMemo(() => {
    if (!mainComponentIds) return undefined
    return (n: any) => mainComponentIds.has(n.id)
  }, [mainComponentIds])

  const handleEngineStop = useCallback(() => {
    if (!needsFitRef.current) return
    needsFitRef.current = false
    fgRef.current?.zoomToFit?.(500, 80, fitFilter)
  }, [fitFilter])

  const fitToView = useCallback(() => {
    fgRef.current?.zoomToFit?.(400, 80, fitFilter)
  }, [fitFilter])

  // —— Imperative focus from parent ——
  useEffect(() => {
    if (!focusRef) return
    focusRef.current = (n: GraphNode) => {
      const live = displayed.nodes.find((x: any) => x.id === n.id) as any
      if (live && live.x !== undefined && fgRef.current) {
        fgRef.current.centerAt(live.x, live.y, 600)
        fgRef.current.zoom(2.2, 600)
      }
    }
    return () => { focusRef.current = null }
  }, [focusRef, displayed])

  // —— Importance + label thresholds ——
  const importance = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of displayed.nodes) m.set(n.id, KIND_WEIGHT[n.kind] ?? 1)
    for (const e of displayed.links as any[]) {
      if (e.rel === 'contains' || e.rel === 'sub-llm') continue
      const s = typeof e.source === 'object' ? e.source.id : e.source
      const t = typeof e.target === 'object' ? e.target.id : e.target
      const w = (e.rel === 'creates' || e.rel === 'writes') ? 3 : 1
      m.set(s, (m.get(s) ?? 0) + w)
      m.set(t, (m.get(t) ?? 0) + w)
    }
    return m
  }, [displayed])

  const importanceCutoff = useMemo(() => {
    const vals = [...importance.values()].sort((a, b) => b - a)
    if (vals.length === 0) return 0
    const budget = Math.min(40, Math.max(8, Math.floor(vals.length * 0.15)))
    return vals[Math.min(budget, vals.length - 1)] ?? 0
  }, [importance])

  // Per-node zoom threshold: top 5 unlock at 0.7, 6-15 at 1.0, etc.
  const labelZoomThreshold = useMemo(() => {
    const m = new Map<string, number>()
    const ranked = [...displayed.nodes]
      .map(n => ({ id: n.id, imp: importance.get(n.id) ?? 0 }))
      .sort((a, b) => b.imp - a.imp)
    ranked.forEach((e, i) => {
      let t: number
      if (i < 5) t = 0.7
      else if (i < 15) t = 1.0
      else if (i < 40) t = 1.6
      else if (i < 100) t = 2.2
      else t = 3.0
      m.set(e.id, t)
    })
    return m
  }, [displayed, importance])

  function nodeRadius(n: GraphNode): number {
    const base = BASE_RADIUS[n.kind] ?? 4
    const imp = importance.get(n.id) ?? 0
    return base + Math.min(8, Math.sqrt(imp) * 0.9)
  }

  // —— Support slice (upstream + downstream causal closure from selected) ——
  const highlight = useMemo(() => {
    const hN = new Set<string>()
    const hE = new Set<number>()
    if (!selected) return { nodes: hN, edges: hE }
    hN.add(selected.id)
    const outAdj = new Map<string, Array<{ idx: number; to: string }>>()
    const inAdj  = new Map<string, Array<{ idx: number; from: string }>>()
    const push = <T,>(m: Map<string, T[]>, k: string, v: T) => {
      const a = m.get(k); if (a) a.push(v); else m.set(k, [v])
    }
    graph.edges.forEach((e, idx) => {
      if (!CAUSAL.has(e.rel)) return
      push(outAdj, e.source as string, { idx, to: e.target as string })
      push(inAdj,  e.target as string, { idx, from: e.source as string })
    })
    const upStack = [selected.id]
    while (upStack.length) {
      const cur = upStack.pop()!
      for (const { idx, from } of inAdj.get(cur) ?? []) {
        hE.add(idx)
        if (!hN.has(from)) { hN.add(from); upStack.push(from) }
      }
    }
    const dnStack = [selected.id]
    while (dnStack.length) {
      const cur = dnStack.pop()!
      for (const { idx, to } of outAdj.get(cur) ?? []) {
        hE.add(idx)
        if (!hN.has(to)) { hN.add(to); dnStack.push(to) }
      }
    }
    return { nodes: hN, edges: hE }
  }, [graph, selected])

  // —— Taint propagation (forward closure from any direct-tainted node) ——
  const derivedTaint = useMemo(() => {
    const set = new Set<string>()
    if (Object.keys(taint).length === 0) return set
    const outAdj = new Map<string, string[]>()
    for (const e of graph.edges) {
      if (!CAUSAL.has(e.rel)) continue
      const list = outAdj.get(e.source as string)
      if (list) list.push(e.target as string)
      else outAdj.set(e.source as string, [e.target as string])
    }
    for (const id of Object.keys(taint)) {
      const stack = [id]
      while (stack.length) {
        const cur = stack.pop()!
        for (const to of outAdj.get(cur) ?? []) {
          if (set.has(to) || taint[to]) continue
          set.add(to)
          stack.push(to)
        }
      }
    }
    return set
  }, [graph, taint])

  // —— Tainted edges (both endpoints in closure) ——
  const taintedEdges = useMemo(() => {
    const set = new Set<any>()
    const closure = new Set<string>([...Object.keys(taint), ...derivedTaint])
    if (closure.size === 0) return set
    for (const l of displayed.links as any[]) {
      if (l.rel === 'contains' || l.rel === 'sub-llm') continue
      const s = typeof l.source === 'object' ? l.source.id : l.source
      const t = typeof l.target === 'object' ? l.target.id : l.target
      if (closure.has(s) && closure.has(t)) set.add(l)
    }
    return set
  }, [taint, derivedTaint, displayed])

  // —— Slice-membership set of link OBJECTS for accessor lookups ——
  const highlightLinks = useMemo(() => {
    const set = new Set<any>()
    if (!selected) return set
    displayed.links.forEach((l: any) => {
      const src = typeof l.source === 'object' ? l.source.id : l.source
      const tgt = typeof l.target === 'object' ? l.target.id : l.target
      if (highlight.nodes.has(src) && highlight.nodes.has(tgt) && highlight.nodes.size > 1) set.add(l)
    })
    return set
  }, [displayed, selected, highlight])

  // —— Bubble slice info up ——
  useEffect(() => {
    const terminal = pruneResult.terminalStepId
      ? graph.nodes.find(n => n.id === pruneResult.terminalStepId)
      : undefined
    onSliceChange?.({
      nodes: highlight.nodes,
      derivedTaint,
      prune: {
        on: prune,
        terminalStepId: pruneResult.terminalStepId,
        terminalLabel: terminal?.label ?? pruneResult.terminalStepId,
        keptNodes: pruneResult.keptNodes.length,
        prunedNodes: pruneResult.prunedNodes.length,
        flaggedNodes: Object.keys(pruneResult.flags).length,
        spineNodes: pruneResult.spineNodes.length,
        metric: pruneResult.terminalStepId
          ? pruneResult.supportMetrics[pruneResult.terminalStepId] ?? null
          : null,
        edgeClasses: pruneResult.stageStats.edgeClasses,
        nodeRoles: pruneResult.stageStats.nodeRoles,
      },
    })
  }, [highlight, derivedTaint, pruneResult, prune, graph, onSliceChange])

  // —— Link key + prune membership ——
  const linkKey = (l: any): string => edgeKey({ source: edgeSourceId(l), target: edgeTargetId(l), rel: l.rel })
  // When prune is on and nothing is selected, an edge is "greyed" unless it is
  // on the kept critical-path subgraph. Kept edges only connect kept nodes, so
  // the critical path never routes through grey.
  const isPrunedLink = (l: any): boolean => prune && !selected && !keptEdgeSet.has(linkKey(l))

  // —— Link color accessor (shared between line / arrow / particle) ——
  // Edges are coloured by their Stage-0 causal CLASS, not per-rel: causal edges
  // keep their relation hue (creates/reads/… stay distinguishable), temporal
  // edges (the step timeline) render as a dashed neutral grey, and structural
  // scaffolding (contains/mentions) is barely visible. The right-rail shows the
  // per-class counts as the legend.
  function linkColorFor(l: any, opaque = false): string {
    const cls = edgeCausalClass(l.rel as EdgeRel)
    const base = palette.rel[l.rel as EdgeRel] ?? 'rgba(120,120,120,0.5)'
    if (selected) {
      if (highlightLinks.has(l)) return opaque ? base.replace(/[\d.]+\)$/, '1)') : base.replace(/[\d.]+\)$/, '0.95)')
      return 'rgba(80,80,80,0.06)'
    }
    if (isPrunedLink(l)) return 'rgba(80,80,80,0.06)'
    if (cls === 'structural') return 'rgba(80,80,80,0.06)'
    if (cls === 'temporal') return 'rgba(140,140,150,0.34)'
    return opaque ? base.replace(/[\d.]+\)$/, '1)') : base
  }

  return (
    <div ref={containerRef} className="relative w-full h-full min-w-0 min-h-0 overflow-hidden">
      <ForceGraph2D
        ref={fgRef}
        width={size.w}
        height={size.h}
        graphData={displayed}
        backgroundColor="transparent"
        nodeRelSize={5}
        nodeVal={(n: any) => nodeRadius(n)}
        nodeLabel={(n: any) => {
          const base = `<b>${n.kind}</b>: ${n.label}`
          if (n.kind === 'artifact' && typeof n.citationsTotal === 'number' && n.citationsTotal > 0) {
            const unresolved = n.unresolvedCitations?.length ?? 0
            return base + (unresolved > 0
              ? ` — ⚠ ${unresolved}/${n.citationsTotal} citations not retrieved`
              : ` — ${n.citationsResolved ?? n.citationsTotal}/${n.citationsTotal} citations grounded`)
          }
          return base
        }}
        linkColor={(l: any) => {
          const base = linkColorFor(l)
          return taintedEdges.has(l) ? tintToward(base, palette.taint) : base
        }}
        linkLineDash={(l: any) => {
          if (taintedEdges.has(l)) return [4, 3]
          if (!selected && edgeCausalClass(l.rel as EdgeRel) === 'temporal') return [3, 3]
          return null
        }}
        linkWidth={(l: any) => {
          if (taintedEdges.has(l)) return 1.8
          if (selected) return highlightLinks.has(l) ? 2 : 0.5
          if (isPrunedLink(l)) return 0.4
          return (l.rel === 'creates' || l.rel === 'writes') ? 1.8 : 0.6
        }}
        linkDirectionalArrowLength={(l: any) => {
          if (edgeCausalClass(l.rel as EdgeRel) !== 'causal') return 0
          if (selected) return highlightLinks.has(l) ? 7 : 0
          if (isPrunedLink(l)) return 0
          return (l.rel === 'creates' || l.rel === 'writes') ? 6 : 4
        }}
        linkDirectionalArrowRelPos={0.92}
        linkDirectionalArrowColor={(l: any) => {
          const base = linkColorFor(l, true)
          return taintedEdges.has(l) ? tintToward(base, palette.taint) : base
        }}
        linkDirectionalParticles={(l: any) => {
          if (!selected) return 0
          if (edgeCausalClass(l.rel as EdgeRel) !== 'causal') return 0
          return highlightLinks.has(l) ? 3 : 0
        }}
        linkDirectionalParticleWidth={2.4}
        linkDirectionalParticleSpeed={0.012}
        linkDirectionalParticleColor={(l: any) => {
          const base = linkColorFor(l, true)
          return taintedEdges.has(l) ? tintToward(base, palette.taint) : base
        }}
        nodeCanvasObject={(n: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
          const r = nodeRadius(n)
          const isHi = highlight.nodes.has(n.id)
          const isSel = selected?.id === n.id
          const isSearchMatch = searchMatchNodeIds?.has(n.id) ?? false
          const isActiveSearch = activeSearchNodeId === n.id
          const isDirectTaint = !!taint[n.id]
          const isDerivedTaint = derivedTaint.has(n.id)
          const isAutoSuspect = !isDirectTaint && !isDerivedTaint && (autoSuspect?.has(n.id) ?? false)
          const imp = importance.get(n.id) ?? 0
          const important = imp >= importanceCutoff
          const baseC = palette.kind[n.kind as NodeKind] || '#aaa'
          const fill = isAutoSuspect
            ? tintToward(baseC, palette.taint, 0.55)
            : isDirectTaint
              ? tintToward(baseC, palette.taint, 0.35)
              : isDerivedTaint
                ? tintToward(baseC, palette.taint, 0.2)
                : baseC
          const dim = selected
            ? (!isHi && !isSel && !isSearchMatch)
            : prune ? prunedNodeSet.has(n.id) : !important
          ctx.globalAlpha = dim ? 0.22 : 1
          ctx.beginPath()
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
          ctx.fillStyle = fill
          ctx.fill()
          // Rings:
          //   auto-suspect (machine)  → thick solid red ring
          //   direct taint (user)     → thin dashed red ring (darker)
          //   derived taint (user)    → thin dashed red ring (lighter)
          //   selected                → white ring
          if (isAutoSuspect) {
            ctx.lineWidth = 2.4 / globalScale
            ctx.strokeStyle = `rgb(${palette.taint.join(',')})`
            ctx.setLineDash([])
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 2.5, 0, Math.PI * 2); ctx.stroke()
          } else if (isDirectTaint) {
            ctx.lineWidth = 1.6 / globalScale
            ctx.strokeStyle = `rgba(${palette.taint.join(',')},0.9)`
            ctx.setLineDash([3 / globalScale, 2 / globalScale])
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 2.5, 0, Math.PI * 2); ctx.stroke()
            ctx.setLineDash([])
          } else if (isDerivedTaint) {
            ctx.lineWidth = 1.2 / globalScale
            ctx.strokeStyle = `rgba(${palette.taint.join(',')},0.55)`
            ctx.setLineDash([3 / globalScale, 2 / globalScale])
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 2.5, 0, Math.PI * 2); ctx.stroke()
            ctx.setLineDash([])
          } else if (isSel) {
            ctx.lineWidth = 2 / globalScale
            ctx.strokeStyle = '#fff'
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 2, 0, Math.PI * 2); ctx.stroke()
          }
          if (isSearchMatch) {
            ctx.setLineDash([])
            ctx.lineWidth = (isActiveSearch ? 3 : 1.7) / globalScale
            ctx.strokeStyle = isActiveSearch ? 'rgba(245, 158, 11, 1)' : 'rgba(245, 158, 11, 0.68)'
            ctx.beginPath(); ctx.arc(n.x, n.y, r + (isActiveSearch ? 5 : 4), 0, Math.PI * 2); ctx.stroke()
          }
          // Citation flag (A1) — amber badge at top-right of artifacts that cite
          // never-retrieved sources. Deliberately a different visual language
          // than the red taint rings: this is an automatic "verify these
          // references" cue, not a user-marked suspect. A canvasLabel-colored
          // halo keeps the dot legible on any node fill / theme.
          if (n.kind === 'artifact' && Array.isArray(n.unresolvedCitations) && n.unresolvedCitations.length > 0) {
            const bx = n.x + r * 0.72
            const by = n.y - r * 0.72
            const br = Math.max(2.2, r * 0.46)
            ctx.setLineDash([])
            ctx.beginPath(); ctx.arc(bx, by, br + 1 / globalScale, 0, Math.PI * 2)
            ctx.fillStyle = palette.canvasLabel; ctx.fill()
            ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2)
            ctx.fillStyle = palette.warn; ctx.fill()
          }
          // Label gating: per-node zoom threshold from importance rank
          const zoomThresh = labelZoomThreshold.get(n.id) ?? 3.0
          const labelable = isSel || isHi || globalScale >= zoomThresh
          if (labelable) {
            // Match the project's UI font (Inter, loaded via @font-face) so the
            // canvas chrome doesn't clash with the side rails. Slight optical
            // bump on the floor (11px) for readability when zoomed far out.
            ctx.font = `500 ${Math.max(11, 12 / globalScale)}px Inter, system-ui, -apple-system, sans-serif`
            ctx.fillStyle = palette.canvasLabel
            ctx.textAlign = 'left'
            ctx.fillText(String(n.label).slice(0, 40), n.x + r + 2, n.y + 3)
          }
          ctx.globalAlpha = 1
        }}
        nodePointerAreaPaint={(n: any, color: string, ctx: CanvasRenderingContext2D) => {
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(n.x, n.y, nodeRadius(n) + 4, 0, Math.PI * 2)
          ctx.fill()
        }}
        onNodeClick={(n: any) => onSelect(n as GraphNode)}
        onBackgroundClick={() => onSelect(null)}
        cooldownTicks={1}
        onEngineStop={handleEngineStop}
      />
      <div className="absolute top-3 left-3 flex items-center gap-1 rounded-md border t-border-subtle t-bg-elevated shadow-sm p-1">
        <button
          onClick={() => setPrune(p => !p)}
          title={prune ? 'Showing pruned graph — click to show the full graph' : 'Prune: grey everything off the critical path'}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
            prune ? 't-bg-accent-2-muted t-text' : 't-text-muted hover:t-text-secondary'
          }`}
        >
          <GitBranch size={12} />
          Prune
        </button>
        {prune && (
          <span
            title="Kept on the critical path · greyed off it"
            className="ml-1 px-1.5 py-0.5 rounded border t-border-subtle t-text-muted text-[10px] tabular-nums"
          >
            {pruneResult.keptNodes.length} kept · {pruneResult.prunedNodes.length} greyed
          </span>
        )}
      </div>

      {/* Stage-0 classification legend — always visible. Edges are coloured by
          causal class, nodes grouped into 5 roles. Counts are live. */}
      <div className="absolute bottom-3 left-3 rounded-md border t-border-subtle t-bg-elevated/95 backdrop-blur shadow-sm px-2.5 py-2 text-[10px] t-text-secondary select-none">
        <div className="uppercase tracking-wider t-text-muted font-semibold mb-1 text-[9px]">Edge class</div>
        <div className="space-y-0.5 mb-2">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-5" style={{ borderTop: `2px solid ${(palette.rel.returns ?? 'rgba(120,120,120,1)').replace(/[\d.]+\)$/, '1)')}` }} />
            <span className="t-text tabular-nums">{pruneResult.stageStats.edgeClasses.causal}</span>
            <span>causal</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-5" style={{ borderTop: '2px dashed rgba(140,140,150,0.85)' }} />
            <span className="t-text tabular-nums">{pruneResult.stageStats.edgeClasses.temporal}</span>
            <span>temporal</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-5" style={{ borderTop: '2px solid rgba(120,120,120,0.22)' }} />
            <span className="t-text tabular-nums">{pruneResult.stageStats.edgeClasses.structural}</span>
            <span>structural</span>
          </div>
        </div>
        <div className="uppercase tracking-wider t-text-muted font-semibold mb-1 text-[9px]">Node role</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {([
            ['container', palette.kind.trace],
            ['step', palette.kind.step],
            ['tool', palette.kind.tool],
            ['artifact', palette.kind.artifact],
            ['file', palette.kind.file],
            ['skill', palette.kind.skill],
          ] as const).map(([role, color]) => (
            <div key={role} className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
              <span className="t-text tabular-nums">{pruneResult.stageStats.nodeRoles[role]}</span>
              <span>{role}</span>
            </div>
          ))}
        </div>
      </div>
      {/* Floating fit-to-view control, top-right. Lets the user recover
          the overview if force or zoom drifts after pan/drag/filter. */}
      <button
        onClick={fitToView}
        title="Fit to view"
        className="absolute top-3 right-3 p-1.5 rounded-md border t-border-subtle t-bg-elevated t-text-secondary hover:t-text transition-colors shadow-sm"
      >
        <Maximize2 size={13} />
      </button>
    </div>
  )
}
