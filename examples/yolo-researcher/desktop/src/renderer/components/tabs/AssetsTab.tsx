import { useMemo } from 'react'
import type { AssetRecord } from '@/lib/types'
import { friendlyAssetId } from '@/lib/formatters'

interface AssetsTabProps {
  assetRecords: AssetRecord[]
  onExportInventory: () => Promise<void>
}

export function AssetsTab({ assetRecords, onExportInventory }: AssetsTabProps) {
  const assetTypeCounts = useMemo(() => {
    const grouped = new Map<string, number>()
    for (const asset of assetRecords) {
      grouped.set(asset.type, (grouped.get(asset.type) ?? 0) + 1)
    }
    return Array.from(grouped.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [assetRecords])

  return (
    <div>
      <div className="mb-3 rounded-xl t-bg-elevated p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="font-medium">Research Artifacts ({assetRecords.length})</div>
          <button
            onClick={onExportInventory}
            className="rounded-md border t-border px-2 py-1 text-[11px] t-hoverable"
          >
            Export Inventory
          </button>
        </div>
        <div className="mt-1 text-[11px] t-text-muted">
          Every piece of evidence, claim, decision, and analysis produced during the research session.
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {assetTypeCounts.length === 0 ? (
            <span className="t-text-muted">No artifacts yet.</span>
          ) : assetTypeCounts.map(([type, count]) => (
            <span key={type} className="rounded-md border t-border px-2 py-0.5">
              {type} · {count}
            </span>
          ))}
        </div>
      </div>
      {assetRecords.length === 0 ? (
        <div className="rounded-xl t-bg-elevated p-4 text-sm t-text-secondary">No artifacts produced yet.</div>
      ) : (
        <div className="space-y-2">
          {[...assetRecords].reverse().slice(0, 120).map((asset) => (
            <div key={asset.id} className="rounded-xl border t-border p-3">
              <div className="text-xs font-medium" title={asset.id}>{friendlyAssetId(asset.id)}</div>
              <div className="mt-1 text-[11px] t-text-secondary">
                {asset.type}
                {' · '}
                <span title="Which research cycle produced this artifact">Cycle {asset.createdByTurn}</span>
                {' · '}
                <span title="Retry number within this cycle (1 = first attempt)">Run {asset.createdByAttempt}</span>
              </div>
              <div className="mt-1 text-[11px] t-text-muted">
                {new Date(asset.createdAt).toLocaleString()}
                {asset.supersedes ? (
                  <span title={`Replaces: ${asset.supersedes}`}> · replaces {friendlyAssetId(asset.supersedes)}</span>
                ) : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
