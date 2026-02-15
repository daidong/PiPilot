import { describe, expect, it } from 'vitest'

import { StructuralGateEngine } from '../../examples/yolo-researcher/index.js'
import type { SnapshotManifest } from '../../examples/yolo-researcher/index.js'

describe('structural gate engine (P1+)', () => {
  it('is deterministic for identical snapshot manifests', () => {
    const engine = new StructuralGateEngine()
    const manifest: SnapshotManifest = {
      id: 'manifest-001',
      stage: 'S2',
      assetIds: ['Claim-001', 'EvidenceLink-001', 'RiskRegister-001'],
      evidenceLinkIds: ['EvidenceLink-001'],
      branchNodeId: 'N-010',
      planSnapshotHash: 'abc',
      generatedAtTurn: 3
    }

    const first = engine.evaluate(manifest)
    const second = engine.evaluate(manifest)
    expect(second).toEqual(first)
    expect(first.passed).toBe(true)
  })

  it('fails S2 manifest without claim/evidence and reports hard blockers', () => {
    const engine = new StructuralGateEngine()
    const manifest: SnapshotManifest = {
      id: 'manifest-002',
      stage: 'S2',
      assetIds: ['RiskRegister-010'],
      evidenceLinkIds: [],
      branchNodeId: 'N-011',
      planSnapshotHash: 'def',
      generatedAtTurn: 4
    }

    const result = engine.evaluate(manifest)
    expect(result.passed).toBe(false)
    expect(result.hardBlockers.map((item) => item.label)).toContain('claim_without_direct_evidence')
    expect(result.hardBlockers.map((item) => item.label)).toContain('reproducibility_gap')
  })

  it('fails S5 when asserted primary claim coverage is incomplete', () => {
    const engine = new StructuralGateEngine()
    const manifest: SnapshotManifest = {
      id: 'manifest-003',
      stage: 'S5',
      assetIds: ['Claim-001', 'EvidenceLink-001', 'RiskRegister-001'],
      evidenceLinkIds: ['EvidenceLink-001'],
      claimCoverage: {
        assertedPrimary: 2,
        assertedSecondary: 1,
        coveredPrimary: 1,
        coveredSecondary: 1
      },
      reproducibility: {
        keyRunRecordCount: 1,
        keyRunRecordWithCompleteTripleCount: 1,
        missingRunRecordRefs: [],
        runRecordsMissingTriple: []
      },
      branchNodeId: 'N-012',
      planSnapshotHash: 'ghi',
      generatedAtTurn: 5
    }

    const result = engine.evaluate(manifest)
    expect(result.passed).toBe(false)
    expect(result.structuralChecks.some((check) => check.name === 'asserted_primary_coverage' && check.passed === false)).toBe(true)
    expect(result.hardBlockers.map((item) => item.label)).toContain('claim_without_direct_evidence')
  })

  it('fails S5 when asserted claims exist but no claim-freeze Decision is recorded', () => {
    const engine = new StructuralGateEngine()
    const manifest: SnapshotManifest = {
      id: 'manifest-004',
      stage: 'S5',
      assetIds: ['Claim-001', 'Claim-002', 'EvidenceLink-001'],
      evidenceLinkIds: ['EvidenceLink-001'],
      claimCoverage: {
        assertedPrimary: 1,
        assertedSecondary: 1,
        coveredPrimary: 1,
        coveredSecondary: 1
      },
      claimGovernance: {
        assertedClaims: 2,
        claimFreezeDecisionCount: 0
      },
      reproducibility: {
        keyRunRecordCount: 1,
        keyRunRecordWithCompleteTripleCount: 1,
        missingRunRecordRefs: [],
        runRecordsMissingTriple: []
      },
      branchNodeId: 'N-013',
      planSnapshotHash: 'jkl',
      generatedAtTurn: 6
    }

    const result = engine.evaluate(manifest)
    expect(result.passed).toBe(false)
    expect(
      result.structuralChecks.some(
        (check) => check.name === 'asserted_claim_freeze_decision_presence' && check.passed === false
      )
    ).toBe(true)
    expect(result.hardBlockers.map((item) => item.label)).toContain('reproducibility_gap')
  })

  it('passes S5 claim governance check when claim-freeze Decision exists', () => {
    const engine = new StructuralGateEngine()
    const manifest: SnapshotManifest = {
      id: 'manifest-005',
      stage: 'S5',
      assetIds: ['Claim-001', 'EvidenceLink-001', 'Decision-001'],
      evidenceLinkIds: ['EvidenceLink-001'],
      claimCoverage: {
        assertedPrimary: 1,
        assertedSecondary: 0,
        coveredPrimary: 1,
        coveredSecondary: 0
      },
      claimGovernance: {
        assertedClaims: 1,
        claimFreezeDecisionCount: 1
      },
      claimDecisionBinding: {
        assertedClaimCount: 1,
        assertedClaimWithFreezeRefCount: 1,
        missingFreezeRefClaimIds: []
      },
      reproducibility: {
        keyRunRecordCount: 1,
        keyRunRecordWithCompleteTripleCount: 1,
        missingRunRecordRefs: [],
        runRecordsMissingTriple: []
      },
      branchNodeId: 'N-014',
      planSnapshotHash: 'mno',
      generatedAtTurn: 7
    }

    const result = engine.evaluate(manifest)
    const claimFreezeCheck = result.structuralChecks.find(
      (check) => check.name === 'asserted_claim_freeze_decision_presence'
    )
    expect(claimFreezeCheck?.passed).toBe(true)
  })

  it('fails S5 when claim-freeze decision does not bind to asserted claim ids', () => {
    const engine = new StructuralGateEngine()
    const manifest: SnapshotManifest = {
      id: 'manifest-005b',
      stage: 'S5',
      assetIds: ['Claim-001', 'EvidenceLink-001', 'Decision-001'],
      evidenceLinkIds: ['EvidenceLink-001'],
      claimCoverage: {
        assertedPrimary: 1,
        assertedSecondary: 0,
        coveredPrimary: 1,
        coveredSecondary: 0
      },
      claimGovernance: {
        assertedClaims: 1,
        claimFreezeDecisionCount: 1
      },
      claimDecisionBinding: {
        assertedClaimCount: 1,
        assertedClaimWithFreezeRefCount: 0,
        missingFreezeRefClaimIds: ['Claim-001']
      },
      reproducibility: {
        keyRunRecordCount: 1,
        keyRunRecordWithCompleteTripleCount: 1,
        missingRunRecordRefs: [],
        runRecordsMissingTriple: []
      },
      branchNodeId: 'N-014b',
      planSnapshotHash: 'mnp',
      generatedAtTurn: 7
    }

    const result = engine.evaluate(manifest)
    expect(result.passed).toBe(false)
    expect(
      result.structuralChecks.some(
        (check) => check.name === 'asserted_claim_freeze_decision_binding' && check.passed === false
      )
    ).toBe(true)
    expect(result.hardBlockers.map((item) => item.label)).toContain('reproducibility_gap')
  })

  it('fails S4 when key run reproducibility triple is incomplete', () => {
    const engine = new StructuralGateEngine()
    const manifest: SnapshotManifest = {
      id: 'manifest-006',
      stage: 'S4',
      assetIds: ['Claim-001', 'EvidenceLink-001', 'RunRecord-001'],
      evidenceLinkIds: ['EvidenceLink-001'],
      reproducibility: {
        keyRunRecordCount: 1,
        keyRunRecordWithCompleteTripleCount: 0,
        missingRunRecordRefs: [],
        runRecordsMissingTriple: ['RunRecord-001']
      },
      branchNodeId: 'N-015',
      planSnapshotHash: 'pqr',
      generatedAtTurn: 8
    }

    const result = engine.evaluate(manifest)
    expect(result.passed).toBe(false)
    expect(
      result.structuralChecks.some(
        (check) => check.name === 'key_run_reproducibility_triple_complete' && check.passed === false
      )
    ).toBe(true)
    expect(result.hardBlockers.map((item) => item.label)).toContain('reproducibility_gap')
  })

  it('fails S4 when invalid cross-branch countable links are present', () => {
    const engine = new StructuralGateEngine()
    const manifest: SnapshotManifest = {
      id: 'manifest-007',
      stage: 'S4',
      assetIds: ['Claim-001', 'EvidenceLink-001', 'RunRecord-001'],
      evidenceLinkIds: ['EvidenceLink-001'],
      evidencePolicy: {
        crossBranchCountableLinkIds: ['EvidenceLink-001'],
        keyRunMissingParityContractLinkIds: [],
        invalidCountableLinkIds: ['EvidenceLink-001']
      },
      reproducibility: {
        keyRunRecordCount: 1,
        keyRunRecordWithCompleteTripleCount: 1,
        missingRunRecordRefs: [],
        runRecordsMissingTriple: []
      },
      branchNodeId: 'N-016',
      planSnapshotHash: 'stu',
      generatedAtTurn: 9
    }

    const result = engine.evaluate(manifest)
    expect(result.passed).toBe(false)
    expect(
      result.structuralChecks.some(
        (check) => check.name === 'countable_evidence_policy_contract' && check.passed === false
      )
    ).toBe(true)
    expect(result.hardBlockers.map((item) => item.label)).toContain('parity_violation_unresolved')
  })

  it('fails S4 when asserted claim has no claim-freeze decision binding', () => {
    const engine = new StructuralGateEngine()
    const manifest: SnapshotManifest = {
      id: 'manifest-007b',
      stage: 'S4',
      assetIds: ['Claim-001', 'EvidenceLink-001', 'Decision-001'],
      evidenceLinkIds: ['EvidenceLink-001'],
      claimDecisionBinding: {
        assertedClaimCount: 1,
        assertedClaimWithFreezeRefCount: 0,
        missingFreezeRefClaimIds: ['Claim-001']
      },
      reproducibility: {
        keyRunRecordCount: 0,
        keyRunRecordWithCompleteTripleCount: 0,
        missingRunRecordRefs: [],
        runRecordsMissingTriple: []
      },
      branchNodeId: 'N-016b',
      planSnapshotHash: 'stv',
      generatedAtTurn: 9
    }

    const result = engine.evaluate(manifest)
    expect(result.passed).toBe(false)
    expect(
      result.structuralChecks.some(
        (check) => check.name === 'asserted_claim_freeze_decision_binding' && check.passed === false
      )
    ).toBe(true)
    expect(result.hardBlockers.map((item) => item.label)).toContain('reproducibility_gap')
  })

  it('fails S2 when causality-required claims only have correlation evidence', () => {
    const engine = new StructuralGateEngine()
    const manifest: SnapshotManifest = {
      id: 'manifest-008',
      stage: 'S2',
      assetIds: ['Claim-001', 'EvidenceLink-001'],
      evidenceLinkIds: ['EvidenceLink-001'],
      causality: {
        requiredClaims: 1,
        satisfiedClaims: 0,
        interventionLinkCount: 0,
        counterfactualLinkCount: 0,
        correlationOnlyLinkCount: 1,
        missingClaimIds: ['Claim-001']
      },
      branchNodeId: 'N-017',
      planSnapshotHash: 'vwx',
      generatedAtTurn: 10
    }

    const result = engine.evaluate(manifest)
    expect(result.passed).toBe(false)
    expect(
      result.structuralChecks.some(
        (check) => check.name === 'causality_evidence_minimum' && check.passed === false
      )
    ).toBe(true)
    expect(result.hardBlockers.map((item) => item.label)).toContain('causality_gap')
  })

  it('fails S4 when asserted claim misses required evidence kinds', () => {
    const engine = new StructuralGateEngine()
    const manifest: SnapshotManifest = {
      id: 'manifest-009',
      stage: 'S4',
      assetIds: ['Claim-001', 'EvidenceLink-001'],
      evidenceLinkIds: ['EvidenceLink-001'],
      directEvidence: {
        requiredClaims: 1,
        satisfiedClaims: 0,
        missingClaimIds: ['Claim-001']
      },
      branchNodeId: 'N-018',
      planSnapshotHash: 'yz0',
      generatedAtTurn: 11
    }

    const result = engine.evaluate(manifest)
    expect(result.passed).toBe(false)
    expect(
      result.structuralChecks.some(
        (check) => check.name === 'required_evidence_kind_mapping' && check.passed === false
      )
    ).toBe(true)
    expect(result.hardBlockers.map((item) => item.label)).toContain('claim_without_direct_evidence')
  })
})
