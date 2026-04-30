/**
 * AuditSidebar — left rail for the Audit tab.
 *
 * Hosts the entity list (filterable + sortable) so the left rail does real
 * work instead of mirroring status that already lives in pane 3 of AuditView.
 *
 * Cross-rail wiring: selection lives in `useUIStore` so AuditView's center
 * panes can render the chosen entity's details and lineage.
 *
 * The auditor's running/idle status is intentionally NOT shown here —
 * AuditView's pane 2 owns that surface (Findings / History / Scope tabs).
 * Duplicating the indicator was dead weight (RFC-style: one source of truth).
 */

import React, { useEffect, useMemo, useState } from 'react'

import { useProvenanceStore, type ProvenanceNode } from '../../stores/provenance-store'
import { useAuditStore } from '../../stores/audit-store'
import { useUIStore } from '../../stores/ui-store'
import {
  projectGraph,
  defaultFilters,
  type ViewNode,
  type AuditFilters
} from '../center/audit-graph'

// ───────────────────────────────────────────────────────────────────────────
// Per-kind language (kept in sync with AuditView)
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

type SortMode = 'newest' | 'oldest' | 'most-versions' | 'drift-first'

const SORT_LABEL: Record<SortMode, string> = {
  newest: 'newest', oldest: 'oldest',
  'most-versions': 'most versions', 'drift-first': 'drift first'
}

interface ListFilters {
  search: string
  kinds: Set<Kind>
  sort: SortMode
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function basename(label: string): string {
  if (!label) return ''
  const i = label.lastIndexOf('/')
  return i >= 0 && i < label.length - 1 ? label.slice(i + 1) : label
}
function relativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Math.max(0, now - t)
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function latestTs(n: ViewNode): string {
  return n.versions[n.versions.length - 1]?.createdAt ?? ''
}
function earliestTs(n: ViewNode): string {
  return n.versions[0]?.createdAt ?? ''
}

// ───────────────────────────────────────────────────────────────────────────
// Markers
// ───────────────────────────────────────────────────────────────────────────

function DriftMarker() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" className="inline-block t-text-warning"
         role="img" aria-label="drift">
      <title>content drifted since capture</title>
      <path d="M4 0.5 L7.5 7 L0.5 7 Z" fill="currentColor" />
    </svg>
  )
}
function OversizeMarker() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" className="inline-block t-text-secondary"
         role="img" aria-label="oversize">
      <title>too large to snapshot at capture</title>
      <rect x="0" y="0" width="8" height="2" fill="currentColor"/>
      <rect x="0" y="3" width="8" height="2" fill="currentColor"/>
      <rect x="0" y="6" width="8" height="2" fill="currentColor"/>
    </svg>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

