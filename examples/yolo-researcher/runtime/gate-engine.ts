import type { GateEngine, GateResult, SnapshotManifest } from './types.js'

export interface StubGateEngineOptions {
  forceFail?: boolean
  forcedHardBlockerLabel?: string
}

export class StubGateEngine implements GateEngine {
  private readonly forceFail: boolean
  private readonly forcedHardBlockerLabel: string

  constructor(options: StubGateEngineOptions = {}) {
    this.forceFail = options.forceFail ?? false
    this.forcedHardBlockerLabel = options.forcedHardBlockerLabel ?? 'forced_fail_for_test'
  }

  evaluate(manifest: SnapshotManifest): GateResult {
    if (this.forceFail) {
      return {
        stage: manifest.stage,
        passed: false,
        structuralChecks: [{ name: 'stub_forced_fail', passed: false, detail: 'forced fail mode enabled' }],
        hardBlockers: [{ label: this.forcedHardBlockerLabel, assetRefs: [] }],
        advisoryNotes: ['StubGateEngine is in force-fail mode.']
      }
    }

    return {
      stage: manifest.stage,
      passed: true,
      structuralChecks: [{ name: 'stub_default_pass', passed: true }],
      hardBlockers: [],
      advisoryNotes: ['StubGateEngine default pass path.']
    }
  }
}

function assetTypeFromId(assetId: string): string {
  const index = assetId.indexOf('-')
  if (index <= 0) return assetId
  return assetId.slice(0, index)
}

function stageRequiresClaims(stage: SnapshotManifest['stage']): boolean {
  return stage === 'S2' || stage === 'S3' || stage === 'S4' || stage === 'S5'
}

function stageRequiresEvidenceLinks(stage: SnapshotManifest['stage']): boolean {
  return stage === 'S2' || stage === 'S4' || stage === 'S5'
}

function stageRequiresReproducibilityTriple(stage: SnapshotManifest['stage']): boolean {
  return stage === 'S4' || stage === 'S5'
}

function stageRequiresCausalityEvidence(stage: SnapshotManifest['stage']): boolean {
  return stage === 'S2' || stage === 'S3'
}

function stageRequiresClaimDecisionBinding(stage: SnapshotManifest['stage']): boolean {
  return stage === 'S4' || stage === 'S5'
}

function stageRequiresDirectEvidenceMapping(stage: SnapshotManifest['stage']): boolean {
  return stage === 'S4' || stage === 'S5'
}

function stageRequiresExecutableExperimentRequest(stage: SnapshotManifest['stage']): boolean {
  // Lean v2 keeps hard gates minimal and avoids forcing request completeness too early.
  return stage === 'S3' || stage === 'S4'
}

function stageRequiresBoundResultInsight(stage: SnapshotManifest['stage']): boolean {
  // Final bound-insight requirement is enforced at closure stage only.
  return stage === 'S5'
}

function stageRequiresLiteratureEvidence(stage: SnapshotManifest['stage']): boolean {
  // Literature review must exist before advancing beyond S1.
  // S2+ stages rely on prior-art awareness for experiment design and analysis.
  return stage === 'S2' || stage === 'S3' || stage === 'S4' || stage === 'S5'
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1
  return numerator / denominator
}

export class StructuralGateEngine implements GateEngine {
  evaluate(manifest: SnapshotManifest): GateResult {
    const uniqueAssetIds = new Set(manifest.assetIds)
    const hasDuplicateAssetIds = uniqueAssetIds.size !== manifest.assetIds.length
    const danglingEvidenceLinkIds = manifest.evidenceLinkIds.filter((id) => !uniqueAssetIds.has(id))

    const typeCounts = new Map<string, number>()
    for (const assetId of manifest.assetIds) {
      const type = assetTypeFromId(assetId)
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1)
    }

