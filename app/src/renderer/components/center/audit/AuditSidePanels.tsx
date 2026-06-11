/**
 * Audit side panels — filters on the left, details + quarantine on the right.
 *
 * Both rails are theme-aware (t-* utility classes + lucide icons consistent
 * with the rest of the app). Kind colors come from the audit palette so the
 * dots in the filters and pill chips match the dots in the canvas.
 */

import { useMemo, useState, type ReactNode } from 'react'
import { Filter, Search, RefreshCw, ChevronLeft, ChevronRight, ChevronDown, AlertTriangle, X, Crosshair, Eye, ExternalLink, FolderOpen, Quote } from 'lucide-react'
import type {
  AuditGraph,
  GraphNode,
  NodeKind,
} from '../../../../../../lib/audit-graph/index'
import { PATHS } from '../../../../../../lib/types'
import { useAuditPalette } from './audit-theme'
import type { AuditSearchMatch } from './audit-search'

const api = (window as any).api

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

export interface AuditProjectionStats {
  on: boolean
  terminalStepId: string | null
  terminalLabel: string | null
  keptNodes: number
  prunedNodes: number
  flaggedNodes: number
  spineNodes: number
  metric: {
    nGroundingTools: number
    toolKindDiversity: number
    redundancy: number
    suspiciousRatio: number
  } | null
  edgeClasses: { causal: number; temporal: number; structural: number }
  nodeRoles: { container: number; step: number; tool: number; artifact: number; file: number; skill: number }
}

interface RightProps {
  graph: AuditGraph
  selected: GraphNode | null
  taint: Record<string, { reason: string; ts: number }>
  derivedTaint: Set<string>
  autoSuspect?: Map<string, string[]>
  sliceStats: SliceStats
  auditStats?: AuditProjectionStats | null
  onTaint: (id: string, reason: string) => void
  onClearTaint: (id: string) => void
  onClearAllTaint: () => void
  onFocusNode: (n: GraphNode) => void
  searchQuery?: string
  searchCaseSensitive?: boolean
  activeSearchMatch?: AuditSearchMatch | null
  collapsed: boolean
  onToggleCollapsed: () => void
}

