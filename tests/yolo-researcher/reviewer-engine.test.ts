import { describe, expect, it } from 'vitest'

import { createYoloReviewEngine } from '../../examples/yolo-researcher/index.js'
import type { GateResult, SnapshotManifest } from '../../examples/yolo-researcher/index.js'

function buildManifest(stage: SnapshotManifest['stage']): SnapshotManifest {
  return {
    id: `manifest-${stage}`,
    stage,
    assetIds: ['Claim-001', 'EvidenceLink-001', 'RunRecord-001'],
    evidenceLinkIds: ['EvidenceLink-001'],
    branchNodeId: 'N-001',
    planSnapshotHash: 'abc123',
    generatedAtTurn: 1
  }
}

function buildGateResult(stage: string, passed: boolean): GateResult {
  return {
    stage,
    passed,
    structuralChecks: [],
    hardBlockers: [],
    advisoryNotes: []
  }
}

describe('LLM-backed reviewer engine', () => {
  it('builds consensus blockers from persona votes', async () => {
    const engine = createYoloReviewEngine({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      createAgentInstance: ({ persona }) => ({
        ensureInit: async () => {},
        run: async () => {
          const hardBlockers = (persona === 'System' || persona === 'Evaluation')
            ? [{
                label: 'causality_gap',
                citations: ['Claim-001'],
                assetRefs: ['Claim-001']
              }]
            : []
          return {
            success: true,
            output: JSON.stringify({
              notes: [`${persona} pass`],
              hardBlockers
            }),
            steps: 1,
            trace: [],
            durationMs: 10
          }
        }
      })
    })

    const result = await engine.evaluate({
      phase: 'P3',
      stage: 'S2',
      manifest: buildManifest('S2'),
      gateResult: buildGateResult('S2', true)
    })

    expect(result.enabled).toBe(true)
    expect(result.reviewerPasses).toHaveLength(3)
    expect(result.consensusBlockers).toHaveLength(1)
    expect(result.consensusBlockers[0]?.label).toBe('causality_gap')
    expect(result.consensusBlockers[0]?.voteCount).toBe(2)
  })

  it('downgrades non-anchored or uncited blockers to advisory notes', async () => {
    const engine = createYoloReviewEngine({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      createAgentInstance: ({ persona }) => ({
        ensureInit: async () => {},
        run: async () => {
          const hardBlockers = persona === 'System'
            ? [{ label: 'overclaim', citations: [], assetRefs: [] }]
            : persona === 'Writing'
              ? [{ label: 'style_problem', citations: ['Claim-001'], assetRefs: ['Claim-001'] }]
              : []
          return {
            success: true,
            output: JSON.stringify({
              notes: [`${persona} review`],
              hardBlockers
            }),
            steps: 1,
            trace: [],
            durationMs: 10
          }
        }
      })
    })

    const result = await engine.evaluate({
      phase: 'P3',
      stage: 'S5',
      manifest: buildManifest('S5'),
      gateResult: buildGateResult('S5', true)
    })

    expect(result.consensusBlockers).toHaveLength(0)
    const allNotes = result.reviewerPasses.flatMap((pass) => pass.notes)
    expect(allNotes.some((note) => note.includes('downgraded blocker overclaim'))).toBe(true)
    expect(allNotes.some((note) => note.includes('ignored non-anchored hard blocker label: style_problem'))).toBe(true)
  })

  it('falls back to deterministic heuristic blockers when reviewer run fails', async () => {
    const engine = createYoloReviewEngine({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      createAgentInstance: () => ({
        ensureInit: async () => {},
        run: async () => ({
          success: false,
          output: 'upstream timeout',
          error: 'timeout',
          steps: 1,
          trace: [],
          durationMs: 10
        })
      })
    })

    const result = await engine.evaluate({
      phase: 'P3',
      stage: 'S4',
      manifest: {
        ...buildManifest('S4'),
        reproducibility: {
          keyRunRecordCount: 1,
          keyRunRecordWithCompleteTripleCount: 0,
          missingRunRecordRefs: [],
          runRecordsMissingTriple: ['RunRecord-001']
        }
      },
      gateResult: buildGateResult('S4', false)
    })

    expect(result.reviewerPasses).toHaveLength(3)
    expect(result.consensusBlockers.some((item) => item.label === 'reproducibility_gap')).toBe(true)
  })
})
