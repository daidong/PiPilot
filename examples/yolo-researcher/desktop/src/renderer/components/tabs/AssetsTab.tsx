import { useState, useMemo, useEffect, Fragment } from 'react'
import type { AssetRecord } from '@/lib/types'
import {
  friendlyAssetId,
  laneToneFromType,
  laneDotColor,
  assetSearchableText,
  buildSupersedesChain,
} from '@/lib/formatters'

interface AssetsTabProps {
  assetRecords: AssetRecord[]
  onExportInventory: () => Promise<void>
}

const PAGE_SIZE = 50

// Safe string extraction from unknown values
function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

// Truncate long strings for the fallback renderer
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

export function AssetsTab({ assetRecords, onExportInventory }: AssetsTabProps) {
  const [activeTypeFilters, setActiveTypeFilters] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [sortNewestFirst, setSortNewestFirst] = useState(true)
  const [expandedAssetId, setExpandedAssetId] = useState<string | null>(null)
  const [showRawJson, setShowRawJson] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  // Reset raw JSON view when expanding a different card
  useEffect(() => { setShowRawJson(false) }, [expandedAssetId])

  // Reset visible count when filters/sort change
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [activeTypeFilters, searchQuery, sortNewestFirst])

  // Type → count (sorted by count desc, then name asc)
  const assetTypeCounts = useMemo(() => {
    const grouped = new Map<string, number>()
    for (const asset of assetRecords) {
      grouped.set(asset.type, (grouped.get(asset.type) ?? 0) + 1)
    }
    return Array.from(grouped.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [assetRecords])

  // O(1) lookups by asset ID
  const assetMap = useMemo(() => {
    const m = new Map<string, AssetRecord>()
    for (const a of assetRecords) m.set(a.id, a)
    return m
  }, [assetRecords])

  // Pre-computed searchable text per asset
  const searchableCache = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of assetRecords) m.set(a.id, assetSearchableText(a))
    return m
  }, [assetRecords])

  // Filtered + sorted assets
  const filteredAssets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    let result = assetRecords

    // Type filter
    if (activeTypeFilters.size > 0) {
      result = result.filter((a) => activeTypeFilters.has(a.type))
    }

    // Text search
    if (q) {
      result = result.filter((a) => (searchableCache.get(a.id) ?? '').includes(q))
    }

    // Sort
    const sorted = [...result].sort((a, b) => {
      const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      return sortNewestFirst ? -diff : diff
    })

    return sorted
  }, [assetRecords, activeTypeFilters, searchQuery, sortNewestFirst, searchableCache])

  const visibleAssets = filteredAssets.slice(0, visibleCount)
  const remaining = filteredAssets.length - visibleCount
  const isFiltered = activeTypeFilters.size > 0 || searchQuery.trim() !== ''

  // Toggle a type in the filter set
  function toggleTypeFilter(type: string) {
    setActiveTypeFilters((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  function clearFilters() {
    setActiveTypeFilters(new Set())
    setSearchQuery('')
  }

  // Navigate to an ancestor asset in the supersedes chain
  function navigateToAsset(id: string) {
    // Clear filters if the target wouldn't be visible
    const target = assetMap.get(id)
    if (target && activeTypeFilters.size > 0 && !activeTypeFilters.has(target.type)) {
      setActiveTypeFilters(new Set())
    }
    if (searchQuery.trim()) setSearchQuery('')
    setExpandedAssetId(id)
  }

  // Semantic payload renderer
  function renderPayload(asset: AssetRecord) {
    const p = asset.payload
    switch (asset.type) {
      case 'Claim': {
        const statement = str(p.statement) || str(p.claim) || str(p.text)
        const tier = str(p.tier)
        const state = str(p.state)
        return (
          <div className="space-y-1.5">
            {statement && <p className="text-xs italic t-text-primary">"{statement}"</p>}
            <div className="flex flex-wrap gap-1">
              {tier && (
                <span className="rounded-md bg-emerald-500/20 border border-emerald-500/30 px-1.5 py-0.5 text-[10px] font-medium">
                  {tier}
                </span>
              )}
              {state && (
                <span className="rounded-md bg-emerald-500/20 border border-emerald-500/30 px-1.5 py-0.5 text-[10px] font-medium">
                  {state}
                </span>
              )}
            </div>
          </div>
        )
      }
      case 'EvidenceLink': {
        const relation = str(p.relation)
        const policy = str(p.countingPolicy)
        const claimIds: string[] = []
        const evidenceIds: string[] = []
        if (typeof p.claimId === 'string') claimIds.push(p.claimId)
        if (Array.isArray(p.claimIds)) claimIds.push(...p.claimIds.filter((x): x is string => typeof x === 'string'))
        if (typeof p.evidenceId === 'string') evidenceIds.push(p.evidenceId)
        if (Array.isArray(p.evidenceIds)) evidenceIds.push(...p.evidenceIds.filter((x): x is string => typeof x === 'string'))
        return (
          <div className="space-y-1.5">
            {relation && <p className="text-xs t-text-primary">Relation: <span className="font-medium">{relation}</span></p>}
            {policy && <p className="text-[11px] t-text-secondary">Counting policy: {policy}</p>}
            {claimIds.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <span className="text-[10px] t-text-muted mr-0.5">Claims:</span>
                {claimIds.map((id) => (
                  <span key={id} className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px]" title={id}>
                    {friendlyAssetId(id)}
                  </span>
                ))}
              </div>
            )}
            {evidenceIds.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <span className="text-[10px] t-text-muted mr-0.5">Evidence:</span>
                {evidenceIds.map((id) => (
                  <span key={id} className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px]" title={id}>
                    {friendlyAssetId(id)}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      }
      case 'RunRecord': {
        const runKey = str(p.runKey)
        const entries = Object.entries(p).filter(([k]) => k !== 'runKey').slice(0, 8)
        return (
          <div className="space-y-1">
            {runKey && <p className="text-xs t-text-primary font-medium">Run: {runKey}</p>}
            {entries.length > 0 && (
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
                {entries.map(([k, v]) => (
                  <Fragment key={k}>
                    <span className="t-text-muted">{k}</span>
                    <span className="t-text-secondary truncate">{truncate(str(v) || JSON.stringify(v), 200)}</span>
                  </Fragment>
                ))}
              </div>
            )}
          </div>
        )
      }
      case 'Decision': {
        const kind = str(p.kind)
        const checkpoint = str(p.checkpoint)
        const madeBy = str(p.madeBy)
        const targetNode = str(p.targetNode)
        const choice = str(p.choice)
        const rationale = str(p.rationale)
        return (
          <div className="space-y-1">
            {kind && <p className="text-xs t-text-primary font-medium">{kind}</p>}
            {checkpoint && <p className="text-[11px] t-text-secondary">Checkpoint: {checkpoint}</p>}
            {madeBy && <p className="text-[11px] t-text-secondary">Made by: {madeBy}</p>}
            {targetNode && <p className="text-[11px] t-text-secondary">Target: {targetNode}</p>}
            {choice && <p className="text-[11px] t-text-secondary">Choice: {choice}</p>}
            {rationale && <p className="text-xs italic t-text-muted mt-1">"{rationale}"</p>}
          </div>
        )
      }
      default: {
        // Fallback: show up to 10 key-value pairs
        const entries = Object.entries(p).slice(0, 10)
        if (entries.length === 0) return <p className="text-[11px] t-text-muted">Empty payload</p>
        return (
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
            {entries.map(([k, v]) => (
              <Fragment key={k}>
                <span className="t-text-muted">{k}</span>
                <span className="t-text-secondary truncate">{truncate(str(v) || JSON.stringify(v), 200)}</span>
              </Fragment>
            ))}
          </div>
        )
      }
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-3 rounded-xl t-bg-elevated p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="font-medium">Research Artifacts ({assetRecords.length})</div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSortNewestFirst((v) => !v)}
              className="rounded-md border t-border px-2 py-1 text-[11px] t-hoverable"
              title={sortNewestFirst ? 'Showing newest first' : 'Showing oldest first'}
            >
              {sortNewestFirst ? '↓ Newest' : '↑ Oldest'}
            </button>
            <button
              onClick={onExportInventory}
              className="rounded-md border t-border px-2 py-1 text-[11px] t-hoverable"
            >
              Export
            </button>
          </div>
        </div>
        <div className="mt-1 text-[11px] t-text-muted">
          Every piece of evidence, claim, decision, and analysis produced during the research session.
        </div>

        {/* Search */}
        <div className="mt-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by name, type, or content…"
            className="w-full rounded-lg border t-border t-bg-primary px-2.5 py-1.5 text-[11px] placeholder:t-text-muted focus:outline-none focus:ring-1 focus:ring-blue-500/40"
          />
        </div>

        {/* Type filter pills */}
        <div className="mt-2 flex flex-wrap gap-1">
          {assetTypeCounts.length === 0 ? (
            <span className="t-text-muted">No artifacts yet.</span>
          ) : assetTypeCounts.map(([type, count]) => {
            const active = activeTypeFilters.has(type)
            return (
              <button
                key={type}
                onClick={() => toggleTypeFilter(type)}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                  active
                    ? `${laneToneFromType(type)} font-medium`
                    : 't-border t-hoverable'
                }`}
              >
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${laneDotColor(type)}`} />
                {type} · {count}
              </button>
            )
          })}
        </div>

        {/* Filter status bar */}
        {isFiltered && (
          <div className="mt-2 flex items-center justify-between text-[11px] t-text-muted">
            <span>Showing {filteredAssets.length} of {assetRecords.length}</span>
            <button onClick={clearFilters} className="t-hoverable underline">
              Clear filters
            </button>
          </div>
        )}
      </div>

      {/* Asset list */}
      {filteredAssets.length === 0 ? (
        <div className="rounded-xl t-bg-elevated p-4 text-sm t-text-secondary">
          {assetRecords.length === 0 ? 'No artifacts produced yet.' : 'No artifacts match your filters.'}
        </div>
      ) : (
        <div className="space-y-2">
          {visibleAssets.map((asset) => {
            const isExpanded = expandedAssetId === asset.id
            const chain = isExpanded ? buildSupersedesChain(asset.id, assetMap) : []
            return (
              <div
                key={asset.id}
                className={`rounded-xl border p-3 transition-colors cursor-pointer ${
                  isExpanded ? laneToneFromType(asset.type) : 't-border hover:t-bg-elevated'
                }`}
                onClick={() => setExpandedAssetId(isExpanded ? null : asset.id)}
              >
                {/* Collapsed header — always visible */}
                <div className="flex items-start gap-2">
                  <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${laneDotColor(asset.type)}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate" title={asset.id}>
                      {friendlyAssetId(asset.id)}
                    </div>
                    <div className="mt-0.5 text-[11px] t-text-secondary">
                      {asset.type}
                      {' · '}
                      <span title="Which research cycle produced this artifact">Cycle {asset.createdByTurn}</span>
                      {' · '}
                      <span title="Retry number within this cycle (1 = first attempt)">Run {asset.createdByAttempt}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] t-text-muted">
                      {new Date(asset.createdAt).toLocaleString()}
                      {asset.supersedes && (
                        <span title={`Replaces: ${asset.supersedes}`}> · replaces {friendlyAssetId(asset.supersedes)}</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div
                    className="mt-3 border-t border-current/10 pt-3 space-y-3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Semantic payload */}
                    {renderPayload(asset)}

                    {/* Supersedes chain */}
                    {chain.length > 0 && (
                      <div className="text-[11px]">
                        <span className="t-text-muted">Supersedes: </span>
                        {chain.map((ancestor, i) => (
                          <span key={ancestor.id}>
                            {i > 0 && <span className="t-text-muted"> → </span>}
                            <button
                              onClick={() => navigateToAsset(ancestor.id)}
                              className="underline t-hoverable"
                              title={ancestor.id}
                            >
                              {friendlyAssetId(ancestor.id)}
                            </button>
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Raw JSON toggle */}
                    <div>
                      <button
                        onClick={() => setShowRawJson((v) => !v)}
                        className="text-[11px] underline t-hoverable t-text-muted"
                      >
                        {showRawJson ? 'Hide raw JSON' : 'Show raw JSON'}
                      </button>
                      {showRawJson && (
                        <pre className="mt-1 max-h-40 overflow-auto rounded-lg t-bg-elevated p-2 text-[11px] whitespace-pre-wrap break-all">
                          {JSON.stringify(asset.payload, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* Show more */}
          {remaining > 0 && (
            <button
              onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
              className="w-full rounded-xl border t-border p-2.5 text-[11px] t-text-secondary t-hoverable text-center"
            >
              Show more ({remaining} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  )
}
