import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildDefaultP0Constraints,
  ScriptedCoordinator,
  YoloSession,
  type PlannerInput,
  type PlannerOutput,
  type ReviewEngine,
  type TurnPlanner,
  type YoloSessionOptions
} from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

function buildOptions(): YoloSessionOptions {
  return {
    phase: 'P3',
    budget: {
      maxTurns: 8,
      maxTokens: 120_000,
      maxCostUsd: 120
    },
    models: {
      planner: 'gpt-5-nano',
      coordinator: 'gpt-5-mini',
      reviewer: 'gpt-5-mini'
    }
  }
}

class DeterministicPlannerS1ToS5 implements TurnPlanner {
  private readonly stages = ['S1', 'S2', 'S3', 'S4', 'S5'] as const

  async generate(input: PlannerInput): Promise<PlannerOutput> {
    const stage = this.stages[Math.max(0, Math.min(this.stages.length - 1, input.turnNumber - 1))]
    return {
      turnSpec: {
        turnNumber: input.turnNumber,
        stage,
        branch: {
          activeBranchId: input.activeBranchId,
          activeNodeId: input.activeNodeId,
          action: 'advance'
        },
        objective: `coverage closure turn for ${stage}`,
        expectedAssets: ['RiskRegister', 'Claim', 'EvidenceLink', 'Decision'],
        constraints: {
          ...buildDefaultP0Constraints(),
          maxNewAssets: 10
        }
      },
      suggestedPrompt: `coverage closure turn ${input.turnNumber} (${stage})`,
      rationale: 'deterministic S1-S5 stage progression for P3 coverage closure',
      uncertaintyNote: 'none'
    }
  }
}

async function loadAssets(projectPath: string, sessionId: string): Promise<Array<{
  id: string
  type: string
  payload: Record<string, unknown>
  createdByTurn: number
}>> {
  const assetsDir = path.join(projectPath, 'yolo', sessionId, 'assets')
  const names = (await fs.readdir(assetsDir))
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort((a, b) => a.localeCompare(b))
  const loaded = await Promise.all(names.map(async (name) => {
    const raw = await fs.readFile(path.join(assetsDir, name), 'utf-8')
    return JSON.parse(raw) as {
      id: string
      type: string
      payload: Record<string, unknown>
      createdByTurn: number
    }
  }))
  return loaded
}