    const claimCount = typeCounts.get('Claim') ?? 0
    const evidenceCount = manifest.evidenceLinkIds.length
    const assertedClaims = manifest.claimGovernance?.assertedClaims
      ?? ((manifest.claimCoverage?.assertedPrimary ?? 0) + (manifest.claimCoverage?.assertedSecondary ?? 0))
    const claimFreezeDecisionCount = manifest.claimGovernance?.claimFreezeDecisionCount ?? 0
    const assertedClaimCount = manifest.claimDecisionBinding?.assertedClaimCount ?? 0
    const assertedClaimWithFreezeRefCount = manifest.claimDecisionBinding?.assertedClaimWithFreezeRefCount ?? 0
    const missingFreezeRefClaimIds = manifest.claimDecisionBinding?.missingFreezeRefClaimIds ?? []
    const claimFreezeDecisionBindingPassed =
      assertedClaimCount === 0
      || (
        assertedClaimWithFreezeRefCount >= assertedClaimCount
        && missingFreezeRefClaimIds.length === 0
      )
    const primaryCoverageRatio = safeRatio(
      manifest.claimCoverage?.coveredPrimary ?? 0,
      manifest.claimCoverage?.assertedPrimary ?? 0
    )
    const secondaryCoverageRatio = safeRatio(
      manifest.claimCoverage?.coveredSecondary ?? 0,
      manifest.claimCoverage?.assertedSecondary ?? 0
    )
    const keyRunRecordCount = manifest.reproducibility?.keyRunRecordCount ?? 0
    const keyRunRecordWithCompleteTripleCount = manifest.reproducibility?.keyRunRecordWithCompleteTripleCount ?? 0
    const missingRunRecordRefs = manifest.reproducibility?.missingRunRecordRefs ?? []
    const runRecordsMissingTriple = manifest.reproducibility?.runRecordsMissingTriple ?? []
    const reproducibilityTripleComplete =
      keyRunRecordCount === keyRunRecordWithCompleteTripleCount
      && missingRunRecordRefs.length === 0
      && runRecordsMissingTriple.length === 0
    const invalidCountableLinkIds = manifest.evidencePolicy?.invalidCountableLinkIds ?? []
    const countablePolicyContractPassed = invalidCountableLinkIds.length === 0
    const causalityRequiredClaims = manifest.causality?.requiredClaims ?? 0
    const causalitySatisfiedClaims = manifest.causality?.satisfiedClaims ?? 0
    const causalityInterventionLinks = manifest.causality?.interventionLinkCount ?? 0
    const causalityCounterfactualLinks = manifest.causality?.counterfactualLinkCount ?? 0
    const causalityMissingClaimIds = manifest.causality?.missingClaimIds ?? []
    const causalitySatisfied =
      causalityRequiredClaims === 0
      || causalitySatisfiedClaims >= causalityRequiredClaims
    const directEvidenceRequiredClaims = manifest.directEvidence?.requiredClaims ?? 0
    const directEvidenceSatisfiedClaims = manifest.directEvidence?.satisfiedClaims ?? 0
    const directEvidenceMissingClaimIds = manifest.directEvidence?.missingClaimIds ?? []
    const directEvidenceSatisfied =
      directEvidenceRequiredClaims === 0
      || directEvidenceSatisfiedClaims >= directEvidenceRequiredClaims

