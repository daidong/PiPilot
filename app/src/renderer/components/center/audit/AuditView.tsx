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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Layers, Loader2, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useUIStore } from '../../../stores/ui-store'
import type { GraphNode, NodeKind } from '../../../../../../lib/audit-graph/index'
import type { FaithfulnessFinding, NodeAuditRunResult, TraceAuditSummary } from '../../../../../../lib/audit-graph/audit/index'
import type { AdjudicationDecision } from '../../../../../../lib/audit-graph/adjudicate'
import { useAuditGraph } from './use-audit-graph'
import { ProvenanceGraph } from './ProvenanceGraph'
import { AuditLeftRail, AuditRightRail, type AuditProjectionStats, type FiltersState, type SliceStats } from './AuditSidePanels'
import { EmptyTelemetry } from './EmptyTelemetry'
import { useSharingStore } from '../../../stores/sharing-store'
import { pruneGraph } from '../../../../../../lib/audit-graph/prune'
import type { StepSupportMetric } from '../../../../../../lib/audit-graph/prune'
import { AuditFindBar } from './AuditFindBar'
import { searchAuditGraph } from './audit-search'

const DEFAULT_KINDS: Set<NodeKind> = new Set(['trace', 'step', 'tool', 'chat', 'artifact', 'file', 'dir'])
const api = (window as any).api

// Per-node process-faithfulness audit (audit-pipeline.md §5/§10). Only these
// kinds are auditable (§5.1); the others show the action disabled. Inlined to
// avoid a value import from the audit barrel into the renderer.
const AUDITABLE_KINDS: Set<NodeKind> = new Set<NodeKind>(['step', 'chat', 'artifact', 'tool'])

// Mirror of escalate.ts:VISUAL_RX — escalation (C.5) only applies to visual or
// semantic unverifiable claims. Inlined because escalate.ts transitively pulls
// node:fs and can't be imported into the renderer bundle. Keep in sync.
const VISUAL_RX = /\b(figure|fig\.?|plot|chart|graph|image|diagram|panel|axis|curve|shows?|depicts?|illustrat|visualiz)/i

const TONE: Record<string, { dot: string; label: string }> = {
  rose: { dot: 'bg-rose-500', label: 'text-rose-600 dark:text-rose-400' },
  amber: { dot: 'bg-amber-500', label: 'text-amber-600 dark:text-amber-400' },
  zinc: { dot: 'bg-zinc-400', label: 'text-zinc-500' },
  emerald: { dot: 'bg-emerald-500', label: 'text-emerald-600 dark:text-emerald-400' },
}

// A finding paired with the node it came from (the claiming step / flagged node),
// so a click can jump to that SOURCE node — not the tool anchor.
interface PanelFinding { finding: FaithfulnessFinding; sourceNodeId: string }

