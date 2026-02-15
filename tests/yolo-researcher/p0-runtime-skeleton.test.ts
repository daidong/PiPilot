import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createStaticYoloCoordinator,
  createYoloSession,
  DegenerateBranchManager,
  ScriptedCoordinator,
  YoloSession,
  createConservativeFallbackSpec,
  type PlannerInput,
  type PlannerOutput,
  type TurnPlanner,
  type YoloSessionOptions
} from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** Simple deterministic planner for tests. */
function buildTestPlanner(): TurnPlanner {
  return {
    async generate(input: PlannerInput): Promise<PlannerOutput> {
      return {
        turnSpec: createConservativeFallbackSpec({
          turnNumber: input.turnNumber,
          stage: input.stage,
          activeBranchId: input.activeBranchId,
          activeNodeId: input.activeNodeId
        }),
        suggestedPrompt: `Turn ${input.turnNumber}: advance`,
        rationale: 'Test planner: deterministic advance-only.',
        uncertaintyNote: ''
      }
    }
  }
}

function buildOptions(): YoloSessionOptions {
  return {
    phase: 'P0',
    budget: {
      maxTurns: 5,
      maxTokens: 50_000,
      maxCostUsd: 100
    },
    models: {
      planner: 'gpt-5-nano',
      coordinator: 'gpt-5-mini'
    }
  }
}

