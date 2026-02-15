import type {
  EvidenceGraphData,
  EvidenceGraphNode,
  AssetRecord,
  ClaimMatrixRow,
  LatestClaimEvidenceTable,
} from '@/lib/types'
import { friendlyAssetId } from '@/lib/formatters'

interface EvidenceTabProps {
  evidenceGraph: EvidenceGraphData
  selectedGraphNodeId: string | null
  selectedGraphNode: EvidenceGraphNode | null
  selectedGraphAsset: AssetRecord | null
  showSupersedesEdges: boolean
  latestClaimEvidenceTable: LatestClaimEvidenceTable | null
  matrixRows: ClaimMatrixRow[]
  onSelectGraphNode: (nodeId: string | null) => void
  onToggleSupersedesEdges: (value: boolean | ((prev: boolean) => boolean)) => void
  onExportClaimEvidenceTable: () => Promise<void>
}

const LANE_LABELS: Record<string, string> = {
  claim: 'Claims',
  link: 'Evidence Links',
  evidence: 'Evidence',
  decision: 'Decisions',
}

const LANE_DESCRIPTIONS: Record<string, string> = {
  claim: 'Assertions the research aims to prove or disprove',
  link: 'Connections between claims and their supporting evidence',
  evidence: 'Data, observations, and findings collected during research',
  decision: 'Judgments and rulings made about claims or direction',
}

