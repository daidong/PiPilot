import { describe, expect, it } from 'vitest'

import { createYoloPlanner } from '../../examples/yolo-researcher/agents/planner.js'
import { __private } from '../../examples/yolo-researcher/agents/planner.js'
import { buildDefaultP0Constraints } from '../../examples/yolo-researcher/runtime/planner.js'
import type { PlannerInput } from '../../examples/yolo-researcher/runtime/types.js'

const {
  parsePlannerJson,
  normalizePlannerOutput,
  buildPlannerPrompt,
  normalizeBranchAction,
  hasCodingIntent,
  hasCloudlabIntent
} = __private

function buildInput(overrides?: Partial<PlannerInput>): PlannerInput {
  return {
    sessionId: 'test-session',
    turnNumber: 3,
    state: 'PLANNING',
    stage: 'S2',
    goal: 'investigate causal mechanisms',
    phase: 'P0',
    activeBranchId: 'B-main',
    activeNodeId: 'N-001',
    nonProgressTurns: 0,
    requiresBranchDiversification: false,
    gateFailureCountOnActiveNode: 0,
    requiresGateLoopBreak: false,
    planSnapshotHash: 'abc123',
    branchDossierHash: 'def456',
    planContent: '# Research Plan\n\n## Hypothesis\ndict lookup is faster',
    branchDossierContent: '# Branch B-main\n\nMain investigation branch.',
    previousStageGateStatus: { S1: 'pass', S2: 'none', S3: 'none', S4: 'none', S5: 'none' },
    lastTurnSummaries: [
      { turnNumber: 1, stage: 'S1', objective: 'define hypothesis', assetsCreated: 2, assetsUpdated: 0 },
      { turnNumber: 2, stage: 'S2', objective: 'propose claims', assetsCreated: 1, assetsUpdated: 0 }
    ],
    assetInventory: [
      { id: 'Hypothesis-t001-a1-001', type: 'Hypothesis', createdByTurn: 1 },
      { id: 'RiskRegister-t001-a1-002', type: 'RiskRegister', createdByTurn: 1 },
      { id: 'Claim-t002-a1-001', type: 'Claim', createdByTurn: 2 }
    ],
    mergedUserInputs: [],
    remainingBudget: {
      turns: 10,
      maxTurns: 12,
      tokens: 100_000,
      costUsd: 10
    },
    ...overrides
  }
}

function makeValidPlannerJson(overrides?: Record<string, unknown>) {
  return {
    turnSpec: {
      turnNumber: 3,
      stage: 'S2',
      branch: {
        activeBranchId: 'B-main',
        activeNodeId: 'N-001',
        action: 'advance'
      },
      objective: 'Propose claims and link evidence',
      expectedAssets: ['Claim', 'EvidenceLink'],
      constraints: buildDefaultP0Constraints()
    },
    suggestedPrompt: 'Turn 3: propose claims',
    rationale: 'S2 focus on claims and evidence.',
    uncertaintyNote: 'May need more data.',
    ...overrides
  }
}

function fakeAgent(output: string, success = true) {
  return {
    ensureInit: async () => {},
    run: async () => ({
      success,
      output,
      steps: 1,
      trace: [],
      durationMs: 10,
      error: success ? undefined : 'agent error'
    })
  }
}