    const structuralChecks: GateResult['structuralChecks'] = [
      {
        name: 'manifest_has_assets',
        passed: manifest.assetIds.length > 0,
        detail: `assetCount=${manifest.assetIds.length}`
      },
      {
        name: 'manifest_has_branch_binding',
        passed: Boolean(manifest.branchNodeId?.trim()),
        detail: `branchNodeId=${manifest.branchNodeId || 'missing'}`
      },
      {
        name: 'manifest_has_plan_snapshot_hash',
        passed: Boolean(manifest.planSnapshotHash?.trim()),
        detail: `planSnapshotHash=${manifest.planSnapshotHash || 'missing'}`
      },
      {
        name: 'manifest_asset_ids_unique',
        passed: !hasDuplicateAssetIds,
        detail: hasDuplicateAssetIds ? 'duplicate asset ids detected' : `uniqueAssetCount=${uniqueAssetIds.size}`
      },
      {
        name: 'evidence_links_are_subset_of_assets',
        passed: danglingEvidenceLinkIds.length === 0,
        detail: danglingEvidenceLinkIds.length === 0
          ? `evidenceLinkCount=${manifest.evidenceLinkIds.length}`
          : `danglingEvidenceLinks=${danglingEvidenceLinkIds.join(', ')}`
      },
      {
        name: 'required_claim_presence',
        passed: !stageRequiresClaims(manifest.stage) || claimCount > 0,
        detail: `claimCount=${claimCount}`
      },
      {
        name: 'required_evidence_link_presence',
        passed: !stageRequiresEvidenceLinks(manifest.stage) || evidenceCount > 0,
        detail: `evidenceLinkCount=${evidenceCount}`
      },
      {
        name: 'asserted_primary_coverage',
        passed: manifest.stage !== 'S5' || primaryCoverageRatio >= 1,
        detail: manifest.claimCoverage
          ? `${manifest.claimCoverage.coveredPrimary}/${manifest.claimCoverage.assertedPrimary} (${primaryCoverageRatio.toFixed(2)})`
          : 'coverage_not_provided'
      },
      {
        name: 'asserted_secondary_coverage',
        passed: manifest.stage !== 'S5' || secondaryCoverageRatio >= 0.85,
        detail: manifest.claimCoverage
          ? `${manifest.claimCoverage.coveredSecondary}/${manifest.claimCoverage.assertedSecondary} (${secondaryCoverageRatio.toFixed(2)})`
          : 'coverage_not_provided'
      },
      {
        name: 'asserted_claim_freeze_decision_presence',
        passed: manifest.stage !== 'S5' || assertedClaims === 0 || claimFreezeDecisionCount > 0,
        detail: `assertedClaims=${assertedClaims}, claimFreezeDecisionCount=${claimFreezeDecisionCount}`
      },
      {
        name: 'asserted_claim_freeze_decision_binding',
        passed: !stageRequiresClaimDecisionBinding(manifest.stage) || claimFreezeDecisionBindingPassed,
        detail:
          `assertedClaimCount=${assertedClaimCount}, withFreezeRef=${assertedClaimWithFreezeRefCount}, `
          + `missing=${missingFreezeRefClaimIds.length}`
      },
      {
        name: 'key_run_reproducibility_triple_complete',
        passed: !stageRequiresReproducibilityTriple(manifest.stage) || reproducibilityTripleComplete,
        detail:
          `keyRuns=${keyRunRecordCount}, completeTriple=${keyRunRecordWithCompleteTripleCount}, `
          + `missingRunRefs=${missingRunRecordRefs.length}, missingTriple=${runRecordsMissingTriple.length}`
      },
      {
        name: 'countable_evidence_policy_contract',
        passed: !stageRequiresEvidenceLinks(manifest.stage) || countablePolicyContractPassed,
        detail: `invalidCountableLinks=${invalidCountableLinkIds.length}`
      },
      {
        name: 'causality_evidence_minimum',
        passed: !stageRequiresCausalityEvidence(manifest.stage) || causalitySatisfied,
        detail:
          `requiredClaims=${causalityRequiredClaims}, satisfiedClaims=${causalitySatisfiedClaims}, `
          + `interventionLinks=${causalityInterventionLinks}, counterfactualLinks=${causalityCounterfactualLinks}`
      },
      {
        name: 'required_evidence_kind_mapping',
        passed: !stageRequiresDirectEvidenceMapping(manifest.stage) || directEvidenceSatisfied,
        detail:
          `requiredClaims=${directEvidenceRequiredClaims}, `
          + `satisfiedClaims=${directEvidenceSatisfiedClaims}, `
          + `missing=${directEvidenceMissingClaimIds.length}`
      }
    ]

