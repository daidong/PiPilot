/**
 * Audit side panels — filters on the left, details + quarantine on the right.
 *
 * Both rails are theme-aware (t-* utility classes + lucide icons consistent
 * with the rest of the app). Kind colors come from the audit palette so the
 * dots in the filters and pill chips match the dots in the canvas.
 */

import { useMemo, useState } from 'react'
import { Filter, Search, RefreshCw, ChevronLeft, ChevronRight, AlertTriangle, X, Crosshair, Quote } from 'lucide-react'
import type {
  AuditGraph,
  GraphNode,
  NodeKind,
} from '../../../../../../lib/audit-graph/index'
import { useAuditPalette } from './audit-theme'

// —— Left rail ————————————————————————————————————————————————————————

export interface FiltersState {
  hideContains: boolean
  hideWikiBg: boolean
  selectedTraceId: string | null
  kinds: Set<NodeKind>
}

interface LeftProps {
  graph: AuditGraph
  filters: FiltersState
  setFilters: (f: FiltersState) => void
  onReload: () => void
  onFocusNode: (n: GraphNode) => void
  selected: GraphNode | null
  collapsed: boolean
  onToggleCollapsed: () => void
}

const ALL_KINDS: NodeKind[] = ['trace', 'step', 'tool', 'chat', 'artifact', 'file', 'dir', 'session']
const ENTITY_KINDS: ReadonlySet<NodeKind> = new Set(['artifact', 'file', 'dir', 'tool'])
const ENTITY_DEFAULT_LIMIT = 10
const ENTITY_SEARCH_LIMIT = 80

