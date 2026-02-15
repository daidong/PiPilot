import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildDefaultP0Constraints,
  ScriptedCoordinator,
  StructuralGateEngine,
  YoloSession,
  type PlannerInput,
  type PlannerOutput,
  type TurnPlanner,
  type TurnReport,
  type YoloSessionOptions
} from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

function buildOptions(): YoloSessionOptions {
  return {
    phase: 'P2',
    budget: {
      maxTurns: 4,
      maxTokens: 100_000,
      maxCostUsd: 100
    },
    models: {
      planner: 'gpt-5-nano',
      coordinator: 'gpt-5-mini'
    }
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T
}

describe('gate replay from persisted snapshot manifest', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('replays gate result from stored turn report manifest deterministically', async () => {
    const projectPath = await createTempDir('yolo-gate-replay-')
    tempDirs.push(projectPath)

    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: 'S2',
            branch: {
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId,
              action: 'advance'
            },
            objective: 'gate replay determinism test',
            expectedAssets: ['Claim', 'EvidenceLink'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'build S2 snapshot',
          rationale: 'persist and replay gate manifest',
          uncertaintyNote: 'none'
        }
      }
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S2 replay baseline',
        assets: [
          {
            type: 'Claim',
            payload: {
              state: 'asserted',
              tier: 'primary',
              claimType: 'performance',
              statement: 'Primary claim for gate replay'
            }
          },
          {
            type: 'EvidenceLink',
            payload: {
              claimId: 'Claim-t001-a1-001',
              evidenceId: 'RunRecord-t001-a1-999',
              relation: 'supports',
              countingPolicy: 'countable'
            }
          }
        ],
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 10,
          promptTokens: 20,
          completionTokens: 20,
          turnTokens: 40,
          turnCostUsd: 0.01,
          discoveryOps: 1
        }
      }
    ])

    const session = new YoloSession(
      projectPath,
      'sid-gate-replay',
      'P2 gate replay determinism test',
      buildOptions(),
      coordinator,
      { planner }
    )

    const result = await session.executeNextTurn()
    const persistedTurn = await readJson<TurnReport>(
      path.join(projectPath, 'yolo', 'sid-gate-replay', 'turns', '1.report.json')
    )

    const replayEngine = new StructuralGateEngine()
    const replayed = replayEngine.evaluate(persistedTurn.gateImpact.snapshotManifest)

    expect(replayed).toEqual(persistedTurn.gateImpact.gateResult)
    expect(replayed.passed ? 'pass' : 'fail').toBe(result.turnReport.gateImpact.status)
  })
})
