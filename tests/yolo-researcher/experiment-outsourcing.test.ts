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
        uncertaintyNote: 'none',
        planContract: {
          current_focus: 'produce experiment requirement for user execution',
          why_now: 'validate outsourcing policy behavior',
          action: 'design_experiment',
          tool_plan: [
            {
              step: 1,
              tool: 'writing-draft',
              goal: 'Produce experiment requirement',
              output_contract: 'ExperimentRequirement'
            }
          ],
          expected_output: ['ExperimentRequirement'],
          need_from_user: {
            required: false,
            request: 'No external input required for this test planner output.',
            required_files: []
          },
          done_definition: 'ExperimentRequirement generated for policy evaluation.',
          risk_flags: []
        }
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
              requiresExternalExecution: true,
              why: 'Need controlled intervention evidence to validate bottleneck claim',
              objective: 'Measure effect of queue-depth tuning on tail latency',
              method: 'Run A/B comparison with fixed workload and 5 repeats',
              expectedResult: 'p95 latency improves >= 15% with acceptable CPU overhead',
              requiredFiles: ['results.csv', 'run-notes.md']
            }
          }
        ],
        toolCalls: [
          {
            tool: 'bash',
            argsPreview: 'python local_smoke.py --quick',
            resultPreview: 'Command exited with code 1: missing credential'
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
    expect(snapshot.pendingQuestion?.question).toContain('External experiment execution is needed')

    const tasks = await session.listExternalWaitTasks()
    const task = tasks.find((item) => item.id === snapshot.pendingExternalTaskId)
    expect(task).toBeTruthy()
    expect(task?.completionRule).toBe('checklist:has_upload,required_files')
    expect(task?.details).toContain('Measure effect of queue-depth tuning on tail latency')
  })

  it('does not auto-enter WAITING_EXTERNAL without explicit external-execution signal', async () => {
    const projectPath = await createTempDir('yolo-experiment-local-first-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'prepared experiment requirement without explicit outsourcing',
        assets: [
          {
            type: 'ExperimentRequirement',
            payload: {
              why: 'Can likely run locally first',
              objective: 'Measure baseline command latency locally',
              method: 'Run local command matrix and collect timing CSV',
              expectedResult: 'Produce local timing evidence and only outsource if blocked'
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
      'sid-experiment-local-first',
      'S2 local-first outsourcing policy test',
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

  it('blocks external wait-task creation in S2 when explicit outsource signal has no local proof', async () => {
    const projectPath = await createTempDir('yolo-experiment-proof-gate-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'prepared external experiment requirement without local run evidence',
        assets: [
          {
            type: 'ExperimentRequirement',
            payload: {
              requiresExternalExecution: true,
              why: 'Need external run',
              objective: 'Test objective',
              method: 'Run protocol externally',
              expectedResult: 'External evidence'
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
      'sid-experiment-proof-gate',
      'S2 proof gate test',
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
