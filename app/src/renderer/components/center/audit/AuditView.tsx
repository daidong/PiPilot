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
import { AlertTriangle, Loader2, ShieldCheck, X } from 'lucide-react'
import { useUIStore } from '../../../stores/ui-store'
import type { GraphNode, NodeKind } from '../../../../../../lib/audit-graph/index'
import type { AuditRunResult } from '../../../../../../lib/audit-graph/audit/index'
import { useAuditGraph } from './use-audit-graph'
import { ProvenanceGraph } from './ProvenanceGraph'
import { AuditLeftRail, AuditRightRail, type AuditProjectionStats, type FiltersState, type SliceStats } from './AuditSidePanels'
import { EmptyTelemetry } from './EmptyTelemetry'
import { useSharingStore } from '../../../stores/sharing-store'
import { computeAutoSuspect } from './auto-suspect'

const DEFAULT_KINDS: Set<NodeKind> = new Set(['trace', 'step', 'tool', 'chat', 'artifact', 'file', 'dir'])
const api = (window as any).api

const VERDICT_BADGE: Record<string, string> = {
  supported: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  contradicted: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  ungrounded: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  not_checkable: 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400',
}
const VERDICT_LABEL: Record<string, string> = {
  supported: '✓ supported',
  contradicted: '✗ contradicted',
  ungrounded: '~ low-conf',
  not_checkable: '– n/c',
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
  const [auditRun, setAuditRun] = useState<AuditRunResult | null>(null)
  const [auditRunning, setAuditRunning] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  // Panel is not resident: collapsed to a small launcher until opened.
  const [auditPanelOpen, setAuditPanelOpen] = useState(false)

  // Side-panel collapse
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)

  // Imperative focus into the graph (set by ProvenanceGraph)
  const focusRef = useRef<((n: GraphNode) => void) | null>(null)

  // Reset selection + taint when the loaded graph identity changes (e.g. on reload)
  useEffect(() => { setSelected(null); setTaint({}); setAuditRun(null); setAuditError(null); setAuditPanelOpen(false) }, [graph?.builtAt])

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
  const [sliceInfo, setSliceInfo] = useState<{
    nodes: Set<string>
    derivedTaint: Set<string>
    audit?: {
      mode: 'audit' | 'full'
      targetId: string | null
      targetLabel: string | null
      spineNodes: Set<string>
      observationNodes: Set<string>
      materialNodes: Set<string>
      recoveredFailureNodes: Set<string>
      hiddenBranchNodes: Set<string>
    }
  }>(
    { nodes: new Set(), derivedTaint: new Set() },
  )
  const onSliceChange = useCallback(
    (info: {
      nodes: Set<string>
      derivedTaint: Set<string>
      audit?: {
        mode: 'audit' | 'full'
        targetId: string | null
        targetLabel: string | null
        spineNodes: Set<string>
        observationNodes: Set<string>
        materialNodes: Set<string>
        recoveredFailureNodes: Set<string>
        hiddenBranchNodes: Set<string>
      }
    }) => setSliceInfo(info),
    [],
  )

  const autoSuspect = useMemo(
    () => (graph ? computeAutoSuspect(graph) : new Map<string, string[]>()),
    [graph],
  )

  const nodeById = useMemo(
    () => new Map((graph?.nodes ?? []).map(n => [n.id, n])),
    [graph],
  )

  const runDeliverableAudit = useCallback(async () => {
    if (!api?.auditRunDeliverable) {
      setAuditError('Audit API unavailable — restart the app (main/preload changed) and try again.')
      return
    }
    setAuditRunning(true)
    setAuditError(null)
    try {
      const res = await api.auditRunDeliverable({ targetStepId: sliceInfo.audit?.targetId ?? null })
      if (!res?.success) {
        setAuditError(res?.error ?? 'Audit failed.')
        return
      }
      setAuditRun(res.result)
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err))
    } finally {
      setAuditRunning(false)
    }
  }, [sliceInfo.audit?.targetId])

  const focusEvidenceForClaim = useCallback((claimId: string) => {
    const verdict = auditRun?.report.claims.find(c => c.claimId === claimId)
    const packet = auditRun?.packets.find(p => p.claimId === claimId)
    const evidenceId = verdict?.usedEvidenceIds.find(id => nodeById.has(id)) ?? packet?.nodes.find(n => nodeById.has(n.id))?.id
    const node = evidenceId ? nodeById.get(evidenceId) : null
    if (node) onFocusNode(node)
  }, [auditRun, nodeById, onFocusNode])

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

  const auditStats: AuditProjectionStats | null = useMemo(() => {
    if (!sliceInfo.audit) return null
    return {
      mode: sliceInfo.audit.mode,
      targetId: sliceInfo.audit.targetId,
      targetLabel: sliceInfo.audit.targetLabel,
      spineNodes: sliceInfo.audit.spineNodes.size,
      observationNodes: sliceInfo.audit.observationNodes.size,
      materialNodes: sliceInfo.audit.materialNodes.size,
      recoveredFailureNodes: sliceInfo.audit.recoveredFailureNodes.size,
      hiddenBranchNodes: sliceInfo.audit.hiddenBranchNodes.size,
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

      <div className="flex-1 min-w-0 min-h-0 relative t-bg-base">
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
            {auditRun && (
              <span className="t-text-muted tabular-nums">· {auditRun.report.coverage.contradicted}✗ {auditRun.report.coverage.checkable}/{auditRun.report.coverage.total}</span>
            )}
          </button>
        )}
        {auditPanelOpen && (
        <div className="absolute top-14 left-2 z-20 w-[min(520px,calc(100%-16px))] border t-border-subtle t-bg-surface/95 backdrop-blur shadow-sm rounded-md">
          <div className="flex items-center gap-2 px-2.5 py-2">
            <button
              onClick={runDeliverableAudit}
              disabled={auditRunning}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded border t-border-subtle t-bg-elevated t-text text-[12px] hover:t-bg-hover disabled:opacity-60"
              title="Audit the latest deliverable against recorded evidence"
            >
              {auditRunning ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
              <span>Audit deliverable</span>
            </button>
            {auditRun && (
              <div className="text-[11px] t-text-secondary tabular-nums truncate">
                {auditRun.report.coverage.total} claims · {auditRun.report.coverage.checkable} checkable · {auditRun.report.coverage.supported} supported · {auditRun.report.coverage.contradicted} contradicted · {auditRun.report.coverage.ungrounded} low-confidence · {auditRun.report.coverage.notCheckable} not-checkable
              </div>
            )}
            {!auditRun && !auditError && (
              <div className="text-[11px] t-text-muted truncate">
                Checks each claim that references this graph’s recorded evidence.
              </div>
            )}
            <button
              onClick={() => setAuditPanelOpen(false)}
              className="ml-auto shrink-0 p-1 rounded t-text-muted hover:t-text hover:t-bg-hover"
              title="Close audit panel"
            >
              <X size={13} />
            </button>
          </div>
          {auditError && (
            <div className="px-2.5 pb-2 text-[11px] t-text-error">{auditError}</div>
          )}
          {auditRun && auditRun.report.contradictions.length > 0 && (
            <div className="border-t t-border-subtle px-2.5 py-2 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold t-text-error">
                <AlertTriangle size={12} />
                <span>Contradictions</span>
              </div>
              {auditRun.report.contradictions.slice(0, 4).map(c => (
                <button
                  key={c.claimId}
                  onClick={() => focusEvidenceForClaim(c.claimId)}
                  className="block w-full text-left px-2 py-1 rounded t-bg-elevated hover:t-bg-hover"
                  title={c.explanation}
                >
                  <div className="text-[11px] t-text truncate">{c.claimText ?? c.claimId}</div>
                  {c.quotedContradiction && (
                    <div className="text-[10.5px] t-text-muted truncate">“{c.quotedContradiction}”</div>
                  )}
                </button>
              ))}
            </div>
          )}
          {auditRun && auditRun.report.claims.length > 0 && (
            <div className="border-t t-border-subtle max-h-[40vh] overflow-y-auto">
              {auditRun.report.claims.map(c => (
                <button
                  key={c.claimId}
                  onClick={() => focusEvidenceForClaim(c.claimId)}
                  className="flex w-full items-start gap-1.5 text-left px-2.5 py-1.5 border-b t-border-subtle hover:t-bg-hover"
                  title={c.explanation}
                >
                  <span className={`mt-[1px] shrink-0 px-1 py-[1px] rounded text-[9.5px] font-medium ${VERDICT_BADGE[c.verdict] ?? ''}`}>
                    {VERDICT_LABEL[c.verdict] ?? c.verdict}
                  </span>
                  <span className="text-[11px] t-text-secondary leading-snug">{c.claimText ?? c.claimId}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        )}
        <ProvenanceGraph
          graph={graph}
          selected={selected}
          onSelect={onSelect}
          taint={taint}
          autoSuspect={autoSuspect}
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
        autoSuspect={autoSuspect}
        sliceStats={sliceStats}
        auditStats={auditStats}
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
