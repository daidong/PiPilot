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
      maxTurns: 6,
      maxTokens: 100_000,
      maxCostUsd: 100
    },
    models: {
      planner: 'gpt-5-nano',
      coordinator: 'gpt-5-mini',
      reviewer: 'gpt-5-mini'
    }
  }
}

async function readJsonl(filePath: string): Promise<any[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

class DeterministicPlannerS3 implements TurnPlanner {
  async generate(input: PlannerInput): Promise<PlannerOutput> {
    return {
      turnSpec: {
        turnNumber: input.turnNumber,
        stage: 'S3',
        branch: {
          activeBranchId: input.activeBranchId,
          activeNodeId: input.activeNodeId,
          action: 'advance'
        },
        objective: 'P3 semantic review test turn',
        expectedAssets: ['Claim', 'RiskRegister'],
        constraints: buildDefaultP0Constraints()
      },
      suggestedPrompt: 'P3 semantic review test',
      rationale: 'deterministic S3 planning for semantic consensus checks',
      uncertaintyNote: 'none'
    }
  }
}

describe('P3 semantic review consensus behavior', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('pauses progression when >=2/3 reviewer passes flag the same anchored blocker', async () => {
    const projectPath = await createTempDir('yolo-p3-semantic-blocker-')
    tempDirs.push(projectPath)

    const reviewEngine: ReviewEngine = {
      evaluate: () => ({
        enabled: true,
        reviewerPasses: [
          {
            persona: 'Novelty',
            notes: ['novelty pass'],
            hardBlockers: []
          },
          {
            persona: 'System',
            notes: ['system blocker vote'],
            hardBlockers: [{
              label: 'overclaim',
              citations: ['Claim-t0001-a1-001'],
              assetRefs: ['Claim-t0001-a1-001']
            }]
          },
          {
            persona: 'Evaluation',
            notes: ['evaluation blocker vote'],
            hardBlockers: [{
              label: 'overclaim',
              citations: ['Claim-t0001-a1-001'],
              assetRefs: ['Claim-t0001-a1-001']
            }]
          }
        ],
        consensusBlockers: [{
          label: 'overclaim',
          voteCount: 2,
          personas: ['System', 'Evaluation'],
          citations: ['Claim-t0001-a1-001'],
          assetRefs: ['Claim-t0001-a1-001']
        }],
        advisoryNotes: ['semantic consensus blockers: overclaim']
      })
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S3 turn with structural pass and semantic blocker consensus',
        assets: [{ type: 'Claim', payload: { state: 'proposed', tier: 'primary', statement: 'candidate claim' } }],
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
      'sid-p3-semantic-blocker',
      'P3 semantic blocker consensus test',
      buildOptions(),
      coordinator,
      {
        planner: new DeterministicPlannerS3(),
        reviewEngine
      }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.gateImpact.status).toBe('pass')
    expect(result.turnReport.reviewerSnapshot.status).toBe('completed')
    if (result.turnReport.reviewerSnapshot.status === 'completed') {
      expect(result.turnReport.reviewerSnapshot.consensusBlockers.map((item) => item.label)).toContain('overclaim')
    }
    expect(result.newState).toBe('WAITING_FOR_USER')

    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('WAITING_FOR_USER')
    expect(snapshot.pendingQuestion?.checkpoint).toBe('final-scope')
    expect(snapshot.pendingQuestion?.question.includes('overclaim')).toBe(true)

    const events = await readJsonl(path.join(projectPath, 'yolo', 'sid-p3-semantic-blocker', 'events.jsonl'))
    expect(
      events.some((event) => event.eventType === 'semantic_review_evaluated' && event.payload?.consensusBlockerLabels?.includes('overclaim'))
    ).toBe(true)
  })

  it('does not pause when reviewer votes do not reach consensus', async () => {
    const projectPath = await createTempDir('yolo-p3-semantic-no-consensus-')
    tempDirs.push(projectPath)

    const reviewEngine: ReviewEngine = {
      evaluate: () => ({
        enabled: true,
        reviewerPasses: [
          {
            persona: 'Novelty',
            notes: ['novelty advisory only'],
            hardBlockers: []
          },
          {
            persona: 'System',
            notes: ['system flags overclaim'],
            hardBlockers: [{
              label: 'overclaim',
              citations: ['Claim-t0001-a1-001'],
              assetRefs: ['Claim-t0001-a1-001']
            }]
          },
          {
            persona: 'Evaluation',
            notes: ['evaluation flags causality gap'],
            hardBlockers: [{
              label: 'causality_gap',
              citations: ['Claim-t0001-a1-001'],
              assetRefs: ['Claim-t0001-a1-001']
            }]
          }
        ],
        consensusBlockers: [],
        advisoryNotes: ['semantic review found no consensus blockers']
      })
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S3 turn with no semantic consensus blockers',
        assets: [{ type: 'Claim', payload: { state: 'proposed', tier: 'primary', statement: 'candidate claim' } }],
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
      'sid-p3-semantic-no-consensus',
      'P3 semantic no-consensus test',
      buildOptions(),
      coordinator,
      {
        planner: new DeterministicPlannerS3(),
        reviewEngine
      }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.gateImpact.status).toBe('pass')
    expect(result.turnReport.reviewerSnapshot.status).toBe('completed')
    expect(result.newState).toBe('TURN_COMPLETE')

    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('TURN_COMPLETE')
    expect(snapshot.pendingQuestion).toBeUndefined()
  })
})