describe('LLM-backed TurnPlanner', () => {
  // 1. Parses valid planner JSON → correct PlannerOutput
  it('parses valid JSON and returns correct PlannerOutput', async () => {
    const validJson = makeValidPlannerJson()
    const planner = createYoloPlanner({
      projectPath: process.cwd(),
      model: 'gpt-5.2',
      createAgentInstance: () => fakeAgent(JSON.stringify(validJson))
    })

    const input = buildInput()
    const result = await planner.generate(input)

    expect(result.turnSpec.objective).toBe('Propose claims and link evidence')
    expect(result.turnSpec.stage).toBe('S2')
    expect(result.turnSpec.branch.action).toBe('advance')
    expect(result.suggestedPrompt).toBe('Turn 3: propose claims')
    expect(result.rationale).toBe('S2 focus on claims and evidence.')
    expect(result.uncertaintyNote).toBe('May need more data.')
    expect(result.planContract.current_focus.length).toBeGreaterThan(0)
    expect(result.planContract.action).toBe('stage_s2_default')
  })

  // 2. Handles code-fenced JSON (tier 2 parsing)
  it('handles code-fenced JSON', async () => {
    const validJson = makeValidPlannerJson()
    const codeFenced = `Here is the plan:\n\`\`\`json\n${JSON.stringify(validJson)}\n\`\`\``
    const planner = createYoloPlanner({
      projectPath: process.cwd(),
      model: 'gpt-5.2',
      createAgentInstance: () => fakeAgent(codeFenced)
    })

    const result = await planner.generate(buildInput())
    expect(result.turnSpec.objective).toBe('Propose claims and link evidence')
  })

  // 3. Handles brace-extracted JSON (tier 3 parsing)
  it('handles brace-extracted JSON', async () => {
    const validJson = makeValidPlannerJson()
    const wrapped = `Some preamble text ${JSON.stringify(validJson)} and trailing text`
    const planner = createYoloPlanner({
      projectPath: process.cwd(),
      model: 'gpt-5.2',
      createAgentInstance: () => fakeAgent(wrapped)
    })

    const result = await planner.generate(buildInput())
    expect(result.turnSpec.objective).toBe('Propose claims and link evidence')
  })

  // 4. Falls back on agent failure (success: false)
  it('falls back on agent failure', async () => {
    const planner = createYoloPlanner({
      projectPath: process.cwd(),
      model: 'gpt-5.2',
      createAgentInstance: () => fakeAgent('', false)
    })

    const result = await planner.generate(buildInput())
    expect(result.turnSpec.objective).toBe('consolidate current state and report blockers')
    expect(result.rationale).toContain('fallback')
  })

  // 5. Falls back on invalid JSON output
  it('falls back on invalid JSON output', async () => {
    const planner = createYoloPlanner({
      projectPath: process.cwd(),
      model: 'gpt-5.2',
      createAgentInstance: () => fakeAgent('This is not JSON at all, just prose.')
    })

    const result = await planner.generate(buildInput())
    expect(result.turnSpec.objective).toBe('consolidate current state and report blockers')
  })

  // 6. Falls back on missing required fields
  it('falls back on missing required fields (no objective)', async () => {
    const invalidJson = makeValidPlannerJson()
    // Remove the objective to trigger normalization failure
    ;(invalidJson.turnSpec as Record<string, unknown>).objective = ''
    const planner = createYoloPlanner({
      projectPath: process.cwd(),
      model: 'gpt-5.2',
      createAgentInstance: () => fakeAgent(JSON.stringify(invalidJson))
    })

    const result = await planner.generate(buildInput())
    expect(result.turnSpec.objective).toContain('investigate causal mechanisms')
  })

  // 7. Keeps explicit branch action when provided by planner output
  it('keeps explicit branch action from planner output', async () => {
    const json = makeValidPlannerJson()
    ;(json.turnSpec.branch as Record<string, unknown>).action = 'fork'
    const planner = createYoloPlanner({
      projectPath: process.cwd(),
      model: 'gpt-5.2',
      createAgentInstance: () => fakeAgent(JSON.stringify(json))
    })

    const result = await planner.generate(buildInput({ phase: 'P0' }))
    expect(result.turnSpec.branch.action).toBe('fork')
  })

  // 8. Normalizes partial constraints with defaults
  it('normalizes partial constraints with defaults', async () => {
    const json = makeValidPlannerJson()
    // Only provide a subset of constraints
    ;(json.turnSpec as Record<string, unknown>).constraints = {
      maxToolCalls: 8,
      maxWallClockSec: 120
    }
    const planner = createYoloPlanner({
      projectPath: process.cwd(),
      model: 'gpt-5.2',
      createAgentInstance: () => fakeAgent(JSON.stringify(json))
    })

    const defaults = buildDefaultP0Constraints()
    const result = await planner.generate(buildInput())
    expect(result.turnSpec.constraints.maxToolCalls).toBe(defaults.maxToolCalls)
    expect(result.turnSpec.constraints.maxWallClockSec).toBe(defaults.maxWallClockSec)
    // Missing fields filled from defaults
    expect(result.turnSpec.constraints.maxStepCount).toBe(defaults.maxStepCount)
    expect(result.turnSpec.constraints.maxReadBytes).toBe(defaults.maxReadBytes)
  })

  // 9. Stage-specific prompt content (S1 vs S5)
  it('includes stage-specific guidance in prompt', () => {
    const s1Prompt = buildPlannerPrompt(buildInput({ stage: 'S1' }))
    expect(s1Prompt).toContain('S1 (Define)')
    expect(s1Prompt).toContain('literature-search')

    const s5Prompt = buildPlannerPrompt(buildInput({ stage: 'S5' }))
    expect(s5Prompt).toContain('S5 (Closure)')
    expect(s5Prompt).toContain('final ResultInsight')
  })

  it('includes coding-large-repo guidance for repository-scale coding tasks', () => {
    const codingPrompt = buildPlannerPrompt(buildInput({
      stage: 'S2',
      goal: 'Implement and verify a non-trivial refactor across a large repository'
    }))
    expect(codingPrompt).toContain('coding-large-repo')
    expect(codingPrompt).toContain('skill-script-run')
    expect(codingPrompt).toContain('delegate-coding-agent')
    expect(codingPrompt).toContain('--runtime auto')
  })

  it('includes cloudlab skill guidance for CloudLab distributed tasks', () => {
    const prompt = buildPlannerPrompt(buildInput({
      stage: 'S2',
      goal: 'Run a CloudLab distributed experiment on multi-node cluster and collect artifacts'
    }))
    expect(prompt).toContain('cloudlab-distributed-experiments')
    expect(prompt).toContain('portal-intake')
    expect(prompt).toContain('distributed-ssh')
    expect(prompt).toContain('experiment-terminate')
  })

  // 10. Budget-aware prompt content (healthy vs critical)
  it('includes budget-aware guidance in prompt', () => {
    const healthyPrompt = buildPlannerPrompt(buildInput({
      remainingBudget: { turns: 10, maxTurns: 12, tokens: 100_000, costUsd: 10 }
    }))
    expect(healthyPrompt).toContain('healthy')

    const criticalPrompt = buildPlannerPrompt(buildInput({
      remainingBudget: { turns: 1, maxTurns: 12, tokens: 5_000, costUsd: 1 }
    }))
    expect(criticalPrompt).toContain('critical')
  })

  it('uses coding-large-repo steps in fallback tool_plan when coding intent is present', async () => {
    const planner = createYoloPlanner({
      projectPath: process.cwd(),
      model: 'gpt-5.2',
      createAgentInstance: () => fakeAgent('this is not valid json')
    })

    const result = await planner.generate(buildInput({
      stage: 'S2',
      goal: 'Fix and refactor repository code paths with local tests'
    }))

    expect(result.planContract.tool_plan.some((step) => step.tool === 'skill-script-run')).toBe(true)
    expect(result.planContract.tool_plan.some((step) => step.goal.includes('coding-large-repo'))).toBe(true)
    expect(result.planContract.tool_plan.some((step) => step.goal.includes('delegate-coding-agent'))).toBe(true)
    expect(result.planContract.tool_plan.some((step) => step.goal.includes('Docker-preferred'))).toBe(true)
  })

  it('uses cloudlab skill steps in fallback tool_plan when CloudLab intent is present', async () => {
    const planner = createYoloPlanner({
      projectPath: process.cwd(),
      model: 'gpt-5.2',
      createAgentInstance: () => fakeAgent('this is not valid json')
    })

    const result = await planner.generate(buildInput({
      stage: 'S2',
      goal: 'Orchestrate CloudLab/Powder multi-node experiment lifecycle and collect outputs'
    }))

    expect(result.planContract.tool_plan.some((step) => step.tool === 'skill-script-run')).toBe(true)
    expect(result.planContract.tool_plan.some((step) => step.goal.includes('cloudlab-distributed-experiments'))).toBe(true)
    expect(result.planContract.tool_plan.some((step) => step.goal.includes('distributed-ssh'))).toBe(true)
    expect(result.planContract.tool_plan.some((step) => step.goal.includes('experiment-terminate'))).toBe(true)
  })
})