// One section of the §10 findings panel (Mismatches / Graph flags / Unverifiable
// / Match). Self-collapsing; renders nothing when empty so coverage stays honest.
// Clicking a row jumps to the claiming node + arms the evidence highlight.
function FindingSection({ title, tone, icon, items, activeId, onSelect, onEscalate, escalatingId, collapsed }: {
  title: string
  tone: keyof typeof TONE
  icon?: ReactNode
  items: PanelFinding[]
  activeId?: string | null
  onSelect: (item: PanelFinding) => void
  onEscalate?: (f: FaithfulnessFinding) => void
  escalatingId?: string | null
  collapsed?: boolean
}) {
  const [open, setOpen] = useState(!collapsed)
  if (items.length === 0) return null
  const t = TONE[tone]
  return (
    <div className="border-b t-border-subtle">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 hover:t-bg-hover">
        <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} />
        {icon}
        <span className={`text-[11px] font-semibold ${t.label}`}>{title}</span>
        <span className="text-[10.5px] t-text-muted tabular-nums">{items.length}</span>
        <span className="ml-auto text-[10px] t-text-muted">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div>
          {items.map((item, i) => {
            const f = item.finding
            const isActive = activeId != null && `${item.sourceNodeId}::${f.claimId}` === activeId
            return (
              <div key={`${item.sourceNodeId}-${f.claimId}-${i}`} className={`px-2.5 py-1.5 border-t t-border-subtle ${isActive ? 't-bg-hover' : ''}`}>
                <button onClick={() => onSelect(item)} className="block w-full text-left" title="Jump to the node that made this claim and highlight the evidence">
                  <div className="text-[11px] t-text leading-snug">{f.claimText}</div>
                  {(f.claimed || f.actual) && (
                    <div className="mt-0.5 text-[10.5px] t-text-muted leading-snug">
                      <span className="t-text-secondary">claimed:</span> {f.claimed} · <span className="t-text-secondary">actual:</span> {f.actual}
                      {f.dimension && <span className={`ml-1 ${t.label}`}>· {f.dimension}</span>}
                    </div>
                  )}
                </button>
                {onEscalate && VISUAL_RX.test(f.claimText) && (
                  <button onClick={() => onEscalate(f)} disabled={escalatingId === f.claimId}
                    className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border t-border-subtle t-bg-elevated text-[10.5px] t-text-secondary hover:t-bg-hover disabled:opacity-50">
                    {escalatingId === f.claimId ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                    <span>Verify with LLM</span>
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function AuditView() {
  const centerView = useUIStore(s => s.centerView)
  const active = centerView === 'audit'
  // RFC-013: this graph is built from local telemetry/ledger only, which never
  // travel. When the project is shared, say so — a collaborator's work shows in
  // the Library + Git history, not here, and the graph isn't claiming otherwise.
  const shared = useSharingStore(s => s.status?.shared ?? false)

  const { status, presence, graph, error, reload } = useAuditGraph(active)

  // Filters. `hideWikiBg` defaults on — background-agent traces are noise
  // for audit and they scatter the force layout because they're disconnected
  // from the main lineage cluster.
  const [filters, setFilters] = useState<FiltersState>({
    hideContains: false,
    hideWikiBg: true,
    selectedTraceId: null,
    kinds: DEFAULT_KINDS,
  })

  // Selection + taint
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [taint, setTaint] = useState<Record<string, { reason: string; ts: number }>>({})
  // Per-node audit (§10): the result is keyed to the node it ran on.
  const [nodeAudit, setNodeAudit] = useState<NodeAuditRunResult | null>(null)
  const [auditRunning, setAuditRunning] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  const [escalatingId, setEscalatingId] = useState<string | null>(null)
  // The finding the user clicked: drives the claim/result evidence highlight
  // (claim in the source node, result numbers in the tool) + the focused node.
  const [activeFinding, setActiveFinding] = useState<PanelFinding | null>(null)
  // Whole-trace batch audit (concurrent) + its deterministic summary.
  const [tracing, setTracing] = useState(false)
  const [traceProgress, setTraceProgress] = useState<{ done: number; total: number } | null>(null)
  const [traceSummary, setTraceSummary] = useState<TraceAuditSummary | null>(null)
  // Internal prune refinement of flagged-but-ambiguous nodes. The UI exposes a
  // single Prune switch; this result is folded into that same scope.
  const [pruneOn, setPruneOn] = useState(false)
  const [adjudication, setAdjudication] = useState<AdjudicationDecision[] | null>(null)
  const [adjudicating, setAdjudicating] = useState(false)
  // "Keep anyway" overrides: node ids re-included in the Prune scope.
  const [keepAnyway, setKeepAnyway] = useState<Set<string>>(new Set())
  // Panel is not resident: collapsed to a small launcher until opened.
  const [auditPanelOpen, setAuditPanelOpen] = useState(false)

  // Side-panel collapse
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)

  // Provenance input/output search. This searches the loaded graph snapshot
  // (raw span events + node metadata); the follow-up backend path can extend it
  // to blobs without changing the view wiring.
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findCaseSensitive, setFindCaseSensitive] = useState(false)
  const [activeFindIndex, setActiveFindIndex] = useState(0)

  // Imperative focus into the graph (set by ProvenanceGraph)
  const focusRef = useRef<((n: GraphNode) => void) | null>(null)

  // Reset selection + taint when the loaded graph identity changes (e.g. on reload)
  useEffect(() => {
    setSelected(null); setTaint({}); setNodeAudit(null); setAuditError(null); setAuditPanelOpen(false)
    setPruneOn(false); setAdjudication(null); setKeepAnyway(new Set()); setTraceSummary(null); setActiveFinding(null)
  }, [graph?.builtAt])

  // The audit result only applies to the node it ran on; drop it when selection moves.
  useEffect(() => {
    if (nodeAudit && selected?.id !== nodeAudit.result.nodeId) { setNodeAudit(null); setAuditError(null) }
  }, [selected, nodeAudit])

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
  type PruneInfo = {
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
  const [sliceInfo, setSliceInfo] = useState<{
    nodes: Set<string>
    derivedTaint: Set<string>
    prune?: PruneInfo
  }>(
    { nodes: new Set(), derivedTaint: new Set() },
  )
  const onSliceChange = useCallback(
    (info: { nodes: Set<string>; derivedTaint: Set<string>; prune?: PruneInfo }) => setSliceInfo(info),
    [],
  )

  // Per-node flags from the deterministic prune drive the canvas suspicion
  // rings and the inspector's flag list (supersedes the old auto-suspect).
  const autoSuspect = useMemo(
    () => (graph ? new Map(Object.entries(pruneGraph(graph).flags)) : new Map<string, string[]>()),
    [graph],
  )

  const nodeById = useMemo(
    () => new Map((graph?.nodes ?? []).map(n => [n.id, n])),
    [graph],
  )

  const searchMatches = useMemo(
    () => (graph ? searchAuditGraph(graph, findQuery, findCaseSensitive) : []),
    [graph, findQuery, findCaseSensitive],
  )
  const searchMatchNodeIds = useMemo(
    () => new Set(searchMatches.map(m => m.nodeId)),
    [searchMatches],
  )
  const activeSearchMatch = findOpen && searchMatches.length > 0
    ? searchMatches[Math.min(activeFindIndex, searchMatches.length - 1)]
    : null

  const setFindQueryReset = useCallback((query: string) => {
    setFindQuery(query)
    setActiveFindIndex(0)
  }, [])
  const nextFindMatch = useCallback(() => {
    setActiveFindIndex(i => searchMatches.length === 0 ? 0 : (i + 1) % searchMatches.length)
  }, [searchMatches.length])
  const prevFindMatch = useCallback(() => {
    setActiveFindIndex(i => searchMatches.length === 0 ? 0 : (i <= 0 ? searchMatches.length - 1 : i - 1))
  }, [searchMatches.length])

  useEffect(() => {
    if (activeFindIndex < searchMatches.length) return
    setActiveFindIndex(searchMatches.length > 0 ? searchMatches.length - 1 : 0)
  }, [activeFindIndex, searchMatches.length])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopPropagation()
        setFindOpen(true)
        return
      }
      if (findOpen && event.key === 'Escape' && !typing) {
        event.preventDefault()
        setFindOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active, findOpen])

  useEffect(() => {
    if (!graph || !activeSearchMatch) return
    const node = nodeById.get(activeSearchMatch.nodeId)
    if (!node) return

    setSelected(node)
    setRightCollapsed(false)
    setFilters(current => {
      let changed = false
      let kinds = current.kinds
      if (!kinds.has(node.kind)) {
        kinds = new Set(kinds)
        kinds.add(node.kind)
        changed = true
      }

      let selectedTraceId = current.selectedTraceId
      if (selectedTraceId && node.traceId !== selectedTraceId) {
        selectedTraceId = null
        changed = true
      }

      let hideWikiBg = current.hideWikiBg
      const traceLabel = node.kind === 'trace'
        ? node.label
        : node.traceId
          ? graph.nodes.find(n => n.id === `trace:${node.traceId}`)?.label ?? ''
          : ''
      if (hideWikiBg && /wiki-bg/.test(traceLabel)) {
        hideWikiBg = false
        changed = true
      }

      return changed ? { ...current, kinds, selectedTraceId, hideWikiBg } : current
    })

    window.setTimeout(() => focusRef.current?.(node), 0)
  }, [graph, nodeById, activeSearchMatch])

  const auditable = !!selected && AUDITABLE_KINDS.has(selected.kind)

  // Nodes greyed by Prune's model-backed refinement, minus any the user
  // re-included via "Keep anyway". It affects rendering and audit scope only
  // while the single Prune switch is on.
  const adjudicatedGrey = useMemo(() => {
    const s = new Set<string>()
    for (const d of adjudication ?? []) if (d.decision === 'abandoned' && !keepAnyway.has(d.nodeId)) s.add(d.nodeId)
    return s
  }, [adjudication, keepAnyway])
  const activePruneGrey = useMemo(
    () => (pruneOn ? adjudicatedGrey : new Set<string>()),
    [pruneOn, adjudicatedGrey],
  )

  const runNodeAudit = useCallback(async () => {
    if (!selected) return
    if (!api?.auditRunNode) {
      setAuditError('Audit API unavailable — restart the app (main/preload changed) and try again.')
      return
    }
    setAuditRunning(true)
    setAuditError(null)
    setAuditPanelOpen(true)
    setActiveFinding(null)
    setTraceSummary(null)
    try {
      const res = await api.auditRunNode({ nodeId: selected.id, excludeNodeIds: [...activePruneGrey] })
      if (!res?.success) { setAuditError(res?.error ?? 'Audit failed.'); return }
      setNodeAudit(res.result)
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err))
    } finally {
      setAuditRunning(false)
    }
  }, [selected, activePruneGrey])

  // One-shot: concurrently audit the whole focused trace, stream progress, then
  // show the deterministic summary (incl. the coverage gap).
  const runTraceAudit = useCallback(async () => {
    if (!api?.auditAuditTrace) {
      setAuditError('Audit API unavailable — restart the app (main/preload changed) and try again.')
      return
    }
    setTracing(true)
    setAuditError(null)
    setTraceSummary(null)
    setActiveFinding(null)
    setNodeAudit(null)
    setAuditPanelOpen(true)
    setTraceProgress({ done: 0, total: 0 })
    const unsub = api.onAuditTraceProgress?.((p: { done: number; total: number }) => setTraceProgress(p))
    try {
      const res = await api.auditAuditTrace({ excludeNodeIds: [...activePruneGrey] })
      if (!res?.success) { setAuditError(res?.error ?? 'Trace audit failed.'); return }
      setTraceSummary(res.summary ?? null)
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err))
    } finally {
      setTracing(false)
      setTraceProgress(null)
      unsub?.()
    }
  }, [activePruneGrey])

  // ⚪ → C.5 escalation: send one unverifiable visual/semantic finding to the
  // vision judge and fold the returned verdict back into the result in place.
  const escalateFinding = useCallback(async (finding: FaithfulnessFinding) => {
    if (!api?.auditEscalateFinding) return
    setEscalatingId(finding.claimId)
    try {
      const res = await api.auditEscalateFinding({ finding })
      if (res?.success && res.finding) {
        setNodeAudit(prev => prev && {
          ...prev,
          result: {
            ...prev.result,
            findings: prev.result.findings.map(f => f.claimId === finding.claimId ? res.finding! : f),
          },
        })
      }
    } finally {
      setEscalatingId(null)
    }
  }, [])

  // Prune's internal refinement: grey flagged-but-ambiguous nodes when the
  // model can point to explicit abandonment evidence.
  const runAdjudication = useCallback(async () => {
    if (!api?.auditAdjudicatePrune) return
    setAdjudicating(true)
    try {
      const res = await api.auditAdjudicatePrune({ terminalStepId: sliceInfo.prune?.terminalStepId ?? null })
      if (res?.success) setAdjudication(res.decisions ?? [])
    } finally {
      setAdjudicating(false)
    }
  }, [sliceInfo.prune?.terminalStepId])

  const handlePruneChange = useCallback((next: boolean) => {
    setPruneOn(next)
    if (next) void runAdjudication()
  }, [runAdjudication])

  const keepAnywayNode = useCallback((nodeId: string) => {
    setKeepAnyway(prev => { const next = new Set(prev); next.add(nodeId); return next })
  }, [])

  // Click a finding → jump to the node that MADE the claim (not the tool) and
  // arm the evidence highlight. Viewing that step shows the claim in blue;
  // clicking the anchor tool then shows the actual result in fuchsia.
  const selectFinding = useCallback((item: PanelFinding) => {
    setActiveFinding(item)
    const node = nodeById.get(item.sourceNodeId)
    if (node) onFocusNode(node)
  }, [nodeById, onFocusNode])

  // Per-node audit highlight terms for the active finding: the claim text on
  // its source node, and the actual recorded result values on the anchor tool
  // (result-value mismatches only — count/scope have no result substring).
  const auditHighlightByNode = useMemo(() => {
    const m = new Map<string, { claimExact: string[]; claimFuzzy: string[]; resultExact: string[] }>()
    if (!activeFinding) return m
    const f = activeFinding.finding
    const slot = (id: string) => {
      let s = m.get(id)
      if (!s) {
        s = { claimExact: [], claimFuzzy: [], resultExact: [] }
        m.set(id, s)
      }
      return s
    }
    const source = slot(activeFinding.sourceNodeId)
    // Source node: the claim text is often paraphrased, so use fuzzy region
    // matching. The explicit claimed value gives the highlighter a precise
    // fallback when the text is terse.
    if (f.claimText) source.claimFuzzy.push(f.claimText)
    if (f.claimed) {
      const claimedTerms = `${f.claimed}`.match(/-?\d+(?:\.\d+)?/g) ?? [`${f.claimed}`]
      for (const term of claimedTerms) if (!source.claimExact.includes(term)) source.claimExact.push(term)
    }
    // Anchor tool: actual result values (verbatim) for result-value mismatches.
    if (f.dimension === 'result') {
      const actualTerms = `${f.actual}`.match(/-?\d+(?:\.\d+)?/g) ?? (f.actual ? [`${f.actual}`] : [])
      for (const tid of f.anchorNodeIds) {
        const s = slot(tid)
        for (const term of actualTerms) if (!s.resultExact.includes(term)) s.resultExact.push(term)
      }
    }
    return m
  }, [activeFinding])
  const activeFindingId = activeFinding ? `${activeFinding.sourceNodeId}::${activeFinding.finding.claimId}` : null

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

  // §10 coverage line + section partitions. Claim findings (no `flag`) feed the
  // mismatch/unverifiable/match sections; flagged findings feed "Graph flags".
  // The panel renders EITHER the whole-trace summary (if a batch ran) OR the
  // single selected node's audit — both as the same grouped finding sections.
  // Each item carries its SOURCE node so a click jumps to the claiming node.
  const panelItems: PanelFinding[] = traceSummary
    ? traceSummary.findings.map(x => ({ finding: x.finding, sourceNodeId: x.nodeId }))
    : (nodeAudit ? nodeAudit.result.findings.map(f => ({ finding: f, sourceNodeId: nodeAudit.result.nodeId })) : [])
  const claimItems = panelItems.filter(it => !it.finding.flag)
  const flagItems = panelItems.filter(it => it.finding.flag)
  const coverage = useMemo(() => ({
    claims: claimItems.length,
    mismatch: claimItems.filter(it => it.finding.verdict === 'mismatch').length,
    unverifiable: claimItems.filter(it => it.finding.verdict === 'unverifiable').length,
    match: claimItems.filter(it => it.finding.verdict === 'match').length,
    flags: flagItems.length,
  }), [claimItems, flagItems])

  const auditStats: AuditProjectionStats | null = useMemo(() => {
    if (!sliceInfo.prune) return null
    return {
      on: sliceInfo.prune.on,
      terminalStepId: sliceInfo.prune.terminalStepId,
      terminalLabel: sliceInfo.prune.terminalLabel,
      keptNodes: sliceInfo.prune.keptNodes,
      prunedNodes: sliceInfo.prune.prunedNodes,
      flaggedNodes: sliceInfo.prune.flaggedNodes,
      spineNodes: sliceInfo.prune.spineNodes,
      metric: sliceInfo.prune.metric,
      edgeClasses: sliceInfo.prune.edgeClasses,
      nodeRoles: sliceInfo.prune.nodeRoles,
    }
  }, [sliceInfo])

  // —— Render branches ——————————————————————————————————————————————

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 t-text-muted">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-[13px]">Reading telemetry…</span>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <div className="max-w-md text-center">
          <h2 className="text-[15px] font-medium t-text mb-2">Could not load audit graph</h2>
          <p className="text-[13px] t-text-error mb-4">{error}</p>
          <button onClick={reload} className="px-3 py-1.5 rounded-md border t-border-subtle t-bg-elevated t-text text-[13px]">Retry</button>
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

      <div className="flex-1 min-w-0 min-h-0 flex t-bg-base">
        <div className="flex-1 min-w-0 min-h-0 relative">
        {shared && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 px-2.5 py-1 rounded-full border t-border t-bg-surface/90 backdrop-blur text-[10.5px] t-text-muted shadow-sm pointer-events-none">
            Shows activity on this machine only — collaborators' work appears in the Library &amp; Git history.
          </div>
        )}
        {!auditPanelOpen && (
          <button
            onClick={() => setAuditPanelOpen(true)}
            className="absolute top-14 left-2 z-20 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border t-border-subtle t-bg-surface/95 backdrop-blur shadow-sm t-text text-[12px] hover:t-bg-hover"
            title="Open audit panel"
          >
            <ShieldCheck size={13} />
            <span>Audit</span>
            {nodeAudit && (
              <span className="t-text-muted tabular-nums">· {coverage.mismatch}✗ {coverage.flags}⚑</span>
            )}
          </button>
        )}
        <AuditFindBar
          open={findOpen}
          query={findQuery}
          onQueryChange={setFindQueryReset}
          caseSensitive={findCaseSensitive}
          onToggleCaseSensitive={() => setFindCaseSensitive(v => !v)}
          matches={searchMatches}
          activeIndex={Math.min(activeFindIndex, Math.max(0, searchMatches.length - 1))}
          onSelectIndex={setActiveFindIndex}
          onNext={nextFindMatch}
          onPrev={prevFindMatch}
          onClose={() => setFindOpen(false)}
        />
        <ProvenanceGraph
          graph={graph}
          selected={selected}
          onSelect={onSelect}
          taint={taint}
          autoSuspect={autoSuspect}
          filters={filters}
          focusRef={focusRef}
          onSliceChange={onSliceChange}
          searchMatchNodeIds={searchMatchNodeIds}
          activeSearchNodeId={activeSearchMatch?.nodeId ?? null}
          pruneOn={pruneOn}
          onPruneChange={handlePruneChange}
          prunePending={adjudicating}
          adjudicatedGrey={activePruneGrey}
        />
        </div>
        {auditPanelOpen && (
        <div className="w-[420px] shrink-0 min-h-0 flex flex-col border-l t-border-subtle t-bg-surface">
          <div className="flex items-center gap-1.5 px-2.5 py-2">
            <button
              onClick={runNodeAudit}
              disabled={!auditable || auditRunning}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded border t-border-subtle t-bg-elevated t-text text-[12px] hover:t-bg-hover disabled:opacity-50"
              title={auditable ? 'Extract claims from this node and check them against recorded evidence' : 'This node type is not auditable (§5.1)'}
            >
              {auditRunning ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
              <span>Audit this node</span>
            </button>
            <button
              onClick={runTraceAudit}
              disabled={tracing}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded border t-border-subtle t-bg-elevated t-text text-[12px] hover:t-bg-hover disabled:opacity-50"
              title="Concurrently audit every node in the focused trace and roll up a summary"
            >
              {tracing ? <Loader2 size={13} className="animate-spin" /> : <Layers size={13} />}
              <span>{tracing && traceProgress && traceProgress.total > 0 ? `Auditing ${traceProgress.done}/${traceProgress.total}` : 'Audit trace'}</span>
            </button>
            <button
              onClick={() => setAuditPanelOpen(false)}
              className="ml-auto shrink-0 p-1 rounded t-text-muted hover:t-text hover:t-bg-hover"
              title="Close audit panel"
            >
              <X size={13} />
            </button>
          </div>

          <div className="px-2.5 pb-1.5 text-[11px] truncate">
            {selected
              ? auditable
                ? <span className="t-text-muted">Target: <span className="t-text-secondary">{selected.label}</span></span>
                : <span className="t-text-muted">Not auditable — select a step, chat, artifact, or tool node.</span>
              : <span className="t-text-muted">Select a node, then run the audit.</span>}
          </div>
          {pruneOn && adjudication && (
            <div className="px-2.5 pb-1.5 text-[11px] t-text-secondary tabular-nums">
              Prune greyed {activePruneGrey.size} node(s) · {adjudication.length} checked
            </div>
          )}
          {pruneOn && adjudication && adjudication.length > 0 && (
            <div className="border-t t-border-subtle max-h-[24vh] overflow-y-auto">
              {adjudication.map(d => {
                const node = nodeById.get(d.nodeId)
                const abandoned = d.decision === 'abandoned'
                const userKept = keepAnyway.has(d.nodeId)
                // Greyed = Prune marked abandoned AND user hasn't overridden.
                const greyed = abandoned && !userKept
                return (
                  <div key={d.nodeId} className="px-2.5 py-1.5 border-b t-border-subtle">
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: greyed ? 'rgb(139,92,246)' : 'rgb(113,113,122)' }} />
                      <button onClick={() => node && onFocusNode(node)} className="text-[11px] t-text truncate hover:underline">
                        {node?.label ?? d.nodeId}
                      </button>
                      <span className={`shrink-0 px-1 py-[1px] rounded text-[9.5px] font-medium ${greyed ? 'text-violet-500 bg-violet-500/10' : 't-text-muted'}`}>
                        {greyed ? 'greyed' : 'kept'}
                      </span>
                      {abandoned && (
                        <button
                          onClick={() => keepAnywayNode(d.nodeId)}
                          disabled={userKept}
                          className="ml-auto shrink-0 px-1.5 py-0.5 rounded border t-border-subtle text-[10px] t-text-secondary hover:t-bg-hover disabled:opacity-50"
                          title="Re-include this node in audit scope (§3.2 escape hatch)"
                        >
                          {userKept ? 'restored' : 'Keep anyway'}
                        </button>
                      )}
                    </div>
                    {d.reason && <div className="mt-0.5 text-[10.5px] t-text-muted leading-snug">{d.reason}</div>}
                    {d.quotedReasoning && <div className="mt-0.5 text-[10.5px] t-text-muted italic leading-snug">“{d.quotedReasoning}”</div>}
                  </div>
                )
              })}
            </div>
          )}
          {auditError && <div className="px-2.5 pb-2 text-[11px] t-text-error">{auditError}</div>}

          {/* Coverage header — for the trace batch OR the single node. */}
          {(traceSummary || nodeAudit) && (
            <div className="px-2.5 pb-2 space-y-1 shrink-0">
              <div className="text-[11px] t-text-secondary tabular-nums">
                {traceSummary ? `${traceSummary.nodesAudited} nodes · ` : ''}{coverage.claims} claims · <span className="text-rose-500">{coverage.mismatch} mismatch</span> · {coverage.unverifiable} unverifiable · <span className="text-emerald-500">{coverage.match} match</span> · {coverage.flags} flags
              </div>
              {traceSummary && (
                <div className="text-[10.5px] t-text-muted tabular-nums">
                  tool coverage: {traceSummary.coverage.coveredByClaim}/{traceSummary.coverage.focusedTools} by claim · {traceSummary.coverage.flaggedOnly} flagged-only · <span className={traceSummary.coverage.silent > 0 ? 'text-amber-500' : ''}>{traceSummary.coverage.silent} silent (no narrative)</span>
                </div>
              )}
            </div>
          )}

          {/* Single-node empty state (the trace summary shows its own coverage). */}
          {nodeAudit && !traceSummary && coverage.claims === 0 && coverage.flags === 0 && (
            <div className="border-t t-border-subtle px-2.5 py-2 text-[11px] t-text-muted leading-snug shrink-0">
              {nodeAudit.diagnostics.outputChars === 0
                ? <>No readable output on this node ({nodeAudit.result.nodeKind}). Audit a <span className="t-text-secondary">step</span> or <span className="t-text-secondary">chat</span> where the agent describes what it did, or an <span className="t-text-secondary">artifact</span> with content.</>
                : <>Analyzed {nodeAudit.diagnostics.outputChars} chars — no checkable process claims found. This audit only flags gaps between what the agent <span className="t-text-secondary">says it did</span> and what the trace shows.</>}
            </div>
          )}

          {/* The findings — every claim + flag, grouped by verdict, with reasons. */}
          {(traceSummary || nodeAudit) && (coverage.claims > 0 || coverage.flags > 0) && (
            <div className="flex-1 min-h-0 overflow-y-auto border-t t-border-subtle">
              <FindingSection title="Mismatches" tone="rose" icon={<AlertTriangle size={12} />}
                items={claimItems.filter(it => it.finding.verdict === 'mismatch')} activeId={activeFindingId} onSelect={selectFinding} />
              <FindingSection title="Graph flags" tone="amber"
                items={flagItems} activeId={activeFindingId} onSelect={selectFinding} />
              <FindingSection title="Unverifiable" tone="zinc"
                items={claimItems.filter(it => it.finding.verdict === 'unverifiable')} activeId={activeFindingId} onSelect={selectFinding}
                {...(!traceSummary && { onEscalate: escalateFinding, escalatingId })} />
              <FindingSection title="Match" tone="emerald" collapsed
                items={claimItems.filter(it => it.finding.verdict === 'match')} activeId={activeFindingId} onSelect={selectFinding} />
            </div>
          )}

          {traceSummary && coverage.claims === 0 && coverage.flags === 0 && (
            <div className="px-2.5 py-2 text-[11px] t-text-muted border-t t-border-subtle shrink-0">
              No claims or flags across the trace.{traceSummary.coverage.silent > 0 ? ` ${traceSummary.coverage.silent} tool ops had no narrative to check.` : ''}
            </div>
          )}
        </div>
        )}
      </div>

      <AuditRightRail
        graph={graph}
        selected={selected}
        taint={taint}
        derivedTaint={sliceInfo.derivedTaint}
        autoSuspect={autoSuspect}
        sliceStats={sliceStats}
        auditStats={auditStats}
        onTaint={markTaint}
        onClearTaint={clearTaint}
        onClearAllTaint={() => setTaint({})}
        onFocusNode={onFocusNode}
        searchQuery={findOpen ? findQuery : ''}
        searchCaseSensitive={findCaseSensitive}
        activeSearchMatch={activeSearchMatch}
        auditHighlight={selected ? auditHighlightByNode.get(selected.id) : undefined}
        collapsed={rightCollapsed}
        onToggleCollapsed={() => setRightCollapsed(c => !c)}
      />
    </div>
  )
}
