/**
 * Force-directed render of the provenance projection.
 *
 * The math here (support slice BFS, taint propagation, importance scoring,
 * zoom-gated labels, tinted contamination) is identical to the prototype
 * proven on real telemetry; the chrome around it is rewritten to match
 * the project's theme tokens (no custom OKLCH neutrals, no hardcoded
 * dark-only colors).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import type {
  AuditGraph,
  EdgeRel,
  GraphEdge,
  GraphNode,
  NodeKind,
} from '../../../../../../lib/audit-graph/index'
import { useAuditPalette, tintToward } from './audit-theme'

// —— Importance + radius priors ————————————————————————————————————————

const BASE_RADIUS: Record<NodeKind, number> = {
  session: 8, trace: 7, step: 4, tool: 4, chat: 3, artifact: 6, file: 4, dir: 3.5, span: 3,
}
const KIND_WEIGHT: Record<NodeKind, number> = {
  artifact: 6, file: 4, tool: 2.5, trace: 2, dir: 1.5, step: 0.5, chat: 0.2, session: 1, span: 0.5,
}
const CAUSAL: ReadonlySet<EdgeRel> = new Set([
  'precedes', 'invokes', 'returns', 'sub-llm', 'reads', 'writes', 'creates', 'retrieved', 'mentions', 'listed',
])

// —— Public props ————————————————————————————————————————————————————

export interface ProvenanceGraphProps {
  graph: AuditGraph
  selected: GraphNode | null
  onSelect: (node: GraphNode | null) => void
  taint: Record<string, { reason: string; ts: number }>
  filters: {
    hideContains: boolean
    selectedTraceId: string | null
    kinds: Set<NodeKind>
  }
  /** Imperative focus — parent calls this when user picks a node from a list. */
  focusRef?: React.MutableRefObject<((node: GraphNode) => void) | null>
  /** Bubble support-slice membership up so the side panel can show stats. */
  onSliceChange?: (slice: { nodes: Set<string>; derivedTaint: Set<string> }) => void
}

// —— Component ————————————————————————————————————————————————————————