describe('parsePlannerJson', () => {
  it('returns undefined for empty string', () => {
    expect(parsePlannerJson('')).toBeUndefined()
  })

  it('returns undefined for non-object JSON', () => {
    expect(parsePlannerJson('"just a string"')).toBeUndefined()
  })
})

describe('normalizeBranchAction', () => {
  it('allows fork in P1', () => {
    expect(normalizeBranchAction('fork', 'P1')).toBe('fork')
  })

  it('allows fork in P0 when requested', () => {
    expect(normalizeBranchAction('fork', 'P0')).toBe('fork')
  })

  it('returns advance for invalid action strings', () => {
    expect(normalizeBranchAction('invalid-action', 'P1')).toBe('advance')
  })
})

describe('normalizePlannerOutput', () => {
  it('handles top-level turnSpec object', () => {
    const raw = makeValidPlannerJson()
    const result = normalizePlannerOutput(raw as Record<string, unknown>, buildInput())
    expect(result).toBeDefined()
    expect(result!.turnSpec.objective).toBe('Propose claims and link evidence')
  })

  it('handles flat object (no nested turnSpec)', () => {
    const raw = {
      turnNumber: 3,
      stage: 'S2',
      branch: { activeBranchId: 'B-main', activeNodeId: 'N-001', action: 'advance' },
      objective: 'Flat objective',
      expectedAssets: ['Claim'],
      constraints: buildDefaultP0Constraints(),
      suggestedPrompt: 'prompt',
      rationale: 'reason',
      uncertaintyNote: 'note'
    }
    const result = normalizePlannerOutput(raw as Record<string, unknown>, buildInput())
    expect(result).toBeDefined()
    expect(result!.turnSpec.objective).toBe('Flat objective')
  })
})

