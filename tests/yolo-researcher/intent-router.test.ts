import { describe, expect, it } from 'vitest'

import { createYoloIntentRouter, detectCodingIntentHeuristic } from '../../examples/yolo-researcher/agents/intent-router.js'
import type { PlannerInput } from '../../examples/yolo-researcher/runtime/types.js'

function buildInput(overrides?: Partial<PlannerInput>): PlannerInput {
  return {
    sessionId: 'intent-router-test',
    turnNumber: 1,
    state: 'PLANNING',
    stage: 'S2',
    goal: 'investigate latency bottlenecks',
    activeBranchId: 'B-main',
    activeNodeId: 'N-001',
    nonProgressTurns: 0,
    requiresBranchDiversification: false,
    gateFailureCountOnActiveNode: 0,
    requiresGateLoopBreak: false,
    planSnapshotHash: 'h1',
    branchDossierHash: 'h2',
    planContent: '# plan',
    branchDossierContent: '# branch',
    researchContext: 'focus on runtime and benchmarks',
    previousStageGateStatus: { S1: 'none', S2: 'none', S3: 'none', S4: 'none', S5: 'none' },
    lastTurnSummaries: [],
    assetInventory: [],
    mergedUserInputs: [],
    remainingBudget: {
      turns: 5,
      maxTurns: 10,
      tokens: 10_000,
      costUsd: 10
    },
    ...overrides
  }
}

describe('intent router heuristic', () => {
  it('detects coding intent for repository workflow language', () => {
    const route = detectCodingIntentHeuristic(buildInput({
      goal: 'Refactor repo modules, fix bug, run npx vitest and commit patch'
    }))
    expect(route.isCoding).toBe(true)
    expect(route.source).toBe('router_heuristic')
  })

  it('does not treat generic "make" phrasing as coding intent', () => {
    const route = detectCodingIntentHeuristic(buildInput({
      goal: 'Make a literature comparison and summarize related work gaps'
    }))
    expect(route.isCoding).toBe(false)
  })
})

describe('intent router model path', () => {
  it('uses model classification when confidence is high', async () => {
    const router = createYoloIntentRouter({
      projectPath: process.cwd(),
      createAgentInstance: () => ({
        ensureInit: async () => {},
        run: async () => ({
          success: true,
          output: JSON.stringify({
            label: 'coding_repository',
            is_coding: true,
            confidence: 0.91,
            rationale: 'repo edit plus tests'
          }),
          steps: 1,
          trace: [],
          durationMs: 10
        })
      })
    })

    const route = await router.route(buildInput({
      goal: 'Summarize findings only'
    }))
    expect(route.source).toBe('router_model')
    expect(route.isCoding).toBe(true)
  })

  it('falls back to heuristic when model confidence is low', async () => {
    const router = createYoloIntentRouter({
      projectPath: process.cwd(),
      createAgentInstance: () => ({
        ensureInit: async () => {},
        run: async () => ({
          success: true,
          output: JSON.stringify({
            label: 'research',
            is_coding: false,
            confidence: 0.4,
            rationale: 'low confidence'
          }),
          steps: 1,
          trace: [],
          durationMs: 10
        })
      })
    })

    const route = await router.route(buildInput({
      goal: 'Fix module bug and run pytest'
    }))
    expect(route.source).toBe('router_fallback')
    expect(route.isCoding).toBe(true)
  })
})
