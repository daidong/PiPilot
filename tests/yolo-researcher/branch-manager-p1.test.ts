import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildDefaultP0Constraints,
  DegenerateBranchManager,
  ScriptedCoordinator,
  YoloSession,
  type PlannerInput,
  type PlannerOutput,
  type TurnPlanner,
  type YoloSessionOptions
} from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

function buildOptions(phase: 'P0' | 'P1' = 'P1'): YoloSessionOptions {
  return {
    phase,
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

describe('branch manager P1 operations', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('supports fork/revisit/merge/prune when phase >= P1', async () => {
    const projectPath = await createTempDir('yolo-branch-p1-')
    tempDirs.push(projectPath)

    const sessionDir = path.join(projectPath, 'yolo', 'sid-branch-p1')
    const manager = new DegenerateBranchManager(sessionDir, 'P1')
    await manager.init('S1')

    const advanced = await manager.advance({
      stage: 'S1',
      summary: 'advance root',
      createdByTurn: 1,
      createdByAttempt: 1
    })
    expect(advanced.nextNode.nodeId).toBe('N-002')

    const forked = await manager.fork({
      stage: 'S2',
      summary: 'fork alternative path',
      createdByTurn: 2,
      createdByAttempt: 1
    })
    expect(forked.nextNode.branchId).not.toBe(advanced.nextNode.branchId)

    const revisited = await manager.revisit({ targetNodeId: advanced.nextNode.nodeId })
    expect(revisited.nextNode.nodeId).toBe('N-002')

    const merged = await manager.merge({
      targetNodeId: forked.nextNode.nodeId,
      stage: 'S2',
      summary: 'merge conclusions',
      createdByTurn: 3,
      createdByAttempt: 1
    })
    expect(merged.previousNode.status).toBe('merged')
    expect(merged.nextNode.branchId).toBe(forked.nextNode.branchId)
    expect(merged.nextNode.mergedFrom).toContain('N-002')

    const pruned = await manager.prune()
    expect(pruned.previousNode.status).toBe('pruned')
    expect(pruned.nextNode.nodeId).toBe(forked.nextNode.nodeId)
  })

  it('executes non-advance branch action in P1 session', async () => {
    const projectPath = await createTempDir('yolo-session-p1-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'branch fork turn',
        assets: [
          {
            type: 'RiskRegister',
            payload: { reason: 'branch exploration' }
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

    const forkPlanner: TurnPlanner = {
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
            objective: 'fork for alternative mechanism',
            expectedAssets: ['RiskRegister'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'fork branch',
          rationale: 'explore alternative branch',
          uncertaintyNote: 'none'
        }
      }
    }

    const session = new YoloSession(
      projectPath,
      'sid-session-p1',
      'P1 branch action test',
      buildOptions('P1'),
      coordinator,
      { planner: forkPlanner }
    )

    const result = await session.executeNextTurn()
    expect(result.turnReport.branchDiff.action).toBe('fork')
    expect(result.branchNode.branchId).not.toBe('B-001')
  })

  it('persists WAITING_EXTERNAL tasks and resumes after resolution', async () => {
    const projectPath = await createTempDir('yolo-wait-p1-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'resume after external wait',
        assets: [
          {
            type: 'RiskRegister',
            payload: { reason: 'post-external-run' }
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
      'sid-wait-p1',
      'P1 external wait task test',
      buildOptions('P1'),
      coordinator,
      { planner: new DeterministicPlannerAdvance() }
    )

    await session.init()
    const waitTask = await session.requestExternalWait({
      title: 'Collect external experiment artifacts',
      completionRule: 'Attach experiment output',
      resumeAction: 'Analyze attached output'
    })

    const waitingSnapshot = await session.getSnapshot()
    expect(waitingSnapshot.state).toBe('WAITING_EXTERNAL')
    expect(waitingSnapshot.pendingExternalTaskId).toBe(waitTask.id)
    expect(waitTask.uploadDir).toContain('ingress/user-turn-001-upload')

    const listed = await session.listExternalWaitTasks()
    expect(listed.some((task) => task.id === waitTask.id)).toBe(true)

    const uploadDir = path.join(projectPath, 'yolo', 'sid-wait-p1', waitTask.uploadDir as string)
    await fs.writeFile(path.join(uploadDir, 'external-results.txt'), 'experiment output', 'utf-8')

    const resolved = await session.resolveExternalWaitTask(waitTask.id, 'logs uploaded')
    expect(resolved.status).toBe('satisfied')

    const resumedSnapshot = await session.getSnapshot()
    expect(resumedSnapshot.state).toBe('PLANNING')
    expect(resumedSnapshot.pendingExternalTaskId).toBeUndefined()

    const turnResult = await session.executeNextTurn()
    expect(turnResult.turnReport.turnNumber).toBe(1)

    const historyDir = path.join(projectPath, 'yolo', 'sid-wait-p1', 'wait-tasks', 'history')
    const historyNames = await fs.readdir(historyDir)
    expect(historyNames.some((name) => name.includes('-created.json'))).toBe(true)
    expect(historyNames.some((name) => name.includes('-satisfied.json'))).toBe(true)
  })

  it('rejects resolving WAITING_EXTERNAL when upload directory is empty', async () => {
    const projectPath = await createTempDir('yolo-wait-empty-p1-')
    tempDirs.push(projectPath)

    const session = new YoloSession(
      projectPath,
      'sid-wait-empty-p1',
      'P1 empty wait upload test',
      buildOptions('P1'),
      new ScriptedCoordinator([]),
      { planner: new DeterministicPlannerAdvance() }
    )

    await session.init()
    const waitTask = await session.requestExternalWait({
      title: 'Need external artifact',
      completionRule: 'Upload at least one result file',
      resumeAction: 'Continue analysis'
    })

    await expect(session.resolveExternalWaitTask(waitTask.id, 'no files')).rejects.toThrow('upload directory is empty')
  })

  it('cancels WAITING_EXTERNAL task and returns to PLANNING', async () => {
    const projectPath = await createTempDir('yolo-wait-cancel-p1-')
    tempDirs.push(projectPath)

    const session = new YoloSession(
      projectPath,
      'sid-wait-cancel-p1',
      'P1 cancel wait test',
      buildOptions('P1'),
      new ScriptedCoordinator([]),
      { planner: new DeterministicPlannerAdvance() }
    )

    await session.init()
    const waitTask = await session.requestExternalWait({
      title: 'Need external artifact',
      completionRule: 'Upload one result',
      resumeAction: 'Continue run'
    })
    const cancelled = await session.cancelExternalWaitTask(waitTask.id, 'no longer needed')
    expect(cancelled.status).toBe('canceled')

    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('PLANNING')
    expect(snapshot.pendingExternalTaskId).toBeUndefined()
  })

  it('missing full text triggers ask_user and WAITING_EXTERNAL wait ticket', async () => {
    const projectPath = await createTempDir('yolo-fulltext-wait-p1-')
    tempDirs.push(projectPath)

    const session = new YoloSession(
      projectPath,
      'sid-fulltext-wait-p1',
      'P1 full-text wait test',
      buildOptions('P1'),
      new ScriptedCoordinator([]),
      { planner: new DeterministicPlannerAdvance() }
    )

    await session.init()
    const task = await session.requestFullTextUploadWait({
      citation: 'Doe et al. (2024) systems paper',
      requiredFiles: ['paper.pdf']
    })
    expect(task.status).toBe('waiting')
    expect(task.uploadDir).toContain('ingress/user-turn-001-upload')

    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('WAITING_EXTERNAL')
    expect(snapshot.pendingExternalTaskId).toBe(task.id)
    expect(snapshot.pendingQuestion?.question).toContain('Please upload full text')

    const eventsPath = path.join(projectPath, 'yolo', 'sid-fulltext-wait-p1', 'events.jsonl')
    const eventsRaw = await fs.readFile(eventsPath, 'utf-8')
    const events = eventsRaw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { eventType?: string; payload?: { to?: string } })
    expect(events.some((evt) => evt.eventType === 'ask_user_emitted')).toBe(true)
    expect(events.some((evt) => evt.eventType === 'state_transition' && evt.payload?.to === 'WAITING_EXTERNAL')).toBe(true)

    const uploadDir = path.join(projectPath, 'yolo', 'sid-fulltext-wait-p1', task.uploadDir as string)
    const preValidation = await session.validateExternalWaitTask(task.id)
    expect(preValidation.ok).toBe(false)
    expect(preValidation.missingRequiredUploads).toContain('paper.pdf')
    expect(preValidation.checks.some((item) => item.name === 'has_upload' && item.passed === false)).toBe(true)
    expect(preValidation.checks.some((item) => item.name === 'required_files' && item.passed === false)).toBe(true)
    await expect(session.resolveExternalWaitTask(task.id, 'try resolve too early')).rejects.toThrow('missing required upload')

    await fs.mkdir(path.join(uploadDir, 'nested'), { recursive: true })
    await fs.writeFile(path.join(uploadDir, 'paper.pdf'), 'pdf bytes', 'utf-8')
    const postValidation = await session.validateExternalWaitTask(task.id)
    expect(postValidation.ok).toBe(true)
    expect(postValidation.checks.every((item) => item.passed)).toBe(true)
    const resolved = await session.resolveExternalWaitTask(task.id, 'uploaded full text')
    expect(resolved.status).toBe('satisfied')
  })

  it('fails validation for unknown checklist checks in completionRule', async () => {
    const projectPath = await createTempDir('yolo-wait-checklist-unknown-p1-')
    tempDirs.push(projectPath)

    const session = new YoloSession(
      projectPath,
      'sid-wait-checklist-unknown-p1',
      'P1 wait checklist unknown test',
      buildOptions('P1'),
      new ScriptedCoordinator([]),
      { planner: new DeterministicPlannerAdvance() }
    )
    await session.init()
    const waitTask = await session.requestExternalWait({
      title: 'Unknown checklist test',
      completionRule: 'checklist:unknown_check',
      resumeAction: 'resume when checks pass'
    })

    const uploadDir = path.join(projectPath, 'yolo', 'sid-wait-checklist-unknown-p1', waitTask.uploadDir as string)
    await fs.writeFile(path.join(uploadDir, 'any.txt'), 'content', 'utf-8')

    const validation = await session.validateExternalWaitTask(waitTask.id)
    expect(validation.ok).toBe(false)
    expect(validation.checks.some((item) => item.name === 'unknown_check' && item.passed === false)).toBe(true)
    await expect(session.resolveExternalWaitTask(waitTask.id, 'attempt resolve')).rejects.toThrow('unknown checklist check')
  })

  it('restores WAITING_EXTERNAL state after session restart', async () => {
    const projectPath = await createTempDir('yolo-wait-restore-p1-')
    tempDirs.push(projectPath)

    const initial = new YoloSession(
      projectPath,
      'sid-wait-restore-p1',
      'P1 wait restore test',
      buildOptions('P1'),
      new ScriptedCoordinator([]),
      { planner: new DeterministicPlannerAdvance() }
    )
    await initial.init()
    const waitTask = await initial.requestExternalWait({
      title: 'Run external step',
      completionRule: 'Upload result file',
      resumeAction: 'Continue after upload'
    })

    const restarted = new YoloSession(
      projectPath,
      'sid-wait-restore-p1',
      'P1 wait restore test',
      buildOptions('P1'),
      new ScriptedCoordinator([]),
      { planner: new DeterministicPlannerAdvance() }
    )
    await restarted.init()
    const snapshot = await restarted.getSnapshot()
    expect(snapshot.state).toBe('WAITING_EXTERNAL')
    expect(snapshot.pendingExternalTaskId).toBe(waitTask.id)

    const listed = await restarted.listExternalWaitTasks()
    expect(listed.some((task) => task.id === waitTask.id && task.status === 'waiting')).toBe(true)
  })

  it('auto-resumes from WAITING_EXTERNAL on restart when completion is already satisfied', async () => {
    const projectPath = await createTempDir('yolo-wait-autoresume-p1-')
    tempDirs.push(projectPath)

    const initial = new YoloSession(
      projectPath,
      'sid-wait-autoresume-p1',
      'P1 wait auto-resume test',
      buildOptions('P1'),
      new ScriptedCoordinator([]),
      { planner: new DeterministicPlannerAdvance() }
    )
    await initial.init()
    const waitTask = await initial.requestExternalWait({
      title: 'Upload external result',
      completionRule: 'Upload result file',
      resumeAction: 'Continue after upload'
    })
    const uploadDir = path.join(projectPath, 'yolo', 'sid-wait-autoresume-p1', waitTask.uploadDir as string)
    await fs.writeFile(path.join(uploadDir, 'result.txt'), 'done', 'utf-8')

    const restarted = new YoloSession(
      projectPath,
      'sid-wait-autoresume-p1',
      'P1 wait auto-resume test',
      buildOptions('P1'),
      new ScriptedCoordinator([]),
      { planner: new DeterministicPlannerAdvance() }
    )
    await restarted.init()
    const snapshot = await restarted.getSnapshot()
    expect(snapshot.state).toBe('PLANNING')
    expect(snapshot.pendingExternalTaskId).toBeUndefined()
  })

  it('requests and approves resource extension, then resumes planning', async () => {
    const projectPath = await createTempDir('yolo-resource-extension-p1-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'turn after extension',
        assets: [
          {
            type: 'RiskRegister',
            payload: { reason: 'extension applied' }
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
      'sid-resource-extension-p1',
      'P1 resource extension test',
      buildOptions('P1'),
      coordinator,
      { planner: new DeterministicPlannerAdvance() }
    )

    await session.init()
    const request = await session.requestResourceExtension({
      rationale: 'Need more budget for additional baseline checks',
      delta: { maxTurns: 2, maxTokens: 1000, maxCostUsd: 1.5 },
      requestedBy: 'user'
    })
    expect(request.delta.maxTurns).toBe(2)

    const waitingSnapshot = await session.getSnapshot()
    expect(waitingSnapshot.state).toBe('WAITING_FOR_USER')
    expect(waitingSnapshot.pendingResourceExtension?.id).toBe(request.id)

    const resolved = await session.resolveResourceExtension({ approved: true, note: 'approved' })
    expect(resolved.approved).toBe(true)
    expect(resolved.budget.maxTurns).toBe(8)
    expect(resolved.budget.maxTokens).toBe(101_000)
    expect(resolved.budget.maxCostUsd).toBe(101.5)

    const resumedSnapshot = await session.getSnapshot()
    expect(resumedSnapshot.state).toBe('PLANNING')
    expect(resumedSnapshot.pendingResourceExtension).toBeUndefined()

    const turnResult = await session.executeNextTurn()
    expect(turnResult.turnReport.turnNumber).toBe(1)

    const assetNames = await fs.readdir(path.join(projectPath, 'yolo', 'sid-resource-extension-p1', 'assets'))
    expect(assetNames.some((name) => name.startsWith('ResourceBudget-t000-a0-'))).toBe(true)
    expect(assetNames.some((name) => name.startsWith('Decision-t000-a0-'))).toBe(true)
  })

  it('rejects resource extension and keeps budget unchanged', async () => {
    const projectPath = await createTempDir('yolo-resource-extension-reject-p1-')
    tempDirs.push(projectPath)

    const session = new YoloSession(
      projectPath,
      'sid-resource-extension-reject-p1',
      'P1 resource extension reject test',
      buildOptions('P1'),
      new ScriptedCoordinator([]),
      { planner: new DeterministicPlannerAdvance() }
    )

    await session.init()
    await session.requestResourceExtension({
      rationale: 'Need more budget',
      delta: { maxTurns: 2, maxTokens: 1000, maxCostUsd: 1.5 },
      requestedBy: 'user'
    })

    const resolved = await session.resolveResourceExtension({ approved: false, note: 'rejected' })
    expect(resolved.approved).toBe(false)
    expect(resolved.budget.maxTurns).toBe(6)
    expect(resolved.budget.maxTokens).toBe(100_000)
    expect(resolved.budget.maxCostUsd).toBe(100)

    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('PLANNING')
    expect(snapshot.pendingResourceExtension).toBeUndefined()
  })

  it('injects reviewed ingress manifest summaries into merged inputs in P1', async () => {
    const projectPath = await createTempDir('yolo-ingress-p1-')
    tempDirs.push(projectPath)

    let observedMergedInputs: string[] = []
    const coordinator = new ScriptedCoordinator([
      {
        summary: 'ingress merge turn',
        assets: [
          {
            type: 'RiskRegister',
            payload: { reason: 'ingress check' }
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
      'sid-ingress-p1',
      'P1 ingress merge test',
      buildOptions('P1'),
      {
        async runTurn(input) {
          observedMergedInputs = input.mergedUserInputs.map((item) => item.text)
          return coordinator.runTurn(input)
        }
      },
      { planner: new DeterministicPlannerAdvance() }
    )

    await session.init()
    const ingressDir = await session.ensureIngressUploadDir(1)
    await fs.writeFile(path.join(ingressDir, 'upload.txt'), 'user supplied content', 'utf-8')

    const result = await session.executeNextTurn()
    expect(result.turnReport.turnNumber).toBe(1)
    expect(result.turnReport.mergedUserInputIds.some((id) => id.startsWith('ingest-1-'))).toBe(true)
    expect(observedMergedInputs.some((text) => text.includes('Curated user upload accepted.'))).toBe(true)
    expect(observedMergedInputs.some((text) => text.includes('ingressAsset=UserIngressManifest-'))).toBe(true)

    const assetNames = await fs.readdir(path.join(projectPath, 'yolo', 'sid-ingress-p1', 'assets'))
    expect(assetNames.some((name) => name.startsWith('UserIngressManifest-t001-a0-'))).toBe(true)
  })

  it('hard-enforces maxDiscoveryOps in P1', async () => {
    const projectPath = await createTempDir('yolo-p1-discovery-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'exceed discovery ops',
        assets: [
          {
            type: 'RiskRegister',
            payload: { reason: 'discovery overrun' }
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
          discoveryOps: 3
        }
      }
    ])

    const strictPlanner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        const constraints = buildDefaultP0Constraints()
        constraints.maxDiscoveryOps = 1
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: input.stage,
            branch: {
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId,
              action: 'advance'
            },
            objective: 'strict discovery budget',
            expectedAssets: ['RiskRegister'],
            constraints
          },
          suggestedPrompt: 'strict discovery',
          rationale: 'enforce discovery ops in P1',
          uncertaintyNote: 'none'
        }
      }
    }

    const session = new YoloSession(
      projectPath,
      'sid-p1-discovery',
      'P1 discovery bound',
      buildOptions('P1'),
      coordinator,
      { planner: strictPlanner }
    )

    await expect(session.executeNextTurn()).rejects.toThrow('hard constraint violation')
    const snapshot = await session.getSnapshot()
    expect(snapshot.state).toBe('FAILED')
  })

  it('forces non-progress re-plan to fork after 3 consecutive non-progress turns in P1', async () => {
    const projectPath = await createTempDir('yolo-p1-nonprogress-replan-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'np1',
        assets: [],
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
        summary: 'np2',
        assets: [],
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
        summary: 'np3',
        assets: [],
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
        summary: 'np4 triggers forced fork',
        assets: [],
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

    const planner: TurnPlanner = {
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
            objective: 'keep advancing',
            expectedAssets: [],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'non-progress loop',
          rationale: 'test non-progress replan',
          uncertaintyNote: 'none'
        }
      }
    }

    const session = new YoloSession(
      projectPath,
      'sid-p1-nonprogress-replan',
      'P1 non-progress replan test',
      buildOptions('P1'),
      coordinator,
      { planner }
    )

    await session.executeNextTurn()
    await session.executeNextTurn()
    await session.executeNextTurn()
    const fourth = await session.executeNextTurn()

    expect(fourth.turnReport.branchDiff.action).toBe('fork')
    const snapshot = await session.getSnapshot()
    expect(snapshot.nonProgressTurns).toBe(0)

    const eventsPath = path.join(projectPath, 'yolo', 'sid-p1-nonprogress-replan', 'events.jsonl')
    const eventsRaw = await fs.readFile(eventsPath, 'utf-8')
    const events = eventsRaw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { eventType?: string; payload?: { reason?: string } })
    expect(events.some((event) => event.eventType === 'amendment_requested'
      && event.payload?.reason?.includes('mandatory re-plan triggered'))).toBe(true)
  })

  it('forces loop-breaker fork when same node fails same gate twice in P1', async () => {
    const projectPath = await createTempDir('yolo-p1-loop-breaker-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'gate fail on node N-002',
        assets: [{ type: 'RiskRegister', payload: { reason: 'g1' } }],
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
        summary: 'gate fail again on same node',
        assets: [{ type: 'RiskRegister', payload: { reason: 'g2' } }],
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
        summary: 'loop breaker should force fork',
        assets: [{ type: 'RiskRegister', payload: { reason: 'g3' } }],
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

    let plannerCall = 0
    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        plannerCall += 1
        if (plannerCall === 1) {
          return {
            turnSpec: {
              turnNumber: input.turnNumber,
              stage: 'S2',
              branch: {
                activeBranchId: input.activeBranchId,
                activeNodeId: input.activeNodeId,
                action: 'advance'
              },
              objective: 'advance into S2',
              expectedAssets: ['RiskRegister'],
              constraints: buildDefaultP0Constraints()
            },
            suggestedPrompt: 'gate fail one',
            rationale: 'first failure',
            uncertaintyNote: 'none'
          }
        }

        if (plannerCall === 2) {
          return {
            turnSpec: {
              turnNumber: input.turnNumber,
              stage: 'S2',
              branch: {
                activeBranchId: input.activeBranchId,
                activeNodeId: input.activeNodeId,
                action: 'revisit',
                targetNodeId: input.activeNodeId
              },
              objective: 'revisit same node',
              expectedAssets: ['RiskRegister'],
              constraints: buildDefaultP0Constraints()
            },
            suggestedPrompt: 'gate fail two',
            rationale: 'second failure same node',
            uncertaintyNote: 'none'
          }
        }

        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: 'S2',
            branch: {
              activeBranchId: input.activeBranchId,
              activeNodeId: input.activeNodeId,
              action: 'advance'
            },
            objective: 'planner still wants advance',
            expectedAssets: ['RiskRegister'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'expect loop breaker',
          rationale: 'should be overridden',
          uncertaintyNote: 'none'
        }
      }
    }

    const session = new YoloSession(
      projectPath,
      'sid-p1-loop-breaker',
      'P1 gate loop-breaker test',
      buildOptions('P1'),
      coordinator,
      { planner }
    )

    const first = await session.executeNextTurn()
    expect(first.turnReport.gateImpact.status).toBe('fail')
    const second = await session.executeNextTurn()
    expect(second.turnReport.gateImpact.status).toBe('fail')
    expect(second.turnReport.branchDiff.activeNode).toBe(first.turnReport.branchDiff.activeNode)
    const third = await session.executeNextTurn()
    expect(third.turnReport.branchDiff.action).toBe('fork')
    const invalidatedNode = JSON.parse(await fs.readFile(
      path.join(projectPath, 'yolo', 'sid-p1-loop-breaker', 'branches', 'nodes', 'N-002.json'),
      'utf-8'
    )) as { status?: string }
    expect(invalidatedNode.status).toBe('invalidated')

    const eventsPath = path.join(projectPath, 'yolo', 'sid-p1-loop-breaker', 'events.jsonl')
    const eventsRaw = await fs.readFile(eventsPath, 'utf-8')
    const events = eventsRaw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { eventType?: string; payload?: { reason?: string } })
    expect(events.some((event) => event.eventType === 'amendment_requested'
      && event.payload?.reason?.includes('loop-breaker'))).toBe(true)
  })

  it('blocks revisiting invalidated node without override decision', async () => {
    const projectPath = await createTempDir('yolo-p1-override-block-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 't1',
        assets: [{ type: 'RiskRegister', payload: { reason: 't1' } }],
        metrics: { toolCalls: 1, wallClockSec: 1, stepCount: 1, readBytes: 10, promptTokens: 20, completionTokens: 20, turnTokens: 40, turnCostUsd: 0.01, discoveryOps: 1 }
      },
      {
        summary: 't2',
        assets: [{ type: 'RiskRegister', payload: { reason: 't2' } }],
        metrics: { toolCalls: 1, wallClockSec: 1, stepCount: 1, readBytes: 10, promptTokens: 20, completionTokens: 20, turnTokens: 40, turnCostUsd: 0.01, discoveryOps: 1 }
      },
      {
        summary: 't3',
        assets: [{ type: 'RiskRegister', payload: { reason: 't3' } }],
        metrics: { toolCalls: 1, wallClockSec: 1, stepCount: 1, readBytes: 10, promptTokens: 20, completionTokens: 20, turnTokens: 40, turnCostUsd: 0.01, discoveryOps: 1 }
      },
      {
        summary: 't4 revisit invalidated node',
        assets: [{ type: 'RiskRegister', payload: { reason: 't4' } }],
        metrics: { toolCalls: 1, wallClockSec: 1, stepCount: 1, readBytes: 10, promptTokens: 20, completionTokens: 20, turnTokens: 40, turnCostUsd: 0.01, discoveryOps: 1 }
      }
    ])

    let plannerCall = 0
    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        plannerCall += 1
        if (plannerCall === 1) {
          return {
            turnSpec: {
              turnNumber: input.turnNumber,
              stage: 'S2',
              branch: { activeBranchId: input.activeBranchId, activeNodeId: input.activeNodeId, action: 'advance' },
              objective: 't1',
              expectedAssets: ['RiskRegister'],
              constraints: buildDefaultP0Constraints()
            },
            suggestedPrompt: 't1',
            rationale: 't1',
            uncertaintyNote: 'none'
          }
        }
        if (plannerCall === 2) {
          return {
            turnSpec: {
              turnNumber: input.turnNumber,
              stage: 'S2',
              branch: { activeBranchId: input.activeBranchId, activeNodeId: input.activeNodeId, action: 'revisit', targetNodeId: input.activeNodeId },
              objective: 't2 revisit same node',
              expectedAssets: ['RiskRegister'],
              constraints: buildDefaultP0Constraints()
            },
            suggestedPrompt: 't2',
            rationale: 't2',
            uncertaintyNote: 'none'
          }
        }
        if (plannerCall === 3) {
          return {
            turnSpec: {
              turnNumber: input.turnNumber,
              stage: 'S2',
              branch: { activeBranchId: input.activeBranchId, activeNodeId: input.activeNodeId, action: 'advance' },
              objective: 't3 advance',
              expectedAssets: ['RiskRegister'],
              constraints: buildDefaultP0Constraints()
            },
            suggestedPrompt: 't3',
            rationale: 't3',
            uncertaintyNote: 'none'
          }
        }
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: 'S2',
            branch: { activeBranchId: input.activeBranchId, activeNodeId: input.activeNodeId, action: 'revisit', targetNodeId: 'N-002' },
            objective: 't4 revisit invalidated',
            expectedAssets: ['RiskRegister'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 't4',
          rationale: 't4',
          uncertaintyNote: 'none'
        }
      }
    }

    const session = new YoloSession(
      projectPath,
      'sid-p1-override-block',
      'P1 override block test',
      buildOptions('P1'),
      coordinator,
      { planner }
    )

    await session.executeNextTurn()
    await session.executeNextTurn()
    const third = await session.executeNextTurn()
    expect(third.turnReport.branchDiff.action).toBe('fork')
    await expect(session.executeNextTurn()).rejects.toThrow('override decision required')
  })

  it('allows revisiting invalidated node after override decision is recorded', async () => {
    const projectPath = await createTempDir('yolo-p1-override-allow-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 't1',
        assets: [{ type: 'RiskRegister', payload: { reason: 't1' } }],
        metrics: { toolCalls: 1, wallClockSec: 1, stepCount: 1, readBytes: 10, promptTokens: 20, completionTokens: 20, turnTokens: 40, turnCostUsd: 0.01, discoveryOps: 1 }
      },
      {
        summary: 't2',
        assets: [{ type: 'RiskRegister', payload: { reason: 't2' } }],
        metrics: { toolCalls: 1, wallClockSec: 1, stepCount: 1, readBytes: 10, promptTokens: 20, completionTokens: 20, turnTokens: 40, turnCostUsd: 0.01, discoveryOps: 1 }
      },
      {
        summary: 't3',
        assets: [{ type: 'RiskRegister', payload: { reason: 't3' } }],
        metrics: { toolCalls: 1, wallClockSec: 1, stepCount: 1, readBytes: 10, promptTokens: 20, completionTokens: 20, turnTokens: 40, turnCostUsd: 0.01, discoveryOps: 1 }
      },
      {
        summary: 't4 revisit invalidated with override',
        assets: [{ type: 'RiskRegister', payload: { reason: 't4' } }],
        metrics: { toolCalls: 1, wallClockSec: 1, stepCount: 1, readBytes: 10, promptTokens: 20, completionTokens: 20, turnTokens: 40, turnCostUsd: 0.01, discoveryOps: 1 }
      }
    ])

    let plannerCall = 0
    const planner: TurnPlanner = {
      async generate(input: PlannerInput): Promise<PlannerOutput> {
        plannerCall += 1
        if (plannerCall === 1) {
          return {
            turnSpec: {
              turnNumber: input.turnNumber,
              stage: 'S2',
              branch: { activeBranchId: input.activeBranchId, activeNodeId: input.activeNodeId, action: 'advance' },
              objective: 't1',
              expectedAssets: ['RiskRegister'],
              constraints: buildDefaultP0Constraints()
            },
            suggestedPrompt: 't1',
            rationale: 't1',
            uncertaintyNote: 'none'
          }
        }
        if (plannerCall === 2) {
          return {
            turnSpec: {
              turnNumber: input.turnNumber,
              stage: 'S2',
              branch: { activeBranchId: input.activeBranchId, activeNodeId: input.activeNodeId, action: 'revisit', targetNodeId: input.activeNodeId },
              objective: 't2 revisit same node',
              expectedAssets: ['RiskRegister'],
              constraints: buildDefaultP0Constraints()
            },
            suggestedPrompt: 't2',
            rationale: 't2',
            uncertaintyNote: 'none'
          }
        }
        if (plannerCall === 3) {
          return {
            turnSpec: {
              turnNumber: input.turnNumber,
              stage: 'S2',
              branch: { activeBranchId: input.activeBranchId, activeNodeId: input.activeNodeId, action: 'advance' },
              objective: 't3 advance',
              expectedAssets: ['RiskRegister'],
              constraints: buildDefaultP0Constraints()
            },
            suggestedPrompt: 't3',
            rationale: 't3',
            uncertaintyNote: 'none'
          }
        }
        return {
          turnSpec: {
            turnNumber: input.turnNumber,
            stage: 'S2',
            branch: { activeBranchId: input.activeBranchId, activeNodeId: input.activeNodeId, action: 'revisit', targetNodeId: 'N-002' },
            objective: 't4 revisit invalidated',
            expectedAssets: ['RiskRegister'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 't4',
          rationale: 't4',
          uncertaintyNote: 'none'
        }
      }
    }

    const session = new YoloSession(
      projectPath,
      'sid-p1-override-allow',
      'P1 override allow test',
      buildOptions('P1'),
      coordinator,
      { planner }
    )

    await session.executeNextTurn()
    await session.executeNextTurn()
    const third = await session.executeNextTurn()
    expect(third.turnReport.branchDiff.action).toBe('fork')

    const overrideDecisionId = await session.recordOverrideDecision({
      targetNodeId: 'N-002',
      rationale: 'Need to inspect invalidated node again',
      riskAccepted: 'Accept risk'
    })
    expect(overrideDecisionId.startsWith('Decision-')).toBe(true)

    const fourth = await session.executeNextTurn()
    expect(fourth.turnReport.branchDiff.action).toBe('revisit')
    expect(fourth.turnReport.branchDiff.activeNode).toBe('N-002')
  })

  it('tracks stage gate status across unlocked stages', async () => {
    const projectPath = await createTempDir('yolo-p1-stage-gate-tracking-')
    tempDirs.push(projectPath)

    const coordinator = new ScriptedCoordinator([
      {
        summary: 'S2 pass baseline',
        assets: [
          { type: 'Claim', payload: { text: 'claim' } },
          { type: 'EvidenceLink', payload: { claimId: 'Claim-1', evidenceId: 'Run-1' } }
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
            objective: 'track gate statuses',
            expectedAssets: ['Claim', 'EvidenceLink'],
            constraints: buildDefaultP0Constraints()
          },
          suggestedPrompt: 'gate tracking',
          rationale: 'track gate status',
          uncertaintyNote: 'none'
        }
      }
    }

    const session = new YoloSession(
      projectPath,
      'sid-p1-stage-gate-tracking',
      'P1 stage gate tracking test',
      buildOptions('P1'),
      coordinator,
      { planner }
    )

    await session.executeNextTurn()
    const snapshot = await session.getSnapshot()
    expect(snapshot.stageGateStatus?.S1).toBe('pass')
    expect(snapshot.stageGateStatus?.S2).toBe('pass')
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
        objective: 'advance after external wait',
        expectedAssets: ['RiskRegister'],
        constraints: buildDefaultP0Constraints()
      },
      suggestedPrompt: 'advance after waiting',
      rationale: 'resume normal flow',
      uncertaintyNote: 'none'
    }
  }
}