describe('YOLO Researcher P0 runtime skeleton', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('creates P0 session layout and commits one turn', async () => {
    const projectPath = await createTempDir('yolo-p0-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'created initial hypothesis',
        assets: [
          {
            type: 'Hypothesis',
            payload: { text: 'dict lookup is faster than list linear scan for small n' }
          }
        ],
        metrics: {
          toolCalls: 2,
          wallClockSec: 3,
          stepCount: 3,
          readBytes: 1024,
          promptTokens: 500,
          completionTokens: 200,
          turnTokens: 700,
          turnCostUsd: 0.01,
          discoveryOps: 2
        }
      }
    ])

    const session = new YoloSession(
      projectPath,
      'sid-001',
      'Investigate a toy systems hypothesis',
      buildOptions(),
      coordinator,
      { planner: buildTestPlanner() }
    )

    await session.init()
    const result = await session.executeNextTurn()

    expect(result.turnReport.turnNumber).toBe(1)
    expect(result.turnReport.assetDiff.created.length).toBe(1)

    const baseDir = path.join(projectPath, 'yolo', 'sid-001')
    await expect(fs.access(path.join(baseDir, 'session.json'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(baseDir, 'plan.md'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(baseDir, 'plan-state.json'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(baseDir, 'turns', '1.report.json'))).resolves.toBeUndefined()

    const events = await readJsonl(path.join(baseDir, 'events.jsonl'))
    const eventTypes = events.map((event) => (event as { eventType: string }).eventType)
    expect(eventTypes).toContain('planner_spec_generated')
    expect(eventTypes).toContain('turn_started')
    expect(eventTypes).toContain('turn_committed')
  })

  it('keeps branch manager degenerate in P0', async () => {
    const projectPath = await createTempDir('yolo-branch-')
    tempDirs.push(projectPath)

    const sessionDir = path.join(projectPath, 'yolo', 'sid-branch')
    const manager = new DegenerateBranchManager(sessionDir)
    await manager.init('S1')

    await expect(manager.fork()).rejects.toThrow('not implemented in P0')
    await expect(manager.revisit()).rejects.toThrow('not implemented in P0')
    await expect(manager.merge()).rejects.toThrow('not implemented in P0')
    await expect(manager.prune()).rejects.toThrow('not implemented in P0')
  })

  it('hard-enforces maxReadBytes in P0', async () => {
    const projectPath = await createTempDir('yolo-constraints-')
    tempDirs.push(projectPath)

    const tightPlanner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        return {
          turnSpec: {
            ...createConservativeFallbackSpec({
              turnNumber: input.turnNumber,
              stage: input.stage,
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId
            }),
            constraints: {
              maxToolCalls: 10,
              maxWallClockSec: 10,
              maxStepCount: 10,
              maxNewAssets: 5,
              maxDiscoveryOps: 10,
              maxReadBytes: 8,
              maxPromptTokens: 1000,
              maxCompletionTokens: 500,
              maxTurnTokens: 1500,
              maxTurnCostUsd: 1
            }
          },
          suggestedPrompt: 'tight bounds test',
          rationale: 'test hard maxReadBytes',
          uncertaintyNote: 'none'
        }
      }
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'should fail by readBytes',
        assets: [
          {
            type: 'RiskRegister',
            payload: { reason: 'read too much' }
          }
        ],
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 9,
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
      'sid-constraints',
      'Constraint enforcement test',
      buildOptions(),
      coordinator,
      { planner: tightPlanner }
    )

    await session.init()
    await expect(session.executeNextTurn()).rejects.toThrow('hard constraint violation')

    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('FAILED')

    const events = await readJsonl(path.join(projectPath, 'yolo', 'sid-constraints', 'events.jsonl'))
    const committed = events.filter((event) => (event as { eventType: string }).eventType === 'turn_committed')
    expect(committed).toHaveLength(0)
  })

  it('stops session when maxTokens budget is exhausted', async () => {
    const projectPath = await createTempDir('yolo-budget-token-')
    tempDirs.push(projectPath)

    const options = buildOptions()
    options.budget.maxTokens = 30
    options.budget.maxTurns = 5

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'token-heavy turn',
        assets: [
          {
            type: 'RiskRegister',
            payload: { reason: 'budget test' }
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
          turnCostUsd: 0.02,
          discoveryOps: 1
        }
      }
    ])

    const session = new YoloSession(
      projectPath,
      'sid-budget-token',
      'Stop when token budget is exceeded',
      options,
      coordinator,
      { planner: buildTestPlanner() }
    )

    const result = await session.executeNextTurn()
    expect(result.newState).toBe('STOPPED')

    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('STOPPED')
    expect(snapshot.budgetUsed.tokens).toBe(40)

    const events = await readJsonl(path.join(projectPath, 'yolo', 'sid-budget-token', 'events.jsonl'))
    const stopTransition = events.find((event) => {
      const typed = event as { eventType?: string; payload?: { to?: string; reason?: string } }
      return typed.eventType === 'state_transition' && typed.payload?.to === 'STOPPED'
    }) as { payload?: { reason?: string } } | undefined

    expect(stopTransition?.payload?.reason).toBe('max token budget reached')
  })

  it('supports resume from STOPPED when budget remains', async () => {
    const projectPath = await createTempDir('yolo-stop-resume-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'turn before manual stop',
        assets: [{ type: 'RiskRegister', payload: { reason: 'before stop' } }],
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
      },
      {
        summary: 'turn after resume',
        assets: [{ type: 'RiskRegister', payload: { reason: 'after resume' } }],
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
      'sid-stop-resume',
      'Stop/resume test',
      buildOptions(),
      coordinator,
      { planner: buildTestPlanner() }
    )

    await session.executeNextTurn()
    await session.stop()
    let snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('STOPPED')

    await session.resume()
    snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('PLANNING')

    const second = await session.executeNextTurn()
    expect(second.turnReport.turnNumber).toBe(2)
  })

  it('recovers by cleaning staging and dropping non-durable ghost turn files', async () => {
    const projectPath = await createTempDir('yolo-recovery-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'turn 1 ok',
        assets: [
          {
            type: 'Claim',
            payload: { text: 'toy claim' }
          }
        ],
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 1,
          promptTokens: 10,
          completionTokens: 10,
          turnTokens: 20,
          turnCostUsd: 0.01,
          discoveryOps: 1
        }
      }
    ])

    const session = new YoloSession(
      projectPath,
      'sid-recovery',
      'Recovery test',
      buildOptions(),
      coordinator,
      { planner: buildTestPlanner() }
    )

    await session.init()
    await session.executeNextTurn()

    const baseDir = path.join(projectPath, 'yolo', 'sid-recovery')
    await fs.writeFile(path.join(baseDir, 'assets', '.staging', 'ghost.json'), '{}\n', 'utf-8')
    await fs.writeFile(path.join(baseDir, 'turns', '.staging', '2.report.json'), '{}\n', 'utf-8')
    await fs.writeFile(path.join(baseDir, 'turns', '2.report.json'), '{}\n', 'utf-8')
    await fs.writeFile(path.join(baseDir, 'assets', 'Claim-t002-a1-001.json'), '{}\n', 'utf-8')

    const sessionStatePath = path.join(baseDir, 'session.json')
    const brokenState = await readJson<{ state: string }>(sessionStatePath)
    brokenState.state = 'CRASHED'
    await fs.writeFile(sessionStatePath, `${JSON.stringify(brokenState, null, 2)}\n`, 'utf-8')

    const recovery = await session.recoverFromCrash()

    expect(recovery.lastDurableTurn).toBe(1)
    expect(recovery.cleaned.some((item) => item.includes('assets/.staging/ghost.json'))).toBe(true)
    expect(recovery.cleaned.some((item) => item.includes('turns/.staging/2.report.json'))).toBe(true)

    await expect(fs.access(path.join(baseDir, 'turns', '2.report.json'))).rejects.toThrow()
    await expect(fs.access(path.join(baseDir, 'assets', 'Claim-t002-a1-001.json'))).rejects.toThrow()

    const snapshot = await session.getSnapshot()
    expect(snapshot.currentTurn).toBe(1)
    expect(snapshot.state).toBe('TURN_COMPLETE')

    const events = await readJsonl(path.join(baseDir, 'events.jsonl'))
    const crashEvents = events.filter((event) => (event as { eventType: string }).eventType === 'crash_recovery')
    expect(crashEvents.length).toBeGreaterThan(0)
  })

  it('creates session from helper factory with injected coordinator', async () => {
    const projectPath = await createTempDir('yolo-factory-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Factory assembly test',
      options: buildOptions(),
      planner: buildTestPlanner(),
      coordinator: createStaticYoloCoordinator({
        summary: 'factory turn',
        assets: [{ type: 'RiskRegister', payload: { reason: 'factory' } }],
        metrics: {
          toolCalls: 0,
          wallClockSec: 0,
          stepCount: 1,
          readBytes: 0,
          promptTokens: 0,
          completionTokens: 0,
          turnTokens: 0,
          turnCostUsd: 0,
          discoveryOps: 0
        }
      })
    })

    await session.init()
    const result = await session.executeNextTurn()
    expect(result.turnReport.summary).toBe('factory turn')
  })

  it('enters WAITING_FOR_USER when coordinator emits blocking ask_user', async () => {
    const projectPath = await createTempDir('yolo-ask-user-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Need user checkpoint',
      options: buildOptions(),
      planner: buildTestPlanner(),
      coordinator: createStaticYoloCoordinator({
        summary: 'need user confirmation',
        assets: [{ type: 'Decision', payload: { pending: true } }],
        askUser: {
          question: 'Confirm claim freeze?',
          checkpoint: 'claim-freeze',
          blocking: true
        },
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 0,
          promptTokens: 0,
          completionTokens: 0,
          turnTokens: 0,
          turnCostUsd: 0,
          discoveryOps: 0
        }
      })
    })

    await session.init()
    await session.executeNextTurn()
    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('WAITING_FOR_USER')
    expect(snapshot.pendingQuestion?.question).toBe('Confirm claim freeze?')

    const events = await readJsonl(path.join(projectPath, 'yolo', snapshot.sessionId, 'events.jsonl'))
    const askEvents = events.filter((event) => (event as { eventType: string }).eventType === 'ask_user_emitted')
    expect(askEvents).toHaveLength(1)
  })

  it('records Decision asset and checkpoint_confirmed event when user confirms checkpoint', async () => {
    const projectPath = await createTempDir('yolo-checkpoint-confirm-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Checkpoint decision recording',
      options: buildOptions(),
      planner: buildTestPlanner(),
      coordinator: createStaticYoloCoordinator({
        summary: 'need checkpoint decision',
        assets: [{ type: 'RiskRegister', payload: { reason: 'await checkpoint confirmation' } }],
        askUser: {
          question: 'Approve claim freeze?',
          checkpoint: 'claim-freeze',
          blocking: true
        },
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 0,
          promptTokens: 0,
          completionTokens: 0,
          turnTokens: 0,
          turnCostUsd: 0,
          discoveryOps: 0
        }
      })
    })

    await session.init()
    await session.executeNextTurn()

    const decisionAssetId = await session.recordCheckpointDecision('Confirm')
    expect(decisionAssetId).toBeTruthy()

    const secondCallId = await session.recordCheckpointDecision('Confirm again')
    expect(secondCallId).toBe(decisionAssetId)

    const baseDir = path.join(projectPath, 'yolo', (await session.getSnapshot()).sessionId)
    const decisionAssetPath = path.join(baseDir, 'assets', `${decisionAssetId as string}.json`)
    const decisionAsset = await readJson<{
      type: string
      payload: { checkpoint?: string; responseText?: string; questionId?: string }
      createdByAttempt: number
    }>(decisionAssetPath)
    expect(decisionAsset.type).toBe('Decision')
    expect(decisionAsset.payload.kind).toBe('claim-freeze')
    expect(decisionAsset.payload.checkpoint).toBe('claim-freeze')
    expect(decisionAsset.payload.choice).toBe('Confirm')
    expect(decisionAsset.payload.responseText).toBe('Confirm')
    expect(typeof decisionAsset.payload.questionId).toBe('string')
    expect(decisionAsset.createdByAttempt).toBe(0)

    const events = await readJsonl(path.join(baseDir, 'events.jsonl'))
    const checkpointEvents = events.filter((event) => {
      const typed = event as { eventType?: string; payload?: { decisionAssetId?: string } }
      return typed.eventType === 'checkpoint_confirmed' && typed.payload?.decisionAssetId === decisionAssetId
    })
    expect(checkpointEvents).toHaveLength(1)
  })

  it('auto-binds claim-freeze checkpoint Decision to asserted claim ids', async () => {
    const projectPath = await createTempDir('yolo-checkpoint-autobind-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Checkpoint auto binding',
      options: buildOptions(),
      planner: buildTestPlanner(),
      coordinator: createStaticYoloCoordinator({
        summary: 'need claim-freeze decision with asserted claim',
        assets: [
          { type: 'Claim', payload: { state: 'asserted', tier: 'primary', statement: 'bound claim' } }
        ],
        askUser: {
          question: 'Freeze this asserted claim?',
          checkpoint: 'claim-freeze',
          blocking: true
        },
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 0,
          promptTokens: 0,
          completionTokens: 0,
          turnTokens: 0,
          turnCostUsd: 0,
          discoveryOps: 0
        }
      })
    })

    await session.init()
    await session.executeNextTurn()

    const decisionAssetId = await session.recordCheckpointDecision('Approve freeze')
    expect(decisionAssetId).toBeTruthy()

    const baseDir = path.join(projectPath, 'yolo', (await session.getSnapshot()).sessionId)
    const decisionAssetPath = path.join(baseDir, 'assets', `${decisionAssetId as string}.json`)
    const decisionAsset = await readJson<{
      type: string
      payload: { referencedAssetIds?: string[]; kind?: string; checkpoint?: string }
    }>(decisionAssetPath)

    expect(decisionAsset.type).toBe('Decision')
    expect(decisionAsset.payload.kind).toBe('claim-freeze')
    expect(decisionAsset.payload.checkpoint).toBe('claim-freeze')
    expect(Array.isArray(decisionAsset.payload.referencedAssetIds)).toBe(true)
    expect(decisionAsset.payload.referencedAssetIds).toContain('Claim-t001-a1-001')
  })

  it('auto-populates pending claim-freeze question with asserted claim references', async () => {
    const projectPath = await createTempDir('yolo-checkpoint-pending-refs-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Pending question claim references',
      options: buildOptions(),
      planner: buildTestPlanner(),
      coordinator: createStaticYoloCoordinator({
        summary: 'emit claim-freeze question with asserted claim',
        assets: [
          { type: 'Claim', payload: { state: 'asserted', tier: 'primary', statement: 'pending bound claim' } }
        ],
        askUser: {
          question: 'Freeze this claim now?',
          checkpoint: 'claim-freeze',
          blocking: true
        },
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 0,
          promptTokens: 0,
          completionTokens: 0,
          turnTokens: 0,
          turnCostUsd: 0,
          discoveryOps: 0
        }
      })
    })

    await session.init()
    await session.executeNextTurn()
    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('WAITING_FOR_USER')
    expect(snapshot.pendingQuestion?.checkpoint).toBe('claim-freeze')
    expect(Array.isArray(snapshot.pendingQuestion?.referencedAssetIds)).toBe(true)
    expect(snapshot.pendingQuestion?.referencedAssetIds).toContain('Claim-t001-a1-001')
  })

  it('falls back to conservative TurnSpec when planner emits invalid spec', async () => {
    const projectPath = await createTempDir('yolo-planner-fallback-')
    tempDirs.push(projectPath)

    const invalidPlanner: TurnPlanner = {
      async generate(): Promise<PlannerOutput> {
        return {
          turnSpec: {
            turnNumber: 0,
            stage: 'S1',
            branch: { activeBranchId: '', activeNodeId: '', action: 'advance' },
            objective: '',
            expectedAssets: [],
            constraints: {
              maxToolCalls: 0,
              maxWallClockSec: 0,
              maxStepCount: 0,
              maxNewAssets: 0,
              maxDiscoveryOps: 0,
              maxReadBytes: 0,
              maxPromptTokens: 0,
              maxCompletionTokens: 0,
              maxTurnTokens: 0,
              maxTurnCostUsd: 0
            }
          },
          suggestedPrompt: 'invalid',
          rationale: 'invalid planner output',
          uncertaintyNote: 'n/a'
        }
      }
    }

    // Inject planner via direct session construction to keep fallback test deterministic.
    const directSession = new YoloSession(
      projectPath,
      'sid-fallback',
      'fallback planner test',
      buildOptions(),
      createStaticYoloCoordinator({
        summary: 'fallback used',
        assets: [{ type: 'RiskRegister', payload: { fallback: true } }],
        metrics: {
          toolCalls: 0,
          wallClockSec: 0,
          stepCount: 1,
          readBytes: 0,
          promptTokens: 0,
          completionTokens: 0,
          turnTokens: 0,
          turnCostUsd: 0,
          discoveryOps: 0
        }
      }),
      { planner: invalidPlanner }
    )

    await directSession.init()
    const result = await directSession.executeNextTurn()
    expect(result.turnReport.turnSpec.objective).toBe('consolidate current state and report blockers')
  })
})