export function ProvenanceGraph({
  graph, selected, onSelect, taint, filters, focusRef, onSliceChange,
}: ProvenanceGraphProps) {
  const palette = useAuditPalette()
  const fgRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })

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
  const filtered = useMemo(() => {
    const inTrace = (n: GraphNode) => {
      if (!filters.selectedTraceId) return true
      if (n.kind === 'session') return false
      return n.traceId === filters.selectedTraceId
    }
    const visible = graph.nodes.filter(n => filters.kinds.has(n.kind) && inTrace(n))
    const visibleIds = new Set(visible.map(n => n.id))
    const links = graph.edges.filter(e => {
      if (filters.hideContains && e.rel === 'contains') return false
      return visibleIds.has(e.source as string) && visibleIds.has(e.target as string)
    })
    // react-force-graph mutates source/target into node refs at runtime, so we
    // hand it shallow clones to avoid corrupting the upstream data.
    return { nodes: visible.map(n => ({ ...n })), links: links.map(e => ({ ...e })) }
  }, [graph, filters])

  // —— Force tuning + auto-fit ——
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    fg.d3Force('charge')?.strength(-160)
    fg.d3Force('link')?.distance((l: any) => (l.rel === 'contains' ? 60 : 36))
    const t = setTimeout(() => fg.zoomToFit?.(600, 60), 1400)
    return () => clearTimeout(t)
  }, [filtered])

  // —— Imperative focus from parent ——
  useEffect(() => {
    if (!focusRef) return
    focusRef.current = (n: GraphNode) => {
      const live = filtered.nodes.find((x: any) => x.id === n.id) as any
      if (live && live.x !== undefined && fgRef.current) {
        fgRef.current.centerAt(live.x, live.y, 600)
        fgRef.current.zoom(2.2, 600)
      }
    }
    return () => { focusRef.current = null }
  }, [focusRef, filtered])

  // —— Importance + label thresholds ——
  const importance = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of filtered.nodes) m.set(n.id, KIND_WEIGHT[n.kind] ?? 1)
    for (const e of filtered.links as any[]) {
      if (e.rel === 'contains' || e.rel === 'sub-llm') continue
      const s = typeof e.source === 'object' ? e.source.id : e.source
      const t = typeof e.target === 'object' ? e.target.id : e.target
      const w = (e.rel === 'creates' || e.rel === 'writes') ? 3 : 1
      m.set(s, (m.get(s) ?? 0) + w)
      m.set(t, (m.get(t) ?? 0) + w)
    }
    return m
  }, [filtered])

  const importanceCutoff = useMemo(() => {
    const vals = [...importance.values()].sort((a, b) => b - a)
    if (vals.length === 0) return 0
    const budget = Math.min(40, Math.max(8, Math.floor(vals.length * 0.15)))
    return vals[Math.min(budget, vals.length - 1)] ?? 0
  }, [importance])

  // Per-node zoom threshold: top 5 unlock at 0.7, 6-15 at 1.0, etc.
  const labelZoomThreshold = useMemo(() => {
    const m = new Map<string, number>()
    const ranked = [...filtered.nodes]
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
  }, [filtered, importance])

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
    for (const l of filtered.links as any[]) {
      if (l.rel === 'contains' || l.rel === 'sub-llm') continue
      const s = typeof l.source === 'object' ? l.source.id : l.source
      const t = typeof l.target === 'object' ? l.target.id : l.target
      if (closure.has(s) && closure.has(t)) set.add(l)
    }
    return set
  }, [taint, derivedTaint, filtered])

  // —— Slice-membership set of link OBJECTS for accessor lookups ——
  const highlightLinks = useMemo(() => {
    const set = new Set<any>()
    if (!selected) return set
    filtered.links.forEach((l: any) => {
      const src = typeof l.source === 'object' ? l.source.id : l.source
      const tgt = typeof l.target === 'object' ? l.target.id : l.target
      if (highlight.nodes.has(src) && highlight.nodes.has(tgt) && highlight.nodes.size > 1) set.add(l)
    })
    return set
  }, [filtered, selected, highlight])

  // —— Bubble slice info up ——
  useEffect(() => {
    onSliceChange?.({ nodes: highlight.nodes, derivedTaint })
  }, [highlight, derivedTaint, onSliceChange])

  // —— Link color accessor (shared between line / arrow / particle) ——
  function linkColorFor(l: any, opaque = false): string {
    const base = palette.rel[l.rel as EdgeRel] ?? 'rgba(120,120,120,0.5)'
    if (selected) {
      if (highlightLinks.has(l)) return opaque ? base.replace(/[\d.]+\)$/, '1)') : base.replace(/[\d.]+\)$/, '0.95)')
      return 'rgba(80,80,80,0.06)'
    }
    const muted = l.rel === 'contains' || l.rel === 'sub-llm'
    if (muted) return 'rgba(80,80,80,0.06)'
    return opaque ? base.replace(/[\d.]+\)$/, '1)') : base
  }

  return (
    <div ref={containerRef} className="relative w-full h-full min-w-0 min-h-0 overflow-hidden">
      <ForceGraph2D
        ref={fgRef}
        width={size.w}
        height={size.h}
        graphData={filtered}
        backgroundColor="transparent"
        nodeRelSize={5}
        nodeVal={(n: any) => nodeRadius(n)}
        nodeLabel={(n: any) => `<b>${n.kind}</b>: ${n.label}`}
        linkColor={(l: any) => {
          const base = linkColorFor(l)
          return taintedEdges.has(l) ? tintToward(base, palette.taint) : base
        }}
        linkLineDash={(l: any) => (taintedEdges.has(l) ? [4, 3] : null)}
        linkWidth={(l: any) => {
          if (taintedEdges.has(l)) return 1.8
          if (selected) return highlightLinks.has(l) ? 2 : 0.5
          return (l.rel === 'creates' || l.rel === 'writes') ? 1.8 : 0.6
        }}
        linkDirectionalArrowLength={(l: any) => {
          if (l.rel === 'contains' || l.rel === 'sub-llm') return 0
          if (selected) return highlightLinks.has(l) ? 7 : 0
          return (l.rel === 'creates' || l.rel === 'writes') ? 6 : 4
        }}
        linkDirectionalArrowRelPos={0.92}
        linkDirectionalArrowColor={(l: any) => {
          const base = linkColorFor(l, true)
          return taintedEdges.has(l) ? tintToward(base, palette.taint) : base
        }}
        linkDirectionalParticles={(l: any) => {
          if (!selected) return 0
          if (l.rel === 'contains' || l.rel === 'sub-llm') return 0
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
          const isDirectTaint = !!taint[n.id]
          const isDerivedTaint = derivedTaint.has(n.id)
          const imp = importance.get(n.id) ?? 0
          const important = imp >= importanceCutoff
          const baseC = palette.kind[n.kind as NodeKind] || '#aaa'
          const fill = isDirectTaint
            ? tintToward(baseC, palette.taint, 0.7)
            : isDerivedTaint
              ? tintToward(baseC, palette.taint, 0.4)
              : baseC
          const dim = selected ? (!isHi && !isSel) : !important
          ctx.globalAlpha = dim ? 0.22 : 1
          ctx.beginPath()
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
          ctx.fillStyle = fill
          ctx.fill()
          // Rings — direct = thick solid red, derived = thin dashed red, selected = white
          if (isDirectTaint) {
            ctx.lineWidth = 2.4 / globalScale
            ctx.strokeStyle = `rgb(${palette.taint.join(',')})`
            ctx.setLineDash([])
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 2.5, 0, Math.PI * 2); ctx.stroke()
          } else if (isDerivedTaint) {
            ctx.lineWidth = 1.4 / globalScale
            ctx.strokeStyle = `rgba(${palette.taint.join(',')},0.7)`
            ctx.setLineDash([3 / globalScale, 2 / globalScale])
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 2.5, 0, Math.PI * 2); ctx.stroke()
            ctx.setLineDash([])
          } else if (isSel) {
            ctx.lineWidth = 2 / globalScale
            ctx.strokeStyle = '#fff'
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 2, 0, Math.PI * 2); ctx.stroke()
          }
          // Label gating: per-node zoom threshold from importance rank
          const zoomThresh = labelZoomThreshold.get(n.id) ?? 3.0
          const labelable = isSel || isHi || globalScale >= zoomThresh
          if (labelable) {
            ctx.font = `${Math.max(10, 11 / globalScale)}px ui-monospace,Menlo,monospace`
            ctx.fillStyle = palette.kind.span === '#fff' ? '#000' : '#cbd5e1'
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
        cooldownTicks={120}
      />
    </div>
  )
}
