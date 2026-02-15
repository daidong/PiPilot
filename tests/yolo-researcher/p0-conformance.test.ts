/**
 * RFC-002 §19 P0 Runtime Conformance Tests
 *
 * Each test group maps to a numbered P0-required test from the RFC.
 * Tests use ScriptedCoordinator (deterministic mock) and a simple test planner.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ScriptedCoordinator,
  YoloSession,
  StubGateEngine,
  createConservativeFallbackSpec,
  buildDefaultP0Constraints,
  createYoloSession,
  createStaticYoloCoordinator,
  type CoordinatorTurnMetrics,
  type PlannerInput,
  type PlannerOutput,
  type TurnConstraints,
  type TurnPlanner,
  type TurnReport,
  type YoloSessionOptions,
  type YoloEvent,
  type YoloEventType
} from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function buildOptions(overrides?: Partial<YoloSessionOptions>): YoloSessionOptions {
  return {
    phase: 'P0',
    budget: {
      maxTurns: 10,
      maxTokens: 100_000,
      maxCostUsd: 100
    },
    models: {
      planner: 'gpt-5-nano',
      coordinator: 'gpt-5-mini'
    },
    ...overrides
  }
}

function quietMetrics(overrides?: Partial<CoordinatorTurnMetrics>): CoordinatorTurnMetrics {
  return {
    toolCalls: 1,
    wallClockSec: 1,
    stepCount: 1,
    readBytes: 100,
    promptTokens: 100,
    completionTokens: 50,
    turnTokens: 150,
    turnCostUsd: 0.01,
    discoveryOps: 1,
    ...overrides
  }
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

/** Build a custom planner that sets specific tight constraints. */
function tightConstraintPlanner(constraintOverrides: Partial<TurnConstraints>): TurnPlanner {
  const base = buildDefaultP0Constraints()
  return {
    async generate(input: PlannerInput): Promise<PlannerOutput> {
      return {
        turnSpec: {
          ...createConservativeFallbackSpec({
            turnNumber: input.turnNumber,
            stage: input.stage,
            activeBranchId: input.activeBranchId,
            activeNodeId: input.activeNodeId
          }),
          constraints: { ...base, ...constraintOverrides }
        },
        suggestedPrompt: 'constraint test',
        rationale: 'testing hard constraint enforcement',
        uncertaintyNote: 'none'
      }
    }
  }
}

function sessionDir(projectPath: string, sid: string): string {
  return path.join(projectPath, 'yolo', sid)
}

// ---------------------------------------------------------------------------
// RFC §19 P0 Conformance Tests
// ---------------------------------------------------------------------------

