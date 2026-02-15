import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

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

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath, 'utf-8'))
}

describe('planner replay determinism', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('keeps planner context hashes stable for identical replay contexts', async () => {
    const plannerInputs: PlannerInput[] = []
    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        plannerInputs.push(input)
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: input.stage,
            branch: {
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId,
              action: 'advance'
            },
            objective: 'deterministic replay turn',
            expectedAssets: ['RiskRegister'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'deterministic replay',
          rationale: 'capture planner context hash stability',
          uncertaintyNote: 'none'
        }
      }
    }

    const coordinatorTurn = {
      summary: 'replay baseline',
      assets: [{ type: 'RiskRegister', payload: { reason: 'deterministic replay' } }],
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

    const projectPathA = await createTempDir('yolo-planner-replay-a-')
    const projectPathB = await createTempDir('yolo-planner-replay-b-')
    tempDirs.push(projectPathA, projectPathB)

    const sessionA = new YoloSession(
      projectPathA,
      'sid-planner-replay',
      'P1 planner replay hash test',
      buildOptions(),
      new ScriptedCoordinator([coordinatorTurn]),
      { planner }
    )
    await sessionA.init()
    const expectedPlanHashA = await sha256File(path.join(projectPathA, 'yolo', 'sid-planner-replay', 'plan.md'))
    const expectedDossierHashA = await sha256File(
      path.join(projectPathA, 'yolo', 'sid-planner-replay', 'branch-dossiers', 'B-001.md')
    )
    await sessionA.executeNextTurn()

    const sessionB = new YoloSession(
      projectPathB,
      'sid-planner-replay',
      'P1 planner replay hash test',
      buildOptions(),
      new ScriptedCoordinator([coordinatorTurn]),
      { planner }
    )
    await sessionB.init()
    const expectedPlanHashB = await sha256File(path.join(projectPathB, 'yolo', 'sid-planner-replay', 'plan.md'))
    const expectedDossierHashB = await sha256File(
      path.join(projectPathB, 'yolo', 'sid-planner-replay', 'branch-dossiers', 'B-001.md')
    )
    await sessionB.executeNextTurn()

    expect(plannerInputs).toHaveLength(2)
    expect(plannerInputs[0]?.planSnapshotHash).toBe(expectedPlanHashA)
    expect(plannerInputs[0]?.branchDossierHash).toBe(expectedDossierHashA)
    expect(plannerInputs[1]?.planSnapshotHash).toBe(expectedPlanHashB)
    expect(plannerInputs[1]?.branchDossierHash).toBe(expectedDossierHashB)
    expect(plannerInputs[0]?.planSnapshotHash).toBe(plannerInputs[1]?.planSnapshotHash)
    expect(plannerInputs[0]?.branchDossierHash).toBe(plannerInputs[1]?.branchDossierHash)
  })
})