export function AuditRightRail({
  graph, selected, taint, derivedTaint, autoSuspect, sliceStats, auditStats, onTaint, onClearTaint, onClearAllTaint, onFocusNode, searchQuery = '', searchCaseSensitive = false, activeSearchMatch = null, collapsed, onToggleCollapsed,
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
            autoSuspect={autoSuspect}
            sliceStats={sliceStats}
            auditStats={auditStats}
            searchQuery={searchQuery}
            searchCaseSensitive={searchCaseSensitive}
            activeSearchMatch={activeSearchMatch}
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
  autoSuspect?: Map<string, string[]>
  sliceStats: SliceStats
  auditStats?: AuditProjectionStats | null
  searchQuery: string
  searchCaseSensitive: boolean
  activeSearchMatch: AuditSearchMatch | null
  onTaint: (reason: string) => void
  onClearTaint: () => void
}

function NodeDetails({ node, taint, derivedTaint, autoSuspect, sliceStats, auditStats, searchQuery, searchCaseSensitive, activeSearchMatch, onTaint, onClearTaint }: NDProps) {
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

      {/* Skill — how this skill entered the turn. router-match = pre-selected by
          the intent router at turn start; explicit-load = the agent called
          load_skill mid-turn; mixed = both happened across different turns. */}
      {node.kind === 'skill' && node.skillTrigger && (
        <div className="t-bg-elevated border t-border-subtle rounded-md p-3 mb-3">
          <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1">Skill trigger</div>
          <div className="text-[12px] t-text">
            {node.skillTrigger === 'router-match' && 'Pre-matched by the intent router at turn start.'}
            {node.skillTrigger === 'explicit-load' && 'Loaded mid-turn via the load_skill tool.'}
            {node.skillTrigger === 'mixed' && 'Both router-matched and explicitly loaded across turns.'}
          </div>
        </div>
      )}

      {/* Slice + Taint card */}
      <div className="t-bg-elevated border t-border-subtle rounded-md p-3 mb-3 space-y-3">
        {auditStats && (
          <div>
            <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1">
              {auditStats.on ? 'Prune' : 'Full graph'}
            </div>
            {auditStats.on ? (
              <>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 tabular-nums">
                  <span>
                    <span className="text-[15px] t-text font-medium">{auditStats.keptNodes}</span>
                    <span className="text-[10px] uppercase tracking-wider t-text-muted ml-1">kept</span>
                  </span>
                  <span>
                    <span className="text-[15px] t-text font-medium">{auditStats.prunedNodes}</span>
                    <span className="text-[10px] uppercase tracking-wider t-text-muted ml-1">greyed</span>
                  </span>
                  <span>
                    <span className="text-[15px] t-text font-medium">{auditStats.flaggedNodes}</span>
                    <span className="text-[10px] uppercase tracking-wider t-text-muted ml-1">flagged</span>
                  </span>
                  <span>
                    <span className="text-[15px] t-text font-medium">{auditStats.spineNodes}</span>
                    <span className="text-[10px] uppercase tracking-wider t-text-muted ml-1">on path</span>
                  </span>
                </div>
                <div className="text-[11px] t-text-muted leading-snug mt-1.5">
                  Critical path ends at {auditStats.terminalLabel ?? 'the latest step'}.
                  {auditStats.metric && (
                    <> Grounding tools: {auditStats.metric.nGroundingTools} ({auditStats.metric.toolKindDiversity} kind{auditStats.metric.toolKindDiversity === 1 ? '' : 's'}); suspicious {Math.round(auditStats.metric.suspiciousRatio * 100)}%.</>
                  )}
                </div>
              </>
            ) : (
              <div className="text-[11px] t-text-muted leading-snug">
                Toggle <b className="t-text">Prune</b> on the graph to grey everything off the critical path.
                Full graph: {auditStats.keptNodes + auditStats.prunedNodes} nodes.
              </div>
            )}

            {/* Stage-0 typing — edge classes + node roles over the whole graph.
                This is the classification legend: edges are coloured by class on
                the canvas (causal = relation hue, temporal = dashed grey,
                structural = faint). */}
            <div className="mt-2 pt-2 border-t t-border-subtle">
              <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1">Edge classes</div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] t-text-secondary tabular-nums">
                <span><span className="t-text font-medium">{auditStats.edgeClasses.causal}</span> causal</span>
                <span><span className="t-text font-medium">{auditStats.edgeClasses.temporal}</span> temporal</span>
                <span><span className="t-text font-medium">{auditStats.edgeClasses.structural}</span> structural</span>
              </div>
              <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1 mt-2">Node roles</div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] t-text-secondary tabular-nums">
                <span><span className="t-text font-medium">{auditStats.nodeRoles.container}</span> container</span>
                <span><span className="t-text font-medium">{auditStats.nodeRoles.step}</span> step</span>
                <span><span className="t-text font-medium">{auditStats.nodeRoles.tool}</span> tool</span>
                <span><span className="t-text font-medium">{auditStats.nodeRoles.artifact}</span> artifact</span>
                <span><span className="t-text font-medium">{auditStats.nodeRoles.file}</span> file</span>
                <span><span className="t-text font-medium">{auditStats.nodeRoles.skill}</span> skill</span>
              </div>
            </div>
          </div>
        )}

        {/* Slice stats */}
        <div className={auditStats ? 'pt-3 border-t t-border-subtle' : ''}>
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
          <div className="text-[11px] t-text-muted leading-snug mt-1.5">
            Everything upstream and downstream of this node — what fed into it, and what was produced from it.
          </div>
          {sliceStats.traces.size > 1 && (
            <div className="mt-2 px-2 py-1.5 border-l-2 t-border-accent t-bg-accent/10 t-text-accent text-[11px] rounded-r leading-snug">
              Crosses {sliceStats.traces.size} traces — lineage continues across user turns.
            </div>
          )}
        </div>

        {/* Taint */}
        <div className="pt-3 border-t t-border-subtle">
          <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1.5">Taint</div>
          {(() => {
            const autoReasons = autoSuspect?.get(node.id)
            if (isDirect) return (
              <div className="space-y-1.5">
                {autoReasons && (
                  <div className="flex items-start gap-1.5 text-[11px] t-text-muted">
                    <AlertTriangle size={11} className="flex-shrink-0 mt-0.5 opacity-60" />
                    <span>{autoReasons.join(' · ')}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 t-text-error text-[13px]">
                  <span className="w-2.5 h-2.5 rounded-full border-dashed border-2 flex-shrink-0" style={{ borderColor: 'currentColor' }} />
                  <span className="flex-1 min-w-0 break-words"><b>marked</b> · {taint[node.id].reason}</span>
                  <button onClick={onClearTaint} className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border t-border-subtle t-text-muted hover:t-text">
                    clear
                  </button>
                </div>
              </div>
            )
            if (isDerived) return (
              <div className="space-y-1.5">
                {autoReasons && (
                  <div className="flex items-start gap-1.5 text-[11px] t-text-muted">
                    <AlertTriangle size={11} className="flex-shrink-0 mt-0.5 opacity-60" />
                    <span>{autoReasons.join(' · ')}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 t-text-error-soft text-[13px]">
                  <span className="w-2.5 h-2.5 rounded-full border-2 border-dashed flex-shrink-0 opacity-70" style={{ borderColor: 'currentColor' }} />
                  <span><b>derived</b> · downstream of a marked suspect node</span>
                </div>
              </div>
            )
            if (autoReasons) return (
              <div className="space-y-2">
                <div className="flex items-start gap-1.5 text-[12px] t-text-error">
                  <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                  <span className="leading-snug">{autoReasons.join(' · ')}</span>
                </div>
                <form
                  className="flex gap-2"
                  onSubmit={e => { e.preventDefault(); if (reason.trim()) { onTaint(reason.trim()); setReason('') } }}
                >
                  <input
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    placeholder="confirm or add reason…"
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
                    confirm
                  </button>
                </form>
              </div>
            )
            return (
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
            )
          })()}
        </div>
      </div>

      {/* Citation resolvability (A1) — only renders for citing artifacts */}
      <CitationsCard node={node} />

      {/* Span events — what the node actually did (args) and returned (result).
          Shown first because it's the answer to "what happened here?"; the
          opaque IDs in Attributes below are only for correlating with raw traces. */}
      {node.rawEvents && node.rawEvents.length > 0 && (
        <div>
          <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1.5">Span events</div>
          <div className="space-y-1.5">
            {node.rawEvents.map((e, i) => {
              const refs = collectBlobRefs(e.body)
              const isActiveEvent = activeSearchMatch?.nodeId === node.id && activeSearchMatch.eventName === e.name
              const eventText = humanizeEventBody(e.name, e.body)
              return (
                <div
                  key={i}
                  className={`t-bg-base border rounded p-2 ${
                    isActiveEvent ? 't-border-accent shadow-sm' : 't-border-subtle'
                  }`}
                >
                  <div className="text-[10px] t-text-accent font-mono mb-1">{EVENT_LABELS[e.name] ?? e.name}</div>
                  <pre className="text-[10px] leading-relaxed font-mono t-text whitespace-pre-wrap break-all max-h-64 overflow-auto m-0">
                    <HighlightedSearchText text={eventText} query={searchQuery} caseSensitive={searchCaseSensitive} />
                  </pre>
                  {refs.length > 0 && (
                    <div className="mt-1.5 space-y-1">
                      <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold">Large content (stored on disk)</div>
                      {refs.map((r, j) => <BlobRefCard key={j} refData={r} />)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Attributes table */}
      <div className="mt-3">
        <div className="text-[9px] uppercase tracking-wider t-text-muted font-semibold mb-1.5">Attributes</div>
        <AttributeTable node={node} />
      </div>

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

function HighlightedSearchText({ text, query, caseSensitive }: { text: string; query: string; caseSensitive: boolean }) {
  const q = query.trim()
  if (!q) return <>{text}</>

  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? q : q.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  let key = 0
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from)
    if (idx === -1) break
    if (idx > from) parts.push(text.slice(from, idx))
    parts.push(
      <mark key={key++} className="rounded px-0.5 bg-amber-300/70 text-zinc-950">
        {text.slice(idx, idx + q.length)}
      </mark>,
    )
    from = idx + Math.max(needle.length, 1)
  }
  if (from < text.length) parts.push(text.slice(from))
  return <>{parts}</>
}

function AttributeTable({ node }: { node: GraphNode }) {
  // Default-collapsed: the opaque IDs are only useful for correlating with raw
  // OpenTelemetry traces, which a normal user never does.
  const [showDebug, setShowDebug] = useState(false)

  const primary: Array<[string, unknown]> = []
  const debug: Array<[string, unknown]> = []
  const pushTo = (rows: Array<[string, unknown]>, k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') rows.push([k, v])
  }

  // Primary — "did it work / how long / how big / what is it". The things a
  // user reads to judge the node.
  pushTo(primary, 'isError', node.isError)
  pushTo(primary, 'durationMs', typeof node.durationMs === 'number' ? node.durationMs.toFixed(1) : undefined)
  pushTo(primary, 'model', node.model)
  pushTo(primary, 'inputTokens', node.inputTokens)
  pushTo(primary, 'outputTokens', node.outputTokens)
  pushTo(primary, 'cacheReadTokens', node.cacheReadTokens)
  pushTo(primary, 'type', node.type)
  pushTo(primary, 'path', node.path)

  // Debug — opaque identifiers for correlating with the raw trace stream.
  pushTo(debug, 'id', node.id)
  pushTo(debug, 'traceId', node.traceId)
  pushTo(debug, 'spanId', node.spanId)
  pushTo(debug, 'parentSpanId', node.parentSpanId)
  pushTo(debug, 'turnId', node.turnId)
  pushTo(debug, 'stepIndex', node.stepIndex)
  pushTo(debug, 'toolName', node.toolName)
  pushTo(debug, 'toolCategory', node.toolCategory)
  pushTo(debug, 'toolCallId', node.toolCallId)
  pushTo(debug, 'artifactId', node.artifactId)
  pushTo(debug, 'sessionId', node.sessionId)

  const renderRows = (rows: Array<[string, unknown]>) => (
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

  return (
    <div>
      {primary.length > 0
        ? renderRows(primary)
        : <div className="text-[11px] t-text-muted italic py-1">No primary attributes.</div>}
      {debug.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowDebug(s => !s)}
            className="flex items-center gap-1 text-[10px] uppercase tracking-wider t-text-muted hover:t-text-secondary"
          >
            {showDebug ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            Debug IDs ({debug.length})
          </button>
          {showDebug && <div className="mt-1.5">{renderRows(debug)}</div>}
        </div>
      )}
    </div>
  )
}

/** Friendly headers for the noisy raw event names. */
const EVENT_LABELS: Record<string, string> = {
  'pipilot.tool.args': 'Arguments',
  'pipilot.tool.result': 'Result',
  'pipilot.chat.response_text': 'Assistant output',
  'pipilot.chat.request_payload': 'Prompt sent',
  'pipilot.chat.input_delta': 'Δ Input delta (this step)',
}

/** Join the text parts of a tool result's `content` array, if present. */
function extractResultText(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null
  const content = (parsed as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  const parts = content
    .filter((c): c is { text: string } => !!c && typeof (c as { text?: unknown }).text === 'string')
    .map(c => c.text)
  return parts.length > 0 ? parts.join('\n') : null
}

/** Pretty-print a tool's argument object — unwraps the common `command` case. */
function formatArgs(args: unknown): string {
  if (args && typeof args === 'object' && typeof (args as { command?: unknown }).command === 'string') {
    return (args as { command: string }).command
  }
  if (typeof args === 'string') {
    try { return JSON.stringify(JSON.parse(args), null, 2) } catch { return args }
  }
  return JSON.stringify(args, null, 2)
}

function renderUnknownValue(value: unknown): string {
  if (value === undefined) return ''
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function renderWireContent(content: unknown): string {
  if (Array.isArray(content)) return renderContentBlocks(content)
  return renderUnknownValue(content)
}

/**
 * Render an LLM message content array (assistant output or a prompt message)
 * as readable prose. Each block becomes a small labelled section; the useless
 * `thinkingSignature` crypto blob is dropped, tool calls show name + command,
 * blob refs are left as-is for the blob viewer to pick up.
 */
function renderContentBlocks(blocks: unknown[]): string {
  const out: string[] = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') { out.push(String(b)); continue }
    const block = b as Record<string, unknown>
    if (typeof block.text === 'string' && block.type === undefined) {
      out.push(block.text)
      continue
    }
    if (block.inlineData || block.image_url) {
      out.push('[image]')
      continue
    }
    if (block.functionCall && typeof block.functionCall === 'object') {
      const call = block.functionCall as Record<string, unknown>
      out.push(`[tool call] ${String(call.name ?? 'tool')}\n${formatArgs(call.args)}`)
      continue
    }
    if (block.functionResponse && typeof block.functionResponse === 'object') {
      const res = block.functionResponse as Record<string, unknown>
      out.push(`[tool result] ${String(res.name ?? '')}\n${renderUnknownValue(res.response)}`)
      continue
    }
    switch (block.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        if (typeof block.text === 'string') out.push(block.text)
        break
      case 'message':
        out.push(renderWireMessage(block))
        break
      case 'thinking':
      case 'reasoning':
        if (typeof block.thinking === 'string') out.push(`[thinking]\n${block.thinking}`)
        else if (typeof block.text === 'string') out.push(`[thinking]\n${block.text}`)
        else if (Array.isArray(block.summary) && block.summary.length > 0) {
          out.push(`[thinking]\n${renderContentBlocks(block.summary)}`)
        }
        break
      case 'toolCall':
        out.push(`🔧 ${String(block.name ?? 'tool')}\n${formatArgs(block.arguments)}`)
        break
      case 'tool_use':
        out.push(`🔧 ${String(block.name ?? 'tool')}\n${formatArgs(block.input)}`)
        break
      case 'function_call':
        out.push(`[tool call] ${String(block.name ?? 'tool')}\n${formatArgs(block.arguments)}`)
        break
      case 'function_call_output':
        out.push(`[tool result]\n${renderWireContent(block.output)}`)
        break
      case 'toolResult':
      case 'tool_result': {
        const t = extractResultText(block) ?? (typeof block.content === 'string' ? block.content : JSON.stringify(block.content))
        out.push(`↩ tool result\n${t}`)
        break
      }
      case 'image':
      case 'input_image':
        out.push('🖼 [image]')
        break
      default:
        out.push(JSON.stringify(block, null, 2))
    }
  }
  return out.join('\n\n')
}

/**
 * Human-readable span-event body. Tool args/results and chat messages are
 * unwrapped from their JSON envelope so the user sees the actual command /
 * output / reasoning with real newlines instead of an escaped `\n` soup.
 * Falls back to pretty JSON, then to the raw string if it isn't JSON at all.
 */
function humanizeEventBody(name: string, body: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return body }

  // Whole payload spilled to a blob — the card below handles it; don't dump
  // the raw `{ contentHash, … }` envelope here.
  if (isBlobRef(parsed)) return '⟶ Content too large for the trace; stored on disk (see below).'

  if (name === 'pipilot.tool.args') {
    const cmd = (parsed as { command?: unknown })?.command
    if (typeof cmd === 'string') return cmd
    return JSON.stringify(parsed, null, 2)
  }

  if (name === 'pipilot.tool.result') {
    const text = extractResultText(parsed)
    if (text != null) return text
    return JSON.stringify(parsed, null, 2)
  }

  // Assistant output: content is an array of text/thinking/toolCall blocks.
  if (name === 'pipilot.chat.response_text' && Array.isArray(parsed)) {
    return renderContentBlocks(parsed)
  }

  // Prompt sent: the wire payload — render system + each message readably.
  if (name === 'pipilot.chat.request_payload' && parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>
    const conversation =
      Array.isArray(p.messages) ? p.messages
        : Array.isArray(p.input) ? p.input
          : Array.isArray(p.contents) ? p.contents
            : null
    if (conversation) {
      const parts: string[] = []
      if (typeof p.system === 'string' && p.system.trim()) parts.push(`[system]\n${p.system}`)
      if (typeof p.instructions === 'string' && p.instructions.trim()) {
        parts.push(`[instructions]\n${p.instructions}`)
      }
      const config = p.config as { systemInstruction?: unknown } | undefined
      if (typeof config?.systemInstruction === 'string' && config.systemInstruction.trim()) {
        parts.push(`[system]\n${config.systemInstruction}`)
      }
      for (const m of conversation) parts.push(renderWireMessage(m))
      return parts.join('\n\n')
    }
    return JSON.stringify(parsed, null, 2)
  }

  // Input delta: what entered / left the context since the previous step.
  if (name === 'pipilot.chat.input_delta' && parsed && typeof parsed === 'object') {
    const d = parsed as { appended?: unknown; removed?: unknown; carriedOver?: unknown }
    const appended = Array.isArray(d.appended) ? d.appended : []
    const removed = Array.isArray(d.removed) ? d.removed : []
    const parts: string[] = []
    if (typeof d.carriedOver === 'number') {
      parts.push(`${d.carriedOver} earlier message(s) carried over unchanged.`)
    }
    if (removed.length > 0) {
      parts.push(`── removed (compacted away) · ${removed.length} ──`)
      for (const m of removed) parts.push(renderWireMessage(m))
    }
    if (appended.length > 0) {
      parts.push(`＋ added this step · ${appended.length}`)
      for (const m of appended) parts.push(renderWireMessage(m))
    }
    return parts.length > 0 ? parts.join('\n\n') : '(no change)'
  }

  return JSON.stringify(parsed, null, 2)
}

/** Render one wire message (role + content blocks/string) as readable prose. */
function renderWireMessage(m: unknown): string {
  if (!m || typeof m !== 'object') return renderUnknownValue(m)
  const item = m as Record<string, unknown>

  if (item.type === 'function_call') {
    return `[tool call] ${String(item.name ?? 'tool')}\n${formatArgs(item.arguments)}`
  }
  if (item.type === 'function_call_output') {
    return `[tool result]\n${renderWireContent(item.output)}`
  }
  if (item.type === 'reasoning') {
    if (Array.isArray(item.summary) && item.summary.length > 0) {
      return `[thinking]\n${renderContentBlocks(item.summary)}`
    }
    return '[thinking]\n[encrypted reasoning]'
  }

  const role = String(item.role ?? (item.type === 'message' ? 'assistant' : '?'))
  if ('content' in item) return `[${role}]\n${renderWireContent(item.content)}`
  if ('parts' in item) return `[${role}]\n${renderWireContent(item.parts)}`

  const fallback = renderUnknownValue(item)
  return fallback ? `[${role}]\n${fallback}` : `[${role}]`
}

// —— Blob references ——————————————————————————————————————————————————
//
// When a tool result / chat message exceeded the 4 KB span cap, the redaction
// pipeline spilled the full bytes to the content-addressed blob store and left
// a `{ contentHash, size, mimeType? }` ref in its place (lib/telemetry/
// redaction.ts). The bytes are already on local disk at
// `.research-pilot/blobs/{aa}/{hash}` — we never "download", we just read or
// hand the local file to the OS.

interface BlobRef {
  contentHash: string
  size?: number
  mimeType?: string
  /** true for size-cap text spill; absent for binary/image refs. */
  truncated?: boolean
}

/** A blob ref is any object carrying a string `contentHash`. */
function isBlobRef(v: unknown): v is { contentHash: string } & Record<string, unknown> {
  return !!v && typeof v === 'object' && typeof (v as { contentHash?: unknown }).contentHash === 'string'
}

/** Walk a parsed value tree collecting every blob ref, de-duped by hash. */
function collectBlobRefs(body: string): BlobRef[] {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return [] }
  const found = new Map<string, BlobRef>()
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (isBlobRef(v)) {
      const o = v as Record<string, unknown>
      if (!found.has(o.contentHash as string)) {
        found.set(o.contentHash as string, {
          contentHash: o.contentHash as string,
          size: typeof o.size === 'number' ? o.size : undefined,
          mimeType: typeof o.mimeType === 'string' ? o.mimeType : undefined,
          truncated: o.truncated === true,
        })
      }
    }
    for (const val of Object.values(v as Record<string, unknown>)) walk(val)
  }
  walk(parsed)
  return [...found.values()]
}

/** Local workspace-relative path for a blob hash — mirrors BlobStore.pathFor. */
function blobRelPath(contentHash: string): string {
  const h = contentHash.startsWith('sha256:') ? contentHash.slice('sha256:'.length) : contentHash
  return `${PATHS.blobs}/${h.slice(0, 2)}/${h}`
}

function formatBytes(n?: number): string {
  if (typeof n !== 'number') return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Inline only when small enough not to choke the renderer. */
const TEXT_INLINE_MAX = 512 * 1024
const IMAGE_INLINE_MAX = 8 * 1024 * 1024

/**
 * A spilled-content ref. The bytes live on local disk; this card reads them on
 * demand (text/image preview) or hands the file to the OS (open / reveal). It
 * never transfers anything off the machine.
 */
function BlobRefCard({ refData }: { refData: BlobRef }) {
  const [preview, setPreview] = useState<{ kind: 'text'; text: string } | { kind: 'image'; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const rel = blobRelPath(refData.contentHash)

  const isImage = !!refData.mimeType?.startsWith('image/')
  const isBinary = !!refData.mimeType && !isImage
  const tooBigForText = (refData.size ?? 0) > TEXT_INLINE_MAX
  const tooBigForImage = (refData.size ?? 0) > IMAGE_INLINE_MAX

  const previewText = async () => {
    setBusy(true); setErr(null)
    try {
      const res = await api?.readFile?.(rel)
      if (res?.success) setPreview({ kind: 'text', text: res.content ?? '' })
      else setErr(res?.error ?? 'Could not read blob')
    } finally { setBusy(false) }
  }
  const previewImage = async () => {
    setBusy(true); setErr(null)
    try {
      const res = await api?.readFileBinary?.(rel)
      if (res?.success) setPreview({ kind: 'image', url: `data:${refData.mimeType};base64,${res.base64}` })
      else setErr(res?.error ?? 'Could not read blob')
    } finally { setBusy(false) }
  }
  const openExternal = () => api?.openFile?.(rel)
  const reveal = () => api?.revealInFinder?.(rel)

  const kindLabel = isImage ? (refData.mimeType ?? 'image')
    : isBinary ? (refData.mimeType ?? 'binary')
    : 'text (over 4 KB)'

  return (
    <div className="t-bg-elevated border t-border-subtle rounded p-2 text-[10px]">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="t-text-secondary">{kindLabel}</span>
        {refData.size != null && <span className="t-text-muted tabular-nums">· {formatBytes(refData.size)}</span>}
        <span className="t-text-muted font-mono truncate flex-1" title={refData.contentHash}>
          {refData.contentHash.replace('sha256:', '').slice(0, 10)}
        </span>
      </div>

      {err && <div className="t-text-error mb-1">{err}</div>}

      {preview?.kind === 'image' && (
        <img src={preview.url} alt="blob preview" className="max-w-full rounded border t-border-subtle mb-1" />
      )}
      {preview?.kind === 'text' && (
        <pre className="text-[10px] leading-relaxed font-mono t-text whitespace-pre-wrap break-all max-h-64 overflow-auto m-0 mb-1 t-bg-base rounded p-1.5">
          {preview.text}
        </pre>
      )}

      <div className="flex flex-wrap gap-1">
        {isImage && !tooBigForImage && !preview && (
          <BlobBtn onClick={previewImage} disabled={busy} icon={<Eye size={10} />} label="Preview" />
        )}
        {!refData.mimeType && !tooBigForText && !preview && (
          <BlobBtn onClick={previewText} disabled={busy} icon={<Eye size={10} />} label="View text" />
        )}
        <BlobBtn onClick={openExternal} icon={<ExternalLink size={10} />} label="Open" />
        <BlobBtn onClick={reveal} icon={<FolderOpen size={10} />} label="Reveal" />
      </div>
      {(tooBigForText && !refData.mimeType) && (
        <div className="t-text-muted mt-1 italic">Too large to preview inline — open it instead.</div>
      )}
    </div>
  )
}

function BlobBtn({ onClick, disabled, icon, label }: { onClick: () => void; disabled?: boolean; icon: ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border t-border-subtle t-text-secondary hover:t-text disabled:opacity-40 transition-colors"
    >
      {icon}{label}
    </button>
  )
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
