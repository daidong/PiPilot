import { useState, useMemo } from 'react'
import type { BranchSnapshot, BranchNode } from '@/lib/types'
import { STAGE_LABELS } from '@/lib/formatters'

// Translate internal IDs to user-friendly research terminology
function friendlyBranchId(id: string): string {
  // B-001 → "Research Line 1", B-002 → "Research Line 2"
  const m = id.match(/^B-0*(\d+)$/i)
  return m ? `Research Line ${parseInt(m[1], 10)}` : id
}

function friendlyNodeId(id: string): string {
  // N-001 → "Step 1", N-002 → "Step 2"
  const m = id.match(/^N-0*(\d+)$/i)
  return m ? `Step ${parseInt(m[1], 10)}` : id
}

interface BranchesTabProps {
  branchSnapshot: BranchSnapshot | null
  onRecordOverride: (params: { targetNodeId: string; rationale: string; riskAccepted: string }) => Promise<void>
}

// Each branch rail gets a distinct color
const RAIL_COLORS = [
  '#2dd4bf', // teal (active branch)
  '#38bdf8', // sky
  '#a78bfa', // violet
  '#fb923c', // orange
  '#f472b6', // pink
  '#34d399', // emerald
  '#facc15', // yellow
  '#60a5fa', // blue
]

const DOT_R = 5
const RAIL_GAP = 24
const ROW_H = 60
const PAD_X = 20
const PAD_Y = 16

const STATUS_STYLE: Record<string, { label: string; fg: string }> = {
  active: { label: 'Active', fg: 't-accent-teal' },
  paused: { label: 'Paused', fg: 't-accent-slate' },
  merged: { label: 'Merged', fg: 't-accent-violet' },
  pruned: { label: 'Pruned', fg: 't-accent-amber' },
  invalidated: { label: 'Invalidated', fg: 't-accent-rose' },
}

interface LayoutResult {
  ordered: BranchNode[]
  railOf: Map<string, number>
  totalRails: number
  railSegments: Array<{ x: number; y1: number; y2: number; color: string }>
  branchCurves: Array<{ d: string; color: string; dashed: boolean }>
  dots: Array<{
    cx: number
    cy: number
    nodeId: string
    color: string
    isActive: boolean
    isDimmed: boolean
  }>
  svgW: number
  svgH: number
}