export function AuditLeftRail({ graph, filters, setFilters, onReload, onFocusNode, selected, collapsed, onToggleCollapsed }: LeftProps) {
  const palette = useAuditPalette()
  const [traceQuery, setTraceQuery] = useState('')
  const [entityQuery, setEntityQuery] = useState('')

  const traceList = useMemo(() => {
    const q = traceQuery.trim().toLowerCase()
    return graph.nodes
      .filter(n => n.kind === 'trace' && (!filters.hideWikiBg || !/wiki-bg/.test(n.label)))
      .filter(n => !q || n.label.toLowerCase().includes(q) || (n.traceId || '').includes(q))
      .sort((a, b) => Number(b.startNs || 0) - Number(a.startNs || 0))
  }, [graph, traceQuery, filters.hideWikiBg])

  // Entity score (degree weighted toward producer edges). Same intuition as
  // the canvas importance score but kept simple here — the rail only needs
  // ranking, not the full importance machinery.
  const entityScore = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of graph.edges) {
      if (e.rel === 'contains' || e.rel === 'sub-llm') continue
      const w = (e.rel === 'creates' || e.rel === 'writes') ? 3 : 1
      m.set(e.source as string, (m.get(e.source as string) ?? 0) + w)
      m.set(e.target as string, (m.get(e.target as string) ?? 0) + w)
    }
    return m
  }, [graph])

  const allEntities = useMemo(
    () => graph.nodes
      .filter(n => ENTITY_KINDS.has(n.kind))
      .map(n => ({ n, s: entityScore.get(n.id) ?? 0 })),
    [graph, entityScore],
  )

  const entityResults = useMemo(() => {
    const q = entityQuery.trim().toLowerCase()
    if (!q) {
      // Default view: top N by score so the rail doesn't immediately scroll
      // and the user always sees the most-touched artifacts first.
      return [...allEntities].sort((a, b) => b.s - a.s).slice(0, ENTITY_DEFAULT_LIMIT)
    }
    // Search: substring match against label and path. Rank by:
    //   1. prefix match on label (most predictive of intent)
    //   2. substring match on label
    //   3. substring match on path
    return allEntities
      .map(({ n, s }) => {
        const label = n.label.toLowerCase()
        const path = (n.path ?? '').toLowerCase()
        let rank = -1
        if (label.startsWith(q)) rank = 0
        else if (label.includes(q)) rank = 1
        else if (path.includes(q)) rank = 2
        return { n, s, rank }
      })
      .filter(r => r.rank >= 0)
      .sort((a, b) => a.rank - b.rank || b.s - a.s)
      .slice(0, ENTITY_SEARCH_LIMIT)
  }, [allEntities, entityQuery])

  const entityHeaderCount = entityQuery.trim()
    ? `${entityResults.length}${entityResults.length >= ENTITY_SEARCH_LIMIT ? '+' : ''} / ${allEntities.length}`
    : `top ${entityResults.length} / ${allEntities.length}`

  // Citation watchlist (A1): artifacts that cite identifiers never retrieved
  // this project — the most-suspect first. Empty unless something looks
  // fabricated, so the section stays quiet on clean projects.
  const flaggedCitations = useMemo(
    () => graph.nodes
      .filter(n => n.kind === 'artifact' && (n.unresolvedCitations?.length ?? 0) > 0)
      .map(n => ({ n, unresolved: n.unresolvedCitations!.length, total: n.citationsTotal ?? 0 }))
      .sort((a, b) => b.unresolved - a.unresolved),
    [graph],
  )

  if (collapsed) {
    return (
      <div className="t-bg-surface border-r t-border-subtle flex flex-col items-center pt-2 w-9">
        <button
          onClick={onToggleCollapsed}
          title="Show filters"
          className="p-1.5 rounded t-text-muted hover:t-text-secondary"
        >
          <ChevronRight size={14} />
        </button>
        <div className="mt-2 t-text-muted"><Filter size={13} /></div>
      </div>
    )
  }

  const toggleKind = (k: NodeKind) => {
    const ks = new Set(filters.kinds)
    if (ks.has(k)) ks.delete(k); else ks.add(k)
    setFilters({ ...filters, kinds: ks })
  }

  return (
    <div className="t-bg-surface border-r t-border-subtle flex flex-col w-[228px] flex-shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b t-border-subtle">
        <div className="flex items-center gap-1.5">
          <Filter size={12} className="t-text-muted" />
          <span className="text-[11px] uppercase tracking-wider t-text-muted font-semibold">Filters</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onReload} title="Reload graph" className="p-1 rounded t-text-muted hover:t-text-secondary">
            <RefreshCw size={11} />
          </button>
          <button onClick={onToggleCollapsed} title="Hide filters" className="p-1 rounded t-text-muted hover:t-text-secondary">
            <ChevronLeft size={13} />
          </button>
        </div>
      </div>

      <div className="overflow-y-auto flex-1 px-3 py-3 space-y-4">
        {/* Counts */}
        <div className="text-[11px] t-text-secondary leading-relaxed tabular-nums">
          <div>{graph.counts.nodes} nodes  ·  {graph.counts.edges} edges</div>
          <div>{graph.counts.spans} spans  ·  {graph.counts.traces} traces</div>
        </div>

        {/* Edge / noise filters */}
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-[13px] t-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={filters.hideContains}
              onChange={e => setFilters({ ...filters, hideContains: e.target.checked })}
              className="accent-[var(--color-accent)]"
            />
            <span>Hide <code className="t-bg-elevated px-1 rounded text-[11px] font-mono">contains</code> edges</span>
          </label>
          <label className="flex items-center gap-2 text-[13px] t-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={filters.hideWikiBg}
              onChange={e => setFilters({ ...filters, hideWikiBg: e.target.checked })}
              className="accent-[var(--color-accent)]"
            />
            <span>Hide background traces</span>
          </label>
        </div>

        {/* Node kinds */}
        <div>
          <div className="text-[11px] uppercase tracking-wider t-text-muted font-semibold mb-1.5">Node kinds</div>
          <div className="space-y-1">
            {ALL_KINDS.map(k => (
              <label key={k} className="flex items-center gap-2 text-[13px] t-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.kinds.has(k)}
                  onChange={() => toggleKind(k)}
                  className="accent-[var(--color-accent)]"
                />
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: palette.kind[k] }} />
                <span>{k}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Entities */}
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <div className="text-[11px] uppercase tracking-wider t-text-muted font-semibold">Entities</div>
            <div className="text-[10px] t-text-muted tabular-nums">{entityHeaderCount}</div>
          </div>
          <div className="relative mb-1.5">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 t-text-muted pointer-events-none" />
            <input
              type="text"
              value={entityQuery}
              onChange={e => setEntityQuery(e.target.value)}
              placeholder="search artifacts, files, dirs…"
              className="w-full pl-6 pr-2 py-1 t-bg-elevated t-border-subtle border rounded text-[13px] t-text placeholder:t-text-muted focus:outline-none focus:t-border-accent"
            />
          </div>
          <div className="space-y-0.5 max-h-[36vh] overflow-y-auto pr-1">
            {entityResults.length === 0 ? (
              <div className="px-2 py-1 text-[11px] t-text-muted italic">
                {entityQuery.trim() ? `No entities match “${entityQuery.trim()}”.` : 'No entities in current view.'}
              </div>
            ) : entityResults.map(({ n, s }) => (
              <button
                key={n.id}
                onClick={() => onFocusNode(n)}
                className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left text-[13px] transition-colors ${
                  selected?.id === n.id ? 't-bg-accent-2-muted t-text' : 't-text hover:t-bg-hover'
                }`}
                title={n.path ?? n.id}
              >
                <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: palette.kind[n.kind] }} />
                <span className="truncate flex-1">{n.label}</span>
                <span className="t-text-muted text-[10px] tabular-nums flex-shrink-0">{s}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Suspicious citations (A1) — only when something looks fabricated */}
        {flaggedCitations.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <AlertTriangle size={11} className="t-text-warning flex-shrink-0" />
              <span className="text-[11px] uppercase tracking-wider t-text-warning font-semibold">
                Suspicious citations ({flaggedCitations.length})
              </span>
            </div>
            <div className="space-y-0.5 max-h-[28vh] overflow-y-auto pr-1">
              {flaggedCitations.map(({ n, unresolved, total }) => (
                <button
                  key={n.id}
                  onClick={() => onFocusNode(n)}
                  className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left text-[13px] transition-colors ${
                    selected?.id === n.id ? 't-bg-accent-2-muted t-text' : 't-text hover:t-bg-hover'
                  }`}
                  title={`${unresolved} of ${total} citations never retrieved`}
                >
                  <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: palette.kind.artifact }} />
                  <span className="truncate flex-1">{n.label}</span>
                  <span className="t-text-warning text-[10px] tabular-nums flex-shrink-0">{unresolved}/{total}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Traces */}
        <div>
          <div className="text-[11px] uppercase tracking-wider t-text-muted font-semibold mb-1.5">
            Traces ({traceList.length})
          </div>
          <div className="relative mb-1.5">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 t-text-muted pointer-events-none" />
            <input
              type="text"
              value={traceQuery}
              onChange={e => setTraceQuery(e.target.value)}
              placeholder="filter by name or id…"
              className="w-full pl-6 pr-2 py-1 t-bg-elevated t-border-subtle border rounded text-[13px] t-text placeholder:t-text-muted focus:outline-none focus:t-border-accent"
            />
          </div>
          <div className="space-y-0.5 max-h-[40vh] overflow-y-auto pr-1">
            <button
              onClick={() => setFilters({ ...filters, selectedTraceId: null })}
              className={`w-full text-left px-2 py-1 rounded text-[13px] transition-colors ${
                !filters.selectedTraceId ? 't-bg-accent-2-muted t-text' : 't-text-secondary hover:t-bg-hover'
              }`}
            >
              All
            </button>
            {traceList.slice(0, 120).map(t => (
              <button
                key={t.id}
                onClick={() => setFilters({ ...filters, selectedTraceId: t.traceId || null })}
                className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left text-[13px] transition-colors ${
                  filters.selectedTraceId === t.traceId ? 't-bg-accent-2-muted t-text' : 't-text-secondary hover:t-bg-hover'
                }`}
                title={t.traceId}
              >
                <span className="truncate flex-1">{t.label}</span>
                <span className="text-[10px] t-text-muted font-mono tabular-nums flex-shrink-0">{t.traceId?.slice(0, 6)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// —— Right rail ———————————————————————————————————————————————————————

export interface SliceStats {
  nodes: number
  traces: Set<string>
  sessions: Set<string>
  byKind: Map<NodeKind, number>
}

interface RightProps {
  graph: AuditGraph
  selected: GraphNode | null
  taint: Record<string, { reason: string; ts: number }>
  derivedTaint: Set<string>
  sliceStats: SliceStats
  onTaint: (id: string, reason: string) => void
  onClearTaint: (id: string) => void
  onClearAllTaint: () => void
  onFocusNode: (n: GraphNode) => void
  collapsed: boolean
  onToggleCollapsed: () => void
}

export function AuditRightRail({
  graph, selected, taint, derivedTaint, sliceStats, onTaint, onClearTaint, onClearAllTaint, onFocusNode, collapsed, onToggleCollapsed,
}: RightProps) {
  if (collapsed) {
    return (
      <div className="t-bg-surface border-l t-border-subtle flex flex-col items-center pt-2 w-9">
        <button
          onClick={onToggleCollapsed}
          title="Show details"
          className="p-1.5 rounded t-text-muted hover:t-text-secondary"
        >
          <ChevronLeft size={14} />
        </button>
      </div>
    )
  }

  const quarantine = buildQuarantine(graph, taint, derivedTaint)

  return (
    <div className="t-bg-surface border-l t-border-subtle flex flex-col w-[360px] flex-shrink-0">
      <div className="flex items-center justify-between px-3 py-2 border-b t-border-subtle">
        <div className="flex items-center gap-1.5">
          <Crosshair size={12} className="t-text-muted" />
          <span className="text-[11px] uppercase tracking-wider t-text-muted font-semibold">Inspector</span>
        </div>
        <button onClick={onToggleCollapsed} title="Hide details" className="p-1 rounded t-text-muted hover:t-text-secondary">
          <ChevronRight size={13} />
        </button>
      </div>

      <div className="overflow-y-auto flex-1 px-3 py-3 space-y-3">
        {quarantine && (
          <QuarantinePreview
            q={quarantine}
            taint={taint}
            onFocusNode={onFocusNode}
            onClearAll={onClearAllTaint}
          />
        )}

        {selected ? (
          <NodeDetails
            node={selected}
            taint={taint}
            derivedTaint={derivedTaint}
            sliceStats={sliceStats}
            onTaint={r => onTaint(selected.id, r)}
            onClearTaint={() => onClearTaint(selected.id)}
          />
        ) : !quarantine ? (
          <Placeholder source={graph.source} />
        ) : null}
      </div>
    </div>
  )
}

// —— Placeholder ——————————————————————————————————————————————————————

function Placeholder({ source }: { source: string }) {
  return (
    <div className="t-text-secondary text-[13px] leading-relaxed">
      <h3 className="t-text text-[14px] font-medium mb-2">Click a node</h3>
      <p className="mb-3">Click any node to see its attributes, raw span events, and its support slice (upstream + downstream lineage).</p>
      <div className="text-[11px] uppercase tracking-wider t-text-muted font-semibold mb-1.5 mt-4">Audit primitives</div>
      <ul className="space-y-2 pl-1">
        <li><b className="t-text">Trace</b> — walk upstream from any artifact or file to the originating tool calls and steps.</li>
        <li><b className="t-text">Taint</b> — mark a node suspect; taint flows forward through causal edges. Descendants get a dashed ring.</li>
        <li><b className="t-text">Repair flow</b> — once anything is tainted, this pane shows what would be quarantined and the safe replay point.</li>
      </ul>
      <div className="mt-4 pt-3 border-t t-border-subtle text-[10px] t-text-muted font-mono break-all leading-relaxed">{source}</div>
    </div>
  )
}

// —— Node details ——————————————————————————————————————————————————————

interface NDProps {
  node: GraphNode
  taint: Record<string, { reason: string; ts: number }>
  derivedTaint: Set<string>
  sliceStats: SliceStats
  onTaint: (reason: string) => void
  onClearTaint: () => void
}

function NodeDetails({ node, taint, derivedTaint, sliceStats, onTaint, onClearTaint }: NDProps) {
  const palette = useAuditPalette()
  const [reason, setReason] = useState('')
  const isDirect = !!taint[node.id]
  const isDerived = derivedTaint.has(node.id)
  const breakdown = [...sliceStats.byKind.entries()].sort((a, b) => b[1] - a[1])

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 pb-3 mb-3 border-b t-border-subtle">
        <span
          className="px-1.5 py-0.5 rounded-full text-[9px] uppercase tracking-wider font-bold"
          style={{ background: palette.kind[node.kind], color: '#0c1418' }}
        >
          {node.kind}
        </span>
        <h3 className="flex-1 min-w-0 break-all t-text font-medium text-[14px]">{node.label}</h3>
      </div>

      {/* Slice + Taint card */}
      <div className="t-bg-elevated border t-border-subtle rounded-md p-3 mb-3 space-y-3">
        {/* Slice stats */}
        <div>
          <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1">Support slice</div>
          <div className="flex items-baseline gap-x-0.5 tabular-nums">
            <span className="text-[15px] t-text font-medium">{sliceStats.nodes}</span>
            <span className="text-[10px] uppercase tracking-wider t-text-muted ml-1 mr-2">node{sliceStats.nodes === 1 ? '' : 's'}</span>
            <span className="text-[15px] t-text font-medium">{sliceStats.traces.size}</span>
            <span className="text-[10px] uppercase tracking-wider t-text-muted ml-1 mr-2">trace{sliceStats.traces.size === 1 ? '' : 's'}</span>
            <span className="text-[15px] t-text font-medium">{sliceStats.sessions.size}</span>
            <span className="text-[10px] uppercase tracking-wider t-text-muted ml-1">session{sliceStats.sessions.size === 1 ? '' : 's'}</span>
          </div>
          {breakdown.length > 0 && (
            <div className="flex flex-wrap gap-x-2 gap-y-1 mt-2">
              {breakdown.map(([k, n]) => (
                <span key={k} className="inline-flex items-center gap-1 text-[11px] t-text-secondary tabular-nums">
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: palette.kind[k] }} />
                  {n} {k}
                </span>
              ))}
            </div>
          )}
          {sliceStats.traces.size > 1 && (
            <div className="mt-2 px-2 py-1.5 border-l-2 t-border-accent t-bg-accent/10 t-text-accent text-[11px] rounded-r leading-snug">
              Crosses {sliceStats.traces.size} traces — lineage continues across user turns.
            </div>
          )}
        </div>

        {/* Taint */}
        <div className="pt-3 border-t t-border-subtle">
          <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1.5">Taint</div>
          {isDirect ? (
            <div className="flex items-center gap-2 t-text-error text-[13px]">
              <span className="w-2.5 h-2.5 rounded-full border-2 flex-shrink-0" style={{ borderColor: 'currentColor' }} />
              <span className="flex-1 min-w-0 break-words"><b>direct</b> · {taint[node.id].reason}</span>
              <button onClick={onClearTaint} className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border t-border-subtle t-text-muted hover:t-text">
                clear
              </button>
            </div>
          ) : isDerived ? (
            <div className="flex items-center gap-2 t-text-error-soft text-[13px]">
              <span className="w-2.5 h-2.5 rounded-full border-2 border-dashed flex-shrink-0 opacity-70" style={{ borderColor: 'currentColor' }} />
              <span><b>derived</b> · downstream of another suspect node</span>
            </div>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={e => { e.preventDefault(); if (reason.trim()) { onTaint(reason.trim()); setReason('') } }}
            >
              <input
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="reason for marking suspect…"
                className="flex-1 px-2 py-1 t-bg-base t-border-subtle border rounded text-[11px] t-text placeholder:t-text-muted focus:outline-none focus:t-border-accent"
              />
              <button
                type="submit"
                disabled={!reason.trim()}
                className="px-2.5 py-1 rounded text-[11px] font-medium border t-text-error disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                style={{
                  background: 'color-mix(in oklab, var(--color-status-error) 9%, transparent)',
                  borderColor: 'color-mix(in oklab, var(--color-status-error) 30%, transparent)',
                }}
              >
                mark suspect
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Citation resolvability (A1) — only renders for citing artifacts */}
      <CitationsCard node={node} />

      {/* Attributes table */}
      <div>
        <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1.5">Attributes</div>
        <AttributeTable node={node} />
      </div>

      {/* Span events */}
      {node.rawEvents && node.rawEvents.length > 0 && (
        <div className="mt-3">
          <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1.5">Span events</div>
          <div className="space-y-1.5">
            {node.rawEvents.map((e, i) => (
              <div key={i} className="t-bg-base border t-border-subtle rounded p-2">
                <div className="text-[10px] t-text-accent font-mono mb-1">{e.name}</div>
                <pre className="text-[10px] leading-relaxed font-mono t-text whitespace-pre-wrap break-all max-h-64 overflow-auto m-0">
                  {prettyMaybeJson(e.body)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Versions */}
      {node.versions && (node.versions as unknown[]).length > 0 && (
        <div className="mt-3">
          <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1.5">Artifact versions</div>
          <div className="space-y-1.5">
            {(node.versions as Array<{ version: number; op: string; timestamp: string }>).map((v, i) => (
              <div key={i} className="t-bg-base border t-border-subtle rounded p-2 text-[11px] font-mono">
                <div className="t-text-accent">v{v.version} · {v.op} · {new Date(v.timestamp).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function AttributeTable({ node }: { node: GraphNode }) {
  const rows: Array<[string, unknown]> = []
  const push = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== '') rows.push([k, v]) }
  push('id', node.id)
  push('traceId', node.traceId)
  push('spanId', node.spanId)
  push('parentSpanId', node.parentSpanId)
  push('turnId', node.turnId)
  push('stepIndex', node.stepIndex)
  push('toolName', node.toolName)
  push('toolCategory', node.toolCategory)
  push('toolCallId', node.toolCallId)
  push('model', node.model)
  push('inputTokens', node.inputTokens)
  push('outputTokens', node.outputTokens)
  push('cacheReadTokens', node.cacheReadTokens)
  push('durationMs', typeof node.durationMs === 'number' ? node.durationMs.toFixed(1) : undefined)
  push('isError', node.isError)
  push('artifactId', node.artifactId)
  push('type', node.type)
  push('path', node.path)
  push('sessionId', node.sessionId)
  return (
    <table className="w-full text-[11px]">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-b t-border-subtle">
            <td className="py-1 pr-2 t-text-muted align-top w-[38%]">{k}</td>
            <td className="py-1 t-text break-all font-mono tabular-nums">{String(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function prettyMaybeJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

/** Map a citation resolution rate to a tone + one-word verdict. */
function citationTone(rate: number | null): { cls: string; label: string } {
  if (rate === null) return { cls: 't-text-muted', label: 'no citations' }
  if (rate >= 1) return { cls: 't-text-success', label: 'all grounded' }
  if (rate <= 0) return { cls: 't-text-error', label: 'none grounded' }
  return { cls: 't-text-warning', label: 'partially grounded' }
}

/**
 * Citation resolvability card (A1). Shows how many of a delivered text
 * artifact's DOI / arXiv / URL references were actually retrieved this
 * project, and lists the ones that weren't — the fabrication watchlist.
 * Renders nothing for non-artifact nodes or artifacts the projector didn't
 * scan (no `citationsTotal`).
 */
function CitationsCard({ node }: { node: GraphNode }) {
  if (node.kind !== 'artifact' || typeof node.citationsTotal !== 'number') return null
  const total = node.citationsTotal
  const resolved = node.citationsResolved ?? 0
  const rate = node.citationResolutionRate ?? null
  const unresolved = node.unresolvedCitations ?? []
  const tone = citationTone(rate)
  const pct = rate === null ? 0 : Math.round(rate * 100)
  return (
    <div className="t-bg-elevated border t-border-subtle rounded-md p-3 mb-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Quote size={11} className="t-text-muted" />
        <span className="text-[9px] uppercase tracking-wider t-text-muted font-semibold">Citations</span>
      </div>
      {total === 0 ? (
        <div className="text-[12px] t-text-muted">No DOI / arXiv / URL references in this artifact.</div>
      ) : (
        <>
          <div className="flex items-baseline gap-1.5 tabular-nums">
            <span className={`text-[15px] font-medium ${tone.cls}`}>{resolved}/{total}</span>
            <span className="text-[10px] uppercase tracking-wider t-text-muted">retrieved</span>
            <span className={`ml-auto text-[11px] font-medium ${tone.cls}`}>{pct}% · {tone.label}</span>
          </div>
          <div className="mt-1.5 h-1.5 rounded-full overflow-hidden t-bg-base">
            <div className="h-full transition-[width]" style={{ width: `${pct}%`, background: 'var(--color-status-success)' }} />
          </div>
          {unresolved.length > 0 && (
            <div className="mt-2.5">
              <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1">
                Unresolved — never retrieved
              </div>
              <ul className="space-y-0.5 m-0 p-0 list-none">
                {unresolved.map((c, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px] t-text-error font-mono break-all">
                    <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 text-[10px] t-text-muted leading-snug">
                Not seen by a retrieval tool or in the paper library — verify before trusting.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// —— Quarantine preview ——————————————————————————————————————————————

interface Quarantine {
  direct: string[]
  derived: string[]
  closure: Set<string>
  buckets: { artifact: GraphNode[]; file: GraphNode[]; step: GraphNode[]; tool: GraphNode[]; chat: GraphNode[]; trace: GraphNode[]; dir: GraphNode[] }
  traces: Set<string>
  replayFrom: GraphNode | null
}

function buildQuarantine(
  graph: AuditGraph,
  taint: Record<string, { reason: string; ts: number }>,
  derivedTaint: Set<string>,
): Quarantine | null {
  const direct = Object.keys(taint)
  const derived = [...derivedTaint]
  if (direct.length === 0) return null
  const closure = new Set([...direct, ...derived])
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]))
  const buckets: Quarantine['buckets'] = { artifact: [], file: [], step: [], tool: [], chat: [], trace: [], dir: [] }
  const traces = new Set<string>()
  for (const id of closure) {
    const n = nodeById.get(id); if (!n) continue
    if (n.traceId) traces.add(n.traceId)
    if (n.kind in buckets) (buckets as any)[n.kind].push(n)
  }
  let replayFrom: GraphNode | null = null
  if (traces.size > 0) {
    const firstTrace = [...traces].sort()[0]
    const taintedSteps = graph.nodes.filter(n => n.kind === 'step' && n.traceId === firstTrace && closure.has(n.id))
    if (taintedSteps.length > 0) {
      const minIdx = Math.min(...taintedSteps.map(s => s.stepIndex ?? Infinity))
      const before = graph.nodes
        .filter(n => n.kind === 'step' && n.traceId === firstTrace && (n.stepIndex ?? -1) < minIdx)
        .sort((a, b) => (b.stepIndex ?? 0) - (a.stepIndex ?? 0))
      replayFrom = before[0] || null
    }
  }
  return { direct, derived, closure, buckets, traces, replayFrom }
}

function QuarantinePreview({
  q, taint, onFocusNode, onClearAll,
}: {
  q: Quarantine
  taint: Record<string, { reason: string; ts: number }>
  onFocusNode: (n: GraphNode) => void
  onClearAll: () => void
}) {
  const palette = useAuditPalette()
  const stages: Array<{ k: string; done: boolean; label: string }> = [
    { k: 'trigger',    done: true,  label: 'Trigger' },
    { k: 'trace',      done: true,  label: 'Trace' },
    { k: 'taint',      done: q.direct.length > 0, label: `Taint (${q.direct.length}+${q.derived.length})` },
    { k: 'invalidate', done: false, label: 'Invalidate' },
    { k: 'replay',     done: false, label: 'Replay' },
  ]
  const items = (arr: GraphNode[], cap = 5) => (
    <>
      {arr.slice(0, cap).map(n => (
        <button
          key={n.id}
          onClick={() => onFocusNode(n)}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 t-bg-base border t-border-subtle rounded text-[11px] t-text max-w-[200px] hover:t-bg-elevated transition-colors"
          title={n.id}
        >
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: palette.kind[n.kind] }} />
          <span className="truncate">{n.label}</span>
          {taint[n.id] && <span className="t-text-error text-[10px] leading-none">●</span>}
        </button>
      ))}
      {arr.length > cap && <span className="text-[10px] t-text-muted ml-1">+ {arr.length - cap} more</span>}
    </>
  )
  return (
    <section
      className="rounded-md border p-3 relative"
      style={{
        background: 'color-mix(in oklab, var(--color-status-error) 9%, transparent)',
        borderColor: 'color-mix(in oklab, var(--color-status-error) 30%, transparent)',
      }}
    >
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-0.5 rounded-l t-bg-error" />
      <header className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 t-text-error">
          <AlertTriangle size={12} />
          <span className="text-[11px] uppercase tracking-wider font-semibold">Repair flow</span>
        </div>
        <button onClick={onClearAll} className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border t-border-subtle t-text-muted hover:t-text inline-flex items-center gap-1">
          <X size={10} /> clear all
        </button>
      </header>

      {/* Stages */}
      <ol className="flex flex-wrap gap-1 mb-2 list-none p-0">
        {stages.map(s => (
          <li
            key={s.k}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] ${
              s.done ? 't-bg-elevated t-border-subtle t-text' : 't-bg-base t-border-subtle t-text-muted'
            }`}
          >
            <span className={s.done ? 't-text-accent font-bold' : 't-text-muted'}>{s.done ? '✓' : '·'}</span>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>

      {/* Counts */}
      <div
        className="flex flex-wrap gap-x-4 py-2"
        style={{
          borderTop: '1px solid color-mix(in oklab, var(--color-status-error) 30%, transparent)',
          borderBottom: '1px solid color-mix(in oklab, var(--color-status-error) 30%, transparent)',
        }}
      >
        <div className="flex items-baseline gap-1"><span className="text-[14px] t-text font-medium tabular-nums">{q.closure.size}</span><span className="text-[10px] t-text-muted uppercase tracking-wider">quarantined</span></div>
        <div className="flex items-baseline gap-1"><span className="text-[14px] t-text font-medium tabular-nums">{q.direct.length}</span><span className="text-[10px] t-text-muted uppercase tracking-wider">direct</span></div>
        <div className="flex items-baseline gap-1"><span className="text-[14px] t-text font-medium tabular-nums">{q.derived.length}</span><span className="text-[10px] t-text-muted uppercase tracking-wider">derived</span></div>
        <div className="flex items-baseline gap-1"><span className="text-[14px] t-text font-medium tabular-nums">{q.traces.size}</span><span className="text-[10px] t-text-muted uppercase tracking-wider">traces</span></div>
      </div>

      {/* Would invalidate */}
      <div className="mt-2">
        <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1">Would invalidate</div>
        {q.buckets.artifact.length > 0 && <div className="mb-1 flex flex-wrap items-center gap-1"><span className="text-[9px] uppercase tracking-wider t-text-muted font-semibold min-w-[56px]">artifacts</span>{items(q.buckets.artifact)}</div>}
        {q.buckets.file.length > 0     && <div className="mb-1 flex flex-wrap items-center gap-1"><span className="text-[9px] uppercase tracking-wider t-text-muted font-semibold min-w-[56px]">files</span>{items(q.buckets.file)}</div>}
        {q.buckets.dir.length > 0      && <div className="mb-1 flex flex-wrap items-center gap-1"><span className="text-[9px] uppercase tracking-wider t-text-muted font-semibold min-w-[56px]">dirs</span>{items(q.buckets.dir)}</div>}
        {q.buckets.step.length > 0     && <div className="mb-1 flex flex-wrap items-center gap-1"><span className="text-[9px] uppercase tracking-wider t-text-muted font-semibold min-w-[56px]">steps</span>{items(q.buckets.step, 4)}</div>}
        {q.buckets.tool.length > 0     && <div className="mb-1 flex flex-wrap items-center gap-1"><span className="text-[9px] uppercase tracking-wider t-text-muted font-semibold min-w-[56px]">tool calls</span>{items(q.buckets.tool, 4)}</div>}
      </div>

      {/* Replay from */}
      <div className="mt-3">
        <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1">Replay from</div>
        {q.replayFrom ? (
          <button
            onClick={() => onFocusNode(q.replayFrom!)}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] border t-text hover:opacity-80 transition-opacity"
            style={{
              background: 'color-mix(in oklab, var(--color-accent) 12%, transparent)',
              borderColor: 'color-mix(in oklab, var(--color-accent) 40%, transparent)',
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: palette.kind.step }} />
            <span>{q.replayFrom.label}</span>
            <span className="t-text-muted text-[10px] ml-1 font-mono">({q.replayFrom.traceId?.slice(0, 6)})</span>
          </button>
        ) : (
          <div className="text-[11px] t-text-muted italic">No clean checkpoint before the suspect — full session rebuild required.</div>
        )}
      </div>

      <div className="mt-3 pt-2 border-t border-dashed t-border-subtle text-[10px] t-text-muted leading-relaxed">
        Preview only — actual <code className="t-bg-elevated px-1 rounded font-mono text-[10px]">Invalidate</code> / <code className="t-bg-elevated px-1 rounded font-mono text-[10px]">Replay</code> requires runtime hooks. The closure above is what would be written to <code className="t-bg-elevated px-1 rounded font-mono text-[10px]">.research-pilot/taint.jsonl</code>.
      </div>
    </section>
  )
}
