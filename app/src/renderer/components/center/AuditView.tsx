/**
 * Audit tab — two-pane center.
 *
 * The entity list lives in the left rail (AuditSidebar) so the rail does
 * real work instead of mirroring status. The center is two panes:
 *
 *   Pane A — Entity & Lineage (versions, upstream, downstream, capture meta)
 *            with a breadcrumb trail at the top so traversing relationship
 *            edges accumulates a visible path you can step back through.
 *   Pane B — Audit Run (live or archived) with tabs:
 *              Findings  · the verdicts
 *              History   · the persisted procedure (reasoning + tool calls)
 *              Scope     · which provenance nodes the auditor reviewed
 *
 * Selection contract: the entity selection (and breadcrumb trail) lives in
 * `useUIStore.auditTrail` so the rail can mutate it independently. Clicking
 * an upstream/downstream edge here pushes; clicking a row in the rail resets.
 *
 * RFC: docs/spec/trust-audit.md §5 (UI).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'

import { useProvenanceStore, type ProvenanceNode } from '../../stores/provenance-store'
import { useAuditStore, type AuditReport, type Finding, type TimelineItem } from '../../stores/audit-store'
import { useUIStore } from '../../stores/ui-store'
import {
  projectGraph,
  defaultFilters,
  CATEGORY_COLOR,
  type ViewNode,
  type ViewEdge,
  type AuditFilters
} from './audit-graph'

// ───────────────────────────────────────────────────────────────────────────
// Per-kind language
// ───────────────────────────────────────────────────────────────────────────

type Kind = ViewNode['kind']

const KIND_GLYPH: Record<Kind, string> = {
  'memory-artifact': '◆', 'workspace-file': '▦', 'computation': '⚙',
  'draft': '✎', 'audit-report': '⛨'
}
const KIND_LABEL: Record<Kind, string> = {
  'memory-artifact': 'memory', 'workspace-file': 'file', 'computation': 'compute',
  'draft': 'draft', 'audit-report': 'audit'
}
const KIND_DOT: Record<Kind, string> = {
  'memory-artifact': 'rgb(160 188 220)', 'workspace-file': 'rgb(160 200 168)',
  'computation':     'rgb(190 175 220)', 'draft':          'rgb(220 196 144)',
  'audit-report':    'rgb(220 168 168)'
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function basename(label: string): string {
  if (!label) return ''
  const i = label.lastIndexOf('/')
  return i >= 0 && i < label.length - 1 ? label.slice(i + 1) : label
}
function dirname(label: string): string {
  if (!label) return ''
  const i = label.lastIndexOf('/')
  return i >= 0 ? label.slice(0, i) : ''
}
function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function relativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Math.max(0, now - t)
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function shortIso(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, '')
}
function timeOfDay(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ───────────────────────────────────────────────────────────────────────────
// Markers
// ───────────────────────────────────────────────────────────────────────────

function DriftMarker({ title }: { title?: string }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" className="inline-block t-text-warning"
         role="img" aria-label={title ?? 'drift'}>
      <title>{title ?? 'content drifted since capture'}</title>
      <path d="M4 0.5 L7.5 7 L0.5 7 Z" fill="currentColor" />
    </svg>
  )
}
function OversizeMarker({ title }: { title?: string }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" className="inline-block t-text-secondary"
         role="img" aria-label={title ?? 'oversize'}>
      <title>{title ?? 'too large to snapshot at capture'}</title>
      <rect x="0" y="0" width="8" height="2" fill="currentColor"/>
      <rect x="0" y="3" width="8" height="2" fill="currentColor"/>
      <rect x="0" y="6" width="8" height="2" fill="currentColor"/>
    </svg>
  )
}
function PulseDot() {
  return (
    <span className="inline-block w-1.5 h-1.5 rounded-full t-bg-accent"
          style={{ animation: 'auditMainPulse 1.6s ease-in-out infinite' }} />
  )
}
function ChevronRight({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" className="t-text-muted shrink-0"
         aria-hidden="true">
      <path d="M4 2 L8 6 L4 10" fill="none" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function AuditMainStyles() {
  return (
    <style>{`
      @keyframes auditMainPulse {
        0%, 100% { opacity: 0.95; }
        50%      { opacity: 0.35; }
      }
    `}</style>
  )
}

function CopyHash({ hash, length = 12 }: { hash: string; length?: number }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard?.writeText(hash).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        })
      }}
      className={`font-mono text-[10px] tabular-nums px-1 -mx-1 rounded transition-colors ${
        copied
          ? 't-text-accent bg-[var(--color-accent-soft)]/15'
          : 't-text-secondary hover:t-text hover:bg-[var(--color-accent-soft)]/10'
      }`}
      title={copied ? 'copied' : `copy full hash · ${hash}`}
    >
      {hash.slice(0, length)}
    </button>
  )
}

function SectionLabel({ children, count }: {
  children: React.ReactNode
  count?: number
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] font-medium tracking-wider uppercase t-text-muted">
        {children}
      </span>
      {count !== undefined && (
        <span className="text-[10px] tabular-nums t-text-muted">{count}</span>
      )}
    </div>
  )
}

function KeyValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] tracking-wider uppercase t-text-muted w-16 shrink-0">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

export function AuditView() {
  // Provenance graph (source of truth for entities and edges)
  const enabled       = useProvenanceStore(s => s.enabled)
  const loading       = useProvenanceStore(s => s.loading)
  const error         = useProvenanceStore(s => s.error)
  const rawNodes      = useProvenanceStore(s => s.nodes)
  const rawEdges      = useProvenanceStore(s => s.edges)
  const probeEnabled  = useProvenanceStore(s => s.probeEnabled)
  const loadGraph     = useProvenanceStore(s => s.loadGraph)

  // Audit run state
  const reports          = useAuditStore(s => s.reports)
  const selectedAuditId  = useAuditStore(s => s.selectedAuditId)
  const selectedFindingId = useAuditStore(s => s.selectedFindingId)
  const run              = useAuditStore(s => s.run)
  const startAudit       = useAuditStore(s => s.startAudit)
  const loadReports      = useAuditStore(s => s.loadReports)
  const cancelAudit      = useAuditStore(s => s.cancelAudit)
  const selectAudit      = useAuditStore(s => s.selectAudit)
  const selectFinding    = useAuditStore(s => s.selectFinding)

  // Selection trail — shared with AuditSidebar via ui-store. The last id is
  // the current selection; clicking upstream/downstream here pushes; clicking
  // a row in the rail resets; clicking a breadcrumb truncates.
  const trail        = useUIStore(s => s.auditTrail)
  const setTrail     = useUIStore(s => s.setAuditTrail)
  const selectedEntityId = trail[trail.length - 1] ?? null

  // Right-pane sub-tab (findings/history/scope) — lifted to ui-store so it
  // survives tab switches like the rest of the audit-tab UI state.
  const auditRunTab    = useUIStore(s => s.auditRunTab)
  const setAuditRunTab = useUIStore(s => s.setAuditRunTab)

  const [projectionFilters] = useState<AuditFilters>(defaultFilters)

  useEffect(() => {
    void probeEnabled().then(() => loadGraph())
    void loadReports()
  }, [probeEnabled, loadGraph, loadReports])

  // Project the raw graph
  const projection = useMemo(
    () => projectGraph(rawNodes as ProvenanceNode[], rawEdges, projectionFilters),
    [rawNodes, rawEdges, projectionFilters]
  )
  const nodeById = useMemo(() => {
    const m = new Map<string, ViewNode>()
    for (const n of projection.nodes) m.set(n.id, n)
    return m
  }, [projection.nodes])
  const upstreamByTarget = useMemo(() => {
    const m = new Map<string, ViewEdge[]>()
    for (const e of projection.edges) {
      const arr = m.get(e.to) ?? []
      arr.push(e)
      m.set(e.to, arr)
    }
    return m
  }, [projection.edges])
  // The second half of the relationship — outgoing edges by source. Without
  // it the user could only step backwards into producers.
  const downstreamBySource = useMemo(() => {
    const m = new Map<string, ViewEdge[]>()
    for (const e of projection.edges) {
      const arr = m.get(e.from) ?? []
      arr.push(e)
      m.set(e.from, arr)
    }
    return m
  }, [projection.edges])

  // Drop trail entries that no longer exist in the current projection (e.g.
  // after a graph refresh). Avoids dangling breadcrumbs.
  useEffect(() => {
    if (trail.length === 0) return
    const cleaned = trail.filter(id => nodeById.has(id))
    if (cleaned.length !== trail.length) setTrail(cleaned)
  }, [nodeById, trail, setTrail])

  const selectedEntity = selectedEntityId ? nodeById.get(selectedEntityId) ?? null : null

  // Map raw provenance node id → canonical ViewNode.id, so we can resolve
  // a report's rootNodeIds / a finding's implicatedNodeIds back to the
  // entity rows on the left rail. Reports reference *version* ids, the
  // sidebar groups them under refKey, so this bridge is required.
  const versionIdToEntityId = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of projection.nodes) {
      for (const v of n.versions) m.set(v.id, n.id)
    }
    return m
  }, [projection.nodes])

  // For each entity (canonical id), which reports cover it directly (one of
  // its versions is in scope.rootNodeIds) vs indirectly (only implicated by
  // a finding while the report's root entity is something else)?
  // Sorted newest-first inside each list so picking [0] = "most recent".
  const reportIndex = useMemo(() => {
    const direct = new Map<string, AuditReport[]>()
    const indirect = new Map<string, { report: AuditReport; rootEntityId: string | null }[]>()
    const sorted = [...reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const r of sorted) {
      const rootEntities = new Set<string>()
      for (const id of r.scope.rootNodeIds) {
        const eid = versionIdToEntityId.get(id)
        if (eid) rootEntities.add(eid)
      }
      const rootEntityId = rootEntities.size > 0 ? [...rootEntities][0]! : null
      for (const eid of rootEntities) {
        const arr = direct.get(eid) ?? []
        arr.push(r); direct.set(eid, arr)
      }
      // Indirect: any finding implicates an entity that is NOT a root.
      const implicated = new Set<string>()
      for (const f of r.findings) {
        for (const id of f.implicatedNodeIds) {
          const eid = versionIdToEntityId.get(id)
          if (eid && !rootEntities.has(eid)) implicated.add(eid)
        }
      }
      for (const eid of implicated) {
        const arr = indirect.get(eid) ?? []
        arr.push({ report: r, rootEntityId }); indirect.set(eid, arr)
      }
    }
    return { direct, indirect }
  }, [reports, versionIdToEntityId])

  const auditedEntityIds = useMemo(() => {
    const s = new Set<string>()
    for (const id of reportIndex.direct.keys()) s.add(id)
    for (const id of reportIndex.indirect.keys()) s.add(id)
    return s
  }, [reportIndex])

  // Auto-select the first entity when entering the audit tab and nothing is
  // selected yet. "First" follows the sidebar's default sort (newest-first by
  // latest version createdAt) so the rail and the detail pane agree.
  useEffect(() => {
    if (trail.length > 0) return
    if (projection.nodes.length === 0) return
    const sorted = [...projection.nodes].sort((a, b) =>
      (b.versions[b.versions.length - 1]?.createdAt ?? '')
        .localeCompare(a.versions[a.versions.length - 1]?.createdAt ?? '')
    )
    setTrail([sorted[0]!.id])
  }, [trail.length, projection.nodes, setTrail])

  // When the user switches entity, swing the right pane to the most relevant
  // archived report — direct match wins, indirect (implicated) match second,
  // null otherwise. We track the last entity we auto-selected for so manual
  // dropdown choices aren't clobbered when `reports` re-emits.
  const lastAutoEntityRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedEntityId) return
    if (lastAutoEntityRef.current === selectedEntityId) return
    lastAutoEntityRef.current = selectedEntityId
    if (run.running) return  // don't disturb a live run
    const direct = reportIndex.direct.get(selectedEntityId)
    if (direct && direct.length > 0) { selectAudit(direct[0]!.id); return }
    const indirect = reportIndex.indirect.get(selectedEntityId)
    if (indirect && indirect.length > 0) { selectAudit(indirect[0]!.report.id); return }
    selectAudit(null)
  }, [selectedEntityId, reportIndex, selectAudit, run.running])

  // ── selection actions ──────────────────────────────────────────────────
  const navigateAlongEdge = (id: string) => {
    if (!nodeById.has(id)) return
    if (trail[trail.length - 1] === id) return
    setTrail([...trail, id])
  }
  const jumpTrail = (idx: number) => {
    setTrail(trail.slice(0, idx + 1))
  }

  // Empty / disabled / loading / error states (rail handles its own;
  // center mirrors them so the user isn't staring at a blank pane).
  if (enabled === null || loading) {
    return <CenteredCard tone="muted">Loading provenance graph…</CenteredCard>
  }
  if (!enabled) {
    return (
      <CenteredCard tone="muted">
        <div className="space-y-3 max-w-md">
          <div className="text-[14px] t-text">Provenance capture is off.</div>
          <div className="text-[12px] t-text-secondary leading-relaxed">
            Restart with{' '}
            <code className="px-1.5 py-0.5 rounded text-[11px] font-mono t-bg-elevated t-text-accent">ENABLE_PROVENANCE=1</code>
            {' '}to start tracking the causal graph for this project.
          </div>
        </div>
      </CenteredCard>
    )
  }
  if (error) return <CenteredCard tone="error">{error}</CenteredCard>
  if (rawNodes.length === 0) {
    return (
      <CenteredCard tone="muted">
        <div className="space-y-3 max-w-md">
          <div className="text-[14px] t-text">No provenance captured yet.</div>
          <div className="text-[12px] t-text-secondary leading-relaxed">
            Run a tool that produces an artifact — literature search, document conversion, data analysis —
            and the causal graph will populate here.
          </div>
          <button onClick={() => void loadGraph()}
                  className="text-[12px] t-text-accent hover:underline">
            Refresh ↻
          </button>
        </div>
      </CenteredCard>
    )
  }

  const auditFromNode = (node: ViewNode) => {
    void startAudit({ rootNodeIds: [node.representative.id] })
  }

  // Only fall back to "any first report" when nothing is selected AND no
  // entity is selected (cold start). Once an entity is picked, the auto-
  // selection effect above is the source of truth — falling back here would
  // surface an unrelated report and confuse the "report follows entity" UX.
  const archivedReport =
    reports.find(r => r.id === selectedAuditId) ??
    (selectedEntityId ? null : reports[0]) ??
    null

  // Status of the selected entity wrt audits — drives both the audit button's
  // appearance and the "referred from" hint in the right pane.
  const entityAuditStatus: 'none' | 'direct' | 'indirect' = !selectedEntityId
    ? 'none'
    : reportIndex.direct.has(selectedEntityId)
      ? 'direct'
      : reportIndex.indirect.has(selectedEntityId)
        ? 'indirect'
        : 'none'

  // If the selected entity is only referenced indirectly, find which entity
  // the displayed report was *actually* rooted on so the right pane can say
  // "referred from {root}".
  const referredFromEntity: ViewNode | null = (() => {
    if (!selectedEntityId || !archivedReport) return null
    if (entityAuditStatus !== 'indirect') return null
    const indirect = reportIndex.indirect.get(selectedEntityId) ?? []
    const match = indirect.find(x => x.report.id === archivedReport.id)
    if (!match || !match.rootEntityId) return null
    return nodeById.get(match.rootEntityId) ?? null
  })()

  // Cross-highlight: when a finding is selected, walk the trail to its first
  // implicated node (no-op if not implicated or already shown).
  const onSelectFinding = (id: string | null) => {
    selectFinding(id)
    if (!id) return
    const f = archivedReport?.findings.find(x => x.id === id) ?? run.liveFindings.find(x => x.id === id)
    const target = f?.implicatedNodeIds[0]
    if (target && nodeById.has(target)) navigateAlongEdge(target)
  }

  const driftCount = projection.nodes.filter(n => n.hasDrift).length

  return (
    <div className="flex-1 flex flex-col min-h-0 t-bg-base">
      <AuditMainStyles />

      <div className="flex-1 flex min-h-0">
        {/* PANE A — Entity & Lineage (with breadcrumb) */}
        <div className="w-[42%] min-w-[320px] min-w-0 border-r t-border">
          {selectedEntity ? (
            <EntityDetailPanel
              node={selectedEntity}
              trail={trail.map(id => nodeById.get(id)).filter((n): n is ViewNode => !!n)}
              upstream={upstreamByTarget.get(selectedEntity.id) ?? []}
              downstream={downstreamBySource.get(selectedEntity.id) ?? []}
              edgeLookup={nodeById}
              auditDisabled={run.running}
              auditStatus={entityAuditStatus}
              onAudit={() => auditFromNode(selectedEntity)}
              onNavigate={navigateAlongEdge}
              onJumpTrail={jumpTrail}
            />
          ) : (
            <DetailEmptyState entityCount={projection.nodes.length} />
          )}
        </div>

        {/* PANE B — Audit Run (live or archived) */}
        <div className="flex-1 min-w-0">
          <AuditRunPanel
            run={run}
            reports={reports}
            selectedAuditId={selectedAuditId}
            selectedFindingId={selectedFindingId}
            archivedReport={archivedReport}
            referredFromEntity={referredFromEntity}
            tab={auditRunTab}
            onTab={setAuditRunTab}
            onSelectAudit={selectAudit}
            onSelectFinding={onSelectFinding}
            onCancel={() => void cancelAudit()}
          />
        </div>
      </div>

      <StatusBar
        nodeCount={projection.nodes.length}
        edgeCount={projection.edges.length}
        driftCount={driftCount}
        running={run.running}
      />
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// StatusBar
// ───────────────────────────────────────────────────────────────────────────

