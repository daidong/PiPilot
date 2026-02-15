import { describe, expect, it } from 'vitest'

import {
  buildAssetInventoryExport,
  buildClaimEvidenceTableExport,
  buildFinalBundleManifest,
  type AssetRecord,
  type SessionPersistedState
} from '../../examples/yolo-researcher/index.js'

function buildSnapshot(): SessionPersistedState {
  return {
    sessionId: 'sid-export',
    goal: 'export test',
    phase: 'P2',
    state: 'COMPLETE',
    createdAt: '2026-02-14T00:00:00.000Z',
    updatedAt: '2026-02-14T00:00:00.000Z',
    currentTurn: 5,
    currentAttempt: 1,
    nonProgressTurns: 0,
    activeStage: 'S5',
    activeBranchId: 'B-001',
    activeNodeId: 'N-005',
    budgetUsed: {
      tokens: 1000,
      costUsd: 1.23,
      turns: 5
    }
  }
}

describe('export artifact builders', () => {
  it('uses latest ClaimEvidenceTable asset when available', () => {
    const snapshot = buildSnapshot()
    const assets: AssetRecord[] = [
      {
        id: 'ClaimEvidenceTable-t004-a1-001',
        type: 'ClaimEvidenceTable',
        payload: {
          sourceManifestId: 'manifest-t004-a1',
          coverage: { assertedPrimary: 1, coveredPrimary: 1 },
          completeness: { assertedPrimaryCoveragePass: true, assertedSecondaryCoveragePass: true },
          rows: [{ claimId: 'Claim-t004-a1-001', coverageStatus: 'countable' }]
        },
        createdAt: '2026-02-14T00:00:00.000Z',
        createdByTurn: 4,
        createdByAttempt: 1
      },
      {
        id: 'ClaimEvidenceTable-t005-a1-001',
        type: 'ClaimEvidenceTable',
        payload: {
          sourceManifestId: 'manifest-t005-a1',
          coverage: { assertedPrimary: 2, coveredPrimary: 2 },
          completeness: { assertedPrimaryCoveragePass: true, assertedSecondaryCoveragePass: false },
          rows: [{ claimId: 'Claim-t005-a1-001', coverageStatus: 'countable' }]
        },
        createdAt: '2026-02-14T00:00:01.000Z',
        createdByTurn: 5,
        createdByAttempt: 1
      }
    ]

    const exported = buildClaimEvidenceTableExport(snapshot, assets, '2026-02-14T01:00:00.000Z')
    expect(exported.source).toBe('ClaimEvidenceTable')
    expect(exported.assetId).toBe('ClaimEvidenceTable-t005-a1-001')
    expect(exported.sourceManifestId).toBe('manifest-t005-a1')
    expect(exported.generatedAt).toBe('2026-02-14T01:00:00.000Z')
    expect(Array.isArray(exported.rows)).toBe(true)
    expect(exported.rows).toHaveLength(1)
  })

  it('falls back to derived claim coverage rows when no ClaimEvidenceTable exists', () => {
    const snapshot = buildSnapshot()
    const assets: AssetRecord[] = [
      {
        id: 'Claim-t001-a1-001',
        type: 'Claim',
        payload: { state: 'asserted', tier: 'primary', statement: 'Primary claim' },
        createdAt: '2026-02-14T00:00:00.000Z',
        createdByTurn: 1,
        createdByAttempt: 1
      },
      {
        id: 'Claim-t001-a1-002',
        type: 'Claim',
        payload: { state: 'asserted', tier: 'secondary', statement: 'Secondary claim' },
        createdAt: '2026-02-14T00:00:00.000Z',
        createdByTurn: 1,
        createdByAttempt: 1
      },
      {
        id: 'EvidenceLink-t001-a1-003',
        type: 'EvidenceLink',
        payload: {
          claimId: 'Claim-t001-a1-001',
          countingPolicy: 'countable'
        },
        createdAt: '2026-02-14T00:00:00.000Z',
        createdByTurn: 1,
        createdByAttempt: 1
      },
      {
        id: 'EvidenceLink-t001-a1-004',
        type: 'EvidenceLink',
        payload: {
          claimId: 'Claim-t001-a1-002',
          countingPolicy: 'cite_only'
        },
        createdAt: '2026-02-14T00:00:00.000Z',
        createdByTurn: 1,
        createdByAttempt: 1
      }
    ]

    const exported = buildClaimEvidenceTableExport(snapshot, assets, '2026-02-14T01:00:00.000Z')
    expect(exported.source).toBe('derived_fallback')
    expect(exported.assetId).toBeNull()
    expect((exported.coverage as { assertedPrimary: number }).assertedPrimary).toBe(1)
    expect((exported.coverage as { coveredPrimary: number }).coveredPrimary).toBe(1)
    expect((exported.coverage as { assertedSecondary: number }).assertedSecondary).toBe(1)
    expect((exported.coverage as { coveredSecondary: number }).coveredSecondary).toBe(0)
    expect((exported.completeness as { assertedPrimaryCoveragePass: boolean }).assertedPrimaryCoveragePass).toBe(true)
    expect((exported.completeness as { assertedSecondaryCoveragePass: boolean }).assertedSecondaryCoveragePass).toBe(false)
    expect(exported.rows).toHaveLength(2)
  })

  it('builds asset inventory export and final bundle manifest', () => {
    const snapshot = buildSnapshot()
    const assets: AssetRecord[] = [
      {
        id: 'Claim-t001-a1-001',
        type: 'Claim',
        payload: {},
        createdAt: '2026-02-14T00:00:00.000Z',
        createdByTurn: 1,
        createdByAttempt: 1
      },
      {
        id: 'EvidenceLink-t001-a1-002',
        type: 'EvidenceLink',
        payload: {},
        createdAt: '2026-02-14T00:00:00.000Z',
        createdByTurn: 1,
        createdByAttempt: 1
      },
      {
        id: 'EvidenceLink-t002-a1-001',
        type: 'EvidenceLink',
        payload: {},
        createdAt: '2026-02-14T00:00:01.000Z',
        createdByTurn: 2,
        createdByAttempt: 1,
        supersedes: 'EvidenceLink-t001-a1-002'
      }
    ]

    const inventory = buildAssetInventoryExport(snapshot, assets, '2026-02-14T02:00:00.000Z')
    expect(inventory.generatedAt).toBe('2026-02-14T02:00:00.000Z')
    expect(inventory.assetCount).toBe(3)
    expect(inventory.typeCounts[0]).toEqual({ type: 'EvidenceLink', count: 2 })

    const manifest = buildFinalBundleManifest(
      snapshot,
      {
        sessionSummary: '/tmp/summary.json',
        claimEvidenceTable: '/tmp/claim-evidence.json',
        assetInventory: '/tmp/inventory.json'
      },
      '2026-02-14T03:00:00.000Z'
    )
    expect(manifest.generatedAt).toBe('2026-02-14T03:00:00.000Z')
    expect(manifest.files.sessionSummary).toBe('/tmp/summary.json')
    expect(manifest.files.claimEvidenceTable).toBe('/tmp/claim-evidence.json')
    expect(manifest.files.assetInventory).toBe('/tmp/inventory.json')
  })
})
