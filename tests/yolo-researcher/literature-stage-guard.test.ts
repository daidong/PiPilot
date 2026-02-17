import { afterEach, describe, expect, it } from 'vitest'

import {
  ScriptedCoordinator,
  YoloSession,
  buildDefaultP0Constraints,
  type PlannerInput,
  type PlannerOutput,
  type TurnPlanner,
  type YoloSessionOptions
} from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

function buildOptions(): YoloSessionOptions {
  return {
    budget: {
      maxTurns: 6,
      maxTokens: 200_000,
      maxCostUsd: 100
    },
    models: {
      planner: 'gpt-5-nano',
      coordinator: 'gpt-5-mini'
    },
    mode: 'lean_v2'
  }
}

class StageJumpPlanner implements TurnPlanner {
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
        objective: 'jump to S2 immediately',
        expectedAssets: ['Claim'],
        constraints: buildDefaultP0Constraints()
      },
      suggestedPrompt: 'jump directly to S2',
      rationale: 'planner requests S2 before S1 gate pass',
      uncertaintyNote: 'none'
    }
  }
}

describe('literature-first stage guard', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('holds stage at S1 until S1 gate passes, then allows S2', async () => {
    const projectPath = await createTempDir('yolo-literature-stage-guard-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S1 literature baseline built',
        assets: [
          {
            type: 'Note',
            payload: {
              title: 'Related Work Baseline',
              literatureReview: 'Surveyed prior papers on agent orchestration and tool latency.'
            }
          }
        ],
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 100,
          promptTokens: 20,
          completionTokens: 20,
          turnTokens: 40,
          turnCostUsd: 0.01,
          discoveryOps: 1
        }
      },
      {
        summary: 'proceed with S2 scoping',
        assets: [
          { type: 'Claim', payload: { text: 'S2 planning starts after S1 pass.' } }
        ],
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 80,
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
      'sid-literature-stage-guard',
      'Evaluate orchestration latency bottlenecks',
      buildOptions(),
      coordinator,
      { planner: new StageJumpPlanner() }
    )

    const t1 = await session.executeNextTurn()
    const snapshotAfterT1 = await session.getSnapshot()
    const t2 = await session.executeNextTurn()

    expect(t1.turnReport.turnSpec.stage).toBe('S1')
    expect(t1.turnReport.riskDelta.some((note) => note.includes('literature-first stage guard'))).toBe(true)
    expect(snapshotAfterT1.stageGateStatus.S1).toBe('pass')
    expect(t2.turnReport.turnSpec.stage).toBe('S2')
  })
})