export function AuditSidebar() {
  const enabled       = useProvenanceStore(s => s.enabled)
  const loading       = useProvenanceStore(s => s.loading)
  const error         = useProvenanceStore(s => s.error)
  const rawNodes      = useProvenanceStore(s => s.nodes)
  const rawEdges      = useProvenanceStore(s => s.edges)
  const probeEnabled  = useProvenanceStore(s => s.probeEnabled)
  const loadGraph     = useProvenanceStore(s => s.loadGraph)

  const loadReports   = useAuditStore(s => s.loadReports)

  const auditTrail    = useUIStore(s => s.auditTrail)
  const setAuditTrail = useUIStore(s => s.setAuditTrail)

  useEffect(() => {
    void probeEnabled().then(() => loadGraph())
    void loadReports()
  }, [probeEnabled, loadGraph, loadReports])

  const [projectionFilters] = useState<AuditFilters>(defaultFilters)
  const [filters, setFilters] = useState<ListFilters>({
    search: '', kinds: new Set<Kind>(), sort: 'newest'
  })

  const projection = useMemo(
    () => projectGraph(rawNodes as ProvenanceNode[], rawEdges, projectionFilters),
    [rawNodes, rawEdges, projectionFilters]
  )
  const kindsPresent = useMemo<Kind[]>(() => {
    const s = new Set<Kind>()
    for (const n of projection.nodes) s.add(n.kind)
    return (['draft','memory-artifact','workspace-file','audit-report','computation'] as Kind[])
      .filter(k => s.has(k))
  }, [projection.nodes])

  const visibleEntities = useMemo<ViewNode[]>(() => {
    const search = filters.search.trim().toLowerCase()
    const arr = projection.nodes.filter(n => {
      if (filters.kinds.size > 0 && !filters.kinds.has(n.kind)) return false
      if (search && !n.label.toLowerCase().includes(search)) return false
      return true
    })
    switch (filters.sort) {
      case 'newest':         arr.sort((a, b) => latestTs(b).localeCompare(latestTs(a))); break
      case 'oldest':         arr.sort((a, b) => earliestTs(a).localeCompare(earliestTs(b))); break
      case 'most-versions':  arr.sort((a, b) => b.versions.length - a.versions.length); break
      case 'drift-first':    arr.sort((a, b) => Number(b.hasDrift) - Number(a.hasDrift) || latestTs(b).localeCompare(latestTs(a))); break
    }
    return arr
  }, [projection.nodes, filters])

  const selectedId = auditTrail[auditTrail.length - 1] ?? null

  const onSelect = (id: string) => {
    // Selecting from the rail is "jump anywhere": resets the breadcrumb trail
    // because exploration restarts from a new anchor.
    setAuditTrail([id])
  }

  // Disabled / loading / error / empty states
  if (enabled === null || loading) {
    return <RailMessage>Loading provenance graph…</RailMessage>
  }
  if (!enabled) {
    return (
      <RailMessage>
        <p className="text-[12px] t-text">Provenance capture is off.</p>
        <p className="mt-2 text-[11px] t-text-secondary leading-relaxed">
          Restart with{' '}
          <code className="px-1 py-0.5 rounded text-[10px] font-mono t-bg-elevated t-text-accent">ENABLE_PROVENANCE=1</code>
          {' '}to track the causal graph.
        </p>
      </RailMessage>
    )
  }
  if (error) {
    return <RailMessage tone="error">{error}</RailMessage>
  }
  if (rawNodes.length === 0) {
    return (
      <RailMessage>
        <p className="text-[12px] t-text">No provenance yet.</p>
        <p className="mt-2 text-[11px] t-text-secondary leading-relaxed">
          Run a tool that produces an artifact and the graph will populate here.
        </p>
        <button onClick={() => void loadGraph()}
                className="mt-3 text-[11px] t-text-accent hover:underline">
          Refresh ↻
        </button>
      </RailMessage>
    )
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <RailHeader
        filters={filters}
        onFiltersChange={setFilters}
        kindsPresent={kindsPresent}
        counts={{ total: projection.nodes.length, visible: visibleEntities.length }}
        onRefresh={() => { void loadGraph(); void loadReports() }}
      />

      <div className="flex-1 overflow-y-auto">
        {visibleEntities.length === 0 ? (
          <div className="px-3 py-4 text-[11px] t-text-muted italic">
            No entities match the filters.
          </div>
        ) : (
          visibleEntities.map(n => (
            <EntityRow
              key={n.id}
              node={n}
              selected={n.id === selectedId}
              onClick={() => onSelect(n.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Header — search + kind filter + sort + count
// ───────────────────────────────────────────────────────────────────────────

function RailHeader({
  filters, onFiltersChange, kindsPresent, counts, onRefresh
}: {
  filters: ListFilters
  onFiltersChange: (f: ListFilters) => void
  kindsPresent: Kind[]
  counts: { total: number; visible: number }
  onRefresh: () => void
}) {
  const [sortOpen, setSortOpen] = useState(false)
  return (
    <div className="px-2 pt-2 pb-2 border-b t-border space-y-1.5">
      <div className="flex items-center gap-1.5">
        <p className="text-[10px] t-text-accent-soft uppercase tracking-wider font-medium px-1">
          Entities
        </p>
        <span className="text-[10px] tabular-nums t-text-muted">
          {counts.visible}/{counts.total}
        </span>
        <button onClick={onRefresh}
                className="ml-auto text-[10px] t-text-muted hover:t-text"
                title="Reload graph + reports">↻</button>
      </div>

      <input
        type="search"
        placeholder="Search…"
        value={filters.search}
        onChange={e => onFiltersChange({ ...filters, search: e.target.value })}
        className="w-full px-2 py-1 text-[11px] rounded border t-border-subtle t-bg-base t-text placeholder:t-text-muted focus:t-border-accent focus:outline-none"
      />

      {kindsPresent.length > 1 && (
        <div className="flex items-center gap-1 flex-wrap">
          {kindsPresent.map(k => {
            const on = filters.kinds.has(k)
            return (
              <button
                key={k}
                onClick={() => {
                  const next = new Set(filters.kinds)
                  if (on) next.delete(k); else next.add(k)
                  onFiltersChange({ ...filters, kinds: next })
                }}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] tabular-nums border transition-colors ${
                  on
                    ? 'bg-[var(--color-accent-soft)]/12 t-text t-border-accent-soft'
                    : 't-text-muted t-border-subtle hover:t-text hover:t-border'
                }`}
              >
                <span className="inline-block w-1 h-1 rounded-full"
                      style={{ background: KIND_DOT[k], opacity: on ? 1 : 0.7 }} />
                {KIND_LABEL[k]}
              </button>
            )
          })}
        </div>
      )}

      <div className="relative">
        <button
          onClick={() => setSortOpen(o => !o)}
          className="w-full px-2 py-0.5 text-[10px] rounded border t-border-subtle t-text-secondary hover:t-text text-left"
        >
          sort: {SORT_LABEL[filters.sort]} ↓
        </button>
        {sortOpen && (
          <div className="absolute left-0 top-full mt-1 z-10 py-1 rounded border t-border t-bg-elevated min-w-full">
            {(Object.keys(SORT_LABEL) as SortMode[]).map(s => (
              <button
                key={s}
                onClick={() => {
                  onFiltersChange({ ...filters, sort: s })
                  setSortOpen(false)
                }}
                className={`block w-full px-2 py-1 text-[11px] text-left hover:t-bg-hover ${
                  s === filters.sort ? 't-text-accent' : 't-text-secondary'
                }`}
              >
                {SORT_LABEL[s]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Row
// ───────────────────────────────────────────────────────────────────────────

function EntityRow({ node, selected, onClick }: {
  node: ViewNode
  selected: boolean
  onClick: () => void
}) {
  const v = node.versions[node.versions.length - 1]!
  const filename = basename(node.label)
  const dot = KIND_DOT[node.kind]

  return (
    <div
      onClick={onClick}
      className={`group relative flex items-center gap-2 px-2.5 py-1.5 border-b t-border-subtle last:border-b-0 cursor-pointer transition-colors ${
        selected
          ? 'bg-[var(--color-accent-soft)]/10'
          : 'hover:bg-[var(--color-accent-soft)]/5'
      }`}
    >
      <span aria-hidden="true"
            className={`absolute left-0 top-1 bottom-1 w-[2px] rounded-r ${
              selected ? 't-bg-accent' : 'bg-transparent'
            }`} />

      <span aria-hidden="true"
            className="shrink-0 inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: dot }} />

      <span aria-hidden="true"
            className="shrink-0 text-[11px] leading-none t-text-muted"
            title={KIND_LABEL[node.kind]}>
        {KIND_GLYPH[node.kind]}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className={`text-[12px] truncate ${selected ? 't-text-accent' : 't-text'}`}
                title={node.label}>{filename}</span>
          {node.hasDrift && <DriftMarker />}
          {node.hasOversize && <OversizeMarker />}
        </div>
        <div className="text-[10px] tabular-nums t-text-muted truncate">
          {node.producedBy
            ? <span className="font-mono">{node.producedBy}</span>
            : <span className="italic">—</span>}
          {' · '}
          <span>{relativeTime(v.createdAt)}</span>
          {node.versions.length > 1 && (
            <>
              {' · '}
              <span>×{node.versions.length}</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function RailMessage({
  children, tone = 'muted'
}: {
  children: React.ReactNode
  tone?: 'muted' | 'error'
}) {
  return (
    <div className="h-full flex items-start justify-start px-3 pt-4">
      <div className={`max-w-full ${tone === 'error' ? 't-text-error' : 't-text'}`}>
        {children}
      </div>
    </div>
  )
}
