import type {
  AnchoredHardBlockerLabel,
  ConsensusBlocker,
  GateResult,
  ReviewEngine,
  ReviewerPass,
  ReviewerPersona,
  SemanticReviewResult,
  SnapshotManifest,
  YoloStage
} from './types.js'

export const REVIEWER_PERSONAS_BY_STAGE: Record<YoloStage, ReviewerPersona[]> = {
  S1: ['Novelty', 'System', 'Evaluation'],
  S2: ['Novelty', 'System', 'Evaluation'],
  S3: ['Novelty', 'System', 'Evaluation'],
  S4: ['Novelty', 'System', 'Evaluation'],
  S5: ['System', 'Evaluation', 'Writing']
}

export const ANCHORED_LABELS: AnchoredHardBlockerLabel[] = [
  'claim_without_direct_evidence',
  'causality_gap',
  'parity_violation_unresolved',
  'reproducibility_gap',
  'overclaim'
]

export function buildConsensusBlockers(reviewerPasses: ReviewerPass[]): ConsensusBlocker[] {
  const votes = new Map<AnchoredHardBlockerLabel, {
    voteCount: number
    personas: Set<ReviewerPersona>
    citations: Set<string>
    assetRefs: Set<string>
  }>()

  for (const pass of reviewerPasses) {
    for (const blocker of pass.hardBlockers) {
      if (!ANCHORED_LABELS.includes(blocker.label)) continue
      const bucket = votes.get(blocker.label) ?? {
        voteCount: 0,
        personas: new Set<ReviewerPersona>(),
        citations: new Set<string>(),
        assetRefs: new Set<string>()
      }
      bucket.voteCount += 1
      bucket.personas.add(pass.persona)
      for (const citation of blocker.citations) {
        if (citation.trim()) bucket.citations.add(citation.trim())
      }
      for (const assetRef of blocker.assetRefs) {
        if (assetRef.trim()) bucket.assetRefs.add(assetRef.trim())
      }
      votes.set(blocker.label, bucket)
    }
  }

  const consensus: ConsensusBlocker[] = []
  for (const [label, vote] of votes.entries()) {
    if (vote.voteCount < 2) continue
    consensus.push({
      label,
      voteCount: vote.voteCount,
      personas: Array.from(vote.personas).sort(),
      citations: Array.from(vote.citations).sort(),
      assetRefs: Array.from(vote.assetRefs).sort()
    })
  }
  return consensus.sort((a, b) => b.voteCount - a.voteCount || a.label.localeCompare(b.label))
}

export function buildHeuristicBlockers(
  manifest: SnapshotManifest,
  gateResult: GateResult
): Array<{ label: AnchoredHardBlockerLabel; citations: string[]; assetRefs: string[] }> {
  const blockers: Array<{ label: AnchoredHardBlockerLabel; citations: string[]; assetRefs: string[] }> = []

  const directEvidenceMissing = manifest.directEvidence?.missingClaimIds ?? []
  if (directEvidenceMissing.length > 0) {
    blockers.push({
      label: 'claim_without_direct_evidence',
      citations: directEvidenceMissing,
      assetRefs: directEvidenceMissing
    })
  }

  const causalityMissing = manifest.causality?.missingClaimIds ?? []
  if (causalityMissing.length > 0) {
    blockers.push({
      label: 'causality_gap',
      citations: causalityMissing,
      assetRefs: causalityMissing
    })
  }

  const invalidCountable = manifest.evidencePolicy?.invalidCountableLinkIds ?? []
  if (invalidCountable.length > 0) {
    blockers.push({
      label: 'parity_violation_unresolved',
      citations: invalidCountable,
      assetRefs: invalidCountable
    })
  }

  const reproMissing = [
    ...(manifest.reproducibility?.missingRunRecordRefs ?? []),
    ...(manifest.reproducibility?.runRecordsMissingTriple ?? [])
  ]
  if (reproMissing.length > 0) {
    blockers.push({
      label: 'reproducibility_gap',
      citations: reproMissing,
      assetRefs: reproMissing
    })
  }

  const primaryCoverage = manifest.claimCoverage
    ? (manifest.claimCoverage.coveredPrimary < manifest.claimCoverage.assertedPrimary)
    : false
  if (manifest.stage === 'S5' && primaryCoverage && gateResult.passed) {
    blockers.push({
      label: 'overclaim',
      citations: manifest.assetIds.filter((id) => id.startsWith('Claim-')),
      assetRefs: manifest.assetIds.filter((id) => id.startsWith('Claim-'))
    })
  }

  return blockers
}

export class DisabledReviewEngine implements ReviewEngine {
  evaluate(): SemanticReviewResult {
    return {
      enabled: false,
      reviewerPasses: [],
      consensusBlockers: [],
      advisoryNotes: ['semantic review disabled'],
      processReview: {
        verdict: 'pass',
        critical_issues: [],
        fix_plan: [],
        rewrite_patch: {
          apply: false,
          target: 'coordinator_output',
          patch: {}
        },
        confidence: 0.5,
        notes_for_user: 'semantic review disabled'
      }
    }
  }
}
