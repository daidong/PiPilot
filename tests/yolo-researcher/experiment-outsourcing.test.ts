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
    phase: 'P1',
    budget: {
      maxTurns: 6,
      maxTokens: 100_000,
      maxCostUsd: 100
    },
    models: {
      planner: 'gpt-5-nano',
      coordinator: 'gpt-5-mini'
    }
  }
}

function buildS2Planner(): TurnPlanner {
  return {
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
          objective: 'produce experiment requirement for user execution',
          expectedAssets: ['ExperimentRequirement'],
          constraints: buildDefaultP0Constraints()
        },
        suggestedPrompt: 'externalize experiment execution',
        rationale: 'S2 experiment should be outsourced',
        uncertaintyNote: 'none'
      }
    }
  }
}

describe('experiment outsourcing policy', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('auto-creates WAITING_EXTERNAL task from ExperimentRequirement in S2-S4', async () => {
    const projectPath = await createTempDir('yolo-experiment-outsource-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'prepared experiment requirement',
        assets: [
          {
            type: 'ExperimentRequirement',
            payload: {
              why: 'Need controlled intervention evidence to validate bottleneck claim',
              objective: 'Measure effect of queue-depth tuning on tail latency',
              method: 'Run A/B comparison with fixed workload and 5 repeats',
              expectedResult: 'p95 latency improves >= 15% with acceptable CPU overhead',
              requiredFiles: ['results.csv', 'run-notes.md']
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
      'sid-experiment-outsource',
      'S2 external experiment outsourcing test',
      buildOptions(),
      coordinator,
      { planner: buildS2Planner() }
    )

    const result = await session.executeNextTurn()
    expect(result.newState).toBe('WAITING_EXTERNAL')

    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('WAITING_EXTERNAL')
    expect(snapshot.pendingExternalTaskId).toBeTruthy()
    expect(snapshot.pendingQuestion?.question).toContain('External experiment artifacts required')

    const tasks = await session.listExternalWaitTasks()
    const task = tasks.find((item) => item.id === snapshot.pendingExternalTaskId)
    expect(task).toBeTruthy()
    expect(task?.completionRule).toBe('checklist:has_upload,required_files')
    expect(task?.details).toContain('objective=Measure effect of queue-depth tuning on tail latency')
  })

  it('does not auto-enter WAITING_EXTERNAL when turn already includes RunRecord output', async () => {
    const projectPath = await createTempDir('yolo-experiment-outsource-bypass-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'already has run output',
        assets: [
          {
            type: 'ExperimentRequirement',
            payload: {
              why: 'Need evidence',
              objective: 'Test objective',
              method: 'Test method',
              expectedResult: 'Test expected'
            }
          },
          {
            type: 'RunRecord',
            payload: {
              runKey: 'rk-existing-output'
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
      'sid-experiment-outsource-bypass',
      'S2 outsource bypass with run output',
      buildOptions(),
      coordinator,
      { planner: buildS2Planner() }
    )

    const result = await session.executeNextTurn()
    expect(result.newState).toBe('TURN_COMPLETE')

    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('TURN_COMPLETE')
    expect(snapshot.pendingExternalTaskId).toBeUndefined()

    const tasks = await session.listExternalWaitTasks()
    expect(tasks).toHaveLength(0)
  })
})