function buildTreeLayout(branchSnapshot: BranchSnapshot): LayoutResult | null {
  const nodes = branchSnapshot.nodes
  if (nodes.length === 0) return null

  const nodeMap = new Map<string, BranchNode>()
  nodes.forEach((n) => nodeMap.set(n.nodeId, n))

  // Build children adjacency
  const childrenOf = new Map<string, string[]>()
  nodes.forEach((n) => {
    if (n.parentNodeId) {
      const list = childrenOf.get(n.parentNodeId) || []
      list.push(n.nodeId)
      childrenOf.set(n.parentNodeId, list)
    }
  })

  // Assign rail per branch — active branch always gets rail 0
  const branchIds = [...new Set(nodes.map((n) => n.branchId))]
  const railOf = new Map<string, number>()
  railOf.set(branchSnapshot.activeBranchId, 0)
  let nextRail = 1
  for (const bid of branchIds) {
    if (!railOf.has(bid)) {
      railOf.set(bid, nextRail++)
    }
  }
  const totalRails = nextRail

  // BFS from root to get topological order
  const ordered: BranchNode[] = []
  const visited = new Set<string>()
  const queue: string[] = [branchSnapshot.rootNodeId]
  visited.add(branchSnapshot.rootNodeId)

  while (queue.length > 0) {
    const id = queue.shift()!
    const node = nodeMap.get(id)
    if (node) ordered.push(node)

    const children = childrenOf.get(id) || []
    // Sort: same-branch children first, then by rail index
    children.sort((a, b) => {
      const na = nodeMap.get(a)
      const nb = nodeMap.get(b)
      if (!na || !nb) return 0
      if (node) {
        if (na.branchId === node.branchId && nb.branchId !== node.branchId) return -1
        if (nb.branchId === node.branchId && na.branchId !== node.branchId) return 1
      }
      return (railOf.get(na.branchId) ?? 0) - (railOf.get(nb.branchId) ?? 0)
    })

    for (const cid of children) {
      if (!visited.has(cid)) {
        visited.add(cid)
        queue.push(cid)
      }
    }
  }

  // Add orphan nodes not reachable from root
  nodes.forEach((n) => {
    if (!visited.has(n.nodeId)) ordered.push(n)
  })

  // Row index per node
  const rowOf = new Map<string, number>()
  ordered.forEach((n, i) => rowOf.set(n.nodeId, i))

  // Helper to get center position for a node
  const posOf = (nodeId: string) => {
    const node = nodeMap.get(nodeId)!
    const rail = railOf.get(node.branchId) ?? 0
    const row = rowOf.get(nodeId) ?? 0
    return {
      cx: PAD_X + rail * RAIL_GAP,
      cy: PAD_Y + row * ROW_H + ROW_H / 2,
    }
  }

  // Vertical rail segments: continuous line from first to last node per branch
  const railSegments: LayoutResult['railSegments'] = []
  for (const [bid, rail] of railOf.entries()) {
    const branchNodes = ordered.filter((n) => n.branchId === bid)
    if (branchNodes.length < 2) continue
    const first = posOf(branchNodes[0].nodeId)
    const last = posOf(branchNodes[branchNodes.length - 1].nodeId)
    railSegments.push({
      x: first.cx,
      y1: first.cy,
      y2: last.cy,
      color: RAIL_COLORS[rail % RAIL_COLORS.length],
    })
  }

  // Branch-off and merge curves
  const branchCurves: LayoutResult['branchCurves'] = []

  ordered.forEach((node) => {
    // Branch-off: parent on a different rail
    if (node.parentNodeId) {
      const parent = nodeMap.get(node.parentNodeId)
      if (parent && parent.branchId !== node.branchId) {
        const from = posOf(node.parentNodeId)
        const to = posOf(node.nodeId)
        const dy = to.cy - from.cy
        const d = `M ${from.cx} ${from.cy} C ${from.cx} ${from.cy + dy * 0.4}, ${to.cx} ${to.cy - dy * 0.4}, ${to.cx} ${to.cy}`
        branchCurves.push({
          d,
          color: RAIL_COLORS[(railOf.get(node.branchId) ?? 0) % RAIL_COLORS.length],
          dashed: false,
        })
      }
    }

    // Merge: dashed curve from the last node of the merged branch
    if (node.mergedFrom) {
      for (const mergedBid of node.mergedFrom) {
        const mergedNodes = ordered.filter((n) => n.branchId === mergedBid)
        const nodeRow = rowOf.get(node.nodeId) ?? 0
        const candidates = mergedNodes.filter((n) => (rowOf.get(n.nodeId) ?? 0) <= nodeRow)
        const mergeSource = candidates[candidates.length - 1]
        if (!mergeSource) continue

        const from = posOf(mergeSource.nodeId)
        const to = posOf(node.nodeId)
        const dy = Math.abs(to.cy - from.cy) || ROW_H
        const d = `M ${from.cx} ${from.cy} C ${from.cx} ${from.cy + dy * 0.4}, ${to.cx} ${to.cy - dy * 0.4}, ${to.cx} ${to.cy}`
        branchCurves.push({
          d,
          color: RAIL_COLORS[(railOf.get(mergedBid) ?? 0) % RAIL_COLORS.length],
          dashed: true,
        })
      }
    }
  })

  // Node dots
  const dots: LayoutResult['dots'] = ordered.map((node) => {
    const rail = railOf.get(node.branchId) ?? 0
    const { cx, cy } = posOf(node.nodeId)
    return {
      cx,
      cy,
      nodeId: node.nodeId,
      color: RAIL_COLORS[rail % RAIL_COLORS.length],
      isActive: node.nodeId === branchSnapshot.activeNodeId,
      isDimmed: node.status === 'pruned' || node.status === 'invalidated',
    }
  })

  const svgW = PAD_X * 2 + Math.max(0, totalRails - 1) * RAIL_GAP
  const svgH = PAD_Y * 2 + Math.max(0, ordered.length - 1) * ROW_H + ROW_H

  return { ordered, railOf, totalRails, railSegments, branchCurves, dots, svgW, svgH }
}

