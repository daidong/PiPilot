import { describe, expect, it } from 'vitest'

import { LeanGateEngine } from '../../examples/yolo-researcher/index.js'
import type { SnapshotManifest } from '../../examples/yolo-researcher/index.js'

function buildManifest(literatureNoteCount: number): SnapshotManifest {
  return {
    id: `manifest-s1-${literatureNoteCount}`,
    stage: 'S1',
    assetIds: ['Note-001'],
    evidenceLinkIds: [],
    lean: {
      experimentRequestCount: 0,
      experimentRequestExecutableCount: 0,
      experimentRequestValidationFailures: [],
      resultInsightCount: 0,
      resultInsightLinkedCount: 0,
      literatureNoteCount
    },
    branchNodeId: 'N-001',
    planSnapshotHash: 'hash-001',
    generatedAtTurn: 1
  }
}

describe('lean gate engine', () => {
  it('fails S1 when literature evidence is missing', () => {
    const engine = new LeanGateEngine()
    const result = engine.evaluate(buildManifest(0))

    expect(result.passed).toBe(false)
    expect(
      result.structuralChecks.some((check) => check.name === 'g_min_3_literature_evidence' && check.passed === false)
    ).toBe(true)
    expect(result.hardBlockers.some((item) => item.label === 'reproducibility_gap')).toBe(true)
  })

  it('passes S1 when literature evidence exists', () => {
    const engine = new LeanGateEngine()
    const result = engine.evaluate(buildManifest(1))

    expect(result.passed).toBe(true)
    expect(
      result.structuralChecks.some((check) => check.name === 'g_min_3_literature_evidence' && check.passed === true)
    ).toBe(true)
    expect(result.hardBlockers).toEqual([])
  })
})