describe('P3 coverage closure', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('produces final claim-evidence table with asserted primary coverage 1.0 across S1-S5', async () => {
    const projectPath = await createTempDir('yolo-p3-coverage-closure-')
    tempDirs.push(projectPath)

    const baselineParityContractId = 'BaselineParityContract-t001-a1-001'
    const claimId = 'Claim-t002-a1-001'
    const envSnapshotId = 'EnvSnapshot-t002-a1-002'
    const workloadVersionId = 'WorkloadVersion-t002-a1-003'
    const replayScriptId = 'ReplayScript-t002-a1-004'
    const runRecordId = 'RunRecord-t002-a1-005'
    const evidenceLinkId = 'EvidenceLink-t002-a1-006'

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S1 baseline and hypothesis setup',
        assets: [
          { type: 'BaselineParityContract', payload: { baseline: 'strong-baseline', knobs: ['threads'] } },
          { type: 'Hypothesis', payload: { text: 'Intervention reduces tail latency at fixed throughput.' } }
        ],
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 16,
          promptTokens: 40,
          completionTokens: 30,
          turnTokens: 70,
          turnCostUsd: 0.01,
          discoveryOps: 1
        }
      },
      {
        summary: 'S2 claim + key evidence setup',
        assets: [
          {
            type: 'Claim',
            payload: {
              state: 'asserted',
              tier: 'primary',
              statement: 'The mechanism improves p99 latency without throughput regression.',
              claimType: 'performance'
            }
          },
          { type: 'EnvSnapshot', payload: { hashKey: 'env-hash-001' } },
          { type: 'WorkloadVersion', payload: { hashKey: 'workload-hash-001' } },
          { type: 'ReplayScript', payload: { path: 'scripts/replay.sh' } },
          {
            type: 'RunRecord',
            payload: {
              runKey: 'rk-coverage-closure-001',
              envSnapshotId,
              workloadVersionId,
              replayScriptId
            }
          },
          {
            type: 'EvidenceLink',
            payload: {
              claimId,
              runRecordId,
              baselineParityContractId,
              countingPolicy: 'countable',
              evidenceKind: 'end_to_end',
              causalityType: 'intervention'
            }
          }
        ],
        metrics: {
          toolCalls: 2,
          wallClockSec: 1,
          stepCount: 2,
          readBytes: 32,
          promptTokens: 60,
          completionTokens: 40,
          turnTokens: 100,
          turnCostUsd: 0.02,
          discoveryOps: 2
        }
      },
      {
        summary: 'S3 mechanism refinement',
        assets: [
          { type: 'RiskRegister', payload: { note: 'Monitor baseline parity drift.' } }
        ],
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 16,
          promptTokens: 30,
          completionTokens: 20,
          turnTokens: 50,
          turnCostUsd: 0.01,
          discoveryOps: 1
        }
      },
      {
        summary: 'S4 claim-freeze binding',
        assets: [
          {
            type: 'Decision',
            payload: {
              kind: 'claim-freeze',
              checkpoint: 'claim-freeze',
              choice: 'confirm',
              referencedAssetIds: [claimId],
              rationale: 'Coverage and key run metadata are sufficient for freeze.'
            }
          },
          { type: 'RiskRegister', payload: { note: 'Proceed to final synthesis.' } }
        ],
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 12,
          promptTokens: 30,
          completionTokens: 20,
          turnTokens: 50,
          turnCostUsd: 0.01,
          discoveryOps: 1
        }
      },
      {
        summary: 'S5 final draft synthesis',
        assets: [
          { type: 'Draft', payload: { section: 'abstract', text: 'Final evidence-backed summary.' } }
        ],
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 10,
          promptTokens: 30,
          completionTokens: 20,
          turnTokens: 50,
          turnCostUsd: 0.01,
          discoveryOps: 1
        }
      }
    ])
    const reviewEngine: ReviewEngine = {
      evaluate: () => ({
        enabled: true,
        reviewerPasses: [
          { persona: 'System', notes: ['system pass'], hardBlockers: [] },
          { persona: 'Evaluation', notes: ['evaluation pass'], hardBlockers: [] },
          { persona: 'Writing', notes: ['writing pass'], hardBlockers: [] }
        ],
        consensusBlockers: [],
        advisoryNotes: ['semantic review found no consensus blockers']
      })
    }

    const session = new YoloSession(
      projectPath,
      'sid-p3-coverage-closure',
      'P3 coverage closure test',
      buildOptions(),
      coordinator,
      {
        planner: new DeterministicPlannerS1ToS5(),
        reviewEngine
      }
    )

    const results = []
    while (results.length < 5) {
      const snapshot = await session.getSnapshot()
      if (snapshot.state === 'WAITING_FOR_USER') {
        await session.recordCheckpointDecision('Confirm')
        await session.resume()
        continue
      }
      results.push(await session.executeNextTurn())
    }

    expect(results.map((item) => item.turnReport.turnSpec.stage)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5'])
    expect(results.every((item) => (
      item.newState === 'TURN_COMPLETE'
      || item.newState === 'WAITING_FOR_USER'
      || item.newState === 'COMPLETE'
    ))).toBe(true)

    const finalTurn = results[results.length - 1].turnReport
    expect(results[results.length - 1].newState).toBe('COMPLETE')
    expect(finalTurn.gateImpact.status).toBe('pass')
    expect(finalTurn.gateImpact.snapshotManifest.claimCoverage?.assertedPrimary).toBe(1)
    expect(finalTurn.gateImpact.snapshotManifest.claimCoverage?.coveredPrimary).toBe(1)
    expect(finalTurn.assetDiff.created.some((id) => id.startsWith('ClaimEvidenceTable-'))).toBe(true)

    const assets = await loadAssets(projectPath, 'sid-p3-coverage-closure')
    const claimEvidenceTables = assets.filter((asset) => asset.type === 'ClaimEvidenceTable')
    expect(claimEvidenceTables.length).toBeGreaterThan(0)
    const latestTable = claimEvidenceTables[claimEvidenceTables.length - 1]
    expect(latestTable.createdByTurn).toBe(5)

    const coverage = latestTable.payload.coverage as {
      assertedPrimaryCoverage?: number
      assertedSecondaryCoverage?: number
    }
    expect(coverage.assertedPrimaryCoverage).toBe(1)
    expect((latestTable.payload.completeness as { assertedPrimaryCoveragePass?: boolean }).assertedPrimaryCoveragePass).toBe(true)

    const rows = (latestTable.payload.rows as Array<{
      claimId: string
      countableEvidenceIds: string[]
    }>)
    const row = rows.find((item) => item.claimId === claimId)
    expect(row).toBeDefined()
    expect(row?.countableEvidenceIds).toContain(evidenceLinkId)

    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('COMPLETE')
  })
})