    const hardBlockers: GateResult['hardBlockers'] = []
    if (manifest.assetIds.length === 0) {
      hardBlockers.push({
        label: 'reproducibility_gap',
        assetRefs: []
      })
    }
    if (!manifest.branchNodeId?.trim()) {
      hardBlockers.push({
        label: 'reproducibility_gap',
        assetRefs: []
      })
    }
    if (!manifest.planSnapshotHash?.trim()) {
      hardBlockers.push({
        label: 'reproducibility_gap',
        assetRefs: []
      })
    }
    if (hasDuplicateAssetIds) {
      hardBlockers.push({
        label: 'reproducibility_gap',
        assetRefs: manifest.assetIds
      })
    }
    if (danglingEvidenceLinkIds.length > 0) {
      hardBlockers.push({
        label: 'reproducibility_gap',
        assetRefs: danglingEvidenceLinkIds
      })
    }
    if (stageRequiresClaims(manifest.stage) && claimCount === 0) {
      hardBlockers.push({
        label: 'claim_without_direct_evidence',
        assetRefs: []
      })
    }
    if (stageRequiresEvidenceLinks(manifest.stage) && evidenceCount === 0) {
      hardBlockers.push({
        label: 'reproducibility_gap',
        assetRefs: []
      })
    }
    if (manifest.stage === 'S5' && primaryCoverageRatio < 1) {
      hardBlockers.push({
        label: 'claim_without_direct_evidence',
        assetRefs: manifest.evidenceLinkIds
      })
    }
    if (manifest.stage === 'S5' && assertedClaims > 0 && claimFreezeDecisionCount === 0) {
      hardBlockers.push({
        label: 'reproducibility_gap',
        assetRefs: manifest.assetIds.filter((id) => id.startsWith('Claim-'))
      })
    }
    if (stageRequiresClaimDecisionBinding(manifest.stage) && !claimFreezeDecisionBindingPassed) {
      hardBlockers.push({
        label: 'reproducibility_gap',
        assetRefs: missingFreezeRefClaimIds
      })
    }
    if (stageRequiresReproducibilityTriple(manifest.stage) && !reproducibilityTripleComplete) {
      hardBlockers.push({
        label: 'reproducibility_gap',
        assetRefs: Array.from(new Set([...missingRunRecordRefs, ...runRecordsMissingTriple])).sort()
      })
    }
    if (stageRequiresEvidenceLinks(manifest.stage) && !countablePolicyContractPassed) {
      hardBlockers.push({
        label: 'parity_violation_unresolved',
        assetRefs: invalidCountableLinkIds
      })
    }
    if (stageRequiresCausalityEvidence(manifest.stage) && !causalitySatisfied) {
      hardBlockers.push({
        label: 'causality_gap',
        assetRefs: causalityMissingClaimIds
      })
    }
    if (stageRequiresDirectEvidenceMapping(manifest.stage) && !directEvidenceSatisfied) {
      hardBlockers.push({
        label: 'claim_without_direct_evidence',
        assetRefs: directEvidenceMissingClaimIds
      })
    }

    return {
      stage: manifest.stage,
      passed: structuralChecks.every((check) => check.passed) && hardBlockers.length === 0,
      structuralChecks,
      hardBlockers,
      advisoryNotes: [
        `assetTypes=${JSON.stringify(Object.fromEntries(typeCounts.entries()))}`,
        `manifestId=${manifest.id}`
      ]
    }
  }
}