export function EvidenceTab({
  evidenceGraph,
  selectedGraphNodeId,
  selectedGraphNode,
  selectedGraphAsset,
  showSupersedesEdges,
  latestClaimEvidenceTable,
  matrixRows,
  onSelectGraphNode,
  onToggleSupersedesEdges,
  onExportClaimEvidenceTable,
}: EvidenceTabProps) {
  const { graphW, graphH, nodeW, nodeH } = evidenceGraph

  return (
    <div>
      <div className="mb-3 rounded-xl t-bg-elevated p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="font-medium">Evidence Graph</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onToggleSupersedesEdges((v) => !v)}
              className="rounded-md border t-border px-2 py-1 text-[11px] t-hoverable"
            >
              {showSupersedesEdges ? 'Hide replacements' : 'Show replacements'}
            </button>
            <button
              onClick={onExportClaimEvidenceTable}
              className="rounded-md border t-border px-2 py-1 text-[11px] t-hoverable"
            >
              Export
            </button>
          </div>
        </div>
        <div className="mt-2 t-text-secondary">
          Claims {evidenceGraph.counts.claims}
          {' · '}
          Links {evidenceGraph.counts.links}
          {' · '}
          Evidence {evidenceGraph.counts.evidence}
          {' · '}
          Decisions {evidenceGraph.counts.decisions}
          {' · '}
          Connections {evidenceGraph.edges.length}
        </div>
        {/* Lane color legend */}
        <div className="mt-2 flex flex-wrap gap-3">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> Claims</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-sky-500" /> Evidence Links</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-violet-500" /> Evidence</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> Decisions</span>
        </div>
        {evidenceGraph.edges.length === 0 && evidenceGraph.nodes.length > 0 && (
          <div className="mt-2 rounded-lg border t-border px-2 py-1.5 t-text-muted">
            Artifacts exist but no Evidence Link assets have been created yet. Connections will appear once the researcher creates links between claims and supporting evidence.
          </div>
        )}
        {evidenceGraph.nodes.length === 0 ? (
          <div className="mt-2 t-text-muted">
            No evidence artifacts yet. The graph will populate as the research session produces claims, evidence, and links.
          </div>
        ) : (
          <div className="mt-3 overflow-auto rounded-xl border t-border t-graph-bg" style={{ maxHeight: '520px' }}>
            <div className="relative" style={{ width: graphW, height: graphH, minWidth: '100%' }}>
              {/* SVG edges layer */}
              <svg
                className="absolute inset-0"
                width={graphW}
                height={graphH}
                viewBox={`0 0 ${graphW} ${graphH}`}
                style={{ pointerEvents: 'none' }}
              >
                {evidenceGraph.edges
                  .filter((edge) => showSupersedesEdges || edge.kind !== 'supersedes')
                  .map((edge) => {
                    const from = evidenceGraph.nodeById.get(edge.from)
                    const to = evidenceGraph.nodeById.get(edge.to)
                    if (!from || !to) return null
                    const cx = (from.x + to.x) / 2
                    const path = `M ${from.x} ${from.y} C ${cx} ${from.y}, ${cx} ${to.y}, ${to.x} ${to.y}`
                    const stroke = edge.kind === 'claim_link'
                      ? '#2dd4bf'
                      : edge.kind === 'link_evidence'
                        ? '#38bdf8'
                        : '#f59e0b'
                    return (
                      <path
                        key={edge.id}
                        d={path}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={edge.kind === 'supersedes' ? 1 : 1.5}
                        strokeDasharray={edge.kind === 'supersedes' ? '4 4' : undefined}
                        opacity={edge.kind === 'supersedes' ? 0.5 : 0.7}
                      />
                    )
                  })}
              </svg>

              {/* Node layer */}
              {evidenceGraph.nodes.map((node) => {
                const tone = node.lane === 'claim'
                  ? 'border-emerald-400/50 bg-emerald-500/15 t-accent-emerald'
                  : node.lane === 'link'
                    ? 'border-sky-400/50 bg-sky-500/15 t-accent-sky'
                    : node.lane === 'evidence'
                      ? 'border-violet-400/50 bg-violet-500/15 t-accent-violet'
                      : 'border-amber-400/50 bg-amber-500/15 t-accent-amber'
                return (
                  <button
                    key={node.id}
                    onClick={() => onSelectGraphNode(node.id)}
                    title={`${node.id}\n${node.label}`}
                    style={{
                      position: 'absolute',
                      left: node.x - nodeW / 2,
                      top: node.y - nodeH / 2,
                      width: nodeW,
                      height: nodeH,
                    }}
                    className={`overflow-hidden rounded-lg border px-2 py-1 text-left text-[11px] ${tone} ${
                      selectedGraphNodeId === node.id ? 'ring-2 ring-white/60' : ''
                    }`}
                  >
                    <div className="truncate font-medium">{friendlyAssetId(node.id)}</div>
                    <div className="truncate opacity-90">{node.label}</div>
                    <div className="mt-0.5 truncate text-[9px] uppercase tracking-wide opacity-70">
                      {node.assetType}{node.external ? ' · ext' : ''}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {(selectedGraphNode || selectedGraphAsset) && (
        <div className="mb-3 rounded-xl border t-border p-3 text-xs">
          <div className="font-medium">Selected Artifact</div>
          {selectedGraphNode && (
            <div className="mt-2 space-y-1 t-text-secondary">
              <div className="font-medium" title={selectedGraphNode.id}>{friendlyAssetId(selectedGraphNode.id)}</div>
              <div>
                Category: {LANE_LABELS[selectedGraphNode.lane] ?? selectedGraphNode.lane}
                {' · '}
                Type: {selectedGraphNode.assetType}
                {selectedGraphNode.external ? ' · (referenced but not yet collected)' : ''}
              </div>
              <div className="t-text-muted">{selectedGraphNode.label}</div>
            </div>
          )}
          {selectedGraphAsset && (
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg t-bg-elevated p-2 text-[11px]">
              {JSON.stringify(selectedGraphAsset.payload, null, 2)}
            </pre>
          )}
        </div>
      )}

      <div className="mb-3 rounded-xl t-bg-elevated p-3 text-xs">
        <div className="font-medium">Latest Claim-Evidence Table</div>
        {latestClaimEvidenceTable ? (
          <div className="mt-2 space-y-1 t-text-secondary">
            <div>Asset: {friendlyAssetId(latestClaimEvidenceTable.assetId)} · Cycle {latestClaimEvidenceTable.createdByTurn} · {latestClaimEvidenceTable.rowCount} rows</div>
            <div>
              Primary: {latestClaimEvidenceTable.coveredPrimary}/{latestClaimEvidenceTable.assertedPrimary} covered
              {' · '}
              {latestClaimEvidenceTable.assertedPrimaryCoverage === null ? '-' : `${(latestClaimEvidenceTable.assertedPrimaryCoverage * 100).toFixed(0)}%`}
              {' · '}
              {latestClaimEvidenceTable.primaryPass ? 'Pass' : 'Fail'}
            </div>
            <div>
              Secondary: {latestClaimEvidenceTable.coveredSecondary}/{latestClaimEvidenceTable.assertedSecondary} covered
              {' · '}
              {latestClaimEvidenceTable.assertedSecondaryCoverage === null ? '-' : `${(latestClaimEvidenceTable.assertedSecondaryCoverage * 100).toFixed(0)}%`}
              {' · '}
              {latestClaimEvidenceTable.secondaryPass ? 'Pass' : 'Fail'}
            </div>
          </div>
        ) : (
          <div className="mt-2 t-text-muted">
            No persisted Claim-Evidence Table asset yet. Export will use a derived fallback snapshot.
          </div>
        )}
      </div>

      {matrixRows.length === 0 ? (
        <div className="rounded-xl t-bg-elevated p-4 text-sm t-text-secondary">
          No asserted claims yet. Promote claims to &quot;asserted&quot; to populate the matrix.
        </div>
      ) : (
        <div className="space-y-2">
          {matrixRows.map((row) => (
            <div
              key={row.id}
              className={`rounded-xl border p-3 ${row.hasPrimaryGap ? 'border-rose-500/40 bg-rose-500/5' : 't-border'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium" title={row.id}>{friendlyAssetId(row.id)}</div>
                <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide">
                  <span className="rounded-full border t-border px-2 py-0.5">{row.tier}</span>
                  <span className="rounded-full border t-border px-2 py-0.5">{row.coverageStatus}</span>
                </div>
              </div>
              <div className="mt-1 text-xs t-text-secondary">{row.summary}</div>
              <div className="mt-2 text-[11px] t-text-muted">
                Countable: {row.countableIds.length}
                {' · '}
                Cite-only: {row.citeOnlyIds.length}
                {' · '}
                Needs revalidation: {row.needsRevalidateIds.length}
              </div>
              {row.hasPrimaryGap && (
                <div className="mt-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] t-accent-rose">
                  Primary asserted claim has no countable evidence link.
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