describe('hasCodingIntent', () => {
  it('returns true for explicit repository coding workflow text', () => {
    const result = hasCodingIntent(buildInput({
      goal: 'Refactor repository modules, fix regression, and run pytest locally'
    }))
    expect(result).toBe(true)
  })

  it('returns true when code file paths and commands are present', () => {
    const result = hasCodingIntent(buildInput({
      goal: 'Update examples/yolo-researcher/agents/planner.ts and run npx vitest'
    }))
    expect(result).toBe(true)
  })

  it('returns true for Chinese coding instructions', () => {
    const result = hasCodingIntent(buildInput({
      goal: '请在仓库里修复这个bug，重构脚本并跑单测'
    }))
    expect(result).toBe(true)
  })

  it('returns false for literature-focused requests without coding signals', () => {
    const result = hasCodingIntent(buildInput({
      goal: 'Do a literature review, summarize related work, and improve citation coverage'
    }))
    expect(result).toBe(false)
  })

  it('returns false for ambiguous research verbs without coding objects', () => {
    const result = hasCodingIntent(buildInput({
      goal: 'Implement the experiment protocol, test hypothesis quality, and build a theoretical model'
    }))
    expect(result).toBe(false)
  })

  it('returns false for generic "make" research phrasing without coding signals', () => {
    const result = hasCodingIntent(buildInput({
      goal: 'Make a comparative literature review and summarize benchmark assumptions'
    }))
    expect(result).toBe(false)
  })

  it('prioritizes explicit intent route when available', () => {
    const result = hasCodingIntent(buildInput({
      goal: 'Do a literature review only',
      intentRoute: {
        label: 'coding_repository',
        isCoding: true,
        confidence: 0.9,
        source: 'router_model'
      }
    }))
    expect(result).toBe(true)
  })
})

describe('hasCloudlabIntent', () => {
  it('returns true for CloudLab/Powder distributed execution requests', () => {
    const result = hasCloudlabIntent(buildInput({
      goal: 'Use CloudLab Portal API to run multi-node distributed benchmark and collect artifacts'
    }))
    expect(result).toBe(true)
  })

  it('returns false for generic literature-only requests', () => {
    const result = hasCloudlabIntent(buildInput({
      goal: 'Do a literature review of related work and synthesize key citations'
    }))
    expect(result).toBe(false)
  })
})