function StatusBar({ nodeCount, edgeCount, driftCount, running }: {
  nodeCount: number; edgeCount: number; driftCount: number; running: boolean
}) {
  return (
    <div className="px-4 py-1 border-t t-border t-bg-surface flex items-center gap-3 text-[10px] tabular-nums t-text-muted">
      <span className="font-mono">graph</span>
      <span>{nodeCount} nodes · {edgeCount} edges</span>
      <span className="t-text-muted">·</span>
      <span>{driftCount} drift</span>
      {running && (
        <span className="ml-auto t-text-accent flex items-center gap-1.5">
          <PulseDot /> auditor running
        </span>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// EntityDetailPanel (PANE A — with breadcrumb + downstream)
// ───────────────────────────────────────────────────────────────────────────

function EntityDetailPanel({
  node, trail, upstream, downstream, edgeLookup,
  auditDisabled, auditStatus, onAudit, onNavigate, onJumpTrail
}: {
  node: ViewNode
  trail: ViewNode[]
  upstream: ViewEdge[]
  downstream: ViewEdge[]
  edgeLookup: Map<string, ViewNode>
  auditDisabled: boolean
  auditStatus: 'none' | 'direct' | 'indirect'
  onAudit: () => void
  onNavigate: (id: string) => void
  onJumpTrail: (idx: number) => void
}) {
  const filename = basename(node.label)
  const dir = dirname(node.label)
  const versions = node.versions
  const v = versions[versions.length - 1]!
  // Button copy reflects whether this entity has been reviewed before — a
  // "Re-audit" affordance is more honest than offering "Audit" again, and
  // the indirect case (only mentioned in someone else's findings) deserves
  // its own label so the user knows there's no dedicated report yet.
  const baseLabel = upstream.length === 0
    ? 'Audit this artifact'
    : `Audit cone · ${upstream.length + 1} nodes`
  const auditLabel = auditDisabled
    ? baseLabel
    : auditStatus === 'direct'
      ? (upstream.length === 0 ? 'Re-audit this artifact' : `Re-audit cone · ${upstream.length + 1} nodes`)
      : auditStatus === 'indirect'
        ? `Audit this artifact · referenced before`
        : baseLabel

  const [showAllVersions, setShowAllVersions] = useState(false)

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Header — kind/version pills, breadcrumb, file label, audit button */}
      <div className="px-5 pt-3 pb-3 border-b t-border t-bg-surface">
        {/* Breadcrumb trail — only when there is a path to step back through */}
        {trail.length > 1 && (
          <Breadcrumb trail={trail} onJump={onJumpTrail} />
        )}

        <div className="flex items-center gap-2 mt-2">
          <span aria-hidden="true"
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: KIND_DOT[node.kind] }} />
          <span className="text-[10px] tracking-wider uppercase t-text-muted">{KIND_LABEL[node.kind]}</span>
          {versions.length > 1 && (
            <>
              <span className="t-text-muted">·</span>
              <span className="text-[10px] tabular-nums t-text-muted">{versions.length} versions</span>
            </>
          )}
          {node.hasDrift && (
            <>
              <span className="t-text-muted">·</span>
              <span className="flex items-center gap-1 text-[10px] tracking-wider uppercase t-text-warning">
                <DriftMarker /> drift
              </span>
            </>
          )}
        </div>

        <div className="mt-2 text-[16px] t-text break-all leading-tight font-medium">{filename}</div>
        {dir && (
          <div className="mt-1 text-[11px] font-mono tabular-nums t-text-muted break-all">
            {dir}/
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={onAudit}
            disabled={auditDisabled}
            className={`px-3 py-1.5 rounded text-[11px] font-medium border transition-colors ${
              auditDisabled
                ? 't-text-muted t-border-subtle cursor-not-allowed'
                : auditStatus === 'direct'
                  ? 't-text t-border-subtle bg-[var(--color-accent-soft)]/4 hover:bg-[var(--color-accent-soft)]/12'
                  : 't-text-accent t-border-accent-soft bg-[var(--color-accent-soft)]/8 hover:bg-[var(--color-accent-soft)]/18'
            }`}
            title={auditDisabled ? 'audit running…' : auditLabel}
          >
            {auditStatus === 'direct' && !auditDisabled && (
              <span aria-hidden="true" className="mr-1.5 t-text-accent">✓</span>
            )}
            {auditLabel}
          </button>
          {auditDisabled && (
            <span className="flex items-center gap-1.5 text-[10px] t-text-accent">
              <PulseDot /> running
            </span>
          )}
          {!auditDisabled && auditStatus === 'indirect' && (
            <span className="text-[10px] t-text-muted italic">
              implicated by another audit
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-6">
        {/* Versions */}
        <section>
          <SectionLabel count={versions.length}>Versions</SectionLabel>
          <ul className="mt-1.5 space-y-0.5">
            {(showAllVersions ? [...versions].reverse() : [...versions].reverse().slice(0, 8)).map((ver, i) => {
              const idx = versions.length - 1 - i
              const drift = !!ver.drift && ver.drift.observedHash !== ver.snapshot?.contentHash
              return (
                <li key={ver.id}
                    className="flex items-baseline gap-2 px-2 py-1 rounded hover:bg-[var(--color-accent-soft)]/6 transition-colors">
                  <span className="font-mono text-[10px] tabular-nums t-text-muted w-7 shrink-0">
                    v{idx + 1}
                  </span>
                  <span className="text-[11px] tabular-nums t-text-secondary flex-1 truncate"
                        title={shortIso(ver.createdAt)}>
                    {relativeTime(ver.createdAt)} ago
                  </span>
                  {ver.snapshot && (
                    <CopyHash hash={ver.snapshot.contentHash} length={10} />
                  )}
                  {ver.snapshot && (
                    <span className="text-[10px] tabular-nums t-text-muted w-14 text-right">
                      {formatBytes(ver.snapshot.sizeBytes)}
                    </span>
                  )}
                  {drift && <DriftMarker />}
                  {ver.snapshot?.oversizeSkipped && <OversizeMarker />}
                </li>
              )
            })}
          </ul>
          {!showAllVersions && versions.length > 8 && (
            <button
              onClick={() => setShowAllVersions(true)}
              className="mt-1 text-[10px] t-text-accent hover:underline px-2"
            >
              Show all {versions.length}
            </button>
          )}
        </section>

        {/* Upstream — what produced this entity */}
        <section>
          <SectionLabel count={upstream.length}>Upstream</SectionLabel>
          {upstream.length === 0 ? (
            <div className="mt-1.5 text-[11px] t-text-muted italic">no tracked inputs</div>
          ) : (
            <EdgeList edges={upstream} resolveOther={(e) => edgeLookup.get(e.from)} onNavigate={onNavigate} direction="up" />
          )}
        </section>

        {/* Downstream — what this entity flows into. Symmetric to Upstream
            so traversal works both ways from a single entity. */}
        <section>
          <SectionLabel count={downstream.length}>Downstream</SectionLabel>
          {downstream.length === 0 ? (
            <div className="mt-1.5 text-[11px] t-text-muted italic">no tracked consumers</div>
          ) : (
            <EdgeList edges={downstream} resolveOther={(e) => edgeLookup.get(e.to)} onNavigate={onNavigate} direction="down" />
          )}
        </section>

        {/* Latest capture */}
        <section>
          <SectionLabel>Latest capture</SectionLabel>
          <div className="mt-1.5 space-y-1">
            <KeyValue label="captured">
              <span className="font-mono text-[10px] tabular-nums t-text-secondary">
                {shortIso(v.createdAt)}
              </span>
            </KeyValue>
            {v.snapshot && (
              <>
                <KeyValue label="hash">
                  <CopyHash hash={v.snapshot.contentHash} length={20} />
                </KeyValue>
                <KeyValue label="size">
                  <span className="font-mono text-[10px] tabular-nums t-text-secondary"
                        title={`${v.snapshot.sizeBytes.toLocaleString()} bytes`}>
                    {formatBytes(v.snapshot.sizeBytes)}
                  </span>
                </KeyValue>
                <KeyValue label="blob">
                  {v.snapshot.snapshotted ? (
                    <span className="text-[10px] tabular-nums t-text-secondary">present</span>
                  ) : v.snapshot.oversizeSkipped ? (
                    <span className="text-[10px] tabular-nums t-text-warning">oversize</span>
                  ) : (
                    <span className="text-[10px] tabular-nums t-text-muted">hash only</span>
                  )}
                </KeyValue>
              </>
            )}
            {v.toolCall && (
              <KeyValue label="tool">
                <span className="font-mono text-[11px] t-text">{v.toolCall.name}</span>
              </KeyValue>
            )}
            {v.agentTurn && (
              <KeyValue label="model">
                <span className="font-mono text-[11px] t-text">{v.agentTurn.model}</span>
              </KeyValue>
            )}
            {v.agentTurn && (
              <KeyValue label="turn">
                <span className="font-mono text-[10px] tabular-nums t-text-secondary">
                  #{v.agentTurn.turnIndex}
                  <span className="ml-2 t-text-muted">
                    session {v.agentTurn.sessionId.slice(0, 8)}
                  </span>
                </span>
              </KeyValue>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function Breadcrumb({ trail, onJump }: {
  trail: ViewNode[]
  onJump: (idx: number) => void
}) {
  // Renders e.g.  note.md  ›  paper.pdf  ›  query.json
  // Each crumb is clickable except the last one (current selection).
  return (
    <nav aria-label="Selection trail"
         className="flex items-center gap-1 flex-wrap text-[10px] tabular-nums t-text-muted">
      {trail.map((n, i) => {
        const last = i === trail.length - 1
        const dot = KIND_DOT[n.kind]
        return (
          <React.Fragment key={`${n.id}-${i}`}>
            {i > 0 && <span aria-hidden="true" className="t-text-muted">›</span>}
            <button
              type="button"
              onClick={() => !last && onJump(i)}
              disabled={last}
              title={n.label}
              className={`flex items-center gap-1 px-1 py-0.5 rounded transition-colors ${
                last
                  ? 't-text cursor-default'
                  : 'hover:bg-[var(--color-accent-soft)]/10 hover:t-text'
              }`}
            >
              <span aria-hidden="true"
                    className="inline-block w-1 h-1 rounded-full"
                    style={{ background: dot }} />
              <span className="truncate max-w-[140px]">{basename(n.label)}</span>
            </button>
          </React.Fragment>
        )
      })}
    </nav>
  )
}

function EdgeList({
  edges, resolveOther, onNavigate, direction
}: {
  edges: ViewEdge[]
  resolveOther: (e: ViewEdge) => ViewNode | undefined
  onNavigate: (id: string) => void
  /** 'up' = render the producer (e.from); 'down' = render the consumer (e.to). */
  direction: 'up' | 'down'
}) {
  // Each row is two lines:
  //   ●  filename                               →
  //      └─ {relationship phrase}
  // The relationship line uses a category-colored vertical bar so the eye can
  // group multiple consecutive edges of the same kind without re-reading the
  // label. Phrasing is direction-aware ("produced by …" vs "consumed by …")
  // so the user doesn't have to mentally invert UPSTREAM vs DOWNSTREAM.
  return (
    <ul className="mt-1.5 space-y-1">
      {edges.map(e => {
        const other = resolveOther(e)
        if (!other) return null
        const accent = KIND_DOT[other.kind]
        const rel = relationshipPhrase(direction, e)
        const cColor = CATEGORY_COLOR[e.category]
        return (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => onNavigate(other.id)}
              className="w-full text-left rounded px-2 py-1 hover:bg-[var(--color-accent-soft)]/6 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span aria-hidden="true"
                      className="shrink-0 inline-block w-1.5 h-1.5 rounded-full"
                      style={{ background: accent }} />
                <span className="text-[11px] t-text truncate flex-1"
                      title={other.label}>
                  {basename(other.label)}
                </span>
                <ChevronRight />
              </div>
              <div className="mt-0.5 pl-3.5 flex items-center gap-1.5 text-[10px] t-text-muted"
                   title={`edge category: ${e.category} · raw label: ${e.label}`}>
                <span aria-hidden="true"
                      className="font-mono leading-none"
                      style={{ color: cColor, opacity: 0.85 }}>└─</span>
                <span className="tracking-wide">{rel}</span>
                <span aria-hidden="true"
                      className="px-1 rounded text-[9px] uppercase tracking-wider"
                      style={{ color: cColor, opacity: 0.85 }}>
                  {e.label}
                </span>
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Direction-aware natural-language phrasing for an edge.
 *
 * UPSTREAM (the row IS the producer/source of the selected entity):
 *   - input        → "selected was produced from this"
 *   - derived-from → "selected is a new version of this"
 *   - cited        → "selected cites this"
 *   - else         → fallback to the raw category
 *
 * DOWNSTREAM (the row IS the consumer of the selected entity):
 *   - input        → "this consumes selected as input"
 *   - derived-from → "this is a new version of selected"
 *   - cited        → "this cites selected"
 *
 * We don't reach back to the actual selected node's label — keeping the
 * phrasing relative ("selected") makes the line short enough to fit at the
 * width of the rail without truncation, and the breadcrumb already names
 * the selected entity above.
 */
function relationshipPhrase(direction: 'up' | 'down', e: ViewEdge): string {
  if (direction === 'up') {
    switch (e.category) {
      case 'edit':    return 'edited from this'
      case 'compute': return 'computed from this'
      case 'fetch':   return 'fetched from this'
      case 'memory':  return 'created from this memory'
      case 'bash':    return 'shell-produced from this'
      case 'version': return 'derived from this version'
      case 'cited':   return 'cites this'
      case 'input':
      default:        return 'produced from this'
    }
  }
  switch (e.category) {
    case 'edit':    return 'edited into this'
    case 'compute': return 'fed into this computation'
    case 'fetch':   return 'fetched into this'
    case 'memory':  return 'saved into this memory'
    case 'bash':    return 'used by this shell call'
    case 'version': return 'this version was derived from selected'
    case 'cited':   return 'cited by this'
    case 'input':
    default:        return 'used by this'
  }
}

function DetailEmptyState({ entityCount }: { entityCount: number }) {
  return (
    <div className="h-full flex items-center justify-center px-8 t-bg-surface">
      <div className="space-y-3 max-w-[320px]">
        <div className="h-px w-8 t-bg-accent opacity-50" />
        <div className="text-[14px] t-text leading-snug">
          Pick an entity in the left rail.
        </div>
        <div className="text-[11px] leading-relaxed t-text-secondary">
          {entityCount > 0
            ? `${entityCount} entit${entityCount === 1 ? 'y is' : 'ies are'} tracked. Click one in the rail to see its versions, upstream / downstream, and trigger an audit.`
            : 'No entities tracked yet.'}
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// AuditRunPanel (PANE 3)
// ───────────────────────────────────────────────────────────────────────────

type RunTab = 'findings' | 'history' | 'scope'

function AuditRunPanel({
  run, reports, selectedAuditId, selectedFindingId,
  archivedReport, referredFromEntity, tab, onTab,
  onSelectAudit, onSelectFinding, onCancel
}: {
  run: ReturnType<typeof useAuditStore.getState>['run']
  reports: AuditReport[]
  selectedAuditId: string | null
  selectedFindingId: string | null
  archivedReport: AuditReport | null
  referredFromEntity: ViewNode | null
  tab: RunTab
  onTab: (t: RunTab) => void
  onSelectAudit: (id: string | null) => void
  onSelectFinding: (id: string | null) => void
  onCancel: () => void
}) {
  // Live run wins over archive: as soon as the auditor starts, snap to it.
  const showLive = run.running || !!run.error

  // Source data depends on mode
  const findings = showLive ? run.liveFindings : (archivedReport?.findings ?? [])
  const timeline: TimelineItem[] = showLive
    ? run.timeline
    : ((archivedReport?.timeline ?? []) as TimelineItem[])

  if (!showLive && !archivedReport) {
    return <RunEmptyState />
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      <RunHeader
        showLive={showLive}
        run={run}
        reports={reports}
        archivedReport={archivedReport}
        selectedAuditId={selectedAuditId}
        onSelectAudit={onSelectAudit}
        onCancel={onCancel}
      />

      {/* Cross-pane breadcrumb when the displayed report wasn't directly
          rooted on the selected entity — the entity only shows up because a
          finding implicated it. Without this banner the user sees a report
          for "entity 1" while looking at "entity 2" and has no way to tell
          why. */}
      {!showLive && referredFromEntity && (
        <div className="px-5 py-1.5 text-[10px] tracking-wider uppercase t-text-muted border-b t-border bg-[var(--color-accent-soft)]/5 flex items-center gap-1.5">
          <span aria-hidden="true">↳</span>
          <span>referred from</span>
          <span aria-hidden="true"
                className="inline-block w-1 h-1 rounded-full"
                style={{ background: KIND_DOT[referredFromEntity.kind] }} />
          <span className="normal-case tracking-normal t-text-secondary truncate"
                title={referredFromEntity.label}>
            {basename(referredFromEntity.label)}
          </span>
        </div>
      )}

      <RunTabs tab={tab} onTab={onTab}
               counts={{
                 findings: findings.length,
                 history: timeline.length,
                 scope: showLive ? run.scopeNodeCount : (archivedReport?.scopeNodeCount ?? 0)
               }} />

      {/* Each tab body owns its own scroll container so HistoryTab can manage
          its sticky-bottom scroll behavior without yanking the other tabs'
          scroll positions when the user switches between them. */}
      <div className="flex-1 min-h-0 relative">
        {tab === 'findings' && (
          <div className="absolute inset-0 overflow-y-auto">
            <FindingsTab
              findings={findings}
              summary={showLive ? null : (archivedReport?.summary ?? null)}
              selectedFindingId={selectedFindingId}
              onSelectFinding={onSelectFinding}
              isLive={showLive}
            />
          </div>
        )}
        {tab === 'history' && (
          <HistoryTab timeline={timeline} live={showLive} />
        )}
        {tab === 'scope' && (
          <div className="absolute inset-0 overflow-y-auto">
            <ScopeTab
              showLive={showLive}
              run={run}
              archivedReport={archivedReport}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function RunEmptyState() {
  return (
    <div className="h-full flex items-center justify-center px-8 t-bg-surface">
      <div className="space-y-3 max-w-[320px]">
        <div className="h-px w-8 t-bg-accent opacity-50" />
        <div className="text-[14px] t-text leading-snug">
          No audit selected.
        </div>
        <div className="text-[11px] leading-relaxed t-text-secondary">
          Pick an entity in the middle pane and click <span className="t-text-accent">Audit this artifact</span>.
          Past audits will appear here once you have run one.
        </div>
      </div>
    </div>
  )
}

function RunHeader({
  showLive, run, reports, archivedReport, selectedAuditId, onSelectAudit, onCancel
}: {
  showLive: boolean
  run: ReturnType<typeof useAuditStore.getState>['run']
  reports: AuditReport[]
  archivedReport: AuditReport | null
  selectedAuditId: string | null
  onSelectAudit: (id: string | null) => void
  onCancel: () => void
}) {
  // Tick once a second so elapsed time keeps updating during live runs.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!showLive || !run.running) return
    const id = window.setInterval(() => tick(t => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [showLive, run.running])

  if (showLive) {
    const elapsed = run.startedAt
      ? Math.floor((Date.now() - new Date(run.startedAt).getTime()) / 1000)
      : 0
    const m = Math.floor(elapsed / 60), s = elapsed % 60
    const elapsedStr = m > 0 ? `${m}m ${s}s` : `${s}s`
    // When the run errored out (run.error set, run.running=false) the header
    // becomes an error card, not a live-status indicator. Pulse animation off,
    // message is full-width, hint about where to look. Previous design tucked
    // the error into a small "· {msg}" snippet that was easy to miss when the
    // user's eyes were on pane A.
    const errored = !!run.error && !run.running
    return (
      <div className={`px-5 pt-3 pb-3 border-b t-border ${errored ? 'bg-[var(--color-status-error)]/8' : 't-bg-surface'}`}>
        <div className="flex items-baseline gap-2">
          {errored ? (
            <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full t-bg-error" />
          ) : (
            <PulseDot />
          )}
          <span className={`text-[12px] tracking-wider uppercase ${errored ? 't-text-error' : 't-text-accent'}`}>
            {errored ? 'Audit failed' : 'Live audit'}
          </span>
          {run.running && (
            <button onClick={onCancel}
                    className="ml-auto text-[10px] tracking-wider uppercase t-text-error hover:underline">
              Cancel
            </button>
          )}
        </div>
        {errored ? (
          <div className="mt-2 text-[12px] leading-relaxed t-text-error break-words">
            {run.error}
          </div>
        ) : (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0 text-[10px] tabular-nums t-text-muted">
            <span className="font-mono t-text-secondary">{run.model ?? '?'}</span>
            <span>·</span>
            <span>{run.scopeNodeCount} nodes</span>
            <span>·</span>
            <span>{elapsedStr}</span>
            <span>·</span>
            <span>{run.toolTurnCount} turns</span>
            <span>·</span>
            <span>{run.liveFindings.length} findings</span>
          </div>
        )}
      </div>
    )
  }

  // Archived
  if (!archivedReport) return null
  const c = Number(archivedReport.usage?.cost)
  return (
    <div className="px-5 pt-3 pb-3 border-b t-border t-bg-surface">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] tracking-wider uppercase t-text-secondary">Audit report</span>
        {reports.length > 1 ? (
          <select
            value={selectedAuditId ?? archivedReport.id}
            onChange={e => onSelectAudit(e.target.value)}
            className="ml-auto px-1.5 py-0.5 text-[11px] rounded border t-border-subtle t-bg-base t-text"
          >
            {reports.map(r => (
              <option key={r.id} value={r.id}>
                {shortIso(r.createdAt)} · {r.findings.length} finding{r.findings.length === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        ) : (
          <span className="ml-auto text-[10px] tabular-nums t-text-muted">
            {shortIso(archivedReport.createdAt)}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0 text-[10px] tabular-nums t-text-muted">
        <span className="font-mono t-text-secondary">{archivedReport.model}</span>
        <span>·</span>
        <span>{archivedReport.scopeNodeCount} nodes</span>
        <span>·</span>
        <span>{(Number(archivedReport.durationMs) / 1000).toFixed(1)}s</span>
        {Number.isFinite(c) && c > 0 && <><span>·</span><span>${c.toFixed(4)}</span></>}
      </div>
    </div>
  )
}

function RunTabs({ tab, onTab, counts }: {
  tab: RunTab
  onTab: (t: RunTab) => void
  counts: { findings: number; history: number; scope: number }
}) {
  const item = (id: RunTab, label: string, count: number) => {
    const active = tab === id
    return (
      <button
        type="button"
        onClick={() => onTab(id)}
        className={`px-3 py-1.5 text-[11px] tracking-wider uppercase border-b-2 transition-colors ${
          active
            ? 't-text-accent border-[var(--color-accent)]'
            : 't-text-muted border-transparent hover:t-text'
        }`}
      >
        {label}
        {count > 0 && (
          <span className="ml-1.5 text-[10px] tabular-nums t-text-muted">{count}</span>
        )}
      </button>
    )
  }
  return (
    <div className="flex items-end gap-1 px-3 border-b t-border t-bg-surface">
      {item('findings', 'Findings', counts.findings)}
      {item('history',  'History',  counts.history)}
      {item('scope',    'Scope',    counts.scope)}
    </div>
  )
}

// ── Findings tab ──────────────────────────────────────────────────────────

function FindingsTab({
  findings, summary, selectedFindingId, onSelectFinding, isLive
}: {
  findings: Finding[]
  summary: string | null
  selectedFindingId: string | null
  onSelectFinding: (id: string | null) => void
  isLive: boolean
}) {
  if (!isLive && summary === null && findings.length === 0) {
    return (
      <div className="px-5 py-4 text-[11px] t-text-muted italic">
        Auditor cleared this scope — no findings.
      </div>
    )
  }
  const sorted = sortFindings(findings)
  return (
    <div className="px-5 py-4 space-y-4">
      {summary && (
        <section>
          <SectionLabel>Summary</SectionLabel>
          <p className="mt-1.5 text-[12px] leading-relaxed t-text">{summary}</p>
        </section>
      )}
      <section>
        <div className="flex items-center gap-2">
          <SectionLabel count={findings.length}>{isLive ? 'Live findings' : 'Findings'}</SectionLabel>
          {findings.length > 0 && (
            <CopyButton
              ariaLabel="Copy all findings as Markdown"
              getText={() => formatFindingsMarkdown(sorted, summary, isLive)}
              className="ml-auto"
            >
              Copy all
            </CopyButton>
          )}
        </div>
        {findings.length === 0 ? (
          <p className="mt-1.5 text-[11px] t-text-muted italic">
            {isLive ? 'No findings emitted yet.' : 'No findings on this scope.'}
          </p>
        ) : (
          <div className="mt-1.5 space-y-1">
            {sorted.map(f => (
              <FindingCard
                key={f.id}
                finding={f}
                selected={f.id === selectedFindingId}
                onSelect={() => onSelectFinding(f.id === selectedFindingId ? null : f.id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ── Findings → Markdown (paste-into-coordinator format) ─────────────────────
//
// The coordinator agent reads structured Markdown reliably; we lean on
// fenced code blocks for ids/hashes (so it doesn't autolink them) and use
// stable section headers so the agent can pick fields out without prompting.
// Copying is the user's primary handoff to the fixer; the format is part
// of the contract — keep it stable unless we deliberately revise it.

function formatFindingMarkdown(f: Finding): string {
  const lines: string[] = []
  lines.push(`### [${f.severity.toUpperCase()}] ${f.category}: ${f.claim}`)
  lines.push('')
  lines.push('**Evidence**')
  lines.push('')
  // Indent evidence as a blockquote so it survives paste into a chat that
  // soft-wraps prose. Empty lines inside evidence get a quote marker too.
  for (const line of f.evidence.split(/\r?\n/)) {
    lines.push(`> ${line}`)
  }
  if (f.suggestedAction && f.suggestedAction.trim()) {
    lines.push('')
    lines.push('**Suggested action**')
    lines.push('')
    lines.push(f.suggestedAction.trim())
  }
  if (f.implicatedNodeIds.length > 0) {
    lines.push('')
    lines.push('**Implicated nodes**')
    lines.push('')
    lines.push('```')
    for (const id of f.implicatedNodeIds) lines.push(id)
    lines.push('```')
  }
  lines.push('')
  lines.push(`_finding-id: \`${f.id}\`_`)
  return lines.join('\n')
}

function formatFindingsMarkdown(findings: Finding[], summary: string | null, isLive: boolean): string {
  const header = [
    `# Audit findings (${isLive ? 'live run' : 'archived report'})`,
    '',
    `Generated at ${new Date().toISOString()} — ${findings.length} finding${findings.length === 1 ? '' : 's'}.`
  ]
  if (summary) {
    header.push('')
    header.push('## Summary')
    header.push('')
    header.push(summary)
  }
  header.push('')
  header.push('## Findings')
  header.push('')
  const body = findings.map(formatFindingMarkdown).join('\n\n---\n\n')
  return [...header, body].join('\n')
}

// Compact copy-to-clipboard button with a 1.2s "Copied" confirmation.
// The `getText` callback is lazy so we don't serialise large reports until
// the user actually clicks. `stopPropagation` prevents the click from
// bubbling into a parent clickable card.
function CopyButton({
  getText, ariaLabel, children, className
}: {
  getText: () => string
  ariaLabel: string
  children?: React.ReactNode
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const text = getText()
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      },
      () => { /* clipboard denied — no-op, button stays untriggered */ }
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={copied ? 'Copied — paste into coordinator chat' : ariaLabel}
      className={`px-2 py-0.5 rounded text-[10px] tracking-wider uppercase border transition-colors ${
        copied
          ? 't-text-accent t-border-accent-soft bg-[var(--color-accent-soft)]/15'
          : 't-text-muted t-border-subtle hover:t-text hover:t-border'
      } ${className ?? ''}`}
    >
      {copied ? '✓ Copied' : (children ?? 'Copy')}
    </button>
  )
}

const SEVERITY_RANK: Record<Finding['severity'], number> = {
  critical: 0, major: 1, minor: 2, info: 3
}
function sortFindings(fs: Finding[]): Finding[] {
  return [...fs].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}
const SEVERITY_PILL: Record<Finding['severity'], { label: string; cls: string }> = {
  critical: { label: 'CRIT', cls: 't-text-error' },
  major:    { label: 'MAJ',  cls: 't-text-warning' },
  minor:    { label: 'MIN',  cls: 't-text-info' },
  info:     { label: 'INFO', cls: 't-text-secondary' }
}

function FindingCard({ finding, selected, onSelect }: {
  finding: Finding
  selected: boolean
  onSelect: () => void
}) {
  const pill = SEVERITY_PILL[finding.severity]
  const railColor = finding.severity === 'critical' ? 'var(--color-status-error)'
                  : finding.severity === 'major'    ? 'var(--color-status-warning)'
                  : finding.severity === 'minor'    ? 'var(--color-status-info)'
                  :                                   'var(--color-text-muted)'
  // Outer is a `div role="button"` (not a `<button>`) so the inner CopyButton
  // and the user's text selection on evidence both work — nesting a button
  // inside a button is invalid HTML, and `<button>` blocks selection on the
  // span children in some browsers.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={onKey}
      aria-expanded={selected}
      className={`relative w-full text-left rounded border px-3 py-2 transition-colors cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-soft)] ${
        selected
          ? 'bg-[var(--color-accent-soft)]/10 t-border-accent-soft'
          : 't-border-subtle hover:bg-[var(--color-accent-soft)]/5 hover:t-border'
      }`}
    >
      <span aria-hidden="true"
            className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r"
            style={{ background: railColor, opacity: selected ? 1 : 0.7 }} />
      <div className="flex items-baseline gap-2 pl-1.5">
        <span className={`font-mono text-[9px] tabular-nums tracking-wider ${pill.cls}`}>
          {pill.label}
        </span>
        <span className="text-[9px] uppercase tracking-wider t-text-muted">
          {finding.category}
        </span>
        <CopyButton
          ariaLabel="Copy this finding as Markdown"
          getText={() => formatFindingMarkdown(finding)}
          className="ml-auto"
        />
      </div>
      <div className="mt-1 text-[12px] leading-snug t-text pl-1.5">{finding.claim}</div>
      {selected && (
        <div className="mt-2 pt-2 border-t t-border-subtle space-y-2 pl-1.5">
          <div>
            <div className="text-[10px] tracking-wider uppercase t-text-muted mb-1">Evidence</div>
            <div className="text-[11px] leading-relaxed t-text-secondary whitespace-pre-wrap">
              {finding.evidence}
            </div>
          </div>
          {finding.suggestedAction && (
            <div>
              <div className="text-[10px] tracking-wider uppercase t-text-muted mb-1">Suggested</div>
              <div className="text-[11px] leading-relaxed t-text">{finding.suggestedAction}</div>
            </div>
          )}
          {finding.implicatedNodeIds.length > 0 && (
            <div>
              <div className="text-[10px] tracking-wider uppercase t-text-muted mb-1">Implicated nodes</div>
              <div className="font-mono text-[10px] tabular-nums t-text-secondary break-all">
                {finding.implicatedNodeIds.join(' · ')}
              </div>
              <div className="text-[10px] t-text-muted mt-0.5 italic">
                Click to recenter the entity panel on the first one.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── History tab (persistent timeline replay — live or archived) ───────────

function HistoryTab({ timeline, live }: { timeline: TimelineItem[]; live: boolean }) {
  // Sticky-bottom: the timeline streams new items during a live run, and the
  // expectation is "I see the latest line without chasing the scrollbar."
  // We track whether the user is currently anchored near the bottom; if so,
  // every growth pins them to the bottom. If the user has scrolled up to read
  // earlier reasoning, we leave their position alone — re-anchoring to the
  // bottom mid-read would be hostile.
  //
  // When the run completes and the timeline reloads from the persisted
  // report, the previous behavior snapped the scroll to the top (because the
  // ol element gets fully rebuilt). If the user was at the bottom, we keep
  // them there; otherwise we leave the position they were in.
  const containerRef = useRef<HTMLDivElement>(null)
  const stuckToBottomRef = useRef(true)
  const prevLenRef = useRef(0)

  // Threshold (px) — within this distance of the bottom counts as "at bottom".
  const STICK_PX = 32

  const onScroll = () => {
    const el = containerRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    stuckToBottomRef.current = distance <= STICK_PX
  }

  // Scroll on mount to the bottom too, so opening the tab on an in-flight
  // (or just-finished) audit doesn't park us at the top by default.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stuckToBottomRef.current = true
    // run once on mount; subsequent timeline growth handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // On every timeline change, if the user was at the bottom before this
  // update, glue them to the bottom afterwards. Use rAF so we run after
  // the new items are laid out and scrollHeight reflects them.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const grew = timeline.length > prevLenRef.current
    prevLenRef.current = timeline.length
    if (!grew) return
    if (!stuckToBottomRef.current) return
    requestAnimationFrame(() => {
      if (!containerRef.current) return
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    })
  }, [timeline.length])

  // When the live run finishes and the timeline is replaced by the archived
  // version (often longer), keep the user pinned to the bottom rather than
  // jumping to the top of the rebuilt ol. This effect fires on the
  // live-flag flip; the length-based effect above handles incremental growth.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (!stuckToBottomRef.current) return
    requestAnimationFrame(() => {
      if (!containerRef.current) return
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    })
  }, [live])

  if (timeline.length === 0) {
    return (
      <div ref={containerRef} onScroll={onScroll}
           className="absolute inset-0 overflow-y-auto px-5 py-4 text-[11px] t-text-muted italic">
        {live ? 'Auditor warming up…' : 'No timeline persisted for this audit.'}
      </div>
    )
  }
  const grouped = groupTimeline(timeline)
  return (
    <div ref={containerRef} onScroll={onScroll}
         className="absolute inset-0 overflow-y-auto">
      <ol className="px-5 py-4 space-y-2.5">
        {grouped.map((g, i) => <TimelineNode key={i} item={g} />)}
      </ol>
    </div>
  )
}

type GroupedItem =
  | { kind: 'reasoning'; ts: string; text: string }
  | { kind: 'progress';  ts: string; message: string }
  | { kind: 'finding';   ts: string; severity: Finding['severity']; category: Finding['category']; claim: string }
  | { kind: 'tools';     ts: string; name: string; calls: Array<{ args?: Record<string, unknown>; argsPreview?: string }> }

function groupTimeline(items: TimelineItem[]): GroupedItem[] {
  // Group consecutive same-name tool calls into a single node so a 12-step
  // grep sweep doesn't bury the reasoning that triggered it.
  const out: GroupedItem[] = []
  for (const it of items) {
    if (it.kind === 'tool') {
      const last = out[out.length - 1]
      if (last && last.kind === 'tools' && last.name === it.name) {
        last.calls.push({ args: it.args, argsPreview: it.argsPreview })
      } else {
        out.push({ kind: 'tools', ts: it.ts, name: it.name, calls: [{ args: it.args, argsPreview: it.argsPreview }] })
      }
    } else if (it.kind === 'reasoning') {
      out.push({ kind: 'reasoning', ts: it.ts, text: it.text })
    } else if (it.kind === 'finding') {
      out.push({ kind: 'finding', ts: it.ts, severity: it.severity, category: it.category, claim: it.claim })
    } else {
      out.push({ kind: 'progress', ts: it.ts, message: it.message })
    }
  }
  return out
}

function TimelineNode({ item }: { item: GroupedItem }) {
  const t = timeOfDay(item.ts)
  if (item.kind === 'reasoning') {
    return (
      <li className="relative pl-3">
        <span aria-hidden="true"
              className="absolute left-0 top-0 bottom-0 w-px t-bg-accent opacity-40" />
        <div className="text-[10px] tabular-nums t-text-muted">{t}</div>
        <div className="mt-1 text-[12px] leading-relaxed t-text whitespace-pre-wrap break-words">
          {item.text}
        </div>
      </li>
    )
  }
  if (item.kind === 'progress') {
    return (
      <li className="text-[10px] tabular-nums t-text-muted uppercase tracking-wider">
        <span>{t}</span>
        <span className="ml-2 normal-case tracking-normal t-text-secondary">{item.message}</span>
      </li>
    )
  }
  if (item.kind === 'finding') {
    const pill = SEVERITY_PILL[item.severity]
    return (
      <li className="flex items-baseline gap-2">
        <span className="text-[10px] tabular-nums t-text-muted">{t}</span>
        <span className={`font-mono text-[9px] tabular-nums tracking-wider ${pill.cls}`}>
          {pill.label}
        </span>
        <span className="text-[9px] uppercase tracking-wider t-text-muted">{item.category}</span>
        <span className="text-[12px] t-text truncate" title={item.claim}>{item.claim}</span>
      </li>
    )
  }
  const verb = humanVerb(item.name)
  return (
    <li className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] tabular-nums t-text-muted">{t}</span>
        <span className="text-[10px] tabular-nums uppercase tracking-wider t-text-secondary">
          {verb}
        </span>
        {item.calls.length > 1 && (
          <span className="text-[10px] tabular-nums t-text-muted">×{item.calls.length}</span>
        )}
      </div>
      <ul className="pl-3 space-y-0.5">
        {item.calls.map((c, j) => {
          const h = humanizeAction(item.name, c.args, c.argsPreview)
          return (
            <li key={j} className="text-[12px] truncate t-text-secondary"
                title={h.full || h.target}>
              <span className="t-text-muted">›</span>{' '}
              <span className="t-text">{h.target || h.verb}</span>
            </li>
          )
        })}
      </ul>
    </li>
  )
}

interface HumanAction { verb: string; target: string; full: string }

function humanVerb(toolName: string): string {
  switch (toolName) {
    case 'read':                       return 'read'
    case 'grep':                       return 'search'
    case 'find':                       return 'find'
    case 'ls':                         return 'list'
    case 'bash':                       return 'shell'
    case 'web_fetch':                  return 'fetch'
    case 'provenance_get_node':        return 'lookup'
    case 'provenance_get_upstream':    return 'walk upstream'
    case 'provenance_read_blob':       return 'read snapshot'
    case 'provenance_get_params':      return 'get params'
    case 'provenance_check_drift':     return 'check drift'
    case 'submit_audit_report':        return 'submit'
    default:                           return toolName
  }
}

function humanizeAction(
  toolName: string,
  args: Record<string, unknown> | undefined,
  argsPreview: string | undefined
): HumanAction {
  const a = args ?? {}
  const verb = humanVerb(toolName)
  const fb = (target: string, full: string): HumanAction => ({ verb, target, full })

  switch (toolName) {
    case 'read':
    case 'ls':
    case 'find': {
      const path = String(a.path ?? a.file_path ?? '')
      return fb(basename(path) || path || '?', path)
    }
    case 'grep': {
      const pattern = String(a.pattern ?? '')
      const path = String(a.path ?? '')
      const target = pattern
        ? `'${pattern}'${path ? ` in ${basename(path)}` : ''}`
        : (basename(path) || '?')
      return fb(target, `${pattern} ${path}`.trim())
    }
    case 'bash': {
      const cmd = String(a.command ?? '')
      const head = cmd.split(/\r?\n/, 1)[0]?.trim() ?? ''
      return fb(head.slice(0, 80) || '(empty)', cmd)
    }
    case 'web_fetch': {
      const url = String(a.url ?? '')
      try {
        const u = new URL(url)
        return fb(`${u.host}${u.pathname}`, url)
      } catch {
        return fb(url || '?', url)
      }
    }
    case 'provenance_get_node': {
      const id = String(a.id ?? '')
      return fb(id.slice(0, 16), id)
    }
    case 'provenance_get_upstream': {
      const ids = Array.isArray(a.ids) ? (a.ids as unknown[]).map(String) : []
      return fb(`${ids.length} node${ids.length === 1 ? '' : 's'}`, ids.join(', '))
    }
    case 'provenance_read_blob': {
      const h = String(a.contentHash ?? '')
      return fb(h.slice(0, 16), h)
    }
    case 'provenance_get_params': {
      const ref = String(a.parametersRef ?? '')
      const h = String(a.parametersHash ?? '')
      return fb(basename(ref) || h.slice(0, 12) || '?', ref || h)
    }
    case 'provenance_check_drift': {
      const ids = Array.isArray(a.nodeIds) ? a.nodeIds.length : 0
      return fb(`${ids} node${ids === 1 ? '' : 's'}`, '')
    }
    case 'submit_audit_report': {
      const findingsArr = Array.isArray(a.findings) ? a.findings : []
      return fb(`${findingsArr.length} finding${findingsArr.length === 1 ? '' : 's'}`, '')
    }
    default: {
      const fbText = argsPreview ? argsPreview.replace(/\s+/g, ' ').slice(0, 80) : ''
      return fb(fbText, argsPreview ?? '')
    }
  }
}

// ── Scope tab ─────────────────────────────────────────────────────────────

function ScopeTab({
  showLive, run, archivedReport
}: {
  showLive: boolean
  run: ReturnType<typeof useAuditStore.getState>['run']
  archivedReport: AuditReport | null
}) {
  if (showLive) {
    return (
      <div className="px-5 py-4 space-y-2">
        <SectionLabel>Live audit scope</SectionLabel>
        <div className="text-[12px] t-text">
          {run.scopeNodeCount} node{run.scopeNodeCount === 1 ? '' : 's'} in upstream cone
        </div>
        <div className="text-[10px] t-text-muted">
          The auditor was launched with{' '}
          <span className="font-mono">{run.auditId?.slice(0, 12) ?? '?'}</span>.
          Root ids are not streamed during a run; check the persisted report
          when this audit finishes.
        </div>
      </div>
    )
  }
  if (!archivedReport) return null
  return (
    <div className="px-5 py-4 space-y-3">
      <section>
        <SectionLabel>Scope</SectionLabel>
        <div className="mt-1.5 text-[12px] t-text">
          {archivedReport.scopeNodeCount} node{archivedReport.scopeNodeCount === 1 ? '' : 's'} in upstream cone
        </div>
        <div className="mt-1 text-[10px] tabular-nums t-text-muted">
          maxDepth: {archivedReport.scope.maxDepth ?? 'unbounded'}
        </div>
      </section>
      <section>
        <SectionLabel count={archivedReport.scope.rootNodeIds.length}>Root nodes</SectionLabel>
        <ul className="mt-1.5 space-y-0.5">
          {archivedReport.scope.rootNodeIds.map(id => (
            <li key={id} className="font-mono text-[10px] tabular-nums t-text-secondary break-all">
              {id}
            </li>
          ))}
        </ul>
      </section>
      {archivedReport.draftPreview && (
        <section>
          <SectionLabel>Draft preview</SectionLabel>
          <div className="mt-1.5 text-[11px] leading-relaxed t-text-secondary whitespace-pre-wrap">
            {archivedReport.draftPreview}
          </div>
        </section>
      )}
      {archivedReport.warnings && archivedReport.warnings.length > 0 && (
        <section>
          <SectionLabel count={archivedReport.warnings.length}>Warnings</SectionLabel>
          <ul className="mt-1.5 space-y-0.5">
            {archivedReport.warnings.map((w, i) => (
              <li key={i} className="text-[11px] t-text-warning">{w}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// CenteredCard — disabled / loading / error / no-graph states
// ───────────────────────────────────────────────────────────────────────────

function CenteredCard({ children, tone }: { children: React.ReactNode; tone: 'muted' | 'error' }) {
  return (
    <div className="flex-1 flex items-center justify-center t-bg-base">
      <div className={`max-w-md px-6 ${tone === 'error' ? 't-text-error' : 't-text'}`}>
        {children}
      </div>
    </div>
  )
}