describe('RFC §19 P0 Conformance Tests', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  // =========================================================================
  // [P0-01] enforce tight TurnSpec bounds
  // =========================================================================
  describe('[P0-01] enforce tight TurnSpec bounds', () => {
    async function expectViolation(
      field: keyof TurnConstraints,
      constraintValue: number,
      metricsOverride: Partial<CoordinatorTurnMetrics>
    ) {
      const projectPath = await createTempDir(`yolo-p0-01-${field}-`)
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath,
        `sid-${field}`,
        `Test ${field} hard enforcement`,
        buildOptions(),
        new ScriptedCoordinator([{
          summary: `violate ${field}`,
          assets: [{ type: 'RiskRegister', payload: { reason: `${field} violation` } }],
          metrics: quietMetrics(metricsOverride)
        }]),
        { planner: tightConstraintPlanner({ [field]: constraintValue }) }
      )

      await session.init()
      await expect(session.executeNextTurn()).rejects.toThrow('hard constraint violation')
      const snapshot = await session.getSnapshot()
      expect(snapshot.state).toBe('FAILED')
    }

    it('rejects maxToolCalls violation', async () => {
      await expectViolation('maxToolCalls', 1, { toolCalls: 5 })
    })

    it('rejects maxWallClockSec violation', async () => {
      await expectViolation('maxWallClockSec', 1, { wallClockSec: 10 })
    })

    it('rejects maxStepCount violation', async () => {
      await expectViolation('maxStepCount', 1, { stepCount: 5 })
    })

    it('rejects maxNewAssets violation', async () => {
      const projectPath = await createTempDir('yolo-p0-01-assets-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath,
        'sid-maxassets',
        'Test maxNewAssets hard enforcement',
        buildOptions(),
        new ScriptedCoordinator([{
          summary: 'too many assets',
          assets: [
            { type: 'Hypothesis', payload: { text: 'h1' } },
            { type: 'Hypothesis', payload: { text: 'h2' } },
            { type: 'Hypothesis', payload: { text: 'h3' } }
          ],
          metrics: quietMetrics()
        }]),
        { planner: tightConstraintPlanner({ maxNewAssets: 1 }) }
      )

      await session.init()
      await expect(session.executeNextTurn()).rejects.toThrow('hard constraint violation')
    })

    it('rejects maxReadBytes violation', async () => {
      await expectViolation('maxReadBytes', 8, { readBytes: 100 })
    })
  })

  // =========================================================================
  // [P0-02] advance produces valid linear tree mutation
  // =========================================================================
  describe('[P0-02] advance produces valid linear tree', () => {
    it('produces sequential nodes on single branch across 3 turns', async () => {
      const projectPath = await createTempDir('yolo-p0-02-')
      tempDirs.push(projectPath)

      const coordinator = new ScriptedCoordinator([
        { summary: 'turn 1', assets: [{ type: 'Hypothesis', payload: { text: 'h1' } }], metrics: quietMetrics() },
        { summary: 'turn 2', assets: [{ type: 'Claim', payload: { text: 'c1' } }], metrics: quietMetrics() },
        { summary: 'turn 3', assets: [{ type: 'RiskRegister', payload: { text: 'r1' } }], metrics: quietMetrics() }
      ])

      const session = new YoloSession(
        projectPath, 'sid-linear', 'Linear tree test', buildOptions(), coordinator,
        { planner: buildTestPlanner() }
      )

      const r1 = await session.executeNextTurn()
      const r2 = await session.executeNextTurn()
      const r3 = await session.executeNextTurn()

      // Verify sequential node IDs
      expect(r1.branchNode.nodeId).toBe('N-002')
      expect(r2.branchNode.nodeId).toBe('N-003')
      expect(r3.branchNode.nodeId).toBe('N-004')

      // All on same branch
      expect(r1.branchNode.branchId).toBe('B-001')
      expect(r2.branchNode.branchId).toBe('B-001')
      expect(r3.branchNode.branchId).toBe('B-001')

      // Parent chain is sequential
      expect(r1.branchNode.parentNodeId).toBe('N-001')
      expect(r2.branchNode.parentNodeId).toBe('N-002')
      expect(r3.branchNode.parentNodeId).toBe('N-003')

      // Verify branch tree index on disk
      const base = sessionDir(projectPath, 'sid-linear')
      const tree = await readJson<{ activeNodeId: string; nodeIds: string[] }>(
        path.join(base, 'branches', 'tree.json')
      )
      expect(tree.activeNodeId).toBe('N-004')
      expect(tree.nodeIds).toEqual(['N-001', 'N-002', 'N-003', 'N-004'])
    })
  })

  // =========================================================================
  // [P0-03] asset append-only and supersedes chain
  // =========================================================================
  describe('[P0-03] asset append-only and supersedes chain', () => {
    it('preserves both original and superseding assets', async () => {
      const projectPath = await createTempDir('yolo-p0-03-')
      tempDirs.push(projectPath)

      const coordinator = new ScriptedCoordinator([
        {
          summary: 'create initial hypothesis',
          assets: [{ type: 'Hypothesis', payload: { text: 'original hypothesis' } }],
          metrics: quietMetrics()
        },
        {
          summary: 'update hypothesis',
          assets: [{
            type: 'Hypothesis',
            payload: { text: 'revised hypothesis' },
            supersedes: 'Hypothesis-t001-a1-001'
          }],
          metrics: quietMetrics()
        }
      ])

      const session = new YoloSession(
        projectPath, 'sid-supersedes', 'Supersedes chain test', buildOptions(), coordinator,
        { planner: buildTestPlanner() }
      )

      await session.executeNextTurn()
      const r2 = await session.executeNextTurn()

      const base = sessionDir(projectPath, 'sid-supersedes')
      const assetsDir = path.join(base, 'assets')

      // Both assets must exist (append-only)
      const original = await readJson<{ id: string; payload: { text: string } }>(
        path.join(assetsDir, 'Hypothesis-t001-a1-001.json')
      )
      const revised = await readJson<{ id: string; supersedes: string; payload: { text: string } }>(
        path.join(assetsDir, 'Hypothesis-t002-a1-001.json')
      )

      expect(original.payload.text).toBe('original hypothesis')
      expect(revised.payload.text).toBe('revised hypothesis')
      expect(revised.supersedes).toBe('Hypothesis-t001-a1-001')

      // Turn report records the update
      expect(r2.turnReport.assetDiff.updated).toEqual([
        { newId: 'Hypothesis-t002-a1-001', supersedes: 'Hypothesis-t001-a1-001' }
      ])
    })
  })

  // =========================================================================
  // [P0-04] turn report records asset diff, branch diff, planner input snapshot
  // =========================================================================
  describe('[P0-04] turn report completeness', () => {
    it('populates assetDiff, branchDiff, and plannerInputManifest', async () => {
      const projectPath = await createTempDir('yolo-p0-04-')
      tempDirs.push(projectPath)

      const coordinator = new ScriptedCoordinator([{
        summary: 'comprehensive turn',
        assets: [
          { type: 'Hypothesis', payload: { text: 'h1' } },
          { type: 'EvidenceLink', payload: { claimId: 'c1', evidenceId: 'e1', relation: 'supports', countingPolicy: 'countable', applicability: {} } }
        ],
        metrics: quietMetrics()
      }])

      const session = new YoloSession(
        projectPath, 'sid-report', 'Report completeness test', buildOptions(), coordinator,
        { planner: buildTestPlanner() }
      )

      const result = await session.executeNextTurn()
      const report = result.turnReport

      // assetDiff
      expect(report.assetDiff.created.length).toBeGreaterThanOrEqual(2)
      expect(report.assetDiff.created.some((id) => id.startsWith('Hypothesis-'))).toBe(true)
      expect(report.assetDiff.linked.some((id) => id.startsWith('EvidenceLink-'))).toBe(true)

      // branchDiff
      expect(report.branchDiff.activeNode).toBeTruthy()
      expect(report.branchDiff.action).toBe('advance')

      // plannerInputManifest
      expect(typeof report.plannerInputManifest.planSnapshotHash).toBe('string')
      expect(report.plannerInputManifest.planSnapshotHash.length).toBeGreaterThan(0)
      expect(typeof report.plannerInputManifest.branchDossierHash).toBe('string')
      expect(report.plannerInputManifest.branchDossierHash.length).toBeGreaterThan(0)
      expect(Array.isArray(report.plannerInputManifest.selectedAssetSnapshotIds)).toBe(true)

      // Turn report persisted on disk
      const base = sessionDir(projectPath, 'sid-report')
      const diskReport = await readJson<TurnReport>(path.join(base, 'turns', '1.report.json'))
      expect(diskReport.turnNumber).toBe(1)
      expect(diskReport.plannerInputManifest.planSnapshotHash).toBe(report.plannerInputManifest.planSnapshotHash)
    })
  })

  // =========================================================================
  // [P0-05] StubGateEngine pass and forced-fail branches
  // =========================================================================
  describe('[P0-05] StubGateEngine pass and forced-fail', () => {
    it('default StubGateEngine passes and emits gate_evaluated event', async () => {
      const projectPath = await createTempDir('yolo-p0-05-pass-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath, 'sid-gate-pass', 'Gate pass test', buildOptions(),
        new ScriptedCoordinator([{
          summary: 'gate should pass',
          assets: [{ type: 'Hypothesis', payload: { text: 'h1' } }],
          metrics: quietMetrics()
        }]),
        { planner: buildTestPlanner(), gateEngine: new StubGateEngine() }
      )

      const result = await session.executeNextTurn()
      expect(result.turnReport.gateImpact.gateResult.passed).toBe(true)

      const events = await readJsonl(path.join(sessionDir(projectPath, 'sid-gate-pass'), 'events.jsonl'))
      const gateEvents = events.filter((e) => (e as { eventType: string }).eventType === 'gate_evaluated')
      expect(gateEvents.length).toBeGreaterThan(0)
      const gatePayload = (gateEvents[0] as { payload: { passed: boolean } }).payload
      expect(gatePayload.passed).toBe(true)
    })

    it('forced-fail StubGateEngine records gate failure', async () => {
      const projectPath = await createTempDir('yolo-p0-05-fail-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath, 'sid-gate-fail', 'Gate forced-fail test', buildOptions(),
        new ScriptedCoordinator([{
          summary: 'gate should fail',
          assets: [{ type: 'Hypothesis', payload: { text: 'h1' } }],
          metrics: quietMetrics()
        }]),
        { planner: buildTestPlanner(), gateEngine: new StubGateEngine({ forceFail: true }) }
      )

      const result = await session.executeNextTurn()
      expect(result.turnReport.gateImpact.gateResult.passed).toBe(false)
      expect(result.turnReport.gateImpact.status).toBe('fail')

      const events = await readJsonl(path.join(sessionDir(projectPath, 'sid-gate-fail'), 'events.jsonl'))
      const gateEvents = events.filter((e) => (e as { eventType: string }).eventType === 'gate_evaluated')
      expect(gateEvents.length).toBeGreaterThan(0)
      const gatePayload = (gateEvents[0] as { payload: { passed: boolean; hardBlockerLabels: string[] } }).payload
      expect(gatePayload.passed).toBe(false)
      expect(gatePayload.hardBlockerLabels.length).toBeGreaterThan(0)
    })
  })

  // =========================================================================
  // [P0-06] token/cost constraint enforcement
  // =========================================================================
  describe('[P0-06] token/cost constraint enforcement', () => {
    it('rejects maxPromptTokens violation', async () => {
      const projectPath = await createTempDir('yolo-p0-06-prompt-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath, 'sid-prompt', 'Prompt token test', buildOptions(),
        new ScriptedCoordinator([{
          summary: 'prompt overflow',
          assets: [{ type: 'RiskRegister', payload: { reason: 'overflow' } }],
          metrics: quietMetrics({ promptTokens: 500 })
        }]),
        { planner: tightConstraintPlanner({ maxPromptTokens: 100 }) }
      )

      await session.init()
      await expect(session.executeNextTurn()).rejects.toThrow('hard constraint violation')
    })

    it('rejects maxCompletionTokens violation', async () => {
      const projectPath = await createTempDir('yolo-p0-06-completion-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath, 'sid-completion', 'Completion token test', buildOptions(),
        new ScriptedCoordinator([{
          summary: 'completion overflow',
          assets: [{ type: 'RiskRegister', payload: { reason: 'overflow' } }],
          metrics: quietMetrics({ completionTokens: 500 })
        }]),
        { planner: tightConstraintPlanner({ maxCompletionTokens: 100 }) }
      )

      await session.init()
      await expect(session.executeNextTurn()).rejects.toThrow('hard constraint violation')
    })

    it('rejects maxTurnTokens violation', async () => {
      const projectPath = await createTempDir('yolo-p0-06-turn-tokens-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath, 'sid-turntokens', 'Turn token test', buildOptions(),
        new ScriptedCoordinator([{
          summary: 'turn token overflow',
          assets: [{ type: 'RiskRegister', payload: { reason: 'overflow' } }],
          metrics: quietMetrics({ turnTokens: 2000 })
        }]),
        { planner: tightConstraintPlanner({ maxTurnTokens: 500 }) }
      )

      await session.init()
      await expect(session.executeNextTurn()).rejects.toThrow('hard constraint violation')
    })

    it('rejects maxTurnCostUsd violation', async () => {
      const projectPath = await createTempDir('yolo-p0-06-cost-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath, 'sid-cost', 'Turn cost test', buildOptions(),
        new ScriptedCoordinator([{
          summary: 'cost overflow',
          assets: [{ type: 'RiskRegister', payload: { reason: 'overflow' } }],
          metrics: quietMetrics({ turnCostUsd: 5.0 })
        }]),
        { planner: tightConstraintPlanner({ maxTurnCostUsd: 1.0 }) }
      )

      await session.init()
      await expect(session.executeNextTurn()).rejects.toThrow('hard constraint violation')
    })
  })

  // =========================================================================
  // [P0-07] pause/resume/stop lifecycle
  // =========================================================================
  describe('[P0-07] pause/resume/stop lifecycle', () => {
    it('pause → resume cycle preserves state', async () => {
      const projectPath = await createTempDir('yolo-p0-07-pause-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath, 'sid-pause', 'Pause/resume test', buildOptions(),
        new ScriptedCoordinator([
          { summary: 'turn 1', assets: [{ type: 'Hypothesis', payload: { text: 'h1' } }], metrics: quietMetrics() },
          { summary: 'turn 2', assets: [{ type: 'Claim', payload: { text: 'c1' } }], metrics: quietMetrics() }
        ]),
        { planner: buildTestPlanner() }
      )

      await session.executeNextTurn()
      await session.pause()
      let snapshot = await session.getSnapshot()
      expect(snapshot.state).toBe('PAUSED')
      expect(snapshot.currentTurn).toBe(1)

      // Cannot execute while paused
      await expect(session.executeNextTurn()).rejects.toThrow('session is paused')

      await session.resume()
      snapshot = await session.getSnapshot()
      expect(snapshot.state).toBe('PLANNING')

      // Can continue after resume
      const r2 = await session.executeNextTurn()
      expect(r2.turnReport.turnNumber).toBe(2)
    })

    it('stop → resume with remaining budget', async () => {
      const projectPath = await createTempDir('yolo-p0-07-stop-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath, 'sid-stop', 'Stop/resume test', buildOptions(),
        new ScriptedCoordinator([
          { summary: 'turn 1', assets: [{ type: 'Hypothesis', payload: { text: 'h1' } }], metrics: quietMetrics() },
          { summary: 'turn 2', assets: [{ type: 'Claim', payload: { text: 'c1' } }], metrics: quietMetrics() }
        ]),
        { planner: buildTestPlanner() }
      )

      await session.executeNextTurn()
      await session.stop()
      let snapshot = await session.getSnapshot()
      expect(snapshot.state).toBe('STOPPED')

      await session.resume()
      snapshot = await session.getSnapshot()
      expect(snapshot.state).toBe('PLANNING')
    })

    it('cannot resume from STOPPED when budget is exhausted', async () => {
      const projectPath = await createTempDir('yolo-p0-07-exhausted-')
      tempDirs.push(projectPath)

      const options = buildOptions()
      options.budget.maxTurns = 1

      const session = new YoloSession(
        projectPath, 'sid-exhausted', 'Budget exhaustion test', options,
        new ScriptedCoordinator([
          { summary: 'only turn', assets: [{ type: 'Hypothesis', payload: { text: 'h1' } }], metrics: quietMetrics() }
        ]),
        { planner: buildTestPlanner() }
      )

      const result = await session.executeNextTurn()
      expect(result.newState).toBe('STOPPED')

      await expect(session.resume()).rejects.toThrow()
    })

    it('restart from TURN_COMPLETE by constructing new session over same dir', async () => {
      const projectPath = await createTempDir('yolo-p0-07-restart-')
      tempDirs.push(projectPath)

      const session1 = new YoloSession(
        projectPath, 'sid-restart', 'Restart test', buildOptions(),
        new ScriptedCoordinator([
          { summary: 'turn 1', assets: [{ type: 'Hypothesis', payload: { text: 'h1' } }], metrics: quietMetrics() }
        ]),
        { planner: buildTestPlanner() }
      )

      await session1.executeNextTurn()
      const snap1 = await session1.getSnapshot()
      expect(snap1.currentTurn).toBe(1)

      // Simulate restart: new session instance over same directory
      const session2 = new YoloSession(
        projectPath, 'sid-restart', 'Restart test', buildOptions(),
        new ScriptedCoordinator([
          { summary: 'turn 2', assets: [{ type: 'Claim', payload: { text: 'c1' } }], metrics: quietMetrics() }
        ]),
        { planner: buildTestPlanner() }
      )

      await session2.init()
      const snap2 = await session2.getSnapshot()
      expect(snap2.currentTurn).toBe(1)
      expect(snap2.sessionId).toBe('sid-restart')

      const r2 = await session2.executeNextTurn()
      expect(r2.turnReport.turnNumber).toBe(2)
    })
  })

  // =========================================================================
  // [P0-08] crash recovery: staging cleanup, no ghost assets
  // =========================================================================
  describe('[P0-08] crash recovery', () => {
    it('cleans staging dirs and removes ghost assets/turns after crash', async () => {
      const projectPath = await createTempDir('yolo-p0-08-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath, 'sid-crash', 'Crash recovery test', buildOptions(),
        new ScriptedCoordinator([
          { summary: 'durable turn', assets: [{ type: 'Claim', payload: { text: 'toy claim' } }], metrics: quietMetrics() }
        ]),
        { planner: buildTestPlanner() }
      )

      await session.init()
      await session.executeNextTurn()

      // Simulate crash artifacts
      const base = sessionDir(projectPath, 'sid-crash')
      await fs.writeFile(path.join(base, 'assets', '.staging', 'ghost.json'), '{}\n')
      await fs.writeFile(path.join(base, 'turns', '.staging', '2.report.json'), '{}\n')
      await fs.writeFile(path.join(base, 'turns', '2.report.json'), '{}\n')
      await fs.writeFile(path.join(base, 'assets', 'Claim-t002-a1-001.json'), '{}\n')

      const recovery = await session.recoverFromCrash()
      expect(recovery.lastDurableTurn).toBe(1)
      expect(recovery.cleaned.some((f) => f.includes('assets/.staging/ghost.json'))).toBe(true)
      expect(recovery.cleaned.some((f) => f.includes('turns/.staging/2.report.json'))).toBe(true)

      // Ghost assets and turns removed
      await expect(fs.access(path.join(base, 'turns', '2.report.json'))).rejects.toThrow()
      await expect(fs.access(path.join(base, 'assets', 'Claim-t002-a1-001.json'))).rejects.toThrow()

      // State restored to last durable turn
      const snapshot = await session.getSnapshot()
      expect(snapshot.currentTurn).toBe(1)
      expect(snapshot.state).toBe('TURN_COMPLETE')

      // crash_recovery event emitted
      const events = await readJsonl(path.join(base, 'events.jsonl'))
      const crashEvents = events.filter((e) => (e as { eventType: string }).eventType === 'crash_recovery')
      expect(crashEvents.length).toBeGreaterThan(0)
    })
  })

  // =========================================================================
  // [P0-09] Decision asset on checkpoint + checkpoint_confirmed event
  // =========================================================================
  describe('[P0-09] Decision asset on checkpoint confirmation', () => {
    it('writes Decision asset and checkpoint_confirmed event', async () => {
      const projectPath = await createTempDir('yolo-p0-09-')
      tempDirs.push(projectPath)

      const session = createYoloSession({
        projectPath,
        goal: 'Checkpoint decision test',
        options: buildOptions(),
        planner: buildTestPlanner(),
        coordinator: createStaticYoloCoordinator({
          summary: 'need checkpoint',
          assets: [{ type: 'Claim', payload: { state: 'proposed', tier: 'primary', text: 'test claim' } }],
          askUser: {
            question: 'Approve claim freeze?',
            checkpoint: 'claim-freeze',
            blocking: true
          },
          metrics: quietMetrics()
        })
      })

      await session.init()
      await session.executeNextTurn()

      const decisionId = await session.recordCheckpointDecision('Approved')
      expect(decisionId).toBeTruthy()

      // Idempotent: second call returns same ID
      const secondId = await session.recordCheckpointDecision('Approved again')
      expect(secondId).toBe(decisionId)

      const base = sessionDir(projectPath, (await session.getSnapshot()).sessionId)

      // Decision asset on disk
      const decision = await readJson<{
        type: string
        payload: { kind: string; choice: string; checkpoint: string }
      }>(path.join(base, 'assets', `${decisionId}.json`))
      expect(decision.type).toBe('Decision')
      expect(decision.payload.kind).toBe('claim-freeze')
      expect(decision.payload.checkpoint).toBe('claim-freeze')
      expect(decision.payload.choice).toBe('Approved')

      // checkpoint_confirmed event
      const events = await readJsonl(path.join(base, 'events.jsonl'))
      const confirmed = events.filter((e) => {
        const typed = e as { eventType?: string; payload?: { decisionAssetId?: string } }
        return typed.eventType === 'checkpoint_confirmed' && typed.payload?.decisionAssetId === decisionId
      })
      expect(confirmed).toHaveLength(1)
    })
  })

  // =========================================================================
  // [P0-10] SnapshotManifest in turn report; gate receives manifest
  // =========================================================================
  describe('[P0-10] SnapshotManifest generation and gate input', () => {
    it('turn report contains valid SnapshotManifest and gate evaluates it', async () => {
      const projectPath = await createTempDir('yolo-p0-10-')
      tempDirs.push(projectPath)

      // Track what the gate engine receives
      let receivedManifestId: string | undefined
      const trackingGate = new StubGateEngine()
      const originalEvaluate = trackingGate.evaluate.bind(trackingGate)
      trackingGate.evaluate = (manifest) => {
        receivedManifestId = manifest.id
        return originalEvaluate(manifest)
      }

      const session = new YoloSession(
        projectPath, 'sid-manifest', 'Manifest test', buildOptions(),
        new ScriptedCoordinator([{
          summary: 'manifest turn',
          assets: [
            { type: 'Hypothesis', payload: { text: 'h1' } },
            { type: 'Claim', payload: { text: 'c1', tier: 'primary', state: 'proposed' } }
          ],
          metrics: quietMetrics()
        }]),
        { planner: buildTestPlanner(), gateEngine: trackingGate }
      )

      const result = await session.executeNextTurn()
      const manifest = result.turnReport.gateImpact.snapshotManifest

      // Manifest structure
      expect(manifest.id).toBeTruthy()
      expect(Array.isArray(manifest.assetIds)).toBe(true)
      expect(manifest.assetIds.length).toBeGreaterThan(0)
      expect(Array.isArray(manifest.evidenceLinkIds)).toBe(true)
      expect(manifest.branchNodeId).toBeTruthy()
      expect(typeof manifest.planSnapshotHash).toBe('string')
      expect(manifest.planSnapshotHash.length).toBeGreaterThan(0)
      expect(manifest.generatedAtTurn).toBe(1)

      // Gate engine received the manifest (not a file list)
      expect(receivedManifestId).toBe(manifest.id)

      // Manifest is also persisted in turn report on disk
      const base = sessionDir(projectPath, 'sid-manifest')
      const diskReport = await readJson<TurnReport>(path.join(base, 'turns', '1.report.json'))
      expect(diskReport.gateImpact.snapshotManifest.id).toBe(manifest.id)
    })
  })

  // =========================================================================
  // [P0-11] event schema: valid YoloEvent with typed payload
  // =========================================================================
  describe('[P0-11] event schema validation', () => {
    const KNOWN_EVENT_TYPES: YoloEventType[] = [
      'turn_started',
      'turn_committed',
      'asset_created',
      'asset_updated',
      'branch_mutated',
      'gate_evaluated',
      'state_transition',
      'user_input_merged',
      'ask_user_emitted',
      'checkpoint_confirmed',
      'amendment_requested',
      'planner_spec_generated',
      'semantic_review_evaluated',
      'maintenance_alert',
      'crash_recovery'
    ]

    it('all events have required fields and valid schema', async () => {
      const projectPath = await createTempDir('yolo-p0-11-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath, 'sid-events', 'Event schema test', buildOptions(),
        new ScriptedCoordinator([
          { summary: 'turn 1', assets: [{ type: 'Hypothesis', payload: { text: 'h1' } }], metrics: quietMetrics() },
          { summary: 'turn 2', assets: [{ type: 'Claim', payload: { text: 'c1' } }], metrics: quietMetrics() }
        ]),
        { planner: buildTestPlanner() }
      )

      await session.executeNextTurn()
      await session.executeNextTurn()

      const base = sessionDir(projectPath, 'sid-events')
      const events = await readJsonl(path.join(base, 'events.jsonl')) as Array<Record<string, unknown>>

      expect(events.length).toBeGreaterThan(0)

      for (const event of events) {
        // Required fields present
        expect(typeof event.eventId).toBe('string')
        expect((event.eventId as string).length).toBeGreaterThan(0)
        expect(event.sessionId).toBe('sid-events')
        expect(typeof event.turnNumber).toBe('number')
        expect(typeof event.seq).toBe('number')
        expect(typeof event.timestamp).toBe('string')
        expect(typeof event.schemaVersion).toBe('number')
        expect(event.schemaVersion).toBe(1)
        expect(typeof event.eventType).toBe('string')
        expect(KNOWN_EVENT_TYPES).toContain(event.eventType)
        expect(event.payload).toBeTruthy()
        expect(typeof event.payload).toBe('object')
      }
    })

    it('seq is monotonically increasing within each turn', async () => {
      const projectPath = await createTempDir('yolo-p0-11-seq-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath, 'sid-seq', 'Seq monotonic test', buildOptions(),
        new ScriptedCoordinator([
          { summary: 'turn 1', assets: [{ type: 'Hypothesis', payload: { text: 'h1' } }], metrics: quietMetrics() }
        ]),
        { planner: buildTestPlanner() }
      )

      await session.executeNextTurn()

      const base = sessionDir(projectPath, 'sid-seq')
      const events = await readJsonl(path.join(base, 'events.jsonl')) as Array<{ turnNumber: number; seq: number }>

      // Group events by turn
      const byTurn = new Map<number, number[]>()
      for (const event of events) {
        const seqs = byTurn.get(event.turnNumber) ?? []
        seqs.push(event.seq)
        byTurn.set(event.turnNumber, seqs)
      }

      // Verify monotonic increase within each turn
      for (const [, seqs] of byTurn) {
        for (let i = 1; i < seqs.length; i++) {
          expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
        }
      }
    })

    it('minimum event types are present for a normal turn', async () => {
      const projectPath = await createTempDir('yolo-p0-11-types-')
      tempDirs.push(projectPath)

      const session = new YoloSession(
        projectPath, 'sid-types', 'Event types test', buildOptions(),
        new ScriptedCoordinator([
          { summary: 'turn 1', assets: [{ type: 'Hypothesis', payload: { text: 'h1' } }], metrics: quietMetrics() }
        ]),
        { planner: buildTestPlanner() }
      )

      await session.executeNextTurn()

      const base = sessionDir(projectPath, 'sid-types')
      const events = await readJsonl(path.join(base, 'events.jsonl'))
      const types = new Set(events.map((e) => (e as { eventType: string }).eventType))

      // A normal turn must produce at least these event types
      expect(types.has('state_transition')).toBe(true)
      expect(types.has('planner_spec_generated')).toBe(true)
      expect(types.has('turn_started')).toBe(true)
      expect(types.has('asset_created')).toBe(true)
      expect(types.has('branch_mutated')).toBe(true)
      expect(types.has('gate_evaluated')).toBe(true)
      expect(types.has('turn_committed')).toBe(true)
    })
  })
})
