import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createYoloSession, ScriptedSingleAgent } from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

function stoppedOutcome(input: {
  summary: string
  projectUpdate?: Record<string, unknown>
}) {
  return {
    intent: 'Stop after contract probe',
    status: 'stopped' as const,
    summary: input.summary,
    primaryAction: 'contract-probe',
    stopReason: 'contract_test_stop',
    ...(input.projectUpdate ? { projectUpdate: input.projectUpdate } : {})
  }
}

async function readResult(projectPath: string, turnNumber: number): Promise<Record<string, any>> {
  const filePath = path.join(
    projectPath,
    'runs',
    `turn-${String(turnNumber).padStart(4, '0')}`,
    'result.json'
  )
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<string, any>
}

describe('yolo-researcher v2 runtime contract (paper-only)', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('resolves orchestration mode to artifact_gravity_v3_paper in auto mode', async () => {
    const projectPath = await createTempDir('yolo-v3-paper-auto-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Verify paper orchestration selection',
      orchestrationMode: 'auto',
      agent: new ScriptedSingleAgent([
        stoppedOutcome({ summary: 'Auto mode contract probe.' })
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('stopped')

    const result = await readResult(projectPath, turn.turnNumber)
    expect(result.orchestration_mode).toBe('artifact_gravity_v3_paper')
  })

  it('ignores legacy planBoard/currentPlan payload fields in paper mode', async () => {
    const projectPath = await createTempDir('yolo-v3-paper-legacy-plan-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Ignore legacy plan control fields',
      orchestrationMode: 'artifact_gravity_v3_paper',
      agent: new ScriptedSingleAgent([
        stoppedOutcome({
          summary: 'Emit legacy planning fields.',
          projectUpdate: {
            planBoard: [{
              id: 'P9',
              title: 'Legacy item should be ignored',
              status: 'TODO',
              doneDefinition: ['deliverable: artifacts/legacy.md'],
              evidencePaths: [],
              priority: 9
            }],
            currentPlan: ['legacy plan should be ignored'],
            facts: [{
              text: 'Legacy payload still carries one valid fact.',
              evidencePath: 'runs/turn-0001/result.json'
            }]
          }
        })
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('stopped')

    const result = await readResult(projectPath, turn.turnNumber)
    const rejections = Array.isArray(result.planner_checkpoint_rejections)
      ? result.planner_checkpoint_rejections
      : []
    expect(rejections).toContain('v3_plan_fields_ignored')

    const projectMd = await fs.readFile(path.join(projectPath, 'PROJECT.md'), 'utf-8')
    expect(projectMd).not.toContain('Legacy item should be ignored')
  })

  it('does not emit legacy semantic_gate result block', async () => {
    const projectPath = await createTempDir('yolo-v3-paper-semantic-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Ensure only northstar semantic gate is emitted',
      orchestrationMode: 'artifact_gravity_v3_paper',
      agent: new ScriptedSingleAgent([
        stoppedOutcome({ summary: 'Semantic payload contract probe.' })
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('stopped')

    const result = await readResult(projectPath, turn.turnNumber)
    expect(result.semantic_gate).toBeUndefined()
    expect(typeof result.northstar_semantic_gate).toBe('object')
  })

  it('ignores legacy env mode values and still runs paper mode', async () => {
    const projectPath = await createTempDir('yolo-v3-paper-env-')
    tempDirs.push(projectPath)

    const previous = process.env.YOLO_ORCHESTRATION_MODE
    process.env.YOLO_ORCHESTRATION_MODE = 'plan_v2'

    try {
      const session = createYoloSession({
        projectPath,
        goal: 'Legacy env fallback test',
        agent: new ScriptedSingleAgent([
          stoppedOutcome({ summary: 'Legacy env mode probe.' })
        ])
      })

      await session.init()
      const turn = await session.runNextTurn()
      expect(turn.status).toBe('stopped')

      const result = await readResult(projectPath, turn.turnNumber)
      expect(result.orchestration_mode).toBe('artifact_gravity_v3_paper')
    } finally {
      if (typeof previous === 'string') {
        process.env.YOLO_ORCHESTRATION_MODE = previous
      } else {
        delete process.env.YOLO_ORCHESTRATION_MODE
      }
    }
  })
})
