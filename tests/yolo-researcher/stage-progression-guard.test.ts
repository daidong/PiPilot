import { afterEach, describe, expect, it } from 'vitest'

import {
  buildDefaultP0Constraints,
  ScriptedCoordinator,
  YoloSession,
  type PlannerInput,
  type PlannerOutput,
  type TurnPlanner,
  type YoloSessionOptions
} from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

function buildOptions(): YoloSessionOptions {
  return {
    phase: 'P2',
    budget: {
      maxTurns: 8,
      maxTokens: 200_000,
      maxCostUsd: 100
    },
    models: {
      planner: 'gpt-5-nano',
      coordinator: 'gpt-5-mini'
    }
  }
}

class StickyS1Planner implements TurnPlanner {
  async generate(input: PlannerInput): Promise<PlannerOutput> {
    return {
      turnSpec: {
        turnNumber: input.turnNumber,
        stage: 'S1',
        branch: {
          activeBranchId: input.activeBranchId,
          activeNodeId: input.activeNodeId,
          action: 'advance'
        },
        objective: 'continue S1 consolidation',
        expectedAssets: ['RiskRegister'],
        constraints: buildDefaultP0Constraints()
      },
      suggestedPrompt: 'keep consolidating S1',
      rationale: 'planner intentionally remains in S1',
      uncertaintyNote: 'none'
    }
  }
}

describe('stage progression guard', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('forces S1 -> S2 when S1 framing is already complete and planner keeps repeating S1', async () => {
    const projectPath = await createTempDir('yolo-stage-progression-guard-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'initial framing',
        assets: [
          { type: 'Hypothesis', payload: { text: 'Tool IPC/process overhead dominates latency.' } },
          { type: 'RiskRegister', payload: { reason: 'attribution confounders' } },
          { type: 'LandscapeSurvey', payload: { sections: ['agent', 'orchestration', 'sandbox', 'process'] } }
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
        summary: 'framing consolidated',
        assets: [
          { type: 'ProblemDefinitionPack', payload: { status: 'complete' } }
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
      },
      {
        summary: 'runtime should no longer stay in S1',
        assets: [
          { type: 'RiskRegister', payload: { reason: 'transitioned to S2 planning' } }
        ],
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 50,
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
      'sid-stage-progression-guard',
      'Investigate tool-call latency bottlenecks and optimizations',
      buildOptions(),
      coordinator,
      { planner: new StickyS1Planner() }
    )

    const t1 = await session.executeNextTurn()
    const t2 = await session.executeNextTurn()
    const t3 = await session.executeNextTurn()

    expect(t1.turnReport.turnSpec.stage).toBe('S1')
    expect(t2.turnReport.turnSpec.stage).toBe('S1')
    expect(t3.turnReport.turnSpec.stage).toBe('S2')
    expect(t3.turnReport.turnSpec.objective).toContain('Transition to S2')
    expect(t3.turnReport.nextStepRationale).toContain('stage progression guard')
  })
})