export class LeanGateEngine implements GateEngine {
  evaluate(manifest: SnapshotManifest): GateResult {
    const uniqueAssetIds = new Set(manifest.assetIds)
    const hasDuplicateAssetIds = uniqueAssetIds.size !== manifest.assetIds.length
    const danglingEvidenceLinkIds = manifest.evidenceLinkIds.filter((id) => !uniqueAssetIds.has(id))

    const lean = manifest.lean
    const experimentRequestCount = lean?.experimentRequestCount ?? 0
    const executableExperimentRequestCount = lean?.experimentRequestExecutableCount ?? 0
    const resultInsightCount = lean?.resultInsightCount ?? 0
    const boundResultInsightCount = lean?.resultInsightLinkedCount ?? 0
    const literatureNoteCount = lean?.literatureNoteCount ?? 0

    const erValidationFailures = lean?.experimentRequestValidationFailures ?? []
    const allERsValid = erValidationFailures.length === 0

    const gMin1Required = stageRequiresExecutableExperimentRequest(manifest.stage)
    const gMin2Required = stageRequiresBoundResultInsight(manifest.stage)
    const gMin3Required = stageRequiresLiteratureEvidence(manifest.stage)
    const gMin1Passed = !gMin1Required || (executableExperimentRequestCount > 0 && allERsValid)
    const gMin2Passed = !gMin2Required
      || (
        resultInsightCount > 0
        && boundResultInsightCount >= resultInsightCount
      )
    const gMin3Passed = !gMin3Required || literatureNoteCount > 0

    const structuralChecks: GateResult['structuralChecks'] = [
      {
        name: 'manifest_has_assets',
        passed: manifest.assetIds.length > 0,
        detail: `assetCount=${manifest.assetIds.length}`
      },
      {
        name: 'manifest_has_branch_binding',
        passed: Boolean(manifest.branchNodeId?.trim()),
        detail: `branchNodeId=${manifest.branchNodeId || 'missing'}`
      },
      {
        name: 'manifest_has_plan_snapshot_hash',
        passed: Boolean(manifest.planSnapshotHash?.trim()),
        detail: `planSnapshotHash=${manifest.planSnapshotHash || 'missing'}`
      },
      {
        name: 'manifest_asset_ids_unique',
        passed: !hasDuplicateAssetIds,
        detail: hasDuplicateAssetIds ? 'duplicate asset ids detected' : `uniqueAssetCount=${uniqueAssetIds.size}`
      },
      {
        name: 'evidence_links_are_subset_of_assets',
        passed: danglingEvidenceLinkIds.length === 0,
        detail: danglingEvidenceLinkIds.length === 0
          ? `evidenceLinkCount=${manifest.evidenceLinkIds.length}`
          : `danglingEvidenceLinks=${danglingEvidenceLinkIds.join(', ')}`
      },
      {
        name: 'g_min_1_experiment_request_executable',
        passed: gMin1Passed,
        detail: `required=${gMin1Required}; executable=${executableExperimentRequestCount}; total=${experimentRequestCount}; validationFailures=${erValidationFailures.length}`
      },
      {
        name: 'g_min_2_result_insight_bound',
        passed: gMin2Passed,
        detail: `required=${gMin2Required}; linked=${boundResultInsightCount}; total=${resultInsightCount}`
      },
      {
        name: 'g_min_3_literature_evidence',
        passed: gMin3Passed,
        detail: `required=${gMin3Required}; literatureNotes=${literatureNoteCount}`
      }
    ]

    const hardBlockers: GateResult['hardBlockers'] = []
    if (manifest.assetIds.length === 0) {
      hardBlockers.push({ label: 'reproducibility_gap', assetRefs: [] })
    }
    if (!manifest.branchNodeId?.trim()) {
      hardBlockers.push({ label: 'reproducibility_gap', assetRefs: [] })
    }
    if (!manifest.planSnapshotHash?.trim()) {
      hardBlockers.push({ label: 'reproducibility_gap', assetRefs: [] })
    }
    if (hasDuplicateAssetIds) {
      hardBlockers.push({ label: 'reproducibility_gap', assetRefs: manifest.assetIds })
    }
    if (danglingEvidenceLinkIds.length > 0) {
      hardBlockers.push({ label: 'reproducibility_gap', assetRefs: danglingEvidenceLinkIds })
    }
    if (!gMin1Passed) {
      hardBlockers.push({
        label: 'experiment_request_not_executable',
        assetRefs: manifest.assetIds.filter((id) => id.startsWith('ExperimentRequest-'))
      })
    }
    if (!gMin2Passed) {
      hardBlockers.push({
        label: 'result_insight_not_bound',
        assetRefs: manifest.assetIds.filter((id) => id.startsWith('ResultInsight-'))
      })
    }
    // Literature gate is advisory — it warns but does not hard-block stage advancement.
    // The agent should naturally conduct literature review as part of good research methodology.

    const validationNotes = erValidationFailures.map(
      (f) => `ExperimentRequest ${f.assetId}: missing [${f.missingFields.join(', ')}]${f.warnings.length > 0 ? '; warnings: ' + f.warnings.join('; ') : ''}`
    )

    return {
      stage: manifest.stage,
      passed: structuralChecks.every((check) => check.passed) && hardBlockers.length === 0,
      structuralChecks,
      hardBlockers,
      advisoryNotes: [
        `manifestId=${manifest.id}`,
        `leanSummary={"experimentRequest":{"total":${experimentRequestCount},"executable":${executableExperimentRequestCount}},"resultInsight":{"total":${resultInsightCount},"linked":${boundResultInsightCount}},"literatureNotes":${literatureNoteCount}}`,
        ...(!gMin3Passed ? ['Advisory: No literature Note found yet. A literature review strengthens experiment design and helps identify gaps. Consider using literature-search.'] : []),
        ...validationNotes
      ]
    }
  }
}
