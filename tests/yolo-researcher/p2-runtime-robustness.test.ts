import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildDefaultP0Constraints,
  ScriptedCoordinator,
  YoloSession,
  type PlannerInput,
  type PlannerOutput,
  type RuntimeLease,
  type TurnPlanner,
  type YoloSessionOptions
} from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

function buildOptions(): YoloSessionOptions {
  return {
    phase: 'P2',
    budget: {
      maxTurns: 8,
      maxTokens: 100_000,
      maxCostUsd: 100
    },
    models: {
      planner: 'gpt-5-nano',
      coordinator: 'gpt-5-mini'
    }
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T
}

async function readJsonl(filePath: string): Promise<any[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('P2 runtime robustness', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('writes runtime lease/checkpoints and deduplicates RunRecord by runKey', async () => {
    const projectPath = await createTempDir('yolo-p2-runtime-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'first run with duplicate runKey inside batch',
        assets: [
          {
            type: 'RunRecord',
            payload: { runKey: 'rk-dup-001', metric: 1 }
          },
          {
            type: 'RunRecord',
            payload: { runKey: 'rk-dup-001', metric: 2 }
          },
          {
            type: 'RiskRegister',
            payload: { reason: 'first turn' }
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
      },
      {
        summary: 'second run retries same runKey',
        assets: [
          {
            type: 'RunRecord',
            payload: { runKey: 'rk-dup-001', metric: 3 }
          },
          {
            type: 'RiskRegister',
            payload: { reason: 'second turn' }
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
      'sid-p2-runtime',
      'P2 runtime robustness test',
      buildOptions(),
      coordinator,
      { planner: new DeterministicPlannerAdvance() }
    )

    await session.init()
    const first = await session.executeNextTurn()
    const second = await session.executeNextTurn()

    expect(first.turnReport.assetDiff.created.some((id) => id.startsWith('RunRecord-'))).toBe(true)
    expect(second.turnReport.riskDelta.some((note) => note.includes('duplicate runKey skipped'))).toBe(true)
    expect(first.turnReport.readinessSnapshot?.phase).toBe('P2')
    expect(first.turnReport.readinessSnapshot?.stage).toBe('S1')
    expect(first.turnReport.readinessSnapshot?.pass).toBe(true)
    expect(first.turnReport.readinessSnapshot?.requiredFailed).toHaveLength(0)

    const baseDir = path.join(projectPath, 'yolo', 'sid-p2-runtime')
    const runtimeLeasePath = path.join(baseDir, 'runtime', 'lease.json')
    const runtimeLease = await readJson<RuntimeLease>(runtimeLeasePath)
    expect(runtimeLease.sessionId).toBe('sid-p2-runtime')
    expect(runtimeLease.ownerId).toContain('owner-')
    expect(runtimeLease.heartbeatAt >= runtimeLease.acquiredAt).toBe(true)

    const checkpointsDir = path.join(baseDir, 'runtime', 'checkpoints')
    const checkpointNames = await fs.readdir(checkpointsDir)
    expect(checkpointNames.some((name) => name.endsWith('-turn_complete.json'))).toBe(true)
    expect(checkpointNames).toContain('latest.json')

    const latest = await readJson<{ fileName?: string }>(path.join(checkpointsDir, 'latest.json'))
    expect(typeof latest.fileName).toBe('string')
    expect(latest.fileName?.length).toBeGreaterThan(0)

    const assetNames = await fs.readdir(path.join(baseDir, 'assets'))
    const runRecordAssets = assetNames.filter((name) => name.startsWith('RunRecord-'))
    expect(runRecordAssets).toHaveLength(1)
  })

  it('restores session state from latest runtime checkpoint', async () => {
    const projectPath = await createTempDir('yolo-p2-checkpoint-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'write one turn for checkpoint restore',
        assets: [
          {
            type: 'RiskRegister',
            payload: { reason: 'checkpoint restore' }
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
      'sid-p2-checkpoint',
      'P2 checkpoint restore test',
      buildOptions(),
      coordinator,
      { planner: new DeterministicPlannerAdvance() }
    )

    const result = await session.executeNextTurn()
    const expected = await session.getSnapshot()

    const sessionPath = path.join(projectPath, 'yolo', 'sid-p2-checkpoint', 'session.json')
    await fs.writeFile(sessionPath, JSON.stringify({
      ...expected,
      state: 'IDLE',
      currentTurn: 0,
      activeNodeId: 'N-001'
    }, null, 2), 'utf-8')

    const restarted = new YoloSession(
      projectPath,
      'sid-p2-checkpoint',
      'P2 checkpoint restore test',
      buildOptions(),
      new ScriptedCoordinator([]),
      { planner: new DeterministicPlannerAdvance() }
    )

    const restored = await restarted.restoreFromLatestCheckpoint()
    expect(restored).toBe(true)

    const restoredSnapshot = await restarted.getSnapshot()
    expect(restoredSnapshot.currentTurn).toBe(expected.currentTurn)
    expect(restoredSnapshot.state).toBe(expected.state)
    expect(restoredSnapshot.activeBranchId).toBe(expected.activeBranchId)
    expect(restoredSnapshot.activeNodeId).toBe(result.branchNode.nodeId)
  })

  it('writes periodic rollup checkpoint files on cadence', async () => {
    const projectPath = await createTempDir('yolo-p2-rollup-')
    tempDirs.push(projectPath)

    const base = Date.parse('2026-02-14T00:00:00.000Z')
    let tickSec = 0
    const now = () => new Date(base + (tickSec++) * 1000).toISOString()

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'turn one',
        assets: [{ type: 'RiskRegister', payload: { reason: 'rollup one' } }],
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
        summary: 'turn two',
        assets: [{ type: 'RiskRegister', payload: { reason: 'rollup two' } }],
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
      'sid-p2-rollup',
      'P2 periodic rollup test',
      buildOptions(),
      coordinator,
      {
        planner: new DeterministicPlannerAdvance(),
        now,
        runtimeRollupIntervalSec: 3600
      }
    )

    await session.init()
    await session.executeNextTurn()
    await session.executeNextTurn()

    const checkpointsDir = path.join(projectPath, 'yolo', 'sid-p2-rollup', 'runtime', 'checkpoints')
    const checkpointNames = await fs.readdir(checkpointsDir)
    const periodic = checkpointNames.filter((name) => name.endsWith('-periodic_rollup.json'))
    expect(periodic).toHaveLength(1)
    expect(checkpointNames).toContain('rollup-meta.json')
  })

  it('repairs hallucinated supersedes references instead of failing the turn', async () => {
    const projectPath = await createTempDir('yolo-p2-supersedes-invalid-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'invalid supersedes',
        assets: [
          {
            type: 'RiskRegister',
            supersedes: 'RiskRegister-t999-a1-001',
            payload: { reason: 'invalid supersedes target' }
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
      'sid-p2-supersedes-invalid',
      'P2 invalid supersedes test',
      buildOptions(),
      coordinator,
      { planner: new DeterministicPlannerAdvance() }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.assetDiff.created).toHaveLength(1)
    expect(
      result.turnReport.riskDelta.some((note) => note.includes('supersedes references repaired'))
    ).toBe(true)
  })

  it('emits wait-task reminder and escalation maintenance alerts', async () => {
    const projectPath = await createTempDir('yolo-p2-wait-maintenance-')
    tempDirs.push(projectPath)

    const base = Date.parse('2026-02-14T00:00:00.000Z')
    let currentSec = 0
    const now = () => new Date(base + currentSec * 1000).toISOString()

    const session = new YoloSession(
      projectPath,
      'sid-p2-wait-maintenance',
      'P2 wait maintenance alerts test',
      buildOptions(),
      new ScriptedCoordinator([]),
      { planner: new DeterministicPlannerAdvance(), now }
    )

    await session.init()
    await session.requestExternalWait({
      title: 'Need external logs',
      completionRule: 'Upload logs',
      resumeAction: 'Continue'
    })

    currentSec = 2 * 60 * 60
    await session.getSnapshot()
    currentSec = 7 * 60 * 60
    await session.getSnapshot()

    const eventsPath = path.join(projectPath, 'yolo', 'sid-p2-wait-maintenance', 'events.jsonl')
    const events = await readJsonl(eventsPath)
    const maintenanceEvents = events.filter((event) => event.eventType === 'maintenance_alert')

    expect(maintenanceEvents.some((event) => event.payload?.kind === 'wait_task_reminder')).toBe(true)
    expect(maintenanceEvents.some((event) => event.payload?.kind === 'wait_task_escalation')).toBe(true)
  })

  it('emits budget drift warning and critical maintenance alerts', async () => {
    const projectPath = await createTempDir('yolo-p2-budget-maintenance-')
    tempDirs.push(projectPath)

    const options = buildOptions()
    options.budget.maxTokens = 100
    options.budget.maxTurns = 10
    options.budget.maxCostUsd = 100

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'first high usage turn',
        assets: [{ type: 'RiskRegister', payload: { reason: 'budget warning' } }],
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 10,
          promptTokens: 30,
          completionTokens: 55,
          turnTokens: 85,
          turnCostUsd: 0.01,
          discoveryOps: 1
        }
      },
      {
        summary: 'second high usage turn',
        assets: [{ type: 'RiskRegister', payload: { reason: 'budget critical' } }],
        metrics: {
          toolCalls: 1,
          wallClockSec: 1,
          stepCount: 1,
          readBytes: 10,
          promptTokens: 5,
          completionTokens: 10,
          turnTokens: 15,
          turnCostUsd: 0.01,
          discoveryOps: 1
        }
      }
    ])

    const session = new YoloSession(
      projectPath,
      'sid-p2-budget-maintenance',
      'P2 budget maintenance alerts test',
      options,
      coordinator,
      { planner: new DeterministicPlannerAdvance() }
    )

    await session.executeNextTurn()
    await session.getSnapshot()
    await session.executeNextTurn()
    await session.getSnapshot()

    const eventsPath = path.join(projectPath, 'yolo', 'sid-p2-budget-maintenance', 'events.jsonl')
    const events = await readJsonl(eventsPath)
    const maintenanceEvents = events.filter((event) => event.eventType === 'maintenance_alert')
    expect(maintenanceEvents.some((event) => event.payload?.kind === 'budget_drift_warning')).toBe(true)
    expect(maintenanceEvents.some((event) => event.payload?.kind === 'budget_drift_critical')).toBe(true)
  })

  it('fails S4 gate when key run reproducibility triple is incomplete', async () => {
    const projectPath = await createTempDir('yolo-p2-g4-repro-')
    tempDirs.push(projectPath)

    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: 'S4',
            branch: {
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId,
              action: 'advance'
            },
            objective: 'validate reproducibility triple gate in S4',
            expectedAssets: ['Claim', 'RunRecord', 'EvidenceLink'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'emit S4 assets for reproducibility check',
          rationale: 'targeted S4 reproducibility test',
          uncertaintyNote: 'none'
        }
      }
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S4 reproducibility negative path',
        assets: [
          {
            type: 'Claim',
            payload: { state: 'asserted', tier: 'primary', statement: 'Primary claim for reproducibility check' }
          },
          {
            type: 'RunRecord',
            payload: {
              runKey: 'rk-s4-repro-001',
              envSnapshotId: 'EnvSnapshot-t001-a1-003',
              workloadVersionId: 'WorkloadVersion-t001-a1-004'
            }
          },
          {
            type: 'EnvSnapshot',
            payload: { hashKey: 'env-1' }
          },
          {
            type: 'WorkloadVersion',
            payload: { hashKey: 'wl-1' }
          },
          {
            type: 'BaselineParityContract',
            payload: { parityRequiredKnobs: ['batch_size'] }
          },
          {
            type: 'EvidenceLink',
            payload: {
              claimId: 'Claim-t001-a1-001',
              evidenceId: 'RunRecord-t001-a1-002',
              relation: 'supports',
              countingPolicy: 'countable',
              constraintsRef: {
                baselineParityContractId: 'BaselineParityContract-t001-a1-005'
              }
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
      'sid-p2-g4-repro',
      'P2 G4 reproducibility gate test',
      buildOptions(),
      coordinator,
      { planner }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.turnSpec.stage).toBe('S4')
    expect(result.turnReport.gateImpact.status).toBe('fail')
    expect(
      result.turnReport.gateImpact.gateResult.structuralChecks.some(
        (check) => check.name === 'key_run_reproducibility_triple_complete' && check.passed === false
      )
    ).toBe(true)
    expect(
      result.turnReport.gateImpact.gateResult.hardBlockers.some((item) => item.label === 'reproducibility_gap')
    ).toBe(true)
  })

  it('fails S4 gate when cross-branch countable EvidenceLink lacks auto-upgrade constraints', async () => {
    const projectPath = await createTempDir('yolo-p2-policy-cross-branch-')
    tempDirs.push(projectPath)

    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: 'S4',
            branch: {
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId,
              action: 'advance'
            },
            objective: 'validate cross-branch countable policy',
            expectedAssets: ['Claim', 'RunRecord', 'EvidenceLink'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'emit assets for cross-branch policy check',
          rationale: 'targeted S4 policy contract test',
          uncertaintyNote: 'none'
        }
      }
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S4 cross-branch policy negative path',
        assets: [
          {
            type: 'Claim',
            payload: { state: 'asserted', tier: 'primary', statement: 'Primary claim for policy contract check' }
          },
          {
            type: 'RunRecord',
            payload: {
              runKey: 'rk-s4-policy-001',
              envSnapshotId: 'EnvSnapshot-t001-a1-003',
              workloadVersionId: 'WorkloadVersion-t001-a1-004',
              replayScriptId: 'ReplayScript-t001-a1-005'
            }
          },
          {
            type: 'EnvSnapshot',
            payload: { hashKey: 'env-1' }
          },
          {
            type: 'WorkloadVersion',
            payload: { hashKey: 'wl-1' }
          },
          {
            type: 'ReplayScript',
            payload: { path: 'scripts/replay.sh' }
          },
          {
            type: 'EvidenceLink',
            payload: {
              claimId: 'Claim-t001-a1-001',
              evidenceId: 'RunRecord-t001-a1-002',
              relation: 'supports',
              countingPolicy: 'countable',
              createdByBranchId: 'B-002',
              sourceBranchId: 'B-001',
              constraintsRef: {
                envSnapshotId: 'EnvSnapshot-t001-a1-003',
                workloadVersionId: 'WorkloadVersion-t001-a1-004'
              }
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
      'sid-p2-policy-cross-branch',
      'P2 cross-branch countable policy test',
      buildOptions(),
      coordinator,
      { planner }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.turnSpec.stage).toBe('S4')
    expect(result.turnReport.gateImpact.status).toBe('fail')
    expect(
      result.turnReport.gateImpact.gateResult.structuralChecks.some(
        (check) => check.name === 'countable_evidence_policy_contract' && check.passed === false
      )
    ).toBe(true)
    expect(
      result.turnReport.gateImpact.gateResult.hardBlockers.some((item) => item.label === 'parity_violation_unresolved')
    ).toBe(true)
    expect(
      result.turnReport.riskDelta.some((note) => note.includes('invalid countable links downgraded'))
    ).toBe(true)
  })

  it('fails S4 gate when key-run countable EvidenceLink misses baseline parity contract', async () => {
    const projectPath = await createTempDir('yolo-p2-policy-key-run-parity-')
    tempDirs.push(projectPath)

    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        const constraints = buildDefaultP0Constraints()
        constraints.maxNewAssets = 12
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: 'S4',
            branch: {
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId,
              action: 'advance'
            },
            objective: 'validate key-run parity contract requirement',
            expectedAssets: ['Claim', 'RunRecord', 'EvidenceLink'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'emit assets for key-run parity policy check',
          rationale: 'targeted S4 parity policy test',
          uncertaintyNote: 'none'
        }
      }
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S4 key-run parity policy negative path',
        assets: [
          {
            type: 'Claim',
            payload: { state: 'asserted', tier: 'primary', statement: 'Primary claim for key-run parity check' }
          },
          {
            type: 'RunRecord',
            payload: {
              runKey: 'rk-s4-policy-002',
              envSnapshotId: 'EnvSnapshot-t001-a1-003',
              workloadVersionId: 'WorkloadVersion-t001-a1-004',
              replayScriptId: 'ReplayScript-t001-a1-005'
            }
          },
          {
            type: 'EnvSnapshot',
            payload: { hashKey: 'env-2' }
          },
          {
            type: 'WorkloadVersion',
            payload: { hashKey: 'wl-2' }
          },
          {
            type: 'ReplayScript',
            payload: { path: 'scripts/replay-2.sh' }
          },
          {
            type: 'EvidenceLink',
            payload: {
              claimId: 'Claim-t001-a1-001',
              evidenceId: 'RunRecord-t001-a1-002',
              relation: 'supports',
              countingPolicy: 'countable',
              constraintsRef: {
                envSnapshotId: 'EnvSnapshot-t001-a1-003',
                workloadVersionId: 'WorkloadVersion-t001-a1-004'
              }
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
      'sid-p2-policy-key-run-parity',
      'P2 key-run parity policy test',
      buildOptions(),
      coordinator,
      { planner }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.turnSpec.stage).toBe('S4')
    expect(result.turnReport.gateImpact.status).toBe('fail')
    expect(
      result.turnReport.gateImpact.gateResult.structuralChecks.some(
        (check) => check.name === 'countable_evidence_policy_contract' && check.passed === false
      )
    ).toBe(true)
    expect(
      result.turnReport.gateImpact.gateResult.hardBlockers.some((item) => item.label === 'parity_violation_unresolved')
    ).toBe(true)
    expect(
      result.turnReport.riskDelta.some((note) => note.includes('invalid countable links downgraded'))
    ).toBe(true)
  })

  it('defaults cross-branch evidence to cite_only and auto-upgrades on exact applicability match', async () => {
    const projectPath = await createTempDir('yolo-p2-cross-branch-upgrade-')
    tempDirs.push(projectPath)

    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        const constraints = buildDefaultP0Constraints()
        constraints.maxNewAssets = 12
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: 'S4',
            branch: {
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId,
              action: 'advance'
            },
            objective: 'validate cross-branch reuse default and auto-upgrade behavior',
            expectedAssets: ['Claim', 'RunRecord', 'EvidenceLink', 'Decision'],
            constraints
          },
          suggestedPrompt: 'emit assets for cross-branch reuse behavior',
          rationale: 'targeted cross-branch evidence policy normalization test',
          uncertaintyNote: 'none'
        }
      }
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S4 cross-branch default and auto-upgrade path',
        assets: [
          {
            type: 'Claim',
            payload: { state: 'asserted', tier: 'primary', statement: 'Primary claim for cross-branch reuse check' }
          },
          {
            type: 'RunRecord',
            payload: {
              runKey: 'rk-s4-policy-003',
              envSnapshotId: 'EnvSnapshot-t001-a1-003',
              workloadVersionId: 'WorkloadVersion-t001-a1-004',
              replayScriptId: 'ReplayScript-t001-a1-005'
            }
          },
          {
            type: 'EnvSnapshot',
            payload: { hashKey: 'env-3' }
          },
          {
            type: 'WorkloadVersion',
            payload: { hashKey: 'wl-3' }
          },
          {
            type: 'ReplayScript',
            payload: { path: 'scripts/replay-3.sh' }
          },
          {
            type: 'BaselineParityContract',
            payload: { parityRequiredKnobs: ['threads'] }
          },
          {
            type: 'EvidenceLink',
            payload: {
              claimId: 'Claim-t001-a1-001',
              evidenceId: 'RunRecord-t001-a1-002',
              relation: 'context',
              createdByBranchId: 'B-010',
              sourceBranchId: 'B-001'
            }
          },
          {
            type: 'EvidenceLink',
            payload: {
              claimId: 'Claim-t001-a1-001',
              evidenceId: 'RunRecord-t001-a1-002',
              relation: 'supports',
              countingPolicy: 'cite_only',
              createdByBranchId: 'B-010',
              sourceBranchId: 'B-001',
              constraintsRef: {
                envSnapshotId: 'EnvSnapshot-t001-a1-003',
                workloadVersionId: 'WorkloadVersion-t001-a1-004',
                baselineParityContractId: 'BaselineParityContract-t001-a1-006'
              }
            }
          },
          {
            type: 'Decision',
            payload: {
              kind: 'claim-freeze',
              madeBy: 'user',
              choice: 'confirm',
              referencedAssetIds: ['Claim-t001-a1-001']
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
      'sid-p2-cross-branch-upgrade',
      'P2 cross-branch default/upgrade policy test',
      buildOptions(),
      coordinator,
      { planner }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.turnSpec.stage).toBe('S4')
    expect(result.turnReport.gateImpact.status).toBe('pass')
    expect(
      result.turnReport.riskDelta.some((note) => note.includes('cross-branch evidence defaulted to cite_only'))
    ).toBe(true)
    expect(
      result.turnReport.riskDelta.some((note) => note.includes('cross-branch evidence auto-upgraded to countable'))
    ).toBe(true)

    const evidencePolicy = result.turnReport.gateImpact.snapshotManifest.evidencePolicy
    expect(evidencePolicy?.crossBranchCountableLinkIds).toHaveLength(1)
    expect(evidencePolicy?.invalidCountableLinkIds).toHaveLength(0)

    const baseDir = path.join(projectPath, 'yolo', 'sid-p2-cross-branch-upgrade', 'assets')
    const evidenceLinkIds = result.turnReport.assetDiff.created.filter((id) => id.startsWith('EvidenceLink-'))
    expect(evidenceLinkIds).toHaveLength(2)

    const evidenceLinks = await Promise.all(
      evidenceLinkIds.map(async (id) => readJson<{ payload: Record<string, unknown> }>(path.join(baseDir, `${id}.json`)))
    )
    const policies = evidenceLinks.map((item) => item.payload.countingPolicy)
    expect(policies).toContain('cite_only')
    expect(policies).toContain('countable')
  })

  it('fails S2 gate with causality_gap when bottleneck/mechanism claim has only correlation evidence', async () => {
    const projectPath = await createTempDir('yolo-p2-causality-gap-')
    tempDirs.push(projectPath)

    const planner: TurnPlanner = {
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
            objective: 'validate causality minimum for S2',
            expectedAssets: ['Claim', 'EvidenceLink'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'emit S2 assets for causality check',
          rationale: 'targeted S2 causality policy test',
          uncertaintyNote: 'none'
        }
      }
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S2 causality gap negative path',
        assets: [
          {
            type: 'Claim',
            payload: {
              state: 'asserted',
              tier: 'primary',
              claimType: 'mechanism',
              statement: 'Mechanism claim requiring causal evidence'
            }
          },
          {
            type: 'BaselineParityContract',
            payload: { parityRequiredKnobs: ['threads'] }
          },
          {
            type: 'EvidenceLink',
            payload: {
              claimId: 'Claim-t001-a1-001',
              evidenceId: 'RunRecord-t001-a1-999',
              relation: 'supports',
              countingPolicy: 'countable',
              causalityType: 'correlation',
              constraintsRef: {
                baselineParityContractId: 'BaselineParityContract-t001-a1-002'
              }
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
      'sid-p2-causality-gap',
      'P2 causality gap test',
      buildOptions(),
      coordinator,
      { planner }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.turnSpec.stage).toBe('S2')
    expect(result.turnReport.gateImpact.status).toBe('fail')
    expect(
      result.turnReport.gateImpact.gateResult.structuralChecks.some(
        (check) => check.name === 'causality_evidence_minimum' && check.passed === false
      )
    ).toBe(true)
    expect(
      result.turnReport.gateImpact.gateResult.hardBlockers.some((item) => item.label === 'causality_gap')
    ).toBe(true)
  })

  it('fails S5 gate when claim-freeze decision does not reference asserted claim ids', async () => {
    const projectPath = await createTempDir('yolo-p2-claim-binding-')
    tempDirs.push(projectPath)

    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: 'S5',
            branch: {
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId,
              action: 'advance'
            },
            objective: 'validate claim-freeze binding in S5',
            expectedAssets: ['Claim', 'EvidenceLink', 'Decision'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'emit S5 assets for claim-freeze binding check',
          rationale: 'targeted S5 binding policy test',
          uncertaintyNote: 'none'
        }
      }
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S5 claim-freeze binding negative path',
        assets: [
          {
            type: 'Claim',
            payload: {
              state: 'asserted',
              tier: 'primary',
              claimType: 'performance',
              statement: 'Primary claim for claim-freeze binding check'
            }
          },
          {
            type: 'RunRecord',
            payload: {
              runKey: 'rk-s5-binding-001',
              envSnapshotId: 'EnvSnapshot-t001-a1-901',
              workloadVersionId: 'WorkloadVersion-t001-a1-902',
              replayScriptId: 'ReplayScript-t001-a1-903'
            }
          },
          {
            type: 'BaselineParityContract',
            payload: { parityRequiredKnobs: ['threads'] }
          },
          {
            type: 'EvidenceLink',
            payload: {
              claimId: 'Claim-t001-a1-001',
              evidenceId: 'RunRecord-t001-a1-002',
              relation: 'supports',
              countingPolicy: 'countable',
              causalityType: 'intervention',
              constraintsRef: {
                envSnapshotId: 'EnvSnapshot-t001-a1-901',
                workloadVersionId: 'WorkloadVersion-t001-a1-902',
                baselineParityContractId: 'BaselineParityContract-t001-a1-003'
              }
            }
          },
          {
            type: 'Decision',
            payload: {
              kind: 'claim-freeze',
              madeBy: 'user',
              choice: 'confirm',
              referencedAssetIds: []
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
      'sid-p2-claim-binding',
      'P2 claim-freeze binding test',
      buildOptions(),
      coordinator,
      { planner }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.turnSpec.stage).toBe('S5')
    expect(result.turnReport.gateImpact.status).toBe('fail')
    expect(
      result.turnReport.gateImpact.gateResult.structuralChecks.some(
        (check) => check.name === 'asserted_claim_freeze_decision_binding' && check.passed === false
      )
    ).toBe(true)
    expect(
      result.turnReport.gateImpact.gateResult.hardBlockers.some((item) => item.label === 'reproducibility_gap')
    ).toBe(true)
  })

  it('fails S4 gate when requiredEvidenceKinds are not covered by linked evidence kinds', async () => {
    const projectPath = await createTempDir('yolo-p2-direct-evidence-gap-')
    tempDirs.push(projectPath)

    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: 'S4',
            branch: {
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId,
              action: 'advance'
            },
            objective: 'validate required evidence kinds mapping in S4',
            expectedAssets: ['Claim', 'EvidenceLink', 'Decision'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'emit S4 assets for requiredEvidenceKinds check',
          rationale: 'targeted S4 direct evidence mapping test',
          uncertaintyNote: 'none'
        }
      }
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S4 required evidence kind mismatch path',
        assets: [
          {
            type: 'Claim',
            payload: {
              state: 'asserted',
              tier: 'primary',
              claimType: 'performance',
              statement: 'Primary claim requiring end_to_end evidence',
              requiredEvidenceKinds: ['end_to_end']
            }
          },
          {
            type: 'BaselineParityContract',
            payload: { parityRequiredKnobs: ['threads'] }
          },
          {
            type: 'EvidenceLink',
            payload: {
              claimId: 'Claim-t001-a1-001',
              evidenceId: 'MetricSeries-t001-a1-901',
              relation: 'supports',
              countingPolicy: 'countable',
              evidenceKind: 'microbench',
              constraintsRef: {
                baselineParityContractId: 'BaselineParityContract-t001-a1-002'
              }
            }
          },
          {
            type: 'Decision',
            payload: {
              kind: 'claim-freeze',
              madeBy: 'user',
              choice: 'confirm',
              referencedAssetIds: ['Claim-t001-a1-001']
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
      'sid-p2-direct-evidence-gap',
      'P2 direct evidence mapping test',
      buildOptions(),
      coordinator,
      { planner }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.turnSpec.stage).toBe('S4')
    expect(result.turnReport.gateImpact.status).toBe('fail')
    expect(
      result.turnReport.gateImpact.gateResult.structuralChecks.some(
        (check) => check.name === 'required_evidence_kind_mapping' && check.passed === false
      )
    ).toBe(true)
    expect(
      result.turnReport.gateImpact.gateResult.hardBlockers.some((item) => item.label === 'claim_without_direct_evidence')
    ).toBe(true)
    expect(result.newState).toBe('WAITING_FOR_USER')
    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('WAITING_FOR_USER')
    expect(snapshot.pendingQuestion?.checkpoint).toBe('final-scope')
  })

  it('fails S4 gate on claimType default mapping when performance claim lacks end-to-end evidence', async () => {
    const projectPath = await createTempDir('yolo-p2-direct-evidence-default-')
    tempDirs.push(projectPath)

    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: 'S4',
            branch: {
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId,
              action: 'advance'
            },
            objective: 'validate claimType default direct-evidence mapping in S4',
            expectedAssets: ['Claim', 'EvidenceLink', 'Decision'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'emit S4 assets for default direct-evidence mapping check',
          rationale: 'targeted S4 direct evidence default mapping test',
          uncertaintyNote: 'none'
        }
      }
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S4 claimType default mapping mismatch path',
        assets: [
          {
            type: 'Claim',
            payload: {
              state: 'asserted',
              tier: 'primary',
              claimType: 'performance',
              statement: 'Primary performance claim without explicit requiredEvidenceKinds'
            }
          },
          {
            type: 'BaselineParityContract',
            payload: { parityRequiredKnobs: ['threads'] }
          },
          {
            type: 'EvidenceLink',
            payload: {
              claimId: 'Claim-t001-a1-001',
              evidenceId: 'MetricSeries-t001-a1-902',
              relation: 'supports',
              countingPolicy: 'countable',
              evidenceKind: 'microbench',
              constraintsRef: {
                baselineParityContractId: 'BaselineParityContract-t001-a1-002'
              }
            }
          },
          {
            type: 'Decision',
            payload: {
              kind: 'claim-freeze',
              madeBy: 'user',
              choice: 'confirm',
              referencedAssetIds: ['Claim-t001-a1-001']
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
      'sid-p2-direct-evidence-default',
      'P2 direct evidence default mapping test',
      buildOptions(),
      coordinator,
      { planner }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.turnSpec.stage).toBe('S4')
    expect(result.turnReport.gateImpact.status).toBe('fail')
    expect(
      result.turnReport.gateImpact.gateResult.structuralChecks.some(
        (check) => check.name === 'required_evidence_kind_mapping' && check.passed === false
      )
    ).toBe(true)
    expect(
      result.turnReport.gateImpact.gateResult.hardBlockers.some((item) => item.label === 'claim_without_direct_evidence')
    ).toBe(true)
  })

  it('applies budget degradation ladder before execution under tight remaining budget', async () => {
    const projectPath = await createTempDir('yolo-p2-budget-degrade-')
    tempDirs.push(projectPath)

    const options = buildOptions()
    options.phase = 'P1'
    options.budget.maxTurns = 2

    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: input.stage,
            branch: {
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId,
              action: 'fork'
            },
            objective: 'budget ladder test',
            expectedAssets: ['Hypothesis', 'Claim', 'RiskRegister'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'budget ladder test',
          rationale: 'planner intentionally requests wider scope',
          uncertaintyNote: 'none'
        }
      }
    }

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'budget degrade execution',
        assets: [{ type: 'RiskRegister', payload: { reason: 'budget degrade path' } }],
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
      'sid-p2-budget-degrade',
      'P1 budget degradation ladder test',
      options,
      coordinator,
      { planner }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.turnSpec.branch.action).toBe('advance')
    expect(result.turnReport.turnSpec.expectedAssets.length).toBeLessThanOrEqual(2)
    expect(result.turnReport.turnSpec.constraints.maxToolCalls).toBe(9)
    expect(result.turnReport.turnSpec.constraints.maxDiscoveryOps).toBe(15)
    expect(result.turnReport.turnSpec.constraints.maxReadBytes).toBe(187500)
    expect(result.turnReport.nextStepRationale).toContain('degradation ladder applied')

    const eventsPath = path.join(projectPath, 'yolo', 'sid-p2-budget-degrade', 'events.jsonl')
    const events = await readJsonl(eventsPath)
    const amendments = events.filter((event) => event.eventType === 'amendment_requested')
    expect(amendments.length).toBeGreaterThan(0)
  })

  it('downgrades phase and emits readiness maintenance alert when required gates fail', async () => {
    const projectPath = await createTempDir('yolo-p2-readiness-')
    tempDirs.push(projectPath)

    const options = buildOptions()
    options.phase = 'P1'
    options.models.planner = ''
    options.models.coordinator = ''

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'readiness preflight visibility',
        assets: [{ type: 'RiskRegister', payload: { reason: 'readiness check' } }],
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
      'sid-p2-readiness',
      'P1 readiness snapshot test',
      options,
      coordinator,
      { planner: new DeterministicPlannerAdvance() }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.readinessSnapshot?.phase).toBe('P0')
    expect(result.turnReport.readinessSnapshot?.pass).toBe(true)
    expect(result.turnReport.riskDelta.some((note) => note.includes('downgraded phase to P0'))).toBe(true)

    const snapshot = await session.getSnapshot()
    expect(snapshot.phase).toBe('P0')

    const eventsPath = path.join(projectPath, 'yolo', 'sid-p2-readiness', 'events.jsonl')
    const events = await readJsonl(eventsPath)
    const readinessAlerts = events.filter((event) => (
      event.eventType === 'maintenance_alert'
      && event.payload?.kind === 'readiness_gate_failure'
    ))
    expect(readinessAlerts.length).toBeGreaterThan(0)
    const warningAlerts = readinessAlerts.filter((event) => event.payload?.severity === 'warning')
    expect(warningAlerts.length).toBeGreaterThan(0)
  })
})

class DeterministicPlannerAdvance implements TurnPlanner {
  async generate(input: PlannerInput): Promise<PlannerOutput> {
    return {
      turnSpec: {
        turnNumber: input.turnNumber,
        stage: input.stage,
        branch: {
          activeBranchId: input.activeBranchId,
          activeNodeId: input.activeNodeId,
          action: 'advance'
        },
        objective: 'advance P2 test flow',
        expectedAssets: ['RiskRegister'],
        constraints: buildDefaultP0Constraints()
      },
      suggestedPrompt: 'advance for P2 test',
      rationale: 'deterministic test planner',
      uncertaintyNote: 'none'
    }
  }
}
