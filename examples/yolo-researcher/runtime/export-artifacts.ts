import type { AssetRecord, SessionPersistedState } from './types.js'

export type ClaimEvidenceCoverageStatus = 'countable' | 'cite_only' | 'needs_revalidate' | 'empty'

export interface ClaimEvidenceExportRow {
  claimId: string
  tier: string
  state: string
  summary: string
  coverageStatus: ClaimEvidenceCoverageStatus
  countableEvidenceIds: string[]
  citeOnlyEvidenceIds: string[]
  needsRevalidateEvidenceIds: string[]
}

export interface ClaimEvidenceTableExport {
  sessionId: string
  state: SessionPersistedState['state']
  currentTurn: number
  activeStage: SessionPersistedState['activeStage']
  generatedAt: string
  source: 'ClaimEvidenceTable' | 'derived_fallback'
  assetId: string | null
  createdByTurn: number | null
  sourceManifestId: string | null
  coverage: Record<string, unknown> | null
  completeness: Record<string, unknown> | null
  rows: unknown[]
}

export interface AssetInventoryExport {
  sessionId: string
  state: SessionPersistedState['state']
  currentTurn: number
  generatedAt: string
  assetCount: number
  typeCounts: Array<{ type: string; count: number }>
  assets: Array<{
    id: string
    type: string
    createdAt: string
    createdByTurn: number
    createdByAttempt: number
    supersedes: string | null
  }>
}

export interface FinalBundleManifest {
  sessionId: string
  state: SessionPersistedState['state']
  currentTurn: number
  generatedAt: string
  files: {
    sessionSummary: string
    claimEvidenceTable: string
    assetInventory: string
  }
}

function collectStringIds(value: unknown, sink: Set<string>): void {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (normalized) sink.add(normalized)
    return
  }
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item !== 'string') continue
    const normalized = item.trim()
    if (normalized) sink.add(normalized)
  }
}

export function buildClaimEvidenceRowsFromAssets(assets: AssetRecord[]): ClaimEvidenceExportRow[] {
  const linkedByClaim = new Map<string, {
    countable: Set<string>
    citeOnly: Set<string>
    needsRevalidate: Set<string>
  }>()

  for (const asset of assets) {
    if (asset.type !== 'EvidenceLink') continue
    const payload = asset.payload as Record<string, unknown>
    const claimIds = new Set<string>()
    collectStringIds(payload.claimId, claimIds)
    collectStringIds(payload.claimIds, claimIds)
    collectStringIds(payload.targetClaimId, claimIds)
    collectStringIds(payload.targetClaimIds, claimIds)
    if (claimIds.size === 0) continue

    const policyRaw = typeof payload.countingPolicy === 'string'
      ? payload.countingPolicy.trim().toLowerCase()
      : ''
    const policy: ClaimEvidenceCoverageStatus = policyRaw === 'cite_only' || policyRaw === 'needs_revalidate'
      ? policyRaw
      : 'countable'

    for (const claimId of claimIds) {
      const bucket = linkedByClaim.get(claimId) ?? {
        countable: new Set<string>(),
        citeOnly: new Set<string>(),
        needsRevalidate: new Set<string>()
      }
      if (policy === 'countable') bucket.countable.add(asset.id)
      else if (policy === 'cite_only') bucket.citeOnly.add(asset.id)
      else bucket.needsRevalidate.add(asset.id)
      linkedByClaim.set(claimId, bucket)
    }
  }

  const tierRank: Record<string, number> = { primary: 0, secondary: 1, exploratory: 2 }
  return assets
    .filter((asset) => asset.type === 'Claim')
    .map((asset) => {
      const payload = asset.payload as Record<string, unknown>
      const state = typeof payload.state === 'string' ? payload.state : ''
      if (state !== 'asserted') return null
      const tier = typeof payload.tier === 'string' ? payload.tier : 'secondary'
      const linked = linkedByClaim.get(asset.id) ?? {
        countable: new Set<string>(),
        citeOnly: new Set<string>(),
        needsRevalidate: new Set<string>()
      }
      const countableEvidenceIds = Array.from(linked.countable).sort()
      const citeOnlyEvidenceIds = Array.from(linked.citeOnly).sort()
      const needsRevalidateEvidenceIds = Array.from(linked.needsRevalidate).sort()
      const summary =
        (typeof payload.statement === 'string' && payload.statement)
        || (typeof payload.claim === 'string' && payload.claim)
        || (typeof payload.text === 'string' && payload.text)
        || (typeof payload.title === 'string' && payload.title)
        || 'No claim summary in payload.'
      const coverageStatus: ClaimEvidenceCoverageStatus = countableEvidenceIds.length > 0
        ? 'countable'
        : citeOnlyEvidenceIds.length > 0
          ? 'cite_only'
          : needsRevalidateEvidenceIds.length > 0
            ? 'needs_revalidate'
            : 'empty'
      return {
        claimId: asset.id,
        tier,
        state,
        summary,
        coverageStatus,
        countableEvidenceIds,
        citeOnlyEvidenceIds,
        needsRevalidateEvidenceIds
      }
    })
    .filter((row): row is ClaimEvidenceExportRow => row !== null)
    .sort((a, b) => {
      const rankA = tierRank[a.tier] ?? 99
      const rankB = tierRank[b.tier] ?? 99
      if (rankA !== rankB) return rankA - rankB
      return a.claimId.localeCompare(b.claimId)
    })
}