export function BranchesTab({ branchSnapshot, onRecordOverride }: BranchesTabProps) {
  const [overrideTargetNodeId, setOverrideTargetNodeId] = useState('')
  const [overrideRationale, setOverrideRationale] = useState('')
  const [overrideRiskAccepted, setOverrideRiskAccepted] = useState('')
  const [showRedirect, setShowRedirect] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const layout = useMemo(
    () => (branchSnapshot ? buildTreeLayout(branchSnapshot) : null),
    [branchSnapshot]
  )

  const selectedNode = useMemo(() => {
    if (!selectedNodeId || !branchSnapshot) return null
    return branchSnapshot.nodes.find((n) => n.nodeId === selectedNodeId) ?? null
  }, [selectedNodeId, branchSnapshot])

  // Build branch legend from the layout
  const branchLegend = useMemo(() => {
    if (!layout) return []
    const seen = new Map<string, number>()
    for (const node of layout.ordered) {
      if (!seen.has(node.branchId)) {
        seen.set(node.branchId, layout.railOf.get(node.branchId) ?? 0)
      }
    }
    return [...seen.entries()].map(([bid, rail]) => ({
      branchId: bid,
      color: RAIL_COLORS[rail % RAIL_COLORS.length],
      isActive: bid === branchSnapshot?.activeBranchId,
    }))
  }, [layout, branchSnapshot])

  return (
    <div className="flex flex-col gap-3">
      {!layout ? (
        <div className="rounded-xl t-bg-elevated p-4 text-sm t-text-secondary">
          No branch nodes yet.
        </div>
      ) : (
        <div className="rounded-xl t-bg-elevated p-3">
          {/* Header + branch legend */}
          <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
            <div className="font-medium">Investigation Branches</div>
            <div className="flex flex-wrap items-center gap-2">
              {branchLegend.map((b) => (
                <span key={b.branchId} className="flex items-center gap-1 t-text-secondary">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: b.color }}
                  />
                  <span>{friendlyBranchId(b.branchId)}</span>
                  {b.isActive && (
                    <span className="text-[10px] text-teal-400">(active)</span>
                  )}
                </span>
              ))}
            </div>
            <div className="ml-auto t-text-muted">
              {layout.totalRails} line{layout.totalRails !== 1 ? 's' : ''} · {layout.ordered.length} step{layout.ordered.length !== 1 ? 's' : ''}
            </div>
          </div>
          <div className="mb-2 text-[10px] t-text-muted">
            Each line is an independent research direction. Steps are individual investigation actions within that line.
          </div>

          {/* Graph area */}
          <div
            className="overflow-auto rounded-lg border t-border t-graph-bg"
            style={{ maxHeight: '520px' }}
          >
            <div className="flex" style={{ minHeight: layout.svgH }}>
              {/* SVG rail graph */}
              <svg
                width={layout.svgW}
                height={layout.svgH}
                className="shrink-0"
                style={{ minWidth: layout.svgW }}
              >
                {/* Vertical rail lines */}
                {layout.railSegments.map((seg, i) => (
                  <line
                    key={`rail-${i}`}
                    x1={seg.x}
                    y1={seg.y1}
                    x2={seg.x}
                    y2={seg.y2}
                    stroke={seg.color}
                    strokeWidth={2}
                    opacity={0.35}
                  />
                ))}

                {/* Branch-off and merge curves */}
                {layout.branchCurves.map((curve, i) => (
                  <path
                    key={`curve-${i}`}
                    d={curve.d}
                    fill="none"
                    stroke={curve.color}
                    strokeWidth={2}
                    strokeDasharray={curve.dashed ? '5 3' : undefined}
                    opacity={0.6}
                  />
                ))}

                {/* Node dots */}
                {layout.dots.map((dot) => (
                  <g key={dot.nodeId}>
                    {/* Active node outer ring */}
                    {dot.isActive && (
                      <circle
                        cx={dot.cx}
                        cy={dot.cy}
                        r={DOT_R + 5}
                        fill="none"
                        stroke={dot.color}
                        strokeWidth={1.5}
                        opacity={0.4}
                      />
                    )}
                    {/* Selected node highlight */}
                    {selectedNodeId === dot.nodeId && (
                      <circle
                        cx={dot.cx}
                        cy={dot.cy}
                        r={DOT_R + 3}
                        fill="none"
                        stroke="white"
                        strokeWidth={1.5}
                        opacity={0.5}
                      />
                    )}
                    {/* Dot */}
                    <circle
                      cx={dot.cx}
                      cy={dot.cy}
                      r={dot.isActive ? DOT_R + 1 : DOT_R}
                      fill={dot.isDimmed ? 'transparent' : dot.color}
                      stroke={dot.color}
                      strokeWidth={dot.isActive ? 2.5 : 2}
                      opacity={dot.isDimmed ? 0.45 : 1}
                    />
                  </g>
                ))}
              </svg>

              {/* Node info column */}
              <div className="flex-1 min-w-0">
                {layout.ordered.map((node) => {
                  const rail = layout.railOf.get(node.branchId) ?? 0
                  const color = RAIL_COLORS[rail % RAIL_COLORS.length]
                  const isSelected = selectedNodeId === node.nodeId
                  const isActive = node.nodeId === branchSnapshot!.activeNodeId
                  const sts = STATUS_STYLE[node.status] ?? { label: node.status, fg: 't-text-secondary' }

                  return (
                    <button
                      key={node.nodeId}
                      onClick={() =>
                        setSelectedNodeId(node.nodeId === selectedNodeId ? null : node.nodeId)
                      }
                      className={`flex w-full items-center text-left transition-colors t-hoverable ${
                        isSelected ? 't-bg-selected' : ''
                      }`}
                      style={{ height: ROW_H }}
                    >
                      <div className="flex flex-col gap-0.5 px-3 py-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-semibold" style={{ color }}>
                            {friendlyNodeId(node.nodeId)}
                          </span>
                          <span className="text-[10px] t-text-muted" title={node.branchId}>
                            {friendlyBranchId(node.branchId)}
                          </span>
                          <span
                            className={`rounded-full border t-border px-1.5 py-0.5 text-[10px] ${sts.fg}`}
                          >
                            {sts.label}
                          </span>
                          <span className="text-[10px] t-text-muted">
                            {STAGE_LABELS[node.stage] ?? node.stage}
                          </span>
                          {typeof node.createdByTurn === 'number' && (
                            <span className="text-[10px] t-text-muted">
                              Cycle {node.createdByTurn}
                            </span>
                          )}
                          {isActive && (
                            <span className="text-[10px] font-medium t-accent-teal">CURRENT</span>
                          )}
                        </div>
                        <div className="truncate text-[11px] t-text-secondary max-w-lg">
                          {node.summary || 'No summary'}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Selected step details panel */}
      {selectedNode && (
        <div className="rounded-xl border t-border p-3 text-xs">
          <div className="font-medium">Investigation Step Details</div>
          <div className="mt-2 space-y-1 t-text-secondary">
            <div>
              <span className="t-text-muted">Step:</span> {friendlyNodeId(selectedNode.nodeId)}
              <span className="ml-1 text-[10px] t-text-muted">({selectedNode.nodeId})</span>
            </div>
            <div>
              <span className="t-text-muted">Research Line:</span> {friendlyBranchId(selectedNode.branchId)}
              <span className="ml-1 text-[10px] t-text-muted">({selectedNode.branchId})</span>
            </div>
            <div>
              <span className="t-text-muted">Research Stage:</span>{' '}
              {STAGE_LABELS[selectedNode.stage] ?? selectedNode.stage}
            </div>
            <div>
              <span className="t-text-muted">Status:</span>{' '}
              {STATUS_STYLE[selectedNode.status]?.label ?? selectedNode.status}
            </div>
            <div>
              <span className="t-text-muted">Previous Step:</span>{' '}
              {selectedNode.parentNodeId ? friendlyNodeId(selectedNode.parentNodeId) : '(starting point)'}
            </div>
            {typeof selectedNode.createdByTurn === 'number' && (
              <div>
                <span className="t-text-muted">Created at cycle:</span> {selectedNode.createdByTurn}
              </div>
            )}
            {selectedNode.mergedFrom && selectedNode.mergedFrom.length > 0 && (
              <div>
                <span className="t-text-muted">Merged findings from:</span>{' '}
                {selectedNode.mergedFrom.map(friendlyBranchId).join(', ')}
              </div>
            )}
            <div className="mt-1 t-text-primary">{selectedNode.summary || 'No summary'}</div>
          </div>
        </div>
      )}

      {/* Manual investigation redirect — collapsed by default */}
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 overflow-hidden text-xs">
        <button
          onClick={() => setShowRedirect((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 font-medium t-accent-amber t-hoverable"
        >
          <span>Redirect Investigation</span>
          <span className="t-text-muted">{showRedirect ? '−' : '+'}</span>
        </button>
        {showRedirect && (
          <div className="border-t border-amber-500/20 px-3 py-3">
            <div className="mb-2 t-text-muted text-[10px]">
              Manually override the planner's direction by revisiting a previous investigation step.
              Use this when the automated research took a wrong turn and you want to explore a different path.
            </div>
            <div className="space-y-2">
              <div>
                <label className="mb-0.5 block text-[10px] t-text-muted">Target Step ID (e.g. N-002)</label>
                <input
                  value={overrideTargetNodeId}
                  onChange={(e) => setOverrideTargetNodeId(e.target.value)}
                  className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                  placeholder="e.g. N-002"
                />
              </div>
              <div>
                <label className="mb-0.5 block text-[10px] t-text-muted">Why redirect? (rationale for changing direction)</label>
                <textarea
                  value={overrideRationale}
                  onChange={(e) => setOverrideRationale(e.target.value)}
                  rows={2}
                  className="w-full resize-none rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                  placeholder="e.g. The current approach missed an important angle..."
                />
              </div>
              <div>
                <label className="mb-0.5 block text-[10px] t-text-muted">Acknowledged trade-offs</label>
                <input
                  value={overrideRiskAccepted}
                  onChange={(e) => setOverrideRiskAccepted(e.target.value)}
                  className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                  placeholder="e.g. May revisit already-explored territory"
                />
              </div>
              <button
                onClick={() =>
                  onRecordOverride({
                    targetNodeId: overrideTargetNodeId,
                    rationale: overrideRationale,
                    riskAccepted: overrideRiskAccepted,
                  })
                }
                className="rounded-md border border-amber-500/40 px-3 py-2 text-xs font-medium t-accent-amber hover:bg-amber-500/10"
              >
                Apply Redirect
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
