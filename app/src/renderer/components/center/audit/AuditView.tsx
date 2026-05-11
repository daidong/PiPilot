/**
 * Audit tab — provenance visualization for the active project.
 *
 * Three columns:
 *   - left rail: filters + key entities + trace list
 *   - center: force-directed graph rendering
 *   - right rail: node inspector + repair-flow preview
 *
 * Telemetry is the source of truth; the graph here is a derived view
 * fetched once per session (refreshable). When the project has no
 * telemetry yet, we show a targeted empty state instead of a blank
 * canvas — see EmptyTelemetry for the specific reasons.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useUIStore } from '../../../stores/ui-store'
import type { GraphNode, NodeKind } from '../../../../../../lib/audit-graph/index'
import { useAuditGraph } from './use-audit-graph'
import { ProvenanceGraph } from './ProvenanceGraph'
import { AuditLeftRail, AuditRightRail, type FiltersState, type SliceStats } from './AuditSidePanels'
import { EmptyTelemetry } from './EmptyTelemetry'

const DEFAULT_KINDS: Set<NodeKind> = new Set(['trace', 'step', 'tool', 'chat', 'artifact', 'file', 'dir'])

export function AuditView() {
  const centerView = useUIStore(s => s.centerView)
  const active = centerView === 'audit'

  const { status, presence, graph, error, reload } = useAuditGraph(active)

  // Filters
  const [filters, setFilters] = useState<FiltersState>({
    hideContains: false,
    selectedTraceId: null,
    kinds: DEFAULT_KINDS,
  })

  // Selection + taint
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [taint, setTaint] = useState<Record<string, { reason: string; ts: number }>>({})

  // Side-panel collapse
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)

  // Imperative focus into the graph (set by ProvenanceGraph)
  const focusRef = useRef<((n: GraphNode) => void) | null>(null)

  // Reset selection + taint when the loaded graph identity changes (e.g. on reload)
  useEffect(() => { setSelected(null); setTaint({}) }, [graph?.builtAt])

  const onSelect = useCallback((n: GraphNode | null) => setSelected(n), [])
  const onFocusNode = useCallback((n: GraphNode) => {
    setSelected(n)
    focusRef.current?.(n)
  }, [])
  const markTaint = useCallback((id: string, reason: string) => {
    setTaint(t => ({ ...t, [id]: { reason, ts: Date.now() } }))
  }, [])
  const clearTaint = useCallback((id: string) => {
    setTaint(t => {
      const next = { ...t }; delete next[id]; return next
    })
  }, [])

  // Slice info bubbled up from the canvas — used to compute right-rail stats.
  const [sliceInfo, setSliceInfo] = useState<{ nodes: Set<string>; derivedTaint: Set<string> }>(
    { nodes: new Set(), derivedTaint: new Set() },
  )
  const onSliceChange = useCallback(
    (info: { nodes: Set<string>; derivedTaint: Set<string> }) => setSliceInfo(info),
    [],
  )

  const sliceStats: SliceStats = useMemo(() => {
    const out: SliceStats = { nodes: 0, traces: new Set(), sessions: new Set(), byKind: new Map() }
    if (!graph) return out
    out.nodes = sliceInfo.nodes.size
    const nodeById = new Map(graph.nodes.map(n => [n.id, n]))
    for (const id of sliceInfo.nodes) {
      const n = nodeById.get(id); if (!n) continue
      out.byKind.set(n.kind, (out.byKind.get(n.kind) ?? 0) + 1)
      if (n.traceId) out.traces.add(n.traceId)
      if (n.sessionId) out.sessions.add(n.sessionId)
      else if (n.traceId) {
        const t = nodeById.get(`trace:${n.traceId}`)
        if (t?.sessionId) out.sessions.add(t.sessionId)
      }
    }
    return out
  }, [graph, sliceInfo])

  // —— Render branches ——————————————————————————————————————————————

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 t-text-muted">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-[var(--text-sm)]">Reading telemetry…</span>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <div className="max-w-md text-center">
          <h2 className="text-[var(--text-lg)] font-medium t-text mb-2">Could not load audit graph</h2>
          <p className="text-[var(--text-sm)] t-text-error mb-4">{error}</p>
          <button onClick={reload} className="px-3 py-1.5 rounded-md border t-border-subtle t-bg-elevated t-text text-[var(--text-sm)]">Retry</button>
        </div>
      </div>
    )
  }

  if (status === 'empty' || !graph) {
    return <EmptyTelemetry reason={presence?.reason} onRefresh={reload} />
  }

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      <AuditLeftRail
        graph={graph}
        filters={filters}
        setFilters={setFilters}
        onReload={reload}
        onFocusNode={onFocusNode}
        selected={selected}
        collapsed={leftCollapsed}
        onToggleCollapsed={() => setLeftCollapsed(c => !c)}
      />

      <div className="flex-1 min-w-0 min-h-0 relative t-bg-base">
        <ProvenanceGraph
          graph={graph}
          selected={selected}
          onSelect={onSelect}
          taint={taint}
          filters={filters}
          focusRef={focusRef}
          onSliceChange={onSliceChange}
        />
      </div>

      <AuditRightRail
        graph={graph}
        selected={selected}
        taint={taint}
        derivedTaint={sliceInfo.derivedTaint}
        sliceStats={sliceStats}
        onTaint={markTaint}
        onClearTaint={clearTaint}
        onClearAllTaint={() => setTaint({})}
        onFocusNode={onFocusNode}
        collapsed={rightCollapsed}
        onToggleCollapsed={() => setRightCollapsed(c => !c)}
      />
    </div>
  )
}