export function computeCoverageFromClaimEvidenceRows(rows: ClaimEvidenceExportRow[]): {
  assertedPrimary: number
  coveredPrimary: number
  assertedPrimaryCoverage: number
  assertedSecondary: number
  coveredSecondary: number
  assertedSecondaryCoverage: number
} {
  let assertedPrimary = 0
  let coveredPrimary = 0
  let assertedSecondary = 0
  let coveredSecondary = 0

  for (const row of rows) {
    if (row.tier === 'primary') {
      assertedPrimary += 1
      if (row.countableEvidenceIds.length > 0) coveredPrimary += 1
    } else if (row.tier === 'secondary') {
      assertedSecondary += 1
      if (row.countableEvidenceIds.length > 0) coveredSecondary += 1
    }
  }

  return {
    assertedPrimary,
    coveredPrimary,
    assertedPrimaryCoverage: assertedPrimary === 0 ? 1 : coveredPrimary / assertedPrimary,
    assertedSecondary,
    coveredSecondary,
    assertedSecondaryCoverage: assertedSecondary === 0 ? 1 : coveredSecondary / assertedSecondary
  }
}

export function buildClaimEvidenceTableExport(
  snapshot: SessionPersistedState,
  assets: AssetRecord[],
  generatedAt: string = new Date().toISOString()
): ClaimEvidenceTableExport {
  const latestTable = assets
    .filter((asset) => asset.type === 'ClaimEvidenceTable')
    .sort((a, b) => a.createdByTurn - b.createdByTurn || a.id.localeCompare(b.id))
    .at(-1)

  if (latestTable) {
    const payload = latestTable.payload as Record<string, unknown>
    return {
      sessionId: snapshot.sessionId,
      state: snapshot.state,
      currentTurn: snapshot.currentTurn,
      activeStage: snapshot.activeStage,
      generatedAt,
      source: 'ClaimEvidenceTable',
      assetId: latestTable.id,
      createdByTurn: latestTable.createdByTurn,
      sourceManifestId: typeof payload.sourceManifestId === 'string'
        ? payload.sourceManifestId
        : null,
      coverage: (payload.coverage as Record<string, unknown>) ?? null,
      completeness: (payload.completeness as Record<string, unknown>) ?? null,
      rows: Array.isArray(payload.rows) ? payload.rows : []
    }
  }

  const rows = buildClaimEvidenceRowsFromAssets(assets)
  const coverage = computeCoverageFromClaimEvidenceRows(rows)
  return {
    sessionId: snapshot.sessionId,
    state: snapshot.state,
    currentTurn: snapshot.currentTurn,
    activeStage: snapshot.activeStage,
    generatedAt,
    source: 'derived_fallback',
    assetId: null,
    createdByTurn: null,
    sourceManifestId: null,
    coverage,
    completeness: {
      assertedPrimaryCoveragePass: coverage.assertedPrimaryCoverage >= 1,
      assertedSecondaryCoveragePass: coverage.assertedSecondaryCoverage >= 0.85
    },
    rows
  }
}

export function buildAssetInventoryExport(
  snapshot: SessionPersistedState,
  assets: AssetRecord[],
  generatedAt: string = new Date().toISOString()
): AssetInventoryExport {
  const byType = new Map<string, number>()
  for (const asset of assets) {
    byType.set(asset.type, (byType.get(asset.type) ?? 0) + 1)
  }
  const typeCounts = Array.from(byType.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))

  return {
    sessionId: snapshot.sessionId,
    state: snapshot.state,
    currentTurn: snapshot.currentTurn,
    generatedAt,
    assetCount: assets.length,
    typeCounts,
    assets: assets.map((asset) => ({
      id: asset.id,
      type: asset.type,
      createdAt: asset.createdAt,
      createdByTurn: asset.createdByTurn,
      createdByAttempt: asset.createdByAttempt,
      supersedes: asset.supersedes ?? null
    }))
  }
}

export function buildFinalBundleManifest(
  snapshot: SessionPersistedState,
  files: {
    sessionSummary: string
    claimEvidenceTable: string
    assetInventory: string
  },
  generatedAt: string = new Date().toISOString()
): FinalBundleManifest {
  return {
    sessionId: snapshot.sessionId,
    state: snapshot.state,
    currentTurn: snapshot.currentTurn,
    generatedAt,
    files
  }
}
