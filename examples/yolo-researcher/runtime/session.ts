import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { FileAssetStore } from './asset-store.js'
import { DegenerateBranchManager, type BranchNode } from './branch-manager.js'
import { CheckpointBroker } from './checkpoint-broker.js'
import { LeanGateEngine, StructuralGateEngine, StubGateEngine } from './gate-engine.js'
import { DisabledReviewEngine } from './review-engine.js'
import { UserIngressManager } from './user-ingress-manager.js'
import {
  buildDefaultP0Constraints,
  createConservativeFallbackSpec,
  isTurnSpecValid
} from './planner.js'
import type {
  ActivityEvent,
  AssetRecord,
  AskUserRequest,
  CoordinatorTurnResult,
  ExternalWaitTask,
  GateEngine,
  PendingResourceExtension,
  PlannerInput,
  PlannerOutput,
  QueuedUserInput,
  ReadinessSnapshot,
  ReviewEngine,
  ReviewerProcessReview,
  RuntimeCheckpoint,
  RuntimeLease,
  SessionPersistedState,
  SnapshotManifest,
  TurnExecutionResult,
  TurnPlanner,
  TurnReport,
  WaitTaskValidationResult,
  YoloCoordinator,
  YoloEvent,
  YoloEventPayloadByType,
  YoloEventType,
  YoloRuntimeState,
  YoloSessionOptions,
  YoloStage
} from './types.js'
import {
  appendJsonLine,
  ensureDir,
  fileExists,
  nowIso,
  randomId,
  readJsonFile,
  readTextFileOrEmpty,
  sha256Hex,
  sortStrings,
  writeJsonFile,
  writeTextFile
} from './utils.js'

const SYSTEM_STATE_START = '<!-- SYSTEM_STATE_START -->'
const SYSTEM_STATE_END = '<!-- SYSTEM_STATE_END -->'
const AGENT_NOTES_START = '<!-- AGENT_NOTES_START -->'
const AGENT_NOTES_END = '<!-- AGENT_NOTES_END -->'
const PHASE_ORDER: Record<YoloSessionOptions['phase'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 }
const DEFAULT_RUNTIME_LEASE_STALE_SEC = 180
const DEFAULT_RUNTIME_ROLLUP_INTERVAL_SEC = 24 * 60 * 60
const WAIT_TASK_REMINDER_SEC = 60 * 60
const WAIT_TASK_ESCALATION_SEC = 6 * 60 * 60
const STAGE_ORDER: YoloStage[] = ['S1', 'S2', 'S3', 'S4', 'S5']

interface YoloSessionDeps {
  planner: TurnPlanner
  gateEngine?: GateEngine
  reviewEngine?: ReviewEngine
  assetStore?: FileAssetStore
  branchManager?: DegenerateBranchManager
  checkpointBroker?: CheckpointBroker
  ingressManager?: UserIngressManager
  onActivity?: (event: ActivityEvent) => void
  now?: () => string
  runtimeRollupIntervalSec?: number
}

function defaultSessionState(input: {
  sessionId: string
  goal: string
  options: YoloSessionOptions
  activeBranchId: string
  activeNodeId: string
}): SessionPersistedState {
  const now = nowIso()
  return {
    sessionId: input.sessionId,
    goal: input.goal,
    phase: input.options.phase,
    state: 'IDLE',
    createdAt: now,
    updatedAt: now,
    currentTurn: 0,
    currentAttempt: 0,
    nonProgressTurns: 0,
    activeStage: 'S1',
    activeBranchId: input.activeBranchId,
    activeNodeId: input.activeNodeId,
    budgetUsed: {
      tokens: 0,
      costUsd: 0,
      turns: 0
    },
    gateFailureCounts: {},
    stageGateStatus: {
      S1: 'none',
      S2: 'none',
      S3: 'none',
      S4: 'none',
      S5: 'none'
    },
    maintenance: {
      budgetAlertLevel: 'none',
      waitTaskAlerts: {}
    }
  }
}

function extractZone(raw: string, start: string, end: string): string {
  const startIdx = raw.indexOf(start)
  const endIdx = raw.indexOf(end)
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return ''
  return raw.slice(startIdx + start.length, endIdx).trim()
}

function renderZonedMarkdown(title: string, systemState: unknown, agentNotes: string): string {
  return [
    `# ${title}`,
    '',
    '## SYSTEM_STATE',
    SYSTEM_STATE_START,
    '```json',
    JSON.stringify(systemState, null, 2),
    '```',
    SYSTEM_STATE_END,
    '',
    '## AGENT_NOTES',
    AGENT_NOTES_START,
    agentNotes.trim(),
    AGENT_NOTES_END,
    ''
  ].join('\n')
}

function parseTurnNumberFromReportName(fileName: string): number | null {
  const matched = fileName.match(/^(\d+)\.report\.json$/)
  if (!matched) return null
  const value = Number(matched[1])
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

export class YoloSession {
  readonly sessionDir: string
  readonly sessionPath: string
  readonly eventsPath: string
  readonly turnsDir: string
  readonly turnsStagingDir: string
  readonly planPath: string
  readonly planStatePath: string
  readonly branchDossiersDir: string
  readonly waitTasksDir: string
  readonly waitTaskHistoryDir: string
  readonly runtimeDir: string
  readonly runtimeLeasePath: string
  readonly runtimeCheckpointsDir: string
  readonly runtimeCheckpointsLatestPath: string

  private readonly planner: TurnPlanner
  private readonly gateEngine: GateEngine
  private readonly reviewEngine: ReviewEngine
  private readonly assetStore: FileAssetStore
  private readonly branchManager: DegenerateBranchManager
  private readonly checkpointBroker: CheckpointBroker
  private readonly ingressManager: UserIngressManager
  private readonly onActivity?: (event: ActivityEvent) => void
  private readonly now: () => string
  private readonly runtimeOwnerId: string
  private readonly runtimeRollupIntervalSec: number
  private readonly runtimeMode: YoloSessionOptions['mode']

  constructor(
    private readonly projectPath: string,
    readonly sessionId: string,
    private readonly goal: string,
    private readonly options: YoloSessionOptions,
    private readonly coordinator: YoloCoordinator,
    deps: YoloSessionDeps
  ) {
    this.sessionDir = path.join(projectPath, 'yolo', sessionId)
    this.sessionPath = path.join(this.sessionDir, 'session.json')
    this.eventsPath = path.join(this.sessionDir, 'events.jsonl')
    this.turnsDir = path.join(this.sessionDir, 'turns')
    this.turnsStagingDir = path.join(this.turnsDir, '.staging')
    this.planPath = path.join(this.sessionDir, 'plan.md')
    this.planStatePath = path.join(this.sessionDir, 'plan-state.json')
    this.branchDossiersDir = path.join(this.sessionDir, 'branch-dossiers')
    this.waitTasksDir = path.join(this.sessionDir, 'wait-tasks')
    this.waitTaskHistoryDir = path.join(this.waitTasksDir, 'history')
    this.runtimeDir = path.join(this.sessionDir, 'runtime')
    this.runtimeLeasePath = path.join(this.runtimeDir, 'lease.json')
    this.runtimeCheckpointsDir = path.join(this.runtimeDir, 'checkpoints')
    this.runtimeCheckpointsLatestPath = path.join(this.runtimeCheckpointsDir, 'latest.json')

    this.assetStore = deps.assetStore ?? new FileAssetStore(this.sessionDir)
    this.branchManager = deps.branchManager ?? new DegenerateBranchManager(this.sessionDir, this.options.phase)
    this.checkpointBroker = deps.checkpointBroker ?? new CheckpointBroker()
    this.ingressManager = deps.ingressManager ?? new UserIngressManager(this.sessionDir)
    this.planner = deps.planner
    this.runtimeMode = this.options.mode ?? 'legacy'
    this.gateEngine = deps.gateEngine ?? (
      this.runtimeMode === 'lean_v2'
        ? new LeanGateEngine()
        : (this.options.phase === 'P0' ? new StubGateEngine() : new StructuralGateEngine())
    )
    this.reviewEngine = deps.reviewEngine ?? new DisabledReviewEngine()
    this.onActivity = deps.onActivity
    this.now = deps.now ?? nowIso
    this.runtimeOwnerId = randomId('owner')
    this.runtimeRollupIntervalSec = Math.max(0, Math.floor(deps.runtimeRollupIntervalSec ?? DEFAULT_RUNTIME_ROLLUP_INTERVAL_SEC))
  }

  async init(): Promise<void> {
    await ensureDir(this.sessionDir)
    await ensureDir(this.turnsDir)
    await ensureDir(this.turnsStagingDir)
    await ensureDir(this.branchDossiersDir)
    await ensureDir(this.waitTasksDir)
    await ensureDir(this.waitTaskHistoryDir)
    if (this.isPhaseAtLeast('P2')) {
      await ensureDir(this.runtimeDir)
      await ensureDir(this.runtimeCheckpointsDir)
      await this.acquireRuntimeLease()
    }
    await this.ingressManager.init()
    await this.assetStore.init()

    const branchInit = await this.branchManager.init('S1')
    const dossierPath = path.join(this.branchDossiersDir, `${branchInit.tree.activeBranchId}.md`)

    if (!(await fileExists(this.eventsPath))) {
      await writeTextFile(this.eventsPath, '')
    }

    if (!(await fileExists(this.planPath))) {
      const initialSystemState = {
        sessionId: this.sessionId,
        goal: this.goal,
        activeStage: 'S1',
        activeBranchId: branchInit.tree.activeBranchId,
        activeNodeId: branchInit.tree.activeNodeId,
        turns: 0
      }
      await writeTextFile(this.planPath, renderZonedMarkdown('YOLO Plan', initialSystemState, ''))
      await writeJsonFile(this.planStatePath, initialSystemState)
    }

    if (!(await fileExists(dossierPath))) {
      const initialBranchState = {
        branchId: branchInit.tree.activeBranchId,
        activeNodeId: branchInit.tree.activeNodeId,
        stage: branchInit.activeNode.stage,
        openRisks: []
      }
      await writeTextFile(dossierPath, renderZonedMarkdown(`Branch Dossier ${branchInit.tree.activeBranchId}`, initialBranchState, ''))
    }

    // Auto-create research.md if it doesn't exist
    const researchMdPath = path.join(this.projectPath, 'research.md')
    if (!(await fileExists(researchMdPath))) {
      await writeTextFile(researchMdPath, `Users Overall Research Goal:\n${this.goal}\n`)
    }

    if (!(await fileExists(this.sessionPath))) {
      const sessionState = defaultSessionState({
        sessionId: this.sessionId,
        goal: this.goal,
        options: this.options,
        activeBranchId: branchInit.tree.activeBranchId,
        activeNodeId: branchInit.tree.activeNodeId
      })
      await this.writeSessionState(sessionState)
      await this.writeRuntimeCheckpoint(sessionState, 'init')
    } else {
      await this.reconcileWaitingExternalOnInit()
    }
  }

  enqueueInput(text: string, priority: 'urgent' | 'normal' = 'normal', source: 'chat' | 'system' = 'chat') {
    return this.checkpointBroker.enqueueInput(text, priority, source)
  }

  getQueuedInputs(): QueuedUserInput[] {
    return this.checkpointBroker.getQueueSnapshot()
  }

  removeQueuedInput(id: string): QueuedUserInput | null {
    return this.checkpointBroker.removeQueuedInput(id)
  }

  updateQueuedInputPriority(id: string, priority: QueuedUserInput['priority']): QueuedUserInput | null {
    return this.checkpointBroker.updateQueuedInputPriority(id, priority)
  }

  moveQueuedInput(id: string, toIndex: number): QueuedUserInput[] {
    return this.checkpointBroker.moveQueuedInput(id, toIndex)
  }

  async recordCheckpointDecision(responseText: string): Promise<string | null> {
    await this.init()
    const state = await this.readSessionState()
    const pending = state.pendingQuestion
    if (state.state !== 'WAITING_FOR_USER' || !pending?.checkpoint) {
      return null
    }

    const questionId = pending.id ?? `${state.sessionId}-turn-${state.currentTurn}-checkpoint`
    const existingDecisionId = await this.findExistingCheckpointDecisionId(questionId)
    if (existingDecisionId) return existingDecisionId
    const choice = responseText.trim()
    const recordedAt = this.now()
    const referencedAssetIds = await this.resolveCheckpointReferencedAssetIds(pending)

    const decisionAsset = await this.assetStore.appendOutOfTurnAsset({
      turnNumber: state.currentTurn,
      attempt: 0,
      type: 'Decision',
      payload: {
        kind: pending.checkpoint,
        madeAt: recordedAt,
        madeBy: 'user',
        branchId: state.activeBranchId,
        nodeId: state.activeNodeId,
        turnNumber: state.currentTurn,
        referencedAssetIds,
        choice,
        alternatives: pending.options ?? [],
        rationale: pending.context ?? '',
        checkpoint: pending.checkpoint,
        questionId,
        question: pending.question,
        options: pending.options ?? [],
        context: pending.context ?? '',
        responseText: choice,
        recordedAt
      }
    })

    let seq = await this.getNextSeqForTurn(state.currentTurn)
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'asset_created',
      payload: { assetId: decisionAsset.id, type: decisionAsset.type }
    } satisfies YoloEvent<'asset_created'>)

    seq += 1
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'checkpoint_confirmed',
      payload: {
        decisionAssetId: decisionAsset.id,
        checkpoint: pending.checkpoint
      }
    } satisfies YoloEvent<'checkpoint_confirmed'>)

    return decisionAsset.id
  }

  async recordOverrideDecision(input: {
    targetNodeId: string
    rationale: string
    riskAccepted?: string
    madeBy?: 'user' | 'system'
  }): Promise<string> {
    await this.init()
    const targetNodeId = input.targetNodeId.trim()
    const rationale = input.rationale.trim()
    if (!targetNodeId) throw new Error('targetNodeId is required')
    if (!rationale) throw new Error('override rationale is required')

    const state = await this.readSessionState()
    const recordedAt = this.now()
    const decision = await this.assetStore.appendOutOfTurnAsset({
      turnNumber: state.currentTurn,
      attempt: 0,
      type: 'Decision',
      payload: {
        kind: 'override',
        madeAt: recordedAt,
        madeBy: input.madeBy ?? 'user',
        branchId: state.activeBranchId,
        nodeId: state.activeNodeId,
        turnNumber: state.currentTurn,
        referencedAssetIds: [],
        choice: 'override',
        targetNodeId,
        rationale,
        riskAccepted: input.riskAccepted?.trim() || undefined,
        recordedAt,
        stage: state.activeStage
      }
    })

    const seq = await this.getNextSeqForTurn(state.currentTurn)
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'asset_created',
      payload: { assetId: decision.id, type: decision.type }
    } satisfies YoloEvent<'asset_created'>)

    return decision.id
  }

  async requestResourceExtension(input: {
    rationale: string
    delta: {
      maxTurns?: number
      maxTokens?: number
      maxCostUsd?: number
    }
    requestedBy?: 'user' | 'agent'
  }): Promise<PendingResourceExtension> {
    await this.init()
    const state = await this.readSessionState()
    // Allow extension requests from STOPPED so budget-exhausted sessions can be continued.
    if (state.state === 'FAILED' || state.state === 'COMPLETE') {
      throw new Error(`cannot request resource extension from terminal state ${state.state}`)
    }
    if (state.pendingResourceExtension) {
      throw new Error('resource extension request is already pending')
    }

    const rationale = input.rationale.trim()
    if (!rationale) throw new Error('resource extension rationale is required')

    const delta = {
      maxTurns: Math.max(0, Math.floor(input.delta.maxTurns ?? 0)),
      maxTokens: Math.max(0, Math.floor(input.delta.maxTokens ?? 0)),
      maxCostUsd: Math.max(0, Number(input.delta.maxCostUsd ?? 0))
    }
    if (delta.maxTurns === 0 && delta.maxTokens === 0 && delta.maxCostUsd === 0) {
      throw new Error('resource extension delta must request at least one positive budget increase')
    }

    const request: PendingResourceExtension = {
      id: randomId('rext'),
      requestedAt: this.now(),
      requestedBy: input.requestedBy ?? 'user',
      rationale,
      delta
    }

    const previousBudget = { ...this.options.budget }
    const proposedBudget = {
      maxTurns: previousBudget.maxTurns + delta.maxTurns,
      maxTokens: previousBudget.maxTokens + delta.maxTokens,
      maxCostUsd: previousBudget.maxCostUsd + delta.maxCostUsd,
      deadlineIso: previousBudget.deadlineIso
    }

    const budgetRequestAsset = await this.assetStore.appendOutOfTurnAsset({
      turnNumber: state.currentTurn,
      attempt: 0,
      type: 'ResourceBudget',
      payload: {
        kind: 'extension_request',
        requestId: request.id,
        requestedAt: request.requestedAt,
        requestedBy: request.requestedBy,
        rationale: request.rationale,
        delta: request.delta,
        previousBudget,
        proposedBudget
      }
    })

    const prompt = this.checkpointBroker.emitQuestion({
      question: 'Approve resource extension request?',
      options: ['Approve', 'Reject'],
      context: [
        `requestId=${request.id}`,
        `deltaTurns=+${delta.maxTurns}`,
        `deltaTokens=+${delta.maxTokens}`,
        `deltaCostUsd=+${delta.maxCostUsd.toFixed(3)}`,
        `rationale=${rationale}`
      ].join(' | '),
      checkpoint: 'final-scope',
      blocking: true
    })

    const from = state.state
    state.state = 'WAITING_FOR_USER'
    state.pendingQuestion = prompt
    state.pendingResourceExtension = request
    state.pendingExternalTaskId = undefined
    state.updatedAt = this.now()
    await this.writeSessionState(state)
    await this.writeRuntimeCheckpoint(state, 'state_transition')

    let seq = await this.getNextSeqForTurn(state.currentTurn)
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'asset_created',
      payload: { assetId: budgetRequestAsset.id, type: budgetRequestAsset.type }
    } satisfies YoloEvent<'asset_created'>)
    seq += 1
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'ask_user_emitted',
      payload: {
        questionId: prompt.id as string,
        blocking: prompt.blocking ?? true,
        checkpoint: prompt.checkpoint
      }
    } satisfies YoloEvent<'ask_user_emitted'>)
    seq += 1
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'state_transition',
      payload: { from, to: 'WAITING_FOR_USER', reason: `resource extension requested: ${request.id}` }
    } satisfies YoloEvent<'state_transition'>)

    return request
  }

  async resolveResourceExtension(input: { approved: boolean; note?: string }): Promise<{
    approved: boolean
    requestId: string
    decisionAssetId: string
    budget: YoloSessionOptions['budget']
  }> {
    await this.init()
    const state = await this.readSessionState()
    const request = state.pendingResourceExtension
    if (!request) {
      throw new Error('no pending resource extension request')
    }

    const note = input.note?.trim() ?? ''
    const previousBudget = { ...this.options.budget }
    const nextBudget = input.approved
      ? {
          maxTurns: previousBudget.maxTurns + request.delta.maxTurns,
          maxTokens: previousBudget.maxTokens + request.delta.maxTokens,
          maxCostUsd: previousBudget.maxCostUsd + request.delta.maxCostUsd,
          deadlineIso: previousBudget.deadlineIso
        }
      : previousBudget

    const decisionAsset = await this.assetStore.appendOutOfTurnAsset({
      turnNumber: state.currentTurn,
      attempt: 0,
      type: 'Decision',
      payload: {
        kind: 'resource_extension_decision',
        requestId: request.id,
        approved: input.approved,
        note,
        delta: request.delta,
        previousBudget,
        nextBudget,
        recordedAt: this.now()
      }
    })

    const budgetDecisionAsset = await this.assetStore.appendOutOfTurnAsset({
      turnNumber: state.currentTurn,
      attempt: 0,
      type: 'ResourceBudget',
      payload: {
        kind: input.approved ? 'extension_approved' : 'extension_rejected',
        requestId: request.id,
        decidedAt: this.now(),
        note,
        delta: request.delta,
        previousBudget,
        nextBudget
      }
    })

    if (input.approved) {
      this.options.budget.maxTurns = nextBudget.maxTurns
      this.options.budget.maxTokens = nextBudget.maxTokens
      this.options.budget.maxCostUsd = nextBudget.maxCostUsd
    }

    const from = state.state
    this.checkpointBroker.resolvePendingQuestion()
    state.pendingQuestion = undefined
    state.pendingResourceExtension = undefined
    state.pendingExternalTaskId = undefined
    state.state = 'PLANNING'
    state.updatedAt = this.now()
    await this.writeSessionState(state)
    await this.writeRuntimeCheckpoint(state, 'state_transition')

    let seq = await this.getNextSeqForTurn(state.currentTurn)
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'asset_created',
      payload: { assetId: decisionAsset.id, type: decisionAsset.type }
    } satisfies YoloEvent<'asset_created'>)
    seq += 1
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'asset_created',
      payload: { assetId: budgetDecisionAsset.id, type: budgetDecisionAsset.type }
    } satisfies YoloEvent<'asset_created'>)
    seq += 1
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'state_transition',
      payload: {
        from,
        to: 'PLANNING',
        reason: `resource extension ${input.approved ? 'approved' : 'rejected'}: ${request.id}`
      }
    } satisfies YoloEvent<'state_transition'>)

    return {
      approved: input.approved,
      requestId: request.id,
      decisionAssetId: decisionAsset.id,
      budget: { ...this.options.budget }
    }
  }

  async ensureIngressUploadDir(turnNumber?: number): Promise<string> {
    await this.init()
    const snapshot = await this.readSessionState()
    const targetTurn = turnNumber ?? (snapshot.currentTurn + 1)
    return this.ingressManager.ensureTurnIngressDir(targetTurn)
  }

  async requestExternalWait(input: {
    title: string
    completionRule: string
    resumeAction: string
    details?: string
    reason?: string
    requiredArtifacts?: Array<{ kind: string; pathHint?: string; description: string }>
    uploadTurnNumber?: number
  }): Promise<ExternalWaitTask> {
    await this.init()
    if (this.options.phase === 'P0') {
      throw new Error('WAITING_EXTERNAL is not available in P0; upgrade to P1+')
    }
    if (!input.title.trim()) throw new Error('wait task title is required')
    if (!input.completionRule.trim()) throw new Error('wait task completionRule is required')
    if (!input.resumeAction.trim()) throw new Error('wait task resumeAction is required')

    const state = await this.readSessionState()
    if (state.state === 'STOPPED' || state.state === 'FAILED' || state.state === 'COMPLETE') {
      throw new Error(`cannot request external wait from terminal state ${state.state}`)
    }

    const uploadTurnNumber = input.uploadTurnNumber ?? (state.currentTurn + 1)
    const uploadDirAbs = await this.ingressManager.ensureTurnIngressDir(uploadTurnNumber)
    const uploadDirRel = path.relative(this.sessionDir, uploadDirAbs)

    const task: ExternalWaitTask = {
      id: randomId('wait'),
      sessionId: this.sessionId,
      status: 'waiting',
      stage: state.activeStage,
      branchId: state.activeBranchId,
      nodeId: state.activeNodeId,
      title: input.title.trim(),
      reason: input.reason?.trim() || undefined,
      requiredArtifacts: input.requiredArtifacts?.map((item) => ({
        kind: item.kind,
        pathHint: item.pathHint?.trim() || undefined,
        description: item.description
      })),
      completionRule: input.completionRule.trim(),
      resumeAction: input.resumeAction.trim(),
      uploadDir: uploadDirRel,
      details: input.details?.trim() || undefined,
      createdAt: this.now()
    }

    await writeJsonFile(this.waitTaskPath(task.id), task)
    await this.appendWaitTaskHistory(task, 'created')

    const from = state.state
    state.state = 'WAITING_EXTERNAL'
    state.pendingQuestion = undefined
    state.pendingExternalTaskId = task.id
    state.pendingResourceExtension = undefined
    state.updatedAt = this.now()
    await this.writeSessionState(state)
    await this.writeRuntimeCheckpoint(state, 'state_transition')

    const seq = await this.getNextSeqForTurn(state.currentTurn)
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'state_transition',
      payload: { from, to: 'WAITING_EXTERNAL', reason: `external wait requested: ${task.id}` }
    } satisfies YoloEvent<'state_transition'>)

    return task
  }

  async requestFullTextUploadWait(input: {
    citation: string
    requiredFiles?: string[]
    reason?: string
  }): Promise<ExternalWaitTask> {
    await this.init()
    if (this.options.phase === 'P0') {
      throw new Error('full-text wait flow is not available in P0; upgrade to P1+')
    }

    const citation = input.citation.trim()
    if (!citation) throw new Error('citation is required')

    const requiredFiles = (input.requiredFiles ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
    const reason = input.reason?.trim() || 'full text unavailable via programmatic retrieval'

    const task = await this.requestExternalWait({
      title: `Upload full-text artifacts for ${citation}`,
      completionRule: requiredFiles.length > 0
        ? 'checklist:has_upload,required_files'
        : 'checklist:has_upload',
      resumeAction: 'ingest full text and continue literature analysis',
      reason,
      requiredArtifacts: requiredFiles.map((fileName) => ({
        kind: 'full_text_file',
        pathHint: fileName,
        description: `required full-text artifact: ${fileName}`
      })),
      details: [
        `reason=${reason}`,
        `citation=${citation}`,
        requiredFiles.length > 0 ? `requiredFiles=${requiredFiles.join(',')}` : ''
      ].filter(Boolean).join(' | ')
    })

    const state = await this.readSessionState()
    const question = this.checkpointBroker.emitQuestion({
      question: `Please upload full text for: ${citation}`,
      options: ['Uploaded', 'Need more guidance'],
      context: [
        `waitTask=${task.id}`,
        `uploadDir=${task.uploadDir ?? ''}`,
        requiredFiles.length > 0 ? `requiredFiles=${requiredFiles.join(', ')}` : 'requiredFiles=any full-text artifact'
      ].join(' | '),
      blocking: false
    })
    state.pendingQuestion = question
    state.updatedAt = this.now()
    await this.writeSessionState(state)
    await this.writeRuntimeCheckpoint(state, 'state_transition')

    const seq = await this.getNextSeqForTurn(state.currentTurn)
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'ask_user_emitted',
      payload: {
        questionId: question.id as string,
        blocking: question.blocking ?? true,
        checkpoint: question.checkpoint
      }
    } satisfies YoloEvent<'ask_user_emitted'>)

    return task
  }

  async listExternalWaitTasks(): Promise<ExternalWaitTask[]> {
    await ensureDir(this.waitTasksDir)
    const names = await fs.readdir(this.waitTasksDir)
    const tasks: ExternalWaitTask[] = []

    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const parsed = await readJsonFile<ExternalWaitTask>(path.join(this.waitTasksDir, name))
      tasks.push(parsed)
    }

    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async validateExternalWaitTask(taskId: string): Promise<WaitTaskValidationResult> {
    await this.init()
    if (!taskId.trim()) throw new Error('taskId is required')

    const taskPath = this.waitTaskPath(taskId.trim())
    if (!(await fileExists(taskPath))) {
      throw new Error(`wait task not found: ${taskId}`)
    }

    const task = await readJsonFile<ExternalWaitTask>(taskPath)
    return this.evaluateWaitTaskValidation(task)
  }

  async resolveExternalWaitTask(taskId: string, resolutionNote: string): Promise<ExternalWaitTask> {
    await this.init()
    const note = resolutionNote.trim()
    if (!taskId.trim()) throw new Error('taskId is required')
    if (!note) throw new Error('resolution note is required')

    const taskPath = this.waitTaskPath(taskId.trim())
    if (!(await fileExists(taskPath))) {
      throw new Error(`wait task not found: ${taskId}`)
    }

    const existing = await readJsonFile<ExternalWaitTask>(taskPath)
    if (existing.status === 'satisfied' || existing.status === 'resolved') {
      return existing
    }
    if (existing.status === 'canceled' || existing.status === 'cancelled' || existing.status === 'expired') {
      throw new Error(`wait task ${existing.id} is already closed with status ${existing.status}`)
    }
    const validation = await this.evaluateWaitTaskValidation(existing)
    if (!validation.ok) {
      if (validation.missingRequiredUploads.length > 0) {
        throw new Error(`cannot resolve wait task ${existing.id}: missing required upload(s): ${validation.missingRequiredUploads.join(', ')}`)
      }
      throw new Error(`cannot resolve wait task ${existing.id}: ${validation.reason ?? 'completion rule not satisfied'}`)
    }

    const resolved: ExternalWaitTask = {
      ...existing,
      status: 'satisfied',
      resolvedAt: this.now(),
      resolutionNote: note
    }
    await writeJsonFile(taskPath, resolved)
    await this.appendWaitTaskHistory(resolved, 'satisfied')

    const state = await this.readSessionState()
    if (state.pendingExternalTaskId === resolved.id) {
      const from = state.state
      state.pendingExternalTaskId = undefined
      if (state.state === 'WAITING_EXTERNAL') {
        state.state = 'PLANNING'
      }
      this.checkpointBroker.resolvePendingQuestion()
      state.pendingQuestion = undefined
      state.updatedAt = this.now()
      await this.writeSessionState(state)
      await this.writeRuntimeCheckpoint(state, 'state_transition')

      const seq = await this.getNextSeqForTurn(state.currentTurn)
      await appendJsonLine(this.eventsPath, {
        eventId: randomId('evt'),
        sessionId: this.sessionId,
        turnNumber: state.currentTurn,
        seq,
        timestamp: this.now(),
        schemaVersion: 1,
        eventType: 'state_transition',
        payload: { from, to: state.state, reason: `external wait resolved: ${resolved.id}` }
      } satisfies YoloEvent<'state_transition'>)
    }

    return resolved
  }

  async cancelExternalWaitTask(taskId: string, reason: string): Promise<ExternalWaitTask> {
    await this.init()
    const note = reason.trim()
    if (!taskId.trim()) throw new Error('taskId is required')
    if (!note) throw new Error('cancel reason is required')

    const taskPath = this.waitTaskPath(taskId.trim())
    if (!(await fileExists(taskPath))) {
      throw new Error(`wait task not found: ${taskId}`)
    }

    const existing = await readJsonFile<ExternalWaitTask>(taskPath)
    if (existing.status === 'canceled' || existing.status === 'cancelled') {
      return existing
    }
    if (existing.status === 'satisfied' || existing.status === 'resolved' || existing.status === 'expired') {
      throw new Error(`wait task ${existing.id} is already closed with status ${existing.status}`)
    }
    const cancelled: ExternalWaitTask = {
      ...existing,
      status: 'canceled',
      resolvedAt: this.now(),
      resolutionNote: note
    }
    await writeJsonFile(taskPath, cancelled)
    await this.appendWaitTaskHistory(cancelled, 'canceled')

    const state = await this.readSessionState()
    if (state.pendingExternalTaskId === cancelled.id) {
      const from = state.state
      state.pendingExternalTaskId = undefined
      if (state.state === 'WAITING_EXTERNAL') {
        state.state = 'PLANNING'
      }
      this.checkpointBroker.resolvePendingQuestion()
      state.pendingQuestion = undefined
      state.updatedAt = this.now()
      await this.writeSessionState(state)
      await this.writeRuntimeCheckpoint(state, 'state_transition')

      const seq = await this.getNextSeqForTurn(state.currentTurn)
      await appendJsonLine(this.eventsPath, {
        eventId: randomId('evt'),
        sessionId: this.sessionId,
        turnNumber: state.currentTurn,
        seq,
        timestamp: this.now(),
        schemaVersion: 1,
        eventType: 'state_transition',
        payload: { from, to: state.state, reason: `external wait canceled: ${cancelled.id}` }
      } satisfies YoloEvent<'state_transition'>)
    }

    return cancelled
  }

  async pause(): Promise<void> {
    await this.transitionOutOfTurn('PAUSED', 'pause requested by user')
  }

  async resume(): Promise<void> {
    const state = await this.readSessionState()
    if (state.state !== 'PAUSED' && state.state !== 'WAITING_FOR_USER' && state.state !== 'STOPPED') {
      throw new Error(`cannot resume from state ${state.state}`)
    }

    if (state.state === 'WAITING_FOR_USER') {
      if (state.pendingResourceExtension) {
        throw new Error('cannot resume while resource extension decision is pending')
      }
      this.checkpointBroker.resolvePendingQuestion()
      state.pendingQuestion = undefined
    }
    if (state.state === 'STOPPED') {
      const exhausted = this.getBudgetExhaustionReason(state)
      if (exhausted) {
        throw new Error(`cannot resume: ${exhausted}`)
      }
    }

    await this.transitionOutOfTurn('PLANNING', 'resume requested by user', state)
  }

  async stop(): Promise<void> {
    await this.transitionOutOfTurn('STOPPED', 'stop requested by user')
    await this.reviewEngine.destroy?.()
  }

  async getSnapshot(): Promise<SessionPersistedState> {
    await this.init()
    await this.runMaintenanceChecks()
    return this.readSessionState()
  }

  async restoreFromLatestCheckpoint(): Promise<boolean> {
    await this.init()
    if (!this.isPhaseAtLeast('P2')) return false
    if (!(await fileExists(this.runtimeCheckpointsLatestPath))) return false

    const latest = await this.tryReadJsonFile<{ fileName?: string }>(this.runtimeCheckpointsLatestPath)
    if (!latest) return false
    const fileName = latest.fileName?.trim()
    if (!fileName) return false

    const checkpointPath = path.join(this.runtimeCheckpointsDir, fileName)
    if (!(await fileExists(checkpointPath))) return false

    const checkpoint = await this.tryReadJsonFile<RuntimeCheckpoint>(checkpointPath)
    if (!checkpoint) return false
    const restoredState: SessionPersistedState = {
      ...checkpoint.sessionState,
      updatedAt: this.now()
    }
    await this.writeSessionState(restoredState)
    await this.writeRuntimeCheckpoint(restoredState, 'state_transition')
    return true
  }

  async executeNextTurn(): Promise<TurnExecutionResult> {
    await this.init()
    const state = await this.readSessionState()

    if (state.state === 'WAITING_FOR_USER') {
      throw new Error('session is waiting for user input')
    }
    if (state.state === 'WAITING_EXTERNAL') {
      throw new Error('session is waiting for external dependency')
    }
    if (state.state === 'PAUSED') {
      throw new Error('session is paused')
    }
    if (state.state === 'STOPPED' || state.state === 'COMPLETE' || state.state === 'FAILED') {
      throw new Error(`cannot execute turn from terminal state ${state.state}`)
    }

    const exhaustedBeforeTurn = this.getBudgetExhaustionReason(state)
    if (exhaustedBeforeTurn) {
      await this.transitionOutOfTurn('STOPPED', exhaustedBeforeTurn, state)
      throw new Error(exhaustedBeforeTurn)
    }

    const turnNumber = state.currentTurn + 1
    const attempt = 1
    let seq = await this.getNextSeqForTurn(turnNumber)
    const emit = async <T extends YoloEventType>(eventType: T, payload: YoloEventPayloadByType[T]) => {
      const event: YoloEvent<T> = {
        eventId: randomId('evt'),
        sessionId: this.sessionId,
        turnNumber,
        seq,
        timestamp: this.now(),
        schemaVersion: 1,
        eventType,
        payload
      }
      seq += 1
      await appendJsonLine(this.eventsPath, event)
    }

    const transition = async (to: YoloRuntimeState, reason?: string) => {
      await emit('state_transition', { from: state.state, to, reason })
      state.state = to
      state.updatedAt = this.now()
    }

    const startedAt = this.now()

    try {
      await transition('PLANNING', 'turn planning started')
      const advisoryNotes: string[] = []

      const preflight = this.resolveReadinessPreflight(state.activeStage)
      if (!preflight.initialSnapshot.pass) {
        const failed = preflight.initialSnapshot.requiredFailed.join(', ')
        if (preflight.downgradedFrom && preflight.downgradedTo) {
          const message = [
            `readiness required gates failed for phase ${preflight.downgradedFrom}: ${failed}`,
            `downgraded phase to ${preflight.downgradedTo}`
          ].join('; ')
          advisoryNotes.push(message)
          await emit('maintenance_alert', {
            kind: 'readiness_gate_failure',
            severity: 'warning',
            message,
            refs: preflight.initialSnapshot.requiredFailed
          })
          this.options.phase = preflight.downgradedTo
          state.phase = preflight.downgradedTo
          state.updatedAt = this.now()
        } else {
          const stopReason = preflight.stopReason
            ?? `readiness required gates failed for phase ${this.options.phase}: ${failed}`
          await emit('maintenance_alert', {
            kind: 'readiness_gate_failure',
            severity: 'error',
            message: stopReason,
            refs: preflight.initialSnapshot.requiredFailed
          })
          await emit('state_transition', {
            from: state.state,
            to: 'STOPPED',
            reason: stopReason
          })
          state.state = 'STOPPED'
          state.updatedAt = this.now()
          await this.writeSessionState(state)
          await this.writeRuntimeCheckpoint(state, 'state_transition')
          throw new Error(stopReason)
        }
      }

      const mergedInputs = this.checkpointBroker.drainAtTurnBoundary()
      const ingressReview = this.options.phase === 'P0' ? null : await this.ingressManager.reviewTurnIngress(turnNumber)
      if (ingressReview) {
        const ingressManifestAsset = await this.assetStore.appendOutOfTurnAsset({
          turnNumber,
          attempt: 0,
          type: 'UserIngressManifest',
          payload: {
            turnNumber,
            ingressDir: ingressReview.ingressDir,
            manifestPath: ingressReview.manifestPath,
            accepted: ingressReview.accepted,
            rejected: ingressReview.rejected,
            recordedAt: this.now()
          }
        })
        await emit('asset_created', { assetId: ingressManifestAsset.id, type: ingressManifestAsset.type })

        let ingestIdx = 0
        for (const accepted of ingressReview.accepted) {
          mergedInputs.push({
            id: `ingest-${turnNumber}-${ingestIdx}`,
            text: [
              'Curated user upload accepted.',
              `ingressAsset=${ingressManifestAsset.id}`,
              `source=${accepted.sourcePath}`,
              `curated=${accepted.curatedPath}`,
              `hash=${accepted.hash}`,
              `size=${accepted.sizeBytes}`,
              `mime=${accepted.mimeType}`,
              accepted.deduplicatedFrom ? `dedup=${accepted.deduplicatedFrom}` : ''
            ].filter(Boolean).join(' | '),
            priority: 'normal',
            createdAt: this.now(),
            source: 'system'
          })
          ingestIdx += 1
        }
      }
      if (mergedInputs.length > 0) {
        await emit('user_input_merged', { mergedIds: mergedInputs.map((item) => item.id) })
      }

      const activeNode = await this.branchManager.getActiveNode()
      const planContent = await readTextFileOrEmpty(this.planPath)
      const planSnapshotHash = sha256Hex(planContent)
      const branchDossierPath = path.join(this.branchDossiersDir, `${activeNode.branchId}.md`)
      const branchDossierContent = await readTextFileOrEmpty(branchDossierPath)
      const branchDossierHash = sha256Hex(branchDossierContent)
      const researchMdPath = path.join(this.projectPath, 'research.md')
      const researchContext = await readTextFileOrEmpty(researchMdPath)

      // Build turn summaries from recent turn reports (last 5)
      const turnNumbers = await this.listTurnReports()
      const recentTurnNumbers = turnNumbers.slice(-5)
      const lastTurnSummaries: PlannerInput['lastTurnSummaries'] = []
      for (const tn of recentTurnNumbers) {
        const reportPath = path.join(this.turnsDir, `${tn}.report.json`)
        try {
          const report = await readJsonFile<TurnReport>(reportPath)
          lastTurnSummaries.push({
            turnNumber: report.turnNumber,
            stage: report.turnSpec.stage,
            objective: report.turnSpec.objective,
            assetsCreated: report.assetDiff.created.length,
            assetsUpdated: report.assetDiff.updated.length,
            summary: report.summary ?? ''
          })
        } catch {
          // Skip unreadable reports
        }
      }

      // Build asset inventory
      const allAssets = await this.assetStore.list()
      const assetInventory: PlannerInput['assetInventory'] = allAssets.map((a) => ({
        id: a.id,
        type: a.type,
        createdByTurn: a.createdByTurn
      }))

      const plannerInput: PlannerInput = {
        sessionId: this.sessionId,
        turnNumber,
        state: 'PLANNING',
        stage: state.activeStage,
        goal: this.goal,
        phase: this.options.phase,
        activeBranchId: state.activeBranchId,
        activeNodeId: state.activeNodeId,
        nonProgressTurns: state.nonProgressTurns,
        requiresBranchDiversification: state.nonProgressTurns >= 3,
        gateFailureCountOnActiveNode: this.getGateFailureCount(state, state.activeNodeId, state.activeStage),
        requiresGateLoopBreak: this.getGateFailureCount(state, state.activeNodeId, state.activeStage) >= 2,
        planSnapshotHash,
        branchDossierHash,
        planContent,
        branchDossierContent,
        researchContext,
        previousStageGateStatus: { ...state.stageGateStatus },
        lastTurnSummaries,
        assetInventory,
        mergedUserInputs: mergedInputs,
        remainingBudget: {
          turns: Math.max(0, this.options.budget.maxTurns - state.budgetUsed.turns),
          maxTurns: this.options.budget.maxTurns,
          tokens: Math.max(0, this.options.budget.maxTokens - state.budgetUsed.tokens),
          costUsd: Math.max(0, this.options.budget.maxCostUsd - state.budgetUsed.costUsd)
        }
      }

      this.onActivity?.({ id: randomId('act'), timestamp: this.now(), kind: 'planner_start', agent: 'planner' })
      const plannerOutputRaw = await this.planner.generate(plannerInput)
      const plannerOutputValidated = isTurnSpecValid(plannerOutputRaw.turnSpec)
        ? plannerOutputRaw
        : {
            ...plannerOutputRaw,
            turnSpec: createConservativeFallbackSpec({
              turnNumber,
              stage: state.activeStage,
              activeBranchId: state.activeBranchId,
              activeNodeId: state.activeNodeId
            })
          }
      const plannerOutput = plannerOutputValidated
      const invalidateCurrentNode = false
      if (state.nonProgressTurns >= 3) {
        advisoryNotes.push(
          `non-progress signal: ${state.nonProgressTurns} consecutive non-progress turns; planner should re-scope next turn`
        )
      }
      const gateFailuresOnNode = this.getGateFailureCount(state, state.activeNodeId, state.activeStage)
      if (gateFailuresOnNode >= 2) {
        advisoryNotes.push(
          `gate-loop signal: node ${state.activeNodeId} has ${gateFailuresOnNode} gate failures; planner should choose a different approach`
        )
      }
      const remainingTurns = Math.max(0, this.options.budget.maxTurns - state.budgetUsed.turns)
      if (remainingTurns <= 2) {
        advisoryNotes.push('budget signal: <=2 turns remaining; planner should choose minimal irreversible progress.')
      }

      this.onActivity?.({
        id: randomId('act'),
        timestamp: this.now(),
        kind: 'planner_end',
        agent: 'planner',
        preview: plannerOutput.turnSpec.objective?.slice(0, 120)
      })

      await emit('planner_spec_generated', {
        objective: plannerOutput.turnSpec.objective,
        stage: plannerOutput.turnSpec.stage,
        action: plannerOutput.turnSpec.branch.action
      })

      const readinessSnapshot = this.evaluateReadinessSnapshot(plannerOutput.turnSpec.stage)
      if (!readinessSnapshot.pass) {
        const message = `readiness required gates failed for phase ${readinessSnapshot.phase}: ${readinessSnapshot.requiredFailed.join(', ')}`
        advisoryNotes.push(message)
        await emit('maintenance_alert', {
          kind: 'readiness_gate_failure',
          severity: 'error',
          message,
          refs: readinessSnapshot.requiredFailed
        })
        await emit('state_transition', {
          from: state.state,
          to: 'STOPPED',
          reason: message
        })
        state.state = 'STOPPED'
        state.updatedAt = this.now()
        await this.writeSessionState(state)
        await this.writeRuntimeCheckpoint(state, 'state_transition')
        throw new Error(message)
      }

      await transition('EXECUTING', 'planner spec accepted')
      await emit('turn_started', {
        objective: plannerOutput.turnSpec.objective,
        stage: plannerOutput.turnSpec.stage
      })

      this.onActivity?.({ id: randomId('act'), timestamp: this.now(), kind: 'coordinator_start', agent: 'coordinator' })
      const coordinatorResult = await this.coordinator.runTurn({
        turnSpec: plannerOutput.turnSpec,
        stage: plannerOutput.turnSpec.stage,
        goal: this.goal,
        mergedUserInputs: mergedInputs,
        plannerOutput,
        researchContext
      })
      this.onActivity?.({
        id: randomId('act'),
        timestamp: this.now(),
        kind: 'coordinator_end',
        agent: 'coordinator',
        preview: coordinatorResult.summary?.slice(0, 120)
      })

      const constraintAdvisories = this.enforceHardConstraints(plannerOutput.turnSpec, coordinatorResult)
      for (const note of constraintAdvisories) {
        advisoryNotes.push(note)
      }

      if (this.options.phase === 'P0' && coordinatorResult.metrics.discoveryOps > plannerOutput.turnSpec.constraints.maxDiscoveryOps) {
        advisoryNotes.push('maxDiscoveryOps exceeded in P0 (advisory only).')
      }

      const runKeyDedup = await this.dedupeRunRecordAssetsByRunKey(coordinatorResult.assets)
      if (runKeyDedup.duplicateRunKeys.length > 0) {
        advisoryNotes.push(`duplicate runKey skipped: ${runKeyDedup.duplicateRunKeys.join(', ')}`)
      }

      const stagedAssets = await this.assetStore.stageAssets({
        turnNumber,
        attempt,
        assets: runKeyDedup.assets
      })
      const existingAssets = await this.assetStore.list()
      const evidencePolicyNormalization = this.isLeanMode()
        ? {
            updatedLinkIds: [] as string[],
            defaultedCiteOnlyLinkIds: [] as string[],
            autoUpgradedCountableLinkIds: [] as string[]
          }
        : this.normalizeCrossBranchEvidenceLinkPolicies(existingAssets, stagedAssets.records)
      if (!this.isLeanMode()) {
        if (evidencePolicyNormalization.updatedLinkIds.length > 0) {
          const updatedSet = new Set(evidencePolicyNormalization.updatedLinkIds)
          for (const record of stagedAssets.records) {
            if (!updatedSet.has(record.id)) continue
            await writeJsonFile(path.join(this.assetStore.stagingDir, `${record.id}.json`), record)
          }
        }
        if (evidencePolicyNormalization.defaultedCiteOnlyLinkIds.length > 0) {
          advisoryNotes.push(
            `cross-branch evidence defaulted to cite_only: ${evidencePolicyNormalization.defaultedCiteOnlyLinkIds.join(', ')}`
          )
        }
        if (evidencePolicyNormalization.autoUpgradedCountableLinkIds.length > 0) {
          advisoryNotes.push(
            `cross-branch evidence auto-upgraded to countable: ${evidencePolicyNormalization.autoUpgradedCountableLinkIds.join(', ')}`
          )
        }
      }
      const supersedesRepairs = this.repairSupersedesIntegrity(existingAssets, stagedAssets.records)
      if (supersedesRepairs.length > 0) {
        advisoryNotes.push(
          `supersedes references repaired (hallucinated IDs stripped): ${supersedesRepairs.join(', ')}`
        )
        // Re-write repaired staged asset files
        for (const record of stagedAssets.records) {
          if (supersedesRepairs.some((r) => r.startsWith(record.id + '->'))) {
            await writeJsonFile(path.join(this.assetStore.stagingDir, `${record.id}.json`), record)
          }
        }
      }
      // Validate remaining supersedes references (self-refs, type mismatches, cycles are still fatal)
      this.assertSupersedesIntegrity([...existingAssets, ...stagedAssets.records])

      const updatedAssets = stagedAssets.records
        .filter((record) => Boolean(record.supersedes))
        .map((record) => ({ newId: record.id, supersedes: record.supersedes as string }))

      for (const record of stagedAssets.records) {
        if (record.supersedes) {
          await emit('asset_updated', { assetId: record.id, supersedes: record.supersedes })
        } else {
          await emit('asset_created', { assetId: record.id, type: record.type })
        }
      }

      const branchMutation = await this.applyBranchMutation(
        plannerOutput.turnSpec.branch.action,
        plannerOutput.turnSpec.stage,
        plannerOutput.turnSpec.objective,
        plannerOutput.turnSpec.branch.targetNodeId,
        turnNumber,
        attempt,
        { invalidateCurrentNode }
      )
      await emit('branch_mutated', {
        action: plannerOutput.turnSpec.branch.action,
        activeNodeId: branchMutation.nextNode.nodeId,
        branchId: branchMutation.nextNode.branchId
      })

      let allRecords = [...existingAssets, ...stagedAssets.records]
      const lean = this.computeLeanManifestSummary(allRecords)
      let evidencePolicy: SnapshotManifest['evidencePolicy'] | undefined
      let causality: SnapshotManifest['causality'] | undefined
      let directEvidence: SnapshotManifest['directEvidence'] | undefined
      let claimCoverage: SnapshotManifest['claimCoverage'] | undefined
      let claimGovernance: SnapshotManifest['claimGovernance'] | undefined
      let claimDecisionBinding: SnapshotManifest['claimDecisionBinding'] | undefined
      let reproducibility: SnapshotManifest['reproducibility'] | undefined
      const invalidCountableLinkIds = new Set<string>()

      if (!this.isLeanMode()) {
        evidencePolicy = this.computeEvidenceLinkPolicySummary(allRecords)
        for (const id of evidencePolicy.invalidCountableLinkIds) {
          invalidCountableLinkIds.add(id)
        }
        if (invalidCountableLinkIds.size > 0) {
          advisoryNotes.push(
            `invalid countable links downgraded for coverage: ${Array.from(invalidCountableLinkIds).join(', ')}`
          )
        }
        causality = this.computeCausalitySummary(allRecords, invalidCountableLinkIds)
        directEvidence = this.computeDirectEvidenceSummary(allRecords, invalidCountableLinkIds)
        claimCoverage = this.computeClaimCoverageSummary(allRecords, invalidCountableLinkIds)
        claimGovernance = this.computeClaimGovernanceSummary(
          allRecords,
          claimCoverage
        )
        claimDecisionBinding = this.computeClaimDecisionBindingSummary(allRecords)
        reproducibility = this.computeReproducibilitySummary(allRecords, invalidCountableLinkIds)
        if (this.shouldGenerateClaimEvidenceTableAsset(plannerOutput.turnSpec.stage)) {
          const claimEvidenceTable = this.buildClaimEvidenceTablePayload(
            allRecords,
            invalidCountableLinkIds,
            claimCoverage
          )
          const derivedAsset = await this.stageDerivedAsset({
            turnNumber,
            attempt,
            type: 'ClaimEvidenceTable',
            payload: {
              ...claimEvidenceTable,
              sourceManifestId: `manifest-t${turnNumber}-a${attempt}`
            }
          })
          stagedAssets.records.push(derivedAsset)
          allRecords = [...allRecords, derivedAsset]
          await emit('asset_created', { assetId: derivedAsset.id, type: derivedAsset.type })
          advisoryNotes.push(`final claim-evidence table generated: ${derivedAsset.id}`)
        }
      }
      const allAssetIds = sortStrings(allRecords.map((item) => item.id))

      const snapshotManifest: SnapshotManifest = {
        id: `manifest-t${turnNumber}-a${attempt}`,
        stage: plannerOutput.turnSpec.stage,
        assetIds: allAssetIds,
        evidenceLinkIds: this.collectEvidenceLinkIds(allRecords),
        lean,
        claimCoverage,
        claimGovernance,
        claimDecisionBinding,
        reproducibility,
        evidencePolicy,
        causality,
        directEvidence,
        branchNodeId: branchMutation.nextNode.nodeId,
        planSnapshotHash,
        generatedAtTurn: turnNumber
      }

      const gateResult = this.gateEngine.evaluate(snapshotManifest)
      const semanticReview = await Promise.resolve(this.reviewEngine.evaluate({
        phase: this.options.phase,
        stage: plannerOutput.turnSpec.stage,
        manifest: snapshotManifest,
        gateResult,
        plannerOutput,
        coordinatorOutput: coordinatorResult,
        researchContext
      }))
      await emit('semantic_review_evaluated', {
        stage: plannerOutput.turnSpec.stage,
        reviewerCount: semanticReview.reviewerPasses.length,
        consensusBlockerLabels: semanticReview.consensusBlockers.map((item) => item.label)
      })
      const rewriteApplied = this.applyReviewerRewritePatch(
        plannerOutput,
        coordinatorResult,
        semanticReview.processReview
      )
      const plannerOutputForReport = rewriteApplied.plannerOutput
      const coordinatorResultPatched = rewriteApplied.coordinatorResult
      if (rewriteApplied.notes.length > 0) {
        advisoryNotes.push(...rewriteApplied.notes)
      }
      const coordinatorResultWithIntervention: CoordinatorTurnResult = {
        ...coordinatorResultPatched,
        askUser: coordinatorResultPatched.askUser
      }
      await emit('gate_evaluated', {
        stage: plannerOutput.turnSpec.stage,
        passed: gateResult.passed,
        hardBlockerLabels: gateResult.hardBlockers.map((item) => item.label),
        manifestId: snapshotManifest.id
      })

      const nonProgress = stagedAssets.records.length === 0
      const gateStatus = gateResult.passed ? 'pass' : 'fail'
      const gateTracking = this.evaluateStageGateTracking(
        snapshotManifest,
        plannerOutput.turnSpec.stage,
        gateStatus,
        state.stageGateStatus
      )
      if (gateTracking.regressions.length > 0) {
        const message = `gate regression detected: ${gateTracking.regressions.join(', ')}`
        advisoryNotes.push(message)
        await emit('maintenance_alert', {
          kind: 'gate_regression',
          severity: 'warning',
          message,
          refs: gateTracking.regressions
        })
      }
      for (const note of semanticReview.advisoryNotes) {
        advisoryNotes.push(note)
      }
      const reviewerSnapshot: TurnReport['reviewerSnapshot'] = semanticReview.enabled
        ? {
            status: 'completed',
            reviewerPasses: semanticReview.reviewerPasses,
            consensusBlockers: semanticReview.consensusBlockers,
            processReview: semanticReview.processReview,
            notes: semanticReview.advisoryNotes
          }
        : {
            status: 'not-run',
            notes: semanticReview.advisoryNotes
          }
      const finishedAt = this.now()

      const turnReport: TurnReport = {
        turnNumber,
        attempt,
        startedAt,
        finishedAt,
        turnSpec: plannerOutput.turnSpec,
        plannerSpec: plannerOutputForReport,
        consumedBudgets: { ...coordinatorResult.metrics },
        assetDiff: {
          created: stagedAssets.records.map((item) => item.id),
          updated: updatedAssets,
          linked: stagedAssets.records.filter((item) => item.type === 'EvidenceLink').map((item) => item.id)
        },
        branchDiff: {
          activeNode: branchMutation.nextNode.nodeId,
          action: plannerOutput.turnSpec.branch.action,
          createdNodes: [branchMutation.nextNode.nodeId],
          mergedNodes: [],
          prunedNodes: []
        },
        gateImpact: {
          status: gateStatus,
          gateResult,
          snapshotManifest
        },
        reviewerSnapshot,
        riskDelta: advisoryNotes,
        nextStepRationale: plannerOutputForReport.rationale,
        mergedUserInputIds: mergedInputs.map((item) => item.id),
        nonProgress,
        plannerInputManifest: {
          planSnapshotHash,
          branchDossierHash,
          selectedAssetSnapshotIds: snapshotManifest.assetIds
        },
        readinessSnapshot,
        summary: coordinatorResultPatched.summary,
        execution: {
          action: coordinatorResultPatched.action,
          actionRationale: coordinatorResultPatched.actionRationale,
          executionTrace: coordinatorResultPatched.executionTrace,
          toolCalls: coordinatorResultPatched.toolCalls,
          tooling: coordinatorResultPatched.tooling
        }
      }

      const stagedTurnReportPath = path.join(this.turnsStagingDir, `${turnNumber}.report.json`)
      const finalTurnReportPath = path.join(this.turnsDir, `${turnNumber}.report.json`)
      await writeJsonFile(stagedTurnReportPath, turnReport)

      await this.assetStore.commitStagedAssets(stagedAssets.records)
      await fs.rename(stagedTurnReportPath, finalTurnReportPath)

      await emit('turn_committed', {
        turnNumber,
        attempt,
        createdAssetIds: stagedAssets.records.map((item) => item.id),
        snapshotManifestId: snapshotManifest.id
      })

      state.currentTurn = turnNumber
      state.currentAttempt = attempt
      const branchSwitched = state.activeBranchId !== branchMutation.nextNode.branchId
      state.nonProgressTurns = (!nonProgress || branchSwitched || mergedInputs.length > 0)
        ? 0
        : state.nonProgressTurns + 1
      state.activeStage = plannerOutput.turnSpec.stage
      state.activeBranchId = branchMutation.nextNode.branchId
      state.activeNodeId = branchMutation.nextNode.nodeId
      state.budgetUsed.turns += 1
      state.budgetUsed.tokens += coordinatorResult.metrics.turnTokens
      state.budgetUsed.costUsd += coordinatorResult.metrics.turnCostUsd
      this.updateGateFailureCounts(state, branchMutation.nextNode.nodeId, plannerOutput.turnSpec.stage, gateStatus)
      state.stageGateStatus = gateTracking.stageStatuses
      state.updatedAt = this.now()

      const nextStateReason = this.getBudgetExhaustionReason(state)
      let nextState = this.selectNextState(state, coordinatorResultWithIntervention, turnReport)
      const experimentOutsource = await this.maybeCreateExperimentOutsourceWaitTask({
        state,
        turnNumber,
        stage: plannerOutput.turnSpec.stage,
        turnAction: coordinatorResultWithIntervention.action,
        createdAssets: stagedAssets.records,
        mergedInputs,
        existingAskUser: coordinatorResultWithIntervention.askUser
      })
      if (experimentOutsource) {
        nextState = 'WAITING_EXTERNAL'
      }
      await emit('state_transition', {
        from: 'EXECUTING',
        to: nextState,
        reason: nextState === 'STOPPED' ? nextStateReason ?? 'session budget exhausted' : undefined
      })
      state.state = nextState

      if (experimentOutsource) {
        const pendingQuestion = this.checkpointBroker.emitQuestion(experimentOutsource.question)
        state.pendingQuestion = pendingQuestion
        state.pendingExternalTaskId = experimentOutsource.task.id
        await emit('ask_user_emitted', {
          questionId: pendingQuestion.id as string,
          blocking: pendingQuestion.blocking ?? true,
          checkpoint: pendingQuestion.checkpoint
        })
      } else if (
        nextState === 'WAITING_FOR_USER'
        && coordinatorResultWithIntervention.askUser
        && (coordinatorResultWithIntervention.askUser.required ?? true)
      ) {
        let askUserInput = this.withAutoCheckpointReferences(coordinatorResultWithIntervention.askUser, allRecords)
        askUserInput = this.withFallbackAskUserContext(askUserInput, {
          objective: plannerOutput.turnSpec.objective,
          currentFocus: plannerOutputForReport.planContract.current_focus,
          whyNow: plannerOutputForReport.planContract.why_now,
          needFromUser: plannerOutputForReport.planContract.need_from_user?.request,
          doneDefinition: plannerOutputForReport.planContract.done_definition,
          actionRationale: coordinatorResultWithIntervention.actionRationale,
          summary: coordinatorResultPatched.summary
        })
        const pendingQuestion = this.checkpointBroker.emitQuestion(askUserInput)
        state.pendingQuestion = pendingQuestion
        await emit('ask_user_emitted', {
          questionId: pendingQuestion.id as string,
          blocking: pendingQuestion.blocking ?? true,
          checkpoint: pendingQuestion.checkpoint
        })
        state.pendingExternalTaskId = undefined
      } else {
        state.pendingQuestion = undefined
        state.pendingExternalTaskId = undefined
      }
      state.pendingResourceExtension = undefined

      await this.updatePlanFiles(state, branchMutation.nextNode)
      await this.writeSessionState(state)
      await this.writeRuntimeCheckpoint(state, 'turn_complete')

      return {
        turnReport,
        newState: nextState,
        branchNode: branchMutation.nextNode
      }
    } catch (error) {
      if (state.state === 'STOPPED') {
        throw error
      }
      state.state = 'FAILED'
      state.updatedAt = this.now()
      await this.writeSessionState(state)
      await this.writeRuntimeCheckpoint(state, 'state_transition')
      await appendJsonLine(this.eventsPath, {
        eventId: randomId('evt'),
        sessionId: this.sessionId,
        turnNumber,
        seq,
        timestamp: this.now(),
        schemaVersion: 1,
        eventType: 'state_transition',
        payload: { from: 'EXECUTING', to: 'FAILED', reason: (error as Error).message }
      } satisfies YoloEvent<'state_transition'>)
      throw error
    }
  }

  async recoverFromCrash(): Promise<{ cleaned: string[]; lastDurableTurn: number }> {
    await this.init()
    const state = await this.readSessionState()

    const cleaned: string[] = []
    cleaned.push(...await this.assetStore.cleanupStaging())
    cleaned.push(...await this.cleanupTurnStaging())

    const lastDurableTurn = await this.getLastDurableTurn()
    const allTurns = await this.listTurnReports()
    const ghostTurns = allTurns.filter((turn) => turn > lastDurableTurn)

    if (ghostTurns.length > 0) {
      for (const turn of ghostTurns) {
        await fs.rm(path.join(this.turnsDir, `${turn}.report.json`), { force: true })
        cleaned.push(path.join('turns', `${turn}.report.json`))
      }
      cleaned.push(...await this.assetStore.removeAssetsForTurns(ghostTurns))
      cleaned.push(...await this.branchManager.removeNodesForTurns(ghostTurns))
    }

    state.currentTurn = lastDurableTurn
    state.currentAttempt = 0
    state.pendingQuestion = undefined
    state.pendingExternalTaskId = undefined
    state.pendingResourceExtension = undefined
    state.state = lastDurableTurn > 0 ? 'TURN_COMPLETE' : 'IDLE'
    state.updatedAt = this.now()
    await this.writeSessionState(state)
    await this.writeRuntimeCheckpoint(state, 'crash_recovery')

    const seq = await this.getNextSeqForTurn(lastDurableTurn)
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: lastDurableTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'crash_recovery',
      payload: {
        cleanedStagingFiles: sortStrings(cleaned),
        lastDurableTurn
      }
    } satisfies YoloEvent<'crash_recovery'>)

    return { cleaned: sortStrings(cleaned), lastDurableTurn }
  }

  private async readSessionState(): Promise<SessionPersistedState> {
    return readJsonFile<SessionPersistedState>(this.sessionPath)
  }

  private async writeSessionState(state: SessionPersistedState): Promise<void> {
    await writeJsonFile(this.sessionPath, state)
    if (this.isPhaseAtLeast('P2')) {
      await this.heartbeatRuntimeLease()
    }
  }

  private async transitionOutOfTurn(
    to: YoloRuntimeState,
    reason: string,
    sourceState?: SessionPersistedState
  ): Promise<void> {
    await this.init()
    const state = sourceState ?? await this.readSessionState()
    const from = state.state
    state.state = to
    state.updatedAt = this.now()
    await this.writeSessionState(state)
    await this.writeRuntimeCheckpoint(state, 'state_transition')

    const seq = await this.getNextSeqForTurn(state.currentTurn)
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'state_transition',
      payload: { from, to, reason }
    } satisfies YoloEvent<'state_transition'>)
  }

  private enforceHardConstraints(turnSpec: TurnReport['turnSpec'], result: CoordinatorTurnResult): string[] {
    const c = turnSpec.constraints
    const m = result.metrics
    const baseline = this.isLeanMode() ? buildDefaultP0Constraints() : undefined
    const maxToolCalls = baseline ? Math.max(c.maxToolCalls, baseline.maxToolCalls) : c.maxToolCalls
    const maxWallClockSec = baseline ? Math.max(c.maxWallClockSec, baseline.maxWallClockSec) : c.maxWallClockSec
    const maxStepCount = baseline ? Math.max(c.maxStepCount, baseline.maxStepCount) : c.maxStepCount
    const maxNewAssets = baseline ? Math.max(c.maxNewAssets, baseline.maxNewAssets) : c.maxNewAssets
    const maxDiscoveryOps = baseline ? Math.max(c.maxDiscoveryOps, baseline.maxDiscoveryOps) : c.maxDiscoveryOps
    const maxReadBytes = baseline ? Math.max(c.maxReadBytes, baseline.maxReadBytes) : c.maxReadBytes
    const maxPromptTokens = baseline ? Math.max(c.maxPromptTokens, baseline.maxPromptTokens) : c.maxPromptTokens
    const maxCompletionTokens = baseline ? Math.max(c.maxCompletionTokens, baseline.maxCompletionTokens) : c.maxCompletionTokens
    const maxTurnTokens = baseline ? Math.max(c.maxTurnTokens, baseline.maxTurnTokens) : c.maxTurnTokens
    const maxTurnCostUsd = baseline ? Math.max(c.maxTurnCostUsd, baseline.maxTurnCostUsd) : c.maxTurnCostUsd
    const advisoryNotes: string[] = []

    const violations: string[] = []
    const checkWithTolerance = (
      name: string,
      value: number,
      target: number,
      tolerance: number,
      strict: boolean
    ) => {
      if (value <= target) return
      const hardCapRaw = target * tolerance
      const hardCap = Number.isInteger(target)
        ? Math.ceil(hardCapRaw)
        : Math.round(hardCapRaw * 1000) / 1000
      if (value > hardCap) {
        if (strict) {
          violations.push(`${name} ${value} > ${hardCap}`)
        } else {
          advisoryNotes.push(`lean advisory: soft-limit exceeded for ${name} (${value} > ${hardCap}); continuing`)
        }
      } else {
        advisoryNotes.push(`lean advisory: ${name} ${value} exceeded target ${target} (within tolerance)`)
      }
    }

    if (this.isLeanMode()) {
      checkWithTolerance('toolCalls', m.toolCalls, maxToolCalls, 1.25, false)
      checkWithTolerance('wallClockSec', m.wallClockSec, maxWallClockSec, 1.25, false)
      checkWithTolerance('stepCount', m.stepCount, maxStepCount, 1.25, false)
      checkWithTolerance('newAssets', result.assets.length, maxNewAssets, 1.25, false)
      checkWithTolerance('readBytes', m.readBytes, maxReadBytes, 1.25, false)
      if (this.options.phase !== 'P0') {
        checkWithTolerance('discoveryOps', m.discoveryOps, maxDiscoveryOps, 1.25, false)
      }
      checkWithTolerance('promptTokens', m.promptTokens, maxPromptTokens, 1.2, false)
      checkWithTolerance('completionTokens', m.completionTokens, maxCompletionTokens, 1.2, false)
      checkWithTolerance('turnTokens', m.turnTokens, maxTurnTokens, 1.2, false)
      checkWithTolerance('turnCostUsd', m.turnCostUsd, maxTurnCostUsd, 1.2, false)
    } else {
      if (m.toolCalls > maxToolCalls) violations.push(`toolCalls ${m.toolCalls} > ${maxToolCalls}`)
      if (m.wallClockSec > maxWallClockSec) violations.push(`wallClockSec ${m.wallClockSec} > ${maxWallClockSec}`)
      if (m.stepCount > maxStepCount) violations.push(`stepCount ${m.stepCount} > ${maxStepCount}`)
      if (result.assets.length > maxNewAssets) violations.push(`newAssets ${result.assets.length} > ${maxNewAssets}`)
      if (m.readBytes > maxReadBytes) violations.push(`readBytes ${m.readBytes} > ${maxReadBytes}`)
      if (this.options.phase !== 'P0' && m.discoveryOps > maxDiscoveryOps) {
        violations.push(`discoveryOps ${m.discoveryOps} > ${maxDiscoveryOps}`)
      }
      if (m.promptTokens > maxPromptTokens) violations.push(`promptTokens ${m.promptTokens} > ${maxPromptTokens}`)
      if (m.completionTokens > maxCompletionTokens) violations.push(`completionTokens ${m.completionTokens} > ${maxCompletionTokens}`)
      if (m.turnTokens > maxTurnTokens) violations.push(`turnTokens ${m.turnTokens} > ${maxTurnTokens}`)
      if (m.turnCostUsd > maxTurnCostUsd) violations.push(`turnCostUsd ${m.turnCostUsd} > ${maxTurnCostUsd}`)
    }

    if (violations.length > 0) {
      throw new Error(`hard constraint violation: ${violations.join('; ')}`)
    }

    return advisoryNotes
  }

  private getGateFailureCount(
    state: SessionPersistedState,
    nodeId: string,
    stage: YoloStage
  ): number {
    const key = `${nodeId}:${stage}`
    return state.gateFailureCounts?.[key] ?? 0
  }

  private updateGateFailureCounts(
    state: SessionPersistedState,
    nodeId: string,
    stage: YoloStage,
    gateStatus: 'pass' | 'fail'
  ): void {
    const key = `${nodeId}:${stage}`
    const counts = { ...(state.gateFailureCounts ?? {}) }
    if (gateStatus === 'fail') {
      counts[key] = (counts[key] ?? 0) + 1
    } else {
      delete counts[key]
    }
    state.gateFailureCounts = counts
  }

  private evaluateStageGateTracking(
    baseManifest: SnapshotManifest,
    currentStage: YoloStage,
    currentStageStatus: 'pass' | 'fail',
    previousStatuses?: Partial<Record<YoloStage, 'pass' | 'fail' | 'none'>>
  ): {
    stageStatuses: Partial<Record<YoloStage, 'pass' | 'fail' | 'none'>>
    regressions: YoloStage[]
  } {
    const prior = previousStatuses ?? {}
    const stageStatuses: Partial<Record<YoloStage, 'pass' | 'fail' | 'none'>> = { ...prior }
    stageStatuses[currentStage] = currentStageStatus

    if (this.isLeanMode()) {
      return {
        stageStatuses,
        regressions: []
      }
    }

    const maxStageIndex = STAGE_ORDER.indexOf(currentStage)
    const stagesToCheck = STAGE_ORDER.slice(0, Math.max(0, maxStageIndex + 1))

    for (const stage of stagesToCheck) {
      if (stage === currentStage) continue
      const stageManifest: SnapshotManifest = {
        ...baseManifest,
        id: `${baseManifest.id}-${stage}`,
        stage
      }
      const status = this.gateEngine.evaluate(stageManifest).passed ? 'pass' : 'fail'
      stageStatuses[stage] = status
    }

    const regressions: YoloStage[] = []
    for (const stage of stagesToCheck) {
      const previous = prior[stage]
      const current = stageStatuses[stage]
      if (previous === 'pass' && current === 'fail') {
        regressions.push(stage)
      }
    }

    return {
      stageStatuses,
      regressions
    }
  }

  private async applyBranchMutation(
    action: TurnReport['turnSpec']['branch']['action'],
    stage: YoloStage,
    objective: string,
    targetNodeId: string | undefined,
    turnNumber: number,
    attempt: number,
    options: { invalidateCurrentNode?: boolean } = {}
  ): Promise<{ previousNode: BranchNode; nextNode: BranchNode }> {
    if (this.options.phase === 'P0' && action !== 'advance') {
      throw new Error(`not implemented in P0: branch action ${action}`)
    }

    // Validate that targetNodeId exists — LLM planner may hallucinate node IDs.
    // If invalid, fall back to 'advance' to keep the session running.
    let validatedTargetNodeId = targetNodeId
    if (targetNodeId && action !== 'advance') {
      const existingNode = await this.branchManager.getNode(targetNodeId)
      if (!existingNode) {
        console.warn(`[yolo] branch mutation: planner referenced non-existent node ${targetNodeId}, falling back to advance`)
        validatedTargetNodeId = undefined
        // Fall back to advance — the safest default
        return this.branchManager.advance({
          stage,
          summary: objective,
          createdByTurn: turnNumber,
          createdByAttempt: attempt
        })
      }
    }

    if (action === 'advance') {
      return this.branchManager.advance({
        stage,
        summary: objective,
        createdByTurn: turnNumber,
        createdByAttempt: attempt
      })
    }

    if (action === 'fork') {
      return this.branchManager.fork({
        stage,
        summary: objective,
        targetNodeId: validatedTargetNodeId,
        sourceNodeStatus: options.invalidateCurrentNode ? 'invalidated' : 'paused',
        createdByTurn: turnNumber,
        createdByAttempt: attempt
      })
    }

    if (action === 'revisit') {
      if (!validatedTargetNodeId) throw new Error('revisit requires targetNodeId')
      const allowInvalidatedOverride = await this.hasOverrideDecisionForNode(validatedTargetNodeId)
      return this.branchManager.revisit({ targetNodeId: validatedTargetNodeId, allowInvalidatedOverride })
    }

    if (action === 'merge') {
      if (!validatedTargetNodeId) throw new Error('merge requires targetNodeId')
      const allowInvalidatedOverride = await this.hasOverrideDecisionForNode(validatedTargetNodeId)
      return this.branchManager.merge({
        targetNodeId: validatedTargetNodeId,
        allowInvalidatedOverride,
        stage,
        summary: objective,
        createdByTurn: turnNumber,
        createdByAttempt: attempt
      })
    }

    if (action === 'prune') {
      const allowInvalidatedOverride = validatedTargetNodeId ? await this.hasOverrideDecisionForNode(validatedTargetNodeId) : false
      return this.branchManager.prune({ targetNodeId: validatedTargetNodeId, allowInvalidatedOverride })
    }

    throw new Error(`unsupported branch action: ${String(action)}`)
  }

  private applyReviewerRewritePatch(
    plannerOutput: PlannerOutput,
    coordinatorResult: CoordinatorTurnResult,
    processReview: ReviewerProcessReview | undefined
  ): { plannerOutput: PlannerOutput; coordinatorResult: CoordinatorTurnResult; notes: string[] } {
    if (!processReview?.rewrite_patch?.apply) {
      return { plannerOutput, coordinatorResult, notes: [] }
    }
    const patch = processReview.rewrite_patch.patch
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return { plannerOutput, coordinatorResult, notes: ['review rewrite_patch ignored: patch payload is not an object'] }
    }

    const notes: string[] = []
    const asObject = patch as Record<string, unknown>

    if (processReview.rewrite_patch.target === 'planner_output') {
      const nextContract = { ...plannerOutput.planContract }
      if (typeof asObject.current_focus === 'string' && asObject.current_focus.trim()) {
        nextContract.current_focus = asObject.current_focus.trim()
      }
      if (typeof asObject.why_now === 'string' && asObject.why_now.trim()) {
        nextContract.why_now = asObject.why_now.trim()
      }
      if (typeof asObject.done_definition === 'string' && asObject.done_definition.trim()) {
        nextContract.done_definition = asObject.done_definition.trim()
      }
      if (typeof asObject.notes_for_user === 'string' && asObject.notes_for_user.trim()) {
        nextContract.need_from_user = {
          ...nextContract.need_from_user,
          request: asObject.notes_for_user.trim()
        }
      }
      const nextPlannerOutput: PlannerOutput = {
        ...plannerOutput,
        turnSpec: {
          ...plannerOutput.turnSpec,
          objective: nextContract.current_focus
        },
        rationale: nextContract.why_now,
        planContract: nextContract
      }
      notes.push('review rewrite_patch applied to planner_output')
      return {
        plannerOutput: nextPlannerOutput,
        coordinatorResult,
        notes
      }
    }

    const nextCoordinator: CoordinatorTurnResult = { ...coordinatorResult }
    if (typeof asObject.summary === 'string' && asObject.summary.trim()) {
      nextCoordinator.summary = asObject.summary.trim()
    }
    if (typeof asObject.actionRationale === 'string' && asObject.actionRationale.trim()) {
      nextCoordinator.actionRationale = asObject.actionRationale.trim()
    }
    if (
      typeof asObject.action === 'string'
      && (
        asObject.action === 'explore'
        || asObject.action === 'refine_question'
        || asObject.action === 'issue_experiment_request'
        || asObject.action === 'digest_uploaded_results'
      )
    ) {
      nextCoordinator.action = asObject.action
    }
    if (typeof asObject.askUser === 'object' && asObject.askUser !== null && !Array.isArray(asObject.askUser)) {
      const ask = asObject.askUser as Record<string, unknown>
      if (typeof ask.question === 'string' && ask.question.trim()) {
        nextCoordinator.askUser = {
          required: typeof ask.required === 'boolean' ? ask.required : true,
          question: ask.question.trim(),
          blocking: typeof ask.blocking === 'boolean' ? ask.blocking : true,
          context: typeof ask.context === 'string' ? ask.context : undefined,
          options: Array.isArray(ask.options)
            ? ask.options.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : undefined,
          requiredFiles: Array.isArray(ask.required_files)
            ? ask.required_files.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : undefined
        }
      }
    }
    if (Array.isArray(asObject.execution_trace)) {
      const trace = asObject.execution_trace
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
        .map((item) => ({
          tool: typeof item.tool === 'string' ? item.tool.trim() : '',
          reason: typeof item.reason === 'string' ? item.reason.trim() : '',
          result_summary: typeof item.result_summary === 'string' ? item.result_summary.trim() : ''
        }))
        .filter((item) => item.tool && item.reason && item.result_summary)
      if (trace.length > 0) {
        nextCoordinator.executionTrace = trace
      }
    }

    notes.push('review rewrite_patch applied to coordinator_output')
    return {
      plannerOutput,
      coordinatorResult: nextCoordinator,
      notes
    }
  }

  private resolveReadinessPreflight(stage: YoloStage): {
    initialSnapshot: ReadinessSnapshot
    downgradedFrom?: YoloSessionOptions['phase']
    downgradedTo?: YoloSessionOptions['phase']
    stopReason?: string
  } {
    const phaseOrder: YoloSessionOptions['phase'][] = ['P0', 'P1', 'P2', 'P3']
    const currentPhase = this.options.phase
    const initialSnapshot = this.evaluateReadinessSnapshot(stage, currentPhase)
    if (initialSnapshot.pass) {
      return { initialSnapshot }
    }

    const currentRank = phaseOrder.indexOf(currentPhase)
    for (let idx = currentRank - 1; idx >= 0; idx -= 1) {
      const candidatePhase = phaseOrder[idx]
      const candidateSnapshot = this.evaluateReadinessSnapshot(stage, candidatePhase)
      if (!candidateSnapshot.pass) continue
      return {
        initialSnapshot,
        downgradedFrom: currentPhase,
        downgradedTo: candidatePhase
      }
    }

    return {
      initialSnapshot,
      stopReason: [
        `readiness required gates failed for phase ${currentPhase}: ${initialSnapshot.requiredFailed.join(', ')}`,
        'cannot downgrade below P0'
      ].join('; ')
    }
  }

  private evaluateReadinessSnapshot(
    stage: YoloStage,
    phase: YoloSessionOptions['phase'] = this.options.phase
  ): ReadinessSnapshot {
    const required = this.requiredReadinessGates(phase)
    const modelConfigured = Boolean(
      this.options.models.planner.trim()
      && this.options.models.coordinator.trim()
    )

    const gates: ReadinessSnapshot['gates'] = {
      TG0: {
        required: required.has('TG0'),
        passed: true,
        detail: 'core runtime persistence and control surface available'
      },
      TG1: {
        required: required.has('TG1'),
        passed: true,
        detail: 'code authoring/execution path assumed available in example runtime'
      },
      TG2: {
        required: required.has('TG2'),
        passed: true,
        detail: 'data/plot stack not actively probed; treated as available'
      },
      TG3: {
        required: required.has('TG3'),
        passed: true,
        detail: 'experiment externalization flow not actively probed; treated as available'
      },
      TG4: {
        required: required.has('TG4'),
        passed: modelConfigured,
        detail: modelConfigured
          ? 'planner/coordinator models configured'
          : 'planner/coordinator model config missing'
      }
    }

    const requiredFailed = (Object.keys(gates) as Array<keyof ReadinessSnapshot['gates']>)
      .filter((gateId) => gates[gateId].required && !gates[gateId].passed)

    return {
      checkedAt: this.now(),
      phase,
      stage,
      gates,
      requiredFailed,
      pass: requiredFailed.length === 0
    }
  }

  private requiredReadinessGates(
    phase: YoloSessionOptions['phase']
  ): Set<'TG0' | 'TG1' | 'TG2' | 'TG3' | 'TG4'> {
    if (phase === 'P0') return new Set(['TG0'])
    if (phase === 'P1') return new Set(['TG0', 'TG4'])
    if (phase === 'P2') return new Set(['TG0', 'TG1', 'TG2', 'TG4'])
    return new Set(['TG0', 'TG1', 'TG2', 'TG3', 'TG4'])
  }

  private selectNextState(
    state: SessionPersistedState,
    result: CoordinatorTurnResult,
    turnReport: TurnReport
  ): YoloRuntimeState {
    const exhaustedReason = this.getBudgetExhaustionReason(state)
    if (exhaustedReason) {
      return 'STOPPED'
    }

    if (result.askUser && (result.askUser.required ?? true) && (result.askUser.blocking ?? true)) {
      return 'WAITING_FOR_USER'
    }

    if (this.shouldTransitionToComplete(turnReport)) {
      return 'COMPLETE'
    }

    return 'TURN_COMPLETE'
  }

  private async maybeCreateExperimentOutsourceWaitTask(input: {
    state: SessionPersistedState
    turnNumber: number
    stage: YoloStage
    turnAction?: CoordinatorTurnResult['action']
    createdAssets: AssetRecord[]
    mergedInputs: QueuedUserInput[]
    existingAskUser?: AskUserRequest
  }): Promise<{ task: ExternalWaitTask; question: AskUserRequest } | null> {
    if (this.options.phase === 'P0') return null
    if (input.existingAskUser && (input.existingAskUser.required ?? true) && (input.existingAskUser.blocking ?? true)) return null
    if (input.stage !== 'S2' && input.stage !== 'S3' && input.stage !== 'S4') return null
    if (input.createdAssets.some((asset) => asset.type === 'RunRecord')) return null

    const experimentAsset = input.createdAssets
      .filter((asset) => (
        asset.type === 'ExperimentRequest'
        || asset.type === 'ExperimentRequirement'
      ))
      .at(-1)
    if (!experimentAsset) return null

    const payload = experimentAsset.payload as Record<string, unknown>
    const why = this.readStringField(payload, ['why', 'rationale', 'reason'])
      ?? 'No rationale provided.'
    const objective = this.readStringField(payload, ['objective', 'goal', 'experimentGoal'])
      ?? 'No objective provided.'
    const method = this.readStringField(payload, ['method', 'plan', 'procedure', 'approach'])
      ?? 'No method plan provided.'
    const methodSteps = this.readStringListField(payload, ['methodSteps', 'steps', 'procedureSteps', 'executionSteps'])
    const setup = this.readStringField(payload, ['setup', 'environment', 'setupRequirements'])
      ?? 'Use the same machine and runtime for all variants; record OS, CPU, memory, shell, and agent/tool-runner version.'
    const controls = this.readStringField(payload, ['controls', 'controlPlan'])
      ?? 'Keep workload, machine state, and run order controls stable across variants.'
    const metrics = this.readStringField(payload, ['metrics', 'measurementPlan', 'measurements'])
      ?? 'Report p50/p95/p99 for first-byte latency, end-to-end latency, and stderr handling overhead.'
    const expectedResult = this.readStringField(payload, [
      'expectedResult',
      'expectedOutcome',
      'expected',
      'successCriteria'
    ]) ?? 'No expected result provided.'
    const outputFormat = this.readStringField(payload, [
      'outputFormat',
      'deliverables',
      'reportFormat',
      'submissionFormat'
    ]) ?? 'Submit raw traces + summary table + short interpretation note.'
    const submissionChecklist = this.readStringListField(payload, [
      'submissionChecklist',
      'uploadChecklist',
      'checklist'
    ])
    const requiredFiles = this.extractExperimentRequiredFiles(payload)
    const protocolLines = methodSteps.length > 0 ? methodSteps : [method]
    const uploadChecklist = requiredFiles.length > 0
      ? requiredFiles.map((name) => `upload ${name}`)
      : [
          'upload at least one raw trace file (for example *.jsonl or *.csv)',
          'upload one summary file with p50/p95/p99 metrics',
          'upload one short note describing anomalies and caveats'
        ]
    const combinedChecklist = [...uploadChecklist, ...submissionChecklist]

    const uploadTurnNumber = input.turnNumber + 1
    const uploadDirAbs = await this.ingressManager.ensureTurnIngressDir(uploadTurnNumber)
    const uploadDirRel = path.relative(this.sessionDir, uploadDirAbs)
    const task: ExternalWaitTask = {
      id: randomId('wait'),
      sessionId: this.sessionId,
      status: 'waiting',
      stage: input.stage,
      branchId: input.state.activeBranchId,
      nodeId: input.state.activeNodeId,
      title: `Collect externally executed experiment artifacts for ${input.stage}`,
      reason: why,
      requiredArtifacts: requiredFiles.map((fileName) => ({
        kind: 'experiment_result',
        pathHint: fileName,
        description: `required experiment output: ${fileName}`
      })),
      completionRule: requiredFiles.length > 0
        ? 'checklist:has_upload,required_files'
        : 'checklist:has_upload',
      resumeAction: `ingest uploaded experiment outputs and continue ${input.stage} analysis`,
      uploadDir: uploadDirRel,
      details: [
        `Experiment Request: ${experimentAsset.id}`,
        '',
        'Why this experiment:',
        why,
        '',
        'Objective:',
        objective,
        '',
        'Setup / Environment:',
        setup,
        '',
        'Execution protocol:',
        ...protocolLines.map((line, idx) => `${idx + 1}. ${line}`),
        '',
        'Controls:',
        controls,
        '',
        'Metrics to report:',
        metrics,
        '',
        'Expected result:',
        expectedResult,
        '',
        'Output format:',
        outputFormat,
        '',
        'Submission checklist:',
        ...combinedChecklist.map((line, idx) => `${idx + 1}. ${line}`)
      ].join('\n'),
      createdAt: this.now()
    }

    await writeJsonFile(this.waitTaskPath(task.id), task)
    await this.appendWaitTaskHistory(task, 'created')

    return {
      task,
      question: {
        required: true,
        question: `External experiment execution is needed for ${input.stage}. Please run the protocol and upload results to continue.`,
        options: ['Uploaded', 'Need clarification'],
        context: [
          `Task ID: ${task.id}`,
          `Upload folder: ${task.uploadDir ?? ''}`,
          `Objective: ${objective}`,
          `Protocol steps: ${protocolLines.length}`,
          `Expected result: ${expectedResult}`,
          `Required uploads: ${requiredFiles.length > 0 ? requiredFiles.join(', ') : 'raw trace + summary + notes'}`
        ].join('\n'),
        blocking: false
      }
    }
  }

  private shouldTransitionToComplete(turnReport: TurnReport): boolean {
    if (!this.isPhaseAtLeast('P2')) return false
    if (turnReport.turnSpec.stage !== 'S5') return false
    // In lean_v2, gate artifacts are advisory/advanced and should not block closure.
    if (!this.isLeanMode() && turnReport.gateImpact.status !== 'pass') return false

    if (this.isLeanMode()) {
      const lean = turnReport.gateImpact.snapshotManifest.lean
      if (!lean) return false
      return lean.resultInsightCount > 0 && lean.resultInsightLinkedCount >= lean.resultInsightCount
    }

    const coverage = turnReport.gateImpact.snapshotManifest.claimCoverage
    if (!coverage) return false

    const primaryRatio = coverage.assertedPrimary === 0
      ? 1
      : coverage.coveredPrimary / coverage.assertedPrimary
    const secondaryRatio = coverage.assertedSecondary === 0
      ? 1
      : coverage.coveredSecondary / coverage.assertedSecondary

    return primaryRatio >= 1 && secondaryRatio >= 0.85
  }

  private isLeanMode(): boolean {
    return this.runtimeMode === 'lean_v2'
  }

  private collectEvidenceLinkIds(records: AssetRecord[]): string[] {
    return sortStrings(
      records
        .filter((record) => record.type === 'EvidenceLink')
        .map((record) => record.id)
    )
  }

  private computeLeanManifestSummary(records: AssetRecord[]): NonNullable<SnapshotManifest['lean']> {
    let experimentRequestCount = 0
    let experimentRequestExecutableCount = 0
    const experimentRequestValidationFailures: Array<{
      assetId: string
      missingFields: string[]
      warnings: string[]
    }> = []
    let resultInsightCount = 0
    let resultInsightLinkedCount = 0
    let literatureNoteCount = 0

    for (const record of records) {
      const payload = record.payload as Record<string, unknown>
      if (record.type === 'ExperimentRequest' || record.type === 'ExperimentRequirement') {
        experimentRequestCount += 1
        if (this.isExecutableExperimentRequestPayload(payload)) {
          experimentRequestExecutableCount += 1
        }
        const validation = this.validateExperimentRequestPayload(record.id, payload)
        if (!validation.valid) {
          experimentRequestValidationFailures.push({
            assetId: validation.assetId,
            missingFields: validation.missingFields,
            warnings: validation.warnings
          })
        }
        continue
      }

      if (record.type === 'ResultInsight') {
        resultInsightCount += 1
        if (this.isResultInsightLinkedPayload(payload)) {
          resultInsightLinkedCount += 1
        }
        continue
      }

      if (record.type === 'Note' && this.isLiteratureNotePayload(payload)) {
        literatureNoteCount += 1
      }
    }

    return {
      experimentRequestCount,
      experimentRequestExecutableCount,
      experimentRequestValidationFailures,
      resultInsightCount,
      resultInsightLinkedCount,
      literatureNoteCount
    }
  }

  /**
   * Detect whether a Note asset represents literature review / related work content.
   *
   * Heuristic: check for literature-related keywords in payload field names and values.
   * This covers Notes produced by the literature-search tool as well as manually tagged Notes.
   */
  private isLiteratureNotePayload(payload: Record<string, unknown>): boolean {
    // Check payload field names for literature-related keys
    const literatureFieldKeys = [
      'relatedWork', 'related_work', 'literatureReview', 'literature_review',
      'literatureSurvey', 'literature_survey', 'priorArt', 'prior_art',
      'papers', 'citations', 'references', 'survey',
      'paperScores', 'paper_scores', 'searchResults', 'search_results'
    ]
    for (const key of literatureFieldKeys) {
      const val = payload[key]
      if (val !== undefined && val !== null && val !== '') return true
    }

    // Check if the Note's title/topic/type indicates literature content
    const textIndicators = [
      payload.title, payload.topic, payload.subType, payload.sub_type,
      payload.noteType, payload.note_type, payload.category
    ]
    const literaturePatterns = /literature|related.?work|prior.?art|survey|paper.?review|citation/i
    for (const val of textIndicators) {
      if (typeof val === 'string' && literaturePatterns.test(val)) return true
    }

    // Check if the content field mentions literature-search tool usage
    const content = typeof payload.content === 'string' ? payload.content
      : typeof payload.text === 'string' ? payload.text
        : typeof payload.summary === 'string' ? payload.summary
          : undefined
    if (content && content.length > 50) {
      // Only count if the content substantively discusses papers/related work
      const paperMentionCount = (content.match(/\b(?:paper|study|finding|author|et\s+al|doi|arxiv|published|conference|journal)\b/gi) || []).length
      if (paperMentionCount >= 3) return true
    }

    return false
  }

  private validateExperimentRequestPayload(
    assetId: string,
    payload: Record<string, unknown>
  ): { valid: boolean; assetId: string; missingFields: string[]; warnings: string[] } {
    const requiredFields: Array<{ name: string; keys: string[] }> = [
      { name: 'goal', keys: ['goal', 'objective', 'experimentGoal', 'why'] },
      { name: 'preconditions', keys: ['preconditions', 'prerequisites', 'setup', 'requirements'] },
      { name: 'methodSteps', keys: ['methodSteps', 'steps', 'procedureSteps', 'executionSteps', 'method', 'plan', 'procedure'] },
      { name: 'metrics', keys: ['metrics', 'measurements', 'measures'] },
      { name: 'expectedResult', keys: ['expectedResult', 'expectedOutcome', 'expected', 'successCriteria'] }
    ]

    const missingFields: string[] = []
    for (const field of requiredFields) {
      const strVal = this.readStringField(payload, field.keys)
      const listVal = this.readStringListField(payload, field.keys)
      if (!strVal && listVal.length === 0) {
        missingFields.push(field.name)
      } else if (strVal && strVal.length < 20) {
        missingFields.push(field.name)  // too short to be useful
      }
    }

    const warnings: string[] = []
    const methodStr = this.readStringField(payload, ['methodSteps', 'steps', 'method', 'plan', 'procedure'])
    if (methodStr && !methodStr.includes('```')) {
      warnings.push('methodSteps should include code-fenced commands')
    }
    if (!this.readStringField(payload, ['submissionChecklist', 'checklist', 'uploadChecklist'])) {
      warnings.push('Missing submissionChecklist — executor won\'t know what to upload')
    }

    return { valid: missingFields.length === 0, assetId, missingFields, warnings }
  }

  private isExecutableExperimentRequestPayload(payload: Record<string, unknown>): boolean {
    const objective = this.readStringField(payload, ['objective', 'goal', 'experimentGoal'])
    const method = this.readStringField(payload, ['method', 'plan', 'procedure', 'approach'])
    const methodSteps = this.readStringListField(payload, ['methodSteps', 'steps', 'procedureSteps', 'executionSteps'])
    const expectedResult = this.readStringField(payload, ['expectedResult', 'expectedOutcome', 'expected', 'successCriteria'])
    // Lean v2 treats required file names as guidance, not a strict executable contract.
    return Boolean(objective && expectedResult && (method || methodSteps.length > 0))
  }

  private isResultInsightLinkedPayload(payload: Record<string, unknown>): boolean {
    const requestRef = this.readStringField(payload, [
      'experimentRequestId',
      'requestId',
      'requestRef',
      'sourceRequestId',
      'linkedRequestId'
    ])

    const uploadRefs = new Set<string>()
    this.collectStringIds(payload.attachmentManifestId, uploadRefs)
    this.collectStringIds(payload.attachmentManifestIds, uploadRefs)
    this.collectStringIds(payload.uploadManifestId, uploadRefs)
    this.collectStringIds(payload.uploadManifestIds, uploadRefs)
    this.collectStringIds(payload.sourceUploadIds, uploadRefs)
    this.collectStringIds(payload.sourceUploadFiles, uploadRefs)
    this.collectStringIds(payload.uploadedFiles, uploadRefs)
    this.collectStringIds(payload.artifactIds, uploadRefs)
    this.collectStringIds(payload.artifactPaths, uploadRefs)

    const uploadPath = this.readStringField(payload, ['uploadDir', 'uploadSummaryPath', 'attachmentManifestPath'])
    return Boolean(requestRef && (uploadRefs.size > 0 || uploadPath))
  }

  private getBudgetExhaustionReason(state: SessionPersistedState): string | undefined {
    if (state.budgetUsed.turns >= this.options.budget.maxTurns) {
      return 'max turn budget reached'
    }
    // Token budget is report-only — never used as a hard stop.
    // Only cost (maxCostUsd) gates session execution.
    if (state.budgetUsed.costUsd >= this.options.budget.maxCostUsd) {
      return 'max cost budget reached'
    }
    return undefined
  }

  private async updatePlanFiles(state: SessionPersistedState, activeNode: BranchNode): Promise<void> {
    const planRaw = await readTextFileOrEmpty(this.planPath)
    const notes = extractZone(planRaw, AGENT_NOTES_START, AGENT_NOTES_END)

    const planSystemState = {
      sessionId: state.sessionId,
      goal: state.goal,
      phase: state.phase,
      runtimeState: state.state,
      activeStage: state.activeStage,
      activeBranchId: state.activeBranchId,
      activeNodeId: state.activeNodeId,
      turn: state.currentTurn,
      budgetUsed: state.budgetUsed
    }

    await writeTextFile(this.planPath, renderZonedMarkdown('YOLO Plan', planSystemState, notes))
    await writeJsonFile(this.planStatePath, planSystemState)

    const dossierPath = path.join(this.branchDossiersDir, `${activeNode.branchId}.md`)
    const dossierRaw = await readTextFileOrEmpty(dossierPath)
    const dossierNotes = extractZone(dossierRaw, AGENT_NOTES_START, AGENT_NOTES_END)

    const branchSystemState = {
      branchId: activeNode.branchId,
      nodeId: activeNode.nodeId,
      stage: activeNode.stage,
      summary: activeNode.summary,
      openRisks: activeNode.openRisks,
      evidenceDebt: activeNode.evidenceDebt
    }

    await writeTextFile(
      dossierPath,
      renderZonedMarkdown(`Branch Dossier ${activeNode.branchId}`, branchSystemState, dossierNotes)
    )
  }

  private async findExistingCheckpointDecisionId(questionId: string): Promise<string | null> {
    const decisions = await this.assetStore.list('Decision')
    for (const decision of decisions) {
      const payload = decision.payload as Record<string, unknown>
      if (typeof payload.questionId === 'string' && payload.questionId === questionId) {
        return decision.id
      }
    }
    return null
  }

  private async hasOverrideDecisionForNode(nodeId: string): Promise<boolean> {
    const decisions = await this.assetStore.list('Decision')
    for (const decision of decisions) {
      const payload = decision.payload as Record<string, unknown>
      if (payload.kind !== 'override') continue
      if (payload.targetNodeId === nodeId) {
        return true
      }
    }
    return false
  }

  private async evaluateWaitTaskValidation(task: ExternalWaitTask): Promise<WaitTaskValidationResult> {
    const requiredHints = (task.requiredArtifacts ?? [])
      .map((item) => item.pathHint?.trim())
      .filter((value): value is string => Boolean(value))
    const checklist = this.resolveWaitChecklist(task.completionRule, requiredHints.length > 0)

    let hasAnyUpload = false
    const missing: string[] = []
    if (task.uploadDir) {
      const uploadDirPath = path.join(this.sessionDir, task.uploadDir)
      hasAnyUpload = await this.directoryHasFiles(uploadDirPath)
      for (const hint of requiredHints) {
        const expectedPath = path.join(uploadDirPath, hint)
        if (!(await fileExists(expectedPath))) {
          missing.push(hint)
        }
      }
    } else {
      missing.push(...requiredHints)
    }

    const checks: Array<{ name: string; passed: boolean; detail?: string }> = []
    for (const checkName of checklist.checks) {
      if (checkName === 'has_upload') {
        checks.push({
          name: checkName,
          passed: hasAnyUpload,
          detail: hasAnyUpload ? undefined : `upload directory is empty (${task.uploadDir ?? 'none'})`
        })
        continue
      }
      if (checkName === 'required_files') {
        const strictPass = missing.length === 0
        if (this.isLeanMode() && hasAnyUpload) {
          checks.push({
            name: checkName,
            passed: true,
            detail: strictPass ? undefined : `lean advisory: missing hinted upload(s): ${missing.join(', ')}`
          })
          continue
        }
        checks.push({
          name: checkName,
          passed: strictPass,
          detail: strictPass ? undefined : `missing required upload(s): ${missing.join(', ')}`
        })
        continue
      }

      checks.push({
        name: checkName,
        passed: this.isLeanMode(),
        detail: this.isLeanMode()
          ? `lean advisory: unknown checklist check ignored: ${checkName}`
          : `unknown checklist check: ${checkName}`
      })
    }

    const failed = checks.filter((item) => !item.passed)
    return {
      taskId: task.id,
      status: task.status,
      uploadDir: task.uploadDir,
      requiredUploads: requiredHints,
      missingRequiredUploads: missing,
      hasAnyUpload,
      checks,
      ok: failed.length === 0,
      reason: failed.length > 0 ? failed.map((item) => item.detail ?? item.name).join('; ') : undefined
    }
  }

  private resolveWaitChecklist(
    completionRule: string,
    hasRequiredFiles: boolean
  ): { checks: string[] } {
    const raw = completionRule.trim()
    if (raw.toLowerCase().startsWith('checklist:')) {
      const checks = raw
        .slice('checklist:'.length)
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
      return { checks: checks.length > 0 ? checks : ['has_upload'] }
    }

    if (hasRequiredFiles) {
      return { checks: ['required_files'] }
    }
    return { checks: ['has_upload'] }
  }

  private extractExperimentRequiredFiles(payload: Record<string, unknown>): string[] {
    const files = new Set<string>()
    this.collectStringIds(payload.requiredFiles, files)
    this.collectStringIds(payload.requiredUploads, files)
    this.collectStringIds(payload.expectedUploads, files)

    const requiredArtifacts = payload.requiredArtifacts
    if (Array.isArray(requiredArtifacts)) {
      for (const item of requiredArtifacts) {
        if (typeof item !== 'object' || item === null) continue
        const pathHint = (item as { pathHint?: unknown }).pathHint
        if (typeof pathHint !== 'string') continue
        const normalized = pathHint.trim()
        if (normalized) files.add(normalized)
      }
    }

    return sortStrings(Array.from(files))
  }

  private async directoryHasFiles(rootDir: string): Promise<boolean> {
    if (!(await fileExists(rootDir))) return false

    const entries = await fs.readdir(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(rootDir, entry.name)
      if (entry.isFile()) return true
      if (entry.isDirectory() && await this.directoryHasFiles(entryPath)) return true
    }
    return false
  }

  private waitTaskPath(taskId: string): string {
    return path.join(this.waitTasksDir, `${taskId}.json`)
  }

  private async appendWaitTaskHistory(task: ExternalWaitTask, action: 'created' | 'satisfied' | 'canceled'): Promise<void> {
    await ensureDir(this.waitTaskHistoryDir)
    const stamp = this.now().replace(/[:.]/g, '-')
    const filePath = path.join(this.waitTaskHistoryDir, `${task.id}-${stamp}-${action}.json`)
    await writeJsonFile(filePath, {
      action,
      recordedAt: this.now(),
      task
    })
  }

  private async cleanupTurnStaging(): Promise<string[]> {
    await ensureDir(this.turnsStagingDir)
    const names = await fs.readdir(this.turnsStagingDir)
    const removed: string[] = []
    for (const name of names) {
      const fullPath = path.join(this.turnsStagingDir, name)
      await fs.rm(fullPath, { recursive: true, force: true })
      removed.push(path.join('turns', '.staging', name))
    }
    return removed
  }

  private async getLastDurableTurn(): Promise<number> {
    const events = await this.readEvents()
    const committed = events
      .filter((event): event is YoloEvent<'turn_committed'> => event.eventType === 'turn_committed')
      .map((event) => event.payload.turnNumber)

    if (committed.length === 0) return 0
    return Math.max(...committed)
  }

  private async getNextSeqForTurn(turnNumber: number): Promise<number> {
    const events = await this.readEvents()
    const seqs = events
      .filter((event) => event.turnNumber === turnNumber)
      .map((event) => event.seq)

    if (seqs.length === 0) return 1
    return Math.max(...seqs) + 1
  }

  private async readEvents(): Promise<YoloEvent[]> {
    const raw = await readTextFileOrEmpty(this.eventsPath)
    if (!raw.trim()) return []

    const events: YoloEvent[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed) as YoloEvent)
      } catch {
        // ignore malformed rows in example runtime
      }
    }

    return events
  }

  private isJsonParseError(error: unknown): boolean {
    if (error instanceof SyntaxError) return true
    const message = error instanceof Error ? error.message : String(error)
    return (
      message.includes('Unexpected end of JSON input')
      || message.includes('JSON')
      || message.includes('Unexpected token')
    )
  }

  private async tryReadJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      return await readJsonFile<T>(filePath)
    } catch (error) {
      if (this.isJsonParseError(error)) {
        return null
      }
      throw error
    }
  }

  private isPhaseAtLeast(phase: 'P2' | 'P3'): boolean {
    return PHASE_ORDER[this.options.phase] >= PHASE_ORDER[phase]
  }

  private async acquireRuntimeLease(): Promise<RuntimeLease> {
    const now = this.now()
    let takeoverFromOwnerId: string | undefined
    let takeoverReason: RuntimeLease['takeoverReason']
    let acquiredAt = now

    if (await fileExists(this.runtimeLeasePath)) {
      const existing = await this.tryReadJsonFile<RuntimeLease>(this.runtimeLeasePath)
      if (existing) {
        if (existing.ownerId !== this.runtimeOwnerId) {
          takeoverFromOwnerId = existing.ownerId
          const staleAfterSec = existing.staleAfterSec || DEFAULT_RUNTIME_LEASE_STALE_SEC
          const heartbeatMs = Date.parse(existing.heartbeatAt)
          const stale = Number.isFinite(heartbeatMs) && (Date.now() - heartbeatMs > staleAfterSec * 1000)
          takeoverReason = stale ? 'stale_lease' : 'restart_or_takeover'
        } else {
          acquiredAt = existing.acquiredAt
        }
      }
    }

    const lease: RuntimeLease = {
      sessionId: this.sessionId,
      ownerId: this.runtimeOwnerId,
      acquiredAt,
      heartbeatAt: now,
      staleAfterSec: DEFAULT_RUNTIME_LEASE_STALE_SEC,
      takeoverFromOwnerId,
      takeoverReason
    }
    await writeJsonFile(this.runtimeLeasePath, lease)
    return lease
  }

  private async heartbeatRuntimeLease(): Promise<void> {
    if (!(await fileExists(this.runtimeLeasePath))) {
      await this.acquireRuntimeLease()
      return
    }

    const lease = await this.tryReadJsonFile<RuntimeLease>(this.runtimeLeasePath)
    if (!lease) {
      await this.acquireRuntimeLease()
      return
    }
    const now = this.now()
    if (lease.ownerId === this.runtimeOwnerId) {
      lease.heartbeatAt = now
      await writeJsonFile(this.runtimeLeasePath, lease)
      return
    }

    await writeJsonFile(this.runtimeLeasePath, {
      sessionId: this.sessionId,
      ownerId: this.runtimeOwnerId,
      acquiredAt: now,
      heartbeatAt: now,
      staleAfterSec: DEFAULT_RUNTIME_LEASE_STALE_SEC,
      takeoverFromOwnerId: lease.ownerId,
      takeoverReason: 'heartbeat_reacquire'
    } satisfies RuntimeLease)
  }

  private async writeRuntimeCheckpoint(
    state: SessionPersistedState,
    trigger: RuntimeCheckpoint['trigger']
  ): Promise<void> {
    if (!this.isPhaseAtLeast('P2')) return

    const createdAt = this.now()
    await this.writeRuntimeCheckpointRecord(state, trigger, createdAt)
    await this.maybeWritePeriodicRollupCheckpoint(state, createdAt)
  }

  private async writeRuntimeCheckpointRecord(
    state: SessionPersistedState,
    trigger: RuntimeCheckpoint['trigger'],
    createdAt: string
  ): Promise<void> {
    await ensureDir(this.runtimeCheckpointsDir)
    const planSnapshotHash = sha256Hex(await readTextFileOrEmpty(this.planPath))
    const branchDossierPath = path.join(this.branchDossiersDir, `${state.activeBranchId}.md`)
    const branchDossierHash = sha256Hex(await readTextFileOrEmpty(branchDossierPath))
    const checkpointId = randomId('cp')
    const fileName = `t${String(state.currentTurn).padStart(4, '0')}-${checkpointId}-${trigger}.json`
    const checkpointPath = path.join(this.runtimeCheckpointsDir, fileName)

    const checkpoint: RuntimeCheckpoint = {
      checkpointId,
      createdAt,
      trigger,
      turnNumber: state.currentTurn,
      runtimeState: state.state,
      activeStage: state.activeStage,
      activeBranchId: state.activeBranchId,
      activeNodeId: state.activeNodeId,
      pendingExternalTaskId: state.pendingExternalTaskId,
      planSnapshotHash,
      branchDossierHash,
      sessionState: state
    }

    await writeJsonFile(checkpointPath, checkpoint)
    await writeJsonFile(this.runtimeCheckpointsLatestPath, {
      checkpointId,
      fileName,
      createdAt,
      trigger,
      turnNumber: state.currentTurn,
      runtimeState: state.state
    })
  }

  private async maybeWritePeriodicRollupCheckpoint(
    state: SessionPersistedState,
    createdAt: string
  ): Promise<void> {
    if (this.runtimeRollupIntervalSec <= 0) return

    const rollupMetaPath = path.join(this.runtimeCheckpointsDir, 'rollup-meta.json')
    let lastRollupAt: string | undefined
    if (await fileExists(rollupMetaPath)) {
      const parsed = await this.tryReadJsonFile<{ lastRollupAt?: string }>(rollupMetaPath)
      lastRollupAt = parsed?.lastRollupAt
    }

    const due = (() => {
      if (!lastRollupAt) return true
      const previousMs = Date.parse(lastRollupAt)
      const currentMs = Date.parse(createdAt)
      if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs)) return true
      return currentMs - previousMs >= this.runtimeRollupIntervalSec * 1000
    })()

    if (!due) return

    await this.writeRuntimeCheckpointRecord(state, 'periodic_rollup', createdAt)
    await writeJsonFile(rollupMetaPath, {
      lastRollupAt: createdAt,
      intervalSec: this.runtimeRollupIntervalSec
    })
  }

  private async dedupeRunRecordAssetsByRunKey(
    assets: CoordinatorTurnResult['assets']
  ): Promise<{ assets: CoordinatorTurnResult['assets']; duplicateRunKeys: string[] }> {
    if (!this.isPhaseAtLeast('P2')) {
      return { assets, duplicateRunKeys: [] }
    }

    const existingRunKeys = new Set<string>()
    const runRecords = await this.assetStore.list('RunRecord')
    for (const record of runRecords) {
      const payload = record.payload as Record<string, unknown>
      if (typeof payload.runKey === 'string' && payload.runKey.trim()) {
        existingRunKeys.add(payload.runKey.trim())
      }
    }

    const seenInBatch = new Set<string>()
    const deduped: CoordinatorTurnResult['assets'] = []
    const duplicateRunKeys: string[] = []

    for (const asset of assets) {
      if (asset.type !== 'RunRecord') {
        deduped.push(asset)
        continue
      }

      const runKey = typeof asset.payload?.runKey === 'string' ? asset.payload.runKey.trim() : ''
      if (!runKey) {
        deduped.push(asset)
        continue
      }

      if (existingRunKeys.has(runKey) || seenInBatch.has(runKey)) {
        duplicateRunKeys.push(runKey)
        continue
      }

      seenInBatch.add(runKey)
      deduped.push(asset)
    }

    return { assets: deduped, duplicateRunKeys: sortStrings(Array.from(new Set(duplicateRunKeys))) }
  }

  /**
   * Repair missing supersedes references by stripping them from staged assets.
   * This handles the common case where the LLM hallucinates a shorthand ID
   * (e.g. "S1-SCT1") instead of using the real asset ID format.
   * Returns a list of repaired references like "assetId->missingRef".
   */
  private repairSupersedesIntegrity(existingAssets: AssetRecord[], stagedAssets: AssetRecord[]): string[] {
    const allById = new Map<string, AssetRecord>()
    for (const record of existingAssets) allById.set(record.id, record)
    for (const record of stagedAssets) allById.set(record.id, record)

    const repaired: string[] = []
    for (const record of stagedAssets) {
      const supersedes = record.supersedes?.trim()
      if (!supersedes) continue
      if (!allById.has(supersedes)) {
        repaired.push(`${record.id}->${supersedes}`)
        record.supersedes = undefined
      }
    }
    return repaired
  }

  private assertSupersedesIntegrity(records: AssetRecord[]): void {
    const issues = this.collectSupersedesIntegrityIssues(records)
    if (
      issues.missingRefs.length === 0
      && issues.selfRefs.length === 0
      && issues.typeMismatches.length === 0
      && issues.cycles.length === 0
    ) {
      return
    }

    const parts: string[] = []
    if (issues.missingRefs.length > 0) parts.push(`missing=${issues.missingRefs.slice(0, 5).join(', ')}`)
    if (issues.selfRefs.length > 0) parts.push(`self=${issues.selfRefs.slice(0, 5).join(', ')}`)
    if (issues.typeMismatches.length > 0) parts.push(`type=${issues.typeMismatches.slice(0, 5).join(', ')}`)
    if (issues.cycles.length > 0) parts.push(`cycle=${issues.cycles.slice(0, 5).join(', ')}`)
    throw new Error(`asset supersedes integrity violation: ${parts.join(' | ')}`)
  }

  private collectSupersedesIntegrityIssues(records: AssetRecord[]): {
    missingRefs: string[]
    selfRefs: string[]
    typeMismatches: string[]
    cycles: string[]
  } {
    const byId = new Map<string, AssetRecord>()
    for (const record of records) {
      byId.set(record.id, record)
    }

    const missingRefs: string[] = []
    const selfRefs: string[] = []
    const typeMismatches: string[] = []

    for (const record of records) {
      const supersedes = record.supersedes?.trim()
      if (!supersedes) continue
      if (supersedes === record.id) {
        selfRefs.push(record.id)
        continue
      }

      const prior = byId.get(supersedes)
      if (!prior) {
        missingRefs.push(`${record.id}->${supersedes}`)
        continue
      }
      if (prior.type !== record.type) {
        typeMismatches.push(`${record.id}:${record.type}->${prior.id}:${prior.type}`)
      }
    }

    const visiting = new Set<string>()
    const visited = new Set<string>()
    const cycles = new Set<string>()
    const visit = (id: string) => {
      if (visited.has(id)) return
      if (visiting.has(id)) {
        cycles.add(id)
        return
      }
      visiting.add(id)
      const record = byId.get(id)
      const supersedes = record?.supersedes?.trim()
      if (supersedes && byId.has(supersedes)) {
        visit(supersedes)
      }
      visiting.delete(id)
      visited.add(id)
    }
    for (const id of byId.keys()) {
      visit(id)
    }

    return {
      missingRefs: sortStrings(Array.from(new Set(missingRefs))),
      selfRefs: sortStrings(Array.from(new Set(selfRefs))),
      typeMismatches: sortStrings(Array.from(new Set(typeMismatches))),
      cycles: sortStrings(Array.from(cycles))
    }
  }

  private computeClaimCoverageSummary(records: AssetRecord[], invalidCountableLinkIds: Set<string> = new Set()): {
    assertedPrimary: number
    assertedSecondary: number
    coveredPrimary: number
    coveredSecondary: number
  } {
    const assertedPrimary = new Set<string>()
    const assertedSecondary = new Set<string>()
    for (const record of records) {
      if (record.type !== 'Claim') continue
      const payload = record.payload as Record<string, unknown>
      const state = typeof payload.state === 'string' ? payload.state : ''
      const tier = typeof payload.tier === 'string' ? payload.tier : ''
      if (state !== 'asserted') continue
      if (tier === 'primary') {
        assertedPrimary.add(record.id)
      } else if (tier === 'secondary') {
        assertedSecondary.add(record.id)
      }
    }

    const countableLinkedClaims = new Set<string>()
    for (const record of records) {
      if (record.type !== 'EvidenceLink') continue
      const payload = record.payload as Record<string, unknown>
      const policy = typeof payload.countingPolicy === 'string' ? payload.countingPolicy : ''
      if (policy && policy !== 'countable') continue
      if (invalidCountableLinkIds.has(record.id)) continue

      const claimIds = this.extractClaimIdsFromEvidencePayload(payload)
      for (const claimId of claimIds) {
        countableLinkedClaims.add(claimId)
      }
    }

    let coveredPrimary = 0
    let coveredSecondary = 0
    for (const claimId of assertedPrimary) {
      if (countableLinkedClaims.has(claimId)) coveredPrimary += 1
    }
    for (const claimId of assertedSecondary) {
      if (countableLinkedClaims.has(claimId)) coveredSecondary += 1
    }

    return {
      assertedPrimary: assertedPrimary.size,
      assertedSecondary: assertedSecondary.size,
      coveredPrimary,
      coveredSecondary
    }
  }

  private shouldGenerateClaimEvidenceTableAsset(stage: YoloStage): boolean {
    return stage === 'S5' && this.isPhaseAtLeast('P2')
  }

  private async stageDerivedAsset(input: {
    turnNumber: number
    attempt: number
    type: string
    payload: Record<string, unknown>
    supersedes?: string
  }): Promise<AssetRecord> {
    let seq = 1
    let id = this.assetStore.buildAssetId(input.type, input.turnNumber, input.attempt, seq)

    while (
      await fileExists(path.join(this.assetStore.stagingDir, `${id}.json`))
      || await fileExists(path.join(this.assetStore.assetsDir, `${id}.json`))
    ) {
      seq += 1
      if (seq > 9999) {
        throw new Error(`unable to allocate staged asset id for ${input.type}`)
      }
      id = this.assetStore.buildAssetId(input.type, input.turnNumber, input.attempt, seq)
    }

    const record: AssetRecord = {
      id,
      type: input.type,
      payload: input.payload,
      supersedes: input.supersedes,
      createdAt: this.now(),
      createdByTurn: input.turnNumber,
      createdByAttempt: input.attempt
    }
    await writeJsonFile(path.join(this.assetStore.stagingDir, `${record.id}.json`), record)
    return record
  }

  private buildClaimEvidenceTablePayload(
    records: AssetRecord[],
    invalidCountableLinkIds: Set<string>,
    coverage: { assertedPrimary: number; assertedSecondary: number; coveredPrimary: number; coveredSecondary: number }
  ): Record<string, unknown> {
    const linkedByClaim = new Map<string, {
      countable: Set<string>
      citeOnly: Set<string>
      needsRevalidate: Set<string>
    }>()

    for (const record of records) {
      if (record.type !== 'EvidenceLink') continue
      const payload = record.payload as Record<string, unknown>
      const claimIds = this.extractClaimIdsFromEvidencePayload(payload)
      if (claimIds.size === 0) continue

      const policyRaw = typeof payload.countingPolicy === 'string' ? payload.countingPolicy.trim().toLowerCase() : ''
      const effectivePolicy = invalidCountableLinkIds.has(record.id)
        ? 'cite_only'
        : (policyRaw === 'cite_only' || policyRaw === 'needs_revalidate' ? policyRaw : 'countable')

      for (const claimId of claimIds) {
        const bucket = linkedByClaim.get(claimId) ?? {
          countable: new Set<string>(),
          citeOnly: new Set<string>(),
          needsRevalidate: new Set<string>()
        }
        if (effectivePolicy === 'countable') {
          bucket.countable.add(record.id)
        } else if (effectivePolicy === 'cite_only') {
          bucket.citeOnly.add(record.id)
        } else {
          bucket.needsRevalidate.add(record.id)
        }
        linkedByClaim.set(claimId, bucket)
      }
    }

    const tierRank: Record<string, number> = { primary: 0, secondary: 1, exploratory: 2 }
    const rows = records
      .filter((record) => record.type === 'Claim')
      .map((record) => {
        const payload = record.payload as Record<string, unknown>
        const state = typeof payload.state === 'string' ? payload.state : ''
        if (state !== 'asserted') return null
        const tier = typeof payload.tier === 'string' ? payload.tier : 'secondary'
        const linked = linkedByClaim.get(record.id) ?? {
          countable: new Set<string>(),
          citeOnly: new Set<string>(),
          needsRevalidate: new Set<string>()
        }
        const countableEvidenceIds = sortStrings(Array.from(linked.countable))
        const citeOnlyEvidenceIds = sortStrings(Array.from(linked.citeOnly))
        const needsRevalidateEvidenceIds = sortStrings(Array.from(linked.needsRevalidate))

        const summary = this.readStringField(payload, ['statement', 'claim', 'text', 'title']) ?? 'No claim summary in payload.'
        const coverageStatus = countableEvidenceIds.length > 0
          ? 'countable'
          : citeOnlyEvidenceIds.length > 0
            ? 'cite_only'
            : needsRevalidateEvidenceIds.length > 0
              ? 'needs_revalidate'
              : 'empty'

        return {
          claimId: record.id,
          tier,
          state,
          summary,
          coverageStatus,
          countableEvidenceIds,
          citeOnlyEvidenceIds,
          needsRevalidateEvidenceIds
        }
      })
      .filter((row): row is {
        claimId: string
        tier: string
        state: string
        summary: string
        coverageStatus: 'countable' | 'cite_only' | 'needs_revalidate' | 'empty'
        countableEvidenceIds: string[]
        citeOnlyEvidenceIds: string[]
        needsRevalidateEvidenceIds: string[]
      } => row !== null)
      .sort((a, b) => {
        const rankA = tierRank[a.tier] ?? 99
        const rankB = tierRank[b.tier] ?? 99
        if (rankA !== rankB) return rankA - rankB
        return a.claimId.localeCompare(b.claimId)
      })

    const assertedPrimaryCoverage = coverage.assertedPrimary === 0
      ? 1
      : coverage.coveredPrimary / coverage.assertedPrimary
    const assertedSecondaryCoverage = coverage.assertedSecondary === 0
      ? 1
      : coverage.coveredSecondary / coverage.assertedSecondary

    return {
      generatedAt: this.now(),
      stage: 'S5',
      coverage: {
        assertedPrimary: coverage.assertedPrimary,
        coveredPrimary: coverage.coveredPrimary,
        assertedPrimaryCoverage,
        assertedSecondary: coverage.assertedSecondary,
        coveredSecondary: coverage.coveredSecondary,
        assertedSecondaryCoverage
      },
      completeness: {
        assertedPrimaryCoveragePass: assertedPrimaryCoverage >= 1,
        assertedSecondaryCoveragePass: assertedSecondaryCoverage >= 0.85
      },
      rows
    }
  }

  private computeClaimGovernanceSummary(
    records: AssetRecord[],
    coverage: { assertedPrimary: number; assertedSecondary: number }
  ): {
    assertedClaims: number
    claimFreezeDecisionCount: number
  } {
    let claimFreezeDecisionCount = 0
    for (const record of records) {
      if (record.type !== 'Decision') continue
      const payload = record.payload as Record<string, unknown>
      const kind = typeof payload.kind === 'string' ? payload.kind : ''
      const checkpoint = typeof payload.checkpoint === 'string' ? payload.checkpoint : ''
      if (kind === 'claim-freeze' || checkpoint === 'claim-freeze') {
        claimFreezeDecisionCount += 1
      }
    }

    return {
      assertedClaims: coverage.assertedPrimary + coverage.assertedSecondary,
      claimFreezeDecisionCount
    }
  }

  private computeClaimDecisionBindingSummary(records: AssetRecord[]): {
    assertedClaimCount: number
    assertedClaimWithFreezeRefCount: number
    missingFreezeRefClaimIds: string[]
  } {
    const assertedClaimIds = new Set<string>()
    for (const record of records) {
      if (record.type !== 'Claim') continue
      const payload = record.payload as Record<string, unknown>
      const state = typeof payload.state === 'string' ? payload.state : ''
      if (state === 'asserted') {
        assertedClaimIds.add(record.id)
      }
    }

    const referencedClaimIds = new Set<string>()
    for (const record of records) {
      if (record.type !== 'Decision') continue
      const payload = record.payload as Record<string, unknown>
      const kind = typeof payload.kind === 'string' ? payload.kind : ''
      const checkpoint = typeof payload.checkpoint === 'string' ? payload.checkpoint : ''
      if (kind !== 'claim-freeze' && checkpoint !== 'claim-freeze') continue

      this.collectStringIds(payload.referencedAssetIds, referencedClaimIds)
      this.collectStringIds(payload.referencedClaimIds, referencedClaimIds)
      this.collectStringIds(payload.claimId, referencedClaimIds)
      this.collectStringIds(payload.claimIds, referencedClaimIds)
    }

    let assertedClaimWithFreezeRefCount = 0
    const missingFreezeRefClaimIds: string[] = []
    for (const claimId of assertedClaimIds) {
      if (referencedClaimIds.has(claimId)) {
        assertedClaimWithFreezeRefCount += 1
      } else {
        missingFreezeRefClaimIds.push(claimId)
      }
    }

    return {
      assertedClaimCount: assertedClaimIds.size,
      assertedClaimWithFreezeRefCount,
      missingFreezeRefClaimIds: sortStrings(missingFreezeRefClaimIds)
    }
  }

  private computeReproducibilitySummary(
    records: AssetRecord[],
    invalidCountableLinkIds: Set<string> = new Set()
  ): {
    keyRunRecordCount: number
    keyRunRecordWithCompleteTripleCount: number
    missingRunRecordRefs: string[]
    runRecordsMissingTriple: string[]
  } {
    const byId = new Map(records.map((record) => [record.id, record] as const))
    const assertedPrimaryClaimIds = new Set<string>()
    for (const record of records) {
      if (record.type !== 'Claim') continue
      const payload = record.payload as Record<string, unknown>
      const state = typeof payload.state === 'string' ? payload.state : ''
      const tier = typeof payload.tier === 'string' ? payload.tier : ''
      if (state === 'asserted' && tier === 'primary') {
        assertedPrimaryClaimIds.add(record.id)
      }
    }

    const keyRunRecordIds = new Set<string>()
    const missingRunRecordRefs = new Set<string>()
    for (const record of records) {
      if (record.type !== 'EvidenceLink') continue
      const payload = record.payload as Record<string, unknown>
      const policy = typeof payload.countingPolicy === 'string' ? payload.countingPolicy : ''
      if (policy && policy !== 'countable') continue
      if (invalidCountableLinkIds.has(record.id)) continue

      const claimIds = this.extractClaimIdsFromEvidencePayload(payload)
      let targetsAssertedPrimary = false
      for (const claimId of claimIds) {
        if (assertedPrimaryClaimIds.has(claimId)) {
          targetsAssertedPrimary = true
          break
        }
      }
      if (!targetsAssertedPrimary) continue

      const runRefs = this.extractRunRecordRefsFromEvidencePayload(payload)
      if (runRefs.size === 0) {
        missingRunRecordRefs.add(`${record.id}:missing_run_record_ref`)
        continue
      }

      for (const runRef of runRefs) {
        const target = byId.get(runRef)
        if (!target) {
          missingRunRecordRefs.add(`${record.id}->${runRef}:missing`)
          continue
        }
        if (target.type !== 'RunRecord') {
          missingRunRecordRefs.add(`${record.id}->${runRef}:${target.type}`)
          continue
        }
        keyRunRecordIds.add(target.id)
      }
    }

    const runRecordsMissingTriple = new Set<string>()
    let keyRunRecordWithCompleteTripleCount = 0
    for (const runRecordId of keyRunRecordIds) {
      const runRecord = byId.get(runRecordId)
      if (!runRecord || runRecord.type !== 'RunRecord') {
        runRecordsMissingTriple.add(runRecordId)
        continue
      }

      const payload = runRecord.payload as Record<string, unknown>
      const hasEnvSnapshot = this.hasReferencedAssetType(payload, byId, 'EnvSnapshot')
      const hasReplayScript = this.hasReferencedAssetType(payload, byId, 'ReplayScript')
      const hasWorkloadVersion = this.hasReferencedAssetType(payload, byId, 'WorkloadVersion')

      if (hasEnvSnapshot && hasReplayScript && hasWorkloadVersion) {
        keyRunRecordWithCompleteTripleCount += 1
      } else {
        runRecordsMissingTriple.add(runRecordId)
      }
    }

    return {
      keyRunRecordCount: keyRunRecordIds.size,
      keyRunRecordWithCompleteTripleCount,
      missingRunRecordRefs: sortStrings(Array.from(missingRunRecordRefs)),
      runRecordsMissingTriple: sortStrings(Array.from(runRecordsMissingTriple))
    }
  }

  private normalizeCrossBranchEvidenceLinkPolicies(
    existingRecords: AssetRecord[],
    mutableRecords: AssetRecord[]
  ): {
    defaultedCiteOnlyLinkIds: string[]
    autoUpgradedCountableLinkIds: string[]
    updatedLinkIds: string[]
  } {
    const byId = new Map([...existingRecords, ...mutableRecords].map((record) => [record.id, record] as const))
    const defaultedCiteOnlyLinkIds: string[] = []
    const autoUpgradedCountableLinkIds: string[] = []
    const updatedLinkIds = new Set<string>()

    for (const record of mutableRecords) {
      if (record.type !== 'EvidenceLink') continue
      const payload = record.payload as Record<string, unknown>
      const policyRaw = typeof payload.countingPolicy === 'string' ? payload.countingPolicy : ''
      const policy = policyRaw.trim().toLowerCase()

      const createdByBranchId = this.readStringField(payload, [
        'createdByBranchId',
        'branchId',
        'createdInBranchId'
      ])
      const sourceBranchId = this.readStringField(payload, [
        'sourceBranchId',
        'reusedFromBranchId',
        'originBranchId'
      ])
      const crossBranch = Boolean(
        sourceBranchId
        && createdByBranchId
        && sourceBranchId !== createdByBranchId
      )
      if (!crossBranch) continue

      const constraintsRefValue = payload.constraintsRef
      const constraintsRef = typeof constraintsRefValue === 'object' && constraintsRefValue !== null
        ? (constraintsRefValue as Record<string, unknown>)
        : {}
      const envSnapshotId = this.readStringFieldFromRecords([constraintsRef, payload], ['envSnapshotId'])
      const workloadVersionId = this.readStringFieldFromRecords([constraintsRef, payload], ['workloadVersionId'])
      const baselineParityContractId = this.readStringFieldFromRecords(
        [constraintsRef, payload],
        ['baselineParityContractId']
      )
      const hasBaselineParityContractRef = Boolean(
        baselineParityContractId
        && byId.get(baselineParityContractId)?.type === 'BaselineParityContract'
      )
      const exactApplicabilityMatch = Boolean(envSnapshotId && workloadVersionId && hasBaselineParityContractRef)

      if ((!policy || policy === 'cite_only') && exactApplicabilityMatch) {
        payload.countingPolicy = 'countable'
        payload.countingPolicyAuto = 'cross_branch_auto_upgrade'
        autoUpgradedCountableLinkIds.push(record.id)
        updatedLinkIds.add(record.id)
        continue
      }

      if (!policy) {
        payload.countingPolicy = 'cite_only'
        payload.countingPolicyAuto = 'cross_branch_default_cite_only'
        defaultedCiteOnlyLinkIds.push(record.id)
        updatedLinkIds.add(record.id)
      }
    }

    return {
      defaultedCiteOnlyLinkIds: sortStrings(defaultedCiteOnlyLinkIds),
      autoUpgradedCountableLinkIds: sortStrings(autoUpgradedCountableLinkIds),
      updatedLinkIds: sortStrings(Array.from(updatedLinkIds))
    }
  }

  private computeEvidenceLinkPolicySummary(records: AssetRecord[]): {
    crossBranchCountableLinkIds: string[]
    keyRunMissingParityContractLinkIds: string[]
    invalidCountableLinkIds: string[]
  } {
    const byId = new Map(records.map((record) => [record.id, record] as const))
    const crossBranchCountableLinkIds = new Set<string>()
    const keyRunMissingParityContractLinkIds = new Set<string>()
    const invalidCountableLinkIds = new Set<string>()
    const assertedClaimIds = new Set<string>()

    for (const record of records) {
      if (record.type !== 'Claim') continue
      const payload = record.payload as Record<string, unknown>
      const state = typeof payload.state === 'string' ? payload.state : ''
      const tier = typeof payload.tier === 'string' ? payload.tier : ''
      if (state !== 'asserted') continue
      if (tier !== 'primary' && tier !== 'secondary') continue
      assertedClaimIds.add(record.id)
    }

    for (const record of records) {
      if (record.type !== 'EvidenceLink') continue
      const payload = record.payload as Record<string, unknown>
      const policy = typeof payload.countingPolicy === 'string' ? payload.countingPolicy : ''
      if (policy && policy !== 'countable') continue

      const constraintsRefValue = payload.constraintsRef
      const constraintsRef = typeof constraintsRefValue === 'object' && constraintsRefValue !== null
        ? (constraintsRefValue as Record<string, unknown>)
        : {}
      const envSnapshotId = this.readStringFieldFromRecords([constraintsRef, payload], ['envSnapshotId'])
      const workloadVersionId = this.readStringFieldFromRecords([constraintsRef, payload], ['workloadVersionId'])
      const baselineParityContractId = this.readStringFieldFromRecords(
        [constraintsRef, payload],
        ['baselineParityContractId']
      )
      const hasBaselineParityContractRef = Boolean(
        baselineParityContractId
        && byId.get(baselineParityContractId)?.type === 'BaselineParityContract'
      )

      const createdByBranchId = this.readStringField(payload, [
        'createdByBranchId',
        'branchId',
        'createdInBranchId'
      ])
      const sourceBranchId = this.readStringField(payload, [
        'sourceBranchId',
        'reusedFromBranchId',
        'originBranchId'
      ])

      const crossBranch = Boolean(
        sourceBranchId
        && createdByBranchId
        && sourceBranchId !== createdByBranchId
      )
      if (crossBranch) {
        crossBranchCountableLinkIds.add(record.id)

        const canAutoUpgrade = Boolean(envSnapshotId && workloadVersionId && hasBaselineParityContractRef)
        if (!canAutoUpgrade) {
          invalidCountableLinkIds.add(record.id)
        }
      }

      const claimIds = this.extractClaimIdsFromEvidencePayload(payload)
      const targetsAssertedClaim = Array.from(claimIds).some((claimId) => assertedClaimIds.has(claimId))
      if (targetsAssertedClaim && !hasBaselineParityContractRef) {
        keyRunMissingParityContractLinkIds.add(record.id)
        invalidCountableLinkIds.add(record.id)
      }
    }

    return {
      crossBranchCountableLinkIds: sortStrings(Array.from(crossBranchCountableLinkIds)),
      keyRunMissingParityContractLinkIds: sortStrings(Array.from(keyRunMissingParityContractLinkIds)),
      invalidCountableLinkIds: sortStrings(Array.from(invalidCountableLinkIds))
    }
  }

  private computeCausalitySummary(
    records: AssetRecord[],
    invalidCountableLinkIds: Set<string> = new Set()
  ): {
    requiredClaims: number
    satisfiedClaims: number
    interventionLinkCount: number
    counterfactualLinkCount: number
    correlationOnlyLinkCount: number
    missingClaimIds: string[]
  } {
    const requiredClaimIds = new Set<string>()
    for (const record of records) {
      if (record.type !== 'Claim') continue
      const payload = record.payload as Record<string, unknown>
      if (this.isCausalityRequiredClaim(payload)) {
        requiredClaimIds.add(record.id)
      }
    }

    const claimSatisfied = new Map<string, boolean>()
    for (const claimId of requiredClaimIds) {
      claimSatisfied.set(claimId, false)
    }

    let interventionLinkCount = 0
    let counterfactualLinkCount = 0
    let correlationOnlyLinkCount = 0

    for (const record of records) {
      if (record.type !== 'EvidenceLink') continue
      if (invalidCountableLinkIds.has(record.id)) continue

      const payload = record.payload as Record<string, unknown>
      const policy = typeof payload.countingPolicy === 'string' ? payload.countingPolicy : ''
      if (policy && policy !== 'countable') continue

      const linkedClaimIds = this.extractClaimIdsFromEvidencePayload(payload)
      const matchedClaimIds = Array.from(linkedClaimIds).filter((claimId) => requiredClaimIds.has(claimId))
      if (matchedClaimIds.length === 0) continue

      const causalityKind = this.classifyCausalityKind(payload)
      if (causalityKind === 'intervention') {
        interventionLinkCount += 1
        for (const claimId of matchedClaimIds) {
          claimSatisfied.set(claimId, true)
        }
      } else if (causalityKind === 'counterfactual') {
        counterfactualLinkCount += 1
        for (const claimId of matchedClaimIds) {
          claimSatisfied.set(claimId, true)
        }
      } else {
        correlationOnlyLinkCount += 1
      }
    }

    let satisfiedClaims = 0
    const missingClaimIds: string[] = []
    for (const [claimId, satisfied] of claimSatisfied.entries()) {
      if (satisfied) {
        satisfiedClaims += 1
      } else {
        missingClaimIds.push(claimId)
      }
    }

    return {
      requiredClaims: requiredClaimIds.size,
      satisfiedClaims,
      interventionLinkCount,
      counterfactualLinkCount,
      correlationOnlyLinkCount,
      missingClaimIds: sortStrings(missingClaimIds)
    }
  }

  private computeDirectEvidenceSummary(
    records: AssetRecord[],
    invalidCountableLinkIds: Set<string> = new Set()
  ): {
    requiredClaims: number
    satisfiedClaims: number
    missingClaimIds: string[]
  } {
    const assertedClaimsWithRequirements = new Map<string, { allOf: Set<string>; anyOfGroups: Array<Set<string>> }>()
    for (const record of records) {
      if (record.type !== 'Claim') continue
      const payload = record.payload as Record<string, unknown>
      const state = typeof payload.state === 'string' ? payload.state : ''
      if (state !== 'asserted') continue

      const requiredKinds = this.normalizeStringSet(payload.requiredEvidenceKinds)
      if (requiredKinds.size > 0) {
        assertedClaimsWithRequirements.set(record.id, {
          allOf: requiredKinds,
          anyOfGroups: []
        })
        continue
      }

      const inferred = this.inferDirectEvidenceRequirementFromClaimType(payload)
      if (!inferred) continue
      assertedClaimsWithRequirements.set(record.id, inferred)
    }

    const linkedKindsByClaim = new Map<string, Set<string>>()
    for (const record of records) {
      if (record.type !== 'EvidenceLink') continue
      if (invalidCountableLinkIds.has(record.id)) continue

      const payload = record.payload as Record<string, unknown>
      const policy = typeof payload.countingPolicy === 'string' ? payload.countingPolicy : ''
      if (policy && policy !== 'countable') continue

      const claimIds = this.extractClaimIdsFromEvidencePayload(payload)
      if (claimIds.size === 0) continue

      const evidenceKinds = this.normalizeStringSet([
        payload.evidenceKind,
        payload.evidenceKinds,
        payload.evidenceType,
        payload.evidenceTypes,
        payload.measurementType
      ])
      if (evidenceKinds.size === 0) continue

      for (const claimId of claimIds) {
        const existing = linkedKindsByClaim.get(claimId) ?? new Set<string>()
        for (const kind of evidenceKinds) {
          existing.add(kind)
        }
        linkedKindsByClaim.set(claimId, existing)
      }
    }

    let satisfiedClaims = 0
    const missingClaimIds: string[] = []
    for (const [claimId, requirement] of assertedClaimsWithRequirements.entries()) {
      const linkedKinds = linkedKindsByClaim.get(claimId) ?? new Set<string>()
      let allKindsPresent = true
      for (const requiredKind of requirement.allOf) {
        if (!linkedKinds.has(requiredKind)) {
          allKindsPresent = false
          break
        }
      }
      let anyOfGroupsSatisfied = true
      if (allKindsPresent) {
        for (const group of requirement.anyOfGroups) {
          let groupHit = false
          for (const option of group) {
            if (linkedKinds.has(option)) {
              groupHit = true
              break
            }
          }
          if (!groupHit) {
            anyOfGroupsSatisfied = false
            break
          }
        }
      }

      if (allKindsPresent && anyOfGroupsSatisfied) {
        satisfiedClaims += 1
      } else {
        missingClaimIds.push(claimId)
      }
    }

    return {
      requiredClaims: assertedClaimsWithRequirements.size,
      satisfiedClaims,
      missingClaimIds: sortStrings(missingClaimIds)
    }
  }

  private inferDirectEvidenceRequirementFromClaimType(payload: Record<string, unknown>): {
    allOf: Set<string>
    anyOfGroups: Array<Set<string>>
  } | null {
    const claimTypeRaw = typeof payload.claimType === 'string' ? payload.claimType : ''
    const claimType = this.canonicalizeEvidenceKindToken(claimTypeRaw)

    if (claimType === 'performance' || claimType === 'scalability') {
      return {
        allOf: new Set(),
        anyOfGroups: [new Set(['end_to_end', 'e2e'])]
      }
    }

    if (claimType === 'overhead') {
      return {
        allOf: new Set(['resource_breakdown']),
        anyOfGroups: [new Set(['parity', 'parity_alignment', 'parity_validation', 'parity_aligned'])]
      }
    }

    if (claimType === 'robustness') {
      return {
        allOf: new Set(),
        anyOfGroups: [new Set(['sensitivity', 'structured_failure', 'failure_mode', 'failure_analysis'])]
      }
    }

    return null
  }

  private isCausalityRequiredClaim(payload: Record<string, unknown>): boolean {
    if (payload.requiresCausality === true) return true

    const claimType = typeof payload.claimType === 'string' ? payload.claimType.trim().toLowerCase() : ''
    const claimSubtype = typeof payload.claimSubtype === 'string' ? payload.claimSubtype.trim().toLowerCase() : ''
    const tags = Array.isArray(payload.tags) ? payload.tags : []
    const tagStrings = tags
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())

    const tokens = [claimType, claimSubtype, ...tagStrings].filter(Boolean)
    return tokens.some((token) => token.includes('bottleneck') || token.includes('mechanism'))
  }

  private classifyCausalityKind(payload: Record<string, unknown>): 'intervention' | 'counterfactual' | 'correlation' {
    const fields = [
      payload.causalityType,
      payload.testType,
      payload.evidenceKind,
      payload.kind,
      payload.method,
      payload.design
    ]
    const values = fields
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
    const combined = values.join(' ')

    if (
      combined.includes('intervention')
      || combined.includes('ablation')
      || combined.includes('treatment')
    ) {
      return 'intervention'
    }
    if (combined.includes('counterfactual') || combined.includes('what-if') || combined.includes('what if')) {
      return 'counterfactual'
    }
    return 'correlation'
  }

  private extractClaimIdsFromEvidencePayload(payload: Record<string, unknown>): Set<string> {
    const claimIds = new Set<string>()
    this.collectStringIds(payload.claimId, claimIds)
    this.collectStringIds(payload.claimIds, claimIds)
    this.collectStringIds(payload.targetClaimId, claimIds)
    this.collectStringIds(payload.targetClaimIds, claimIds)
    return claimIds
  }

  private extractRunRecordRefsFromEvidencePayload(payload: Record<string, unknown>): Set<string> {
    const runRefs = new Set<string>()
    this.collectStringIds(payload.evidenceId, runRefs)
    this.collectStringIds(payload.evidenceIds, runRefs)
    this.collectStringIds(payload.sourceAssetId, runRefs)
    this.collectStringIds(payload.sourceAssetIds, runRefs)
    this.collectStringIds(payload.runRecordId, runRefs)
    this.collectStringIds(payload.runRecordIds, runRefs)
    this.collectStringIds(payload.runId, runRefs)
    this.collectStringIds(payload.runIds, runRefs)
    return runRefs
  }

  private hasReferencedAssetType(
    payload: Record<string, unknown>,
    byId: Map<string, AssetRecord>,
    targetType: 'EnvSnapshot' | 'ReplayScript' | 'WorkloadVersion'
  ): boolean {
    const candidates = new Set<string>()
    if (targetType === 'EnvSnapshot') {
      this.collectStringIds(payload.envSnapshotId, candidates)
      this.collectStringIds(payload.envSnapshotIds, candidates)
      this.collectStringIds(payload.envSnapshot, candidates)
    } else if (targetType === 'ReplayScript') {
      this.collectStringIds(payload.replayScriptId, candidates)
      this.collectStringIds(payload.replayScriptIds, candidates)
      this.collectStringIds(payload.replayScript, candidates)
    } else if (targetType === 'WorkloadVersion') {
      this.collectStringIds(payload.workloadVersionId, candidates)
      this.collectStringIds(payload.workloadVersionIds, candidates)
      this.collectStringIds(payload.workloadVersion, candidates)
    }

    this.collectDependencyRefIds(payload.dependsOn, candidates)
    this.collectDependencyRefIds(payload.depends_on, candidates)

    for (const candidate of candidates) {
      if (candidate.startsWith(`${targetType}-`)) return true
      const asset = byId.get(candidate)
      if (asset?.type === targetType) return true
    }
    return false
  }

  private readStringFieldFromRecords(records: Array<Record<string, unknown>>, keys: string[]): string | undefined {
    for (const record of records) {
      const value = this.readStringField(record, keys)
      if (value) return value
    }
    return undefined
  }

  private readStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = record[key]
      if (typeof value !== 'string') continue
      const normalized = value.trim()
      if (normalized) return normalized
    }
    return undefined
  }

  private readStringListField(record: Record<string, unknown>, keys: string[]): string[] {
    const values = new Set<string>()
    for (const key of keys) {
      this.collectStringIds(record[key], values)
    }
    return sortStrings(Array.from(values))
  }

  private withAutoCheckpointReferences(request: AskUserRequest, records: AssetRecord[]): AskUserRequest {
    if (request.checkpoint !== 'claim-freeze') return request
    const existingRefs = this.normalizeIdList(request.referencedAssetIds)
    if (existingRefs.length > 0) {
      return {
        ...request,
        referencedAssetIds: existingRefs
      }
    }
    const claimRefs = this.listAssertedClaimIds(records)
    return {
      ...request,
      referencedAssetIds: claimRefs
    }
  }

  private withFallbackAskUserContext(
    request: AskUserRequest,
    input: {
      objective: string
      currentFocus?: string
      whyNow?: string
      needFromUser?: string
      doneDefinition?: string
      actionRationale?: string
      summary?: string
    }
  ): AskUserRequest {
    const existing = typeof request.context === 'string' ? request.context.trim() : ''
    if (existing) {
      return {
        ...request,
        context: existing
      }
    }

    const lines: string[] = []
    const focus = (input.currentFocus ?? '').trim() || input.objective.trim() || 'current research objective'
    lines.push(`Current focus: ${focus}`)

    const why = (input.whyNow ?? '').trim() || (input.actionRationale ?? '').trim() || (input.summary ?? '').trim()
    if (why) {
      lines.push(`Why this is asked now: ${why}`)
    }

    const need = (input.needFromUser ?? '').trim()
    if (need) {
      lines.push(`What is needed from you: ${need}`)
    }

    if (Array.isArray(request.requiredFiles) && request.requiredFiles.length > 0) {
      lines.push(`Files expected: ${request.requiredFiles.join(', ')}`)
    }

    if (/\(\d+\)|\d\)/.test(request.question)) {
      lines.push('Reply format: answer each numbered item inline, for example "1) ... 2) ...".')
    }

    const doneDefinition = (input.doneDefinition ?? '').trim()
    if (doneDefinition) {
      lines.push(`After your reply, the run continues when this is satisfied: ${doneDefinition}`)
    } else {
      lines.push(`After your reply, the run resumes this objective: ${focus}`)
    }

    return {
      ...request,
      context: lines.join('\n')
    }
  }

  private async resolveCheckpointReferencedAssetIds(pending: AskUserRequest): Promise<string[]> {
    const existingRefs = this.normalizeIdList(pending.referencedAssetIds)
    if (existingRefs.length > 0) return existingRefs
    if (pending.checkpoint !== 'claim-freeze') return []

    const claims = await this.assetStore.list('Claim')
    return this.listAssertedClaimIds(claims)
  }

  private listAssertedClaimIds(records: AssetRecord[]): string[] {
    const ids = new Set<string>()
    for (const record of records) {
      if (record.type !== 'Claim') continue
      const payload = record.payload as Record<string, unknown>
      const state = typeof payload.state === 'string' ? payload.state : ''
      if (state === 'asserted') {
        ids.add(record.id)
      }
    }
    return sortStrings(Array.from(ids))
  }

  private normalizeIdList(value: unknown): string[] {
    const ids = new Set<string>()
    this.collectStringIds(value, ids)
    return sortStrings(Array.from(ids))
  }

  private normalizeStringSet(value: unknown): Set<string> {
    const raw = new Set<string>()
    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectStringIds(item, raw)
      }
    } else {
      this.collectStringIds(value, raw)
    }

    const normalized = new Set<string>()
    for (const item of raw) {
      const cleaned = this.canonicalizeEvidenceKindToken(item)
      if (cleaned) normalized.add(cleaned)
    }
    return normalized
  }

  private canonicalizeEvidenceKindToken(value: string): string {
    return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  }

  private collectDependencyRefIds(value: unknown, sink: Set<string>, depth: number = 0): void {
    if (depth > 3 || value === null || value === undefined) return
    if (typeof value === 'string') {
      const normalized = value.trim()
      if (normalized) sink.add(normalized)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectDependencyRefIds(item, sink, depth + 1)
      }
      return
    }
    if (typeof value !== 'object') return

    const record = value as Record<string, unknown>
    const refKeys = [
      'id',
      'ids',
      'assetId',
      'assetIds',
      'refId',
      'refIds',
      'targetId',
      'targetIds',
      'envSnapshotId',
      'envSnapshotIds',
      'workloadVersionId',
      'workloadVersionIds',
      'replayScriptId',
      'replayScriptIds'
    ]
    for (const key of refKeys) {
      this.collectStringIds(record[key], sink)
    }

    this.collectDependencyRefIds(record.dependsOn, sink, depth + 1)
    this.collectDependencyRefIds(record.depends_on, sink, depth + 1)
    this.collectDependencyRefIds(record.refs, sink, depth + 1)
    this.collectDependencyRefIds(record.references, sink, depth + 1)
  }

  private collectStringIds(value: unknown, sink: Set<string>): void {
    if (typeof value === 'string') {
      const normalized = value.trim()
      if (normalized) sink.add(normalized)
      return
    }
    if (!Array.isArray(value)) return
    for (const item of value) {
      if (typeof item !== 'string') continue
      const normalized = item.trim()
      if (normalized) sink.add(normalized)
    }
  }

  private async runMaintenanceChecks(): Promise<void> {
    if (!this.isPhaseAtLeast('P2')) return

    const state = await this.readSessionState()
    const maintenance = state.maintenance ?? { budgetAlertLevel: 'none', waitTaskAlerts: {} }
    if (!maintenance.budgetAlertLevel) maintenance.budgetAlertLevel = 'none'
    if (!maintenance.waitTaskAlerts) maintenance.waitTaskAlerts = {}
    let dirty = false

    const assets = await this.assetStore.list()
    const integrityIssues = this.collectSupersedesIntegrityIssues(assets)
    if (
      integrityIssues.missingRefs.length > 0
      || integrityIssues.selfRefs.length > 0
      || integrityIssues.typeMismatches.length > 0
      || integrityIssues.cycles.length > 0
    ) {
      const integrityRefs = sortStrings([
        ...integrityIssues.missingRefs,
        ...integrityIssues.selfRefs,
        ...integrityIssues.typeMismatches,
        ...integrityIssues.cycles
      ])
      const fingerprint = sha256Hex(JSON.stringify(integrityRefs))
      if (maintenance.lastAssetIntegrityHash !== fingerprint) {
        await this.emitMaintenanceAlert(state.currentTurn, {
          kind: 'asset_chain_integrity',
          severity: 'error',
          message: 'Asset supersedes chain integrity issue detected.',
          refs: integrityRefs.slice(0, 20)
        })
        maintenance.lastAssetIntegrityHash = fingerprint
        dirty = true
      }
    } else if (maintenance.lastAssetIntegrityHash) {
      maintenance.lastAssetIntegrityHash = undefined
      dirty = true
    }

    const pendingTaskId = state.pendingExternalTaskId?.trim()
    if (pendingTaskId) {
      const taskPath = this.waitTaskPath(pendingTaskId)
      if (await fileExists(taskPath)) {
        const task = await readJsonFile<ExternalWaitTask>(taskPath)
        const waiting = task.status === 'waiting' || task.status === 'open'
        if (waiting) {
          const createdMs = Date.parse(task.createdAt)
          const nowIso = this.now()
          const nowMs = Date.parse(nowIso)
          if (Number.isFinite(createdMs) && Number.isFinite(nowMs) && nowMs >= createdMs) {
            const ageSec = Math.floor((nowMs - createdMs) / 1000)
            const alertState = maintenance.waitTaskAlerts[task.id] ?? {}

            if (ageSec >= WAIT_TASK_ESCALATION_SEC && !alertState.lastEscalationAt) {
              await this.emitMaintenanceAlert(state.currentTurn, {
                kind: 'wait_task_escalation',
                severity: 'error',
                message: `WAITING_EXTERNAL task overdue for escalation (${task.id}).`,
                refs: [task.id]
              })
              alertState.lastEscalationAt = nowIso
              if (!alertState.lastReminderAt) {
                alertState.lastReminderAt = nowIso
              }
              maintenance.waitTaskAlerts[task.id] = alertState
              dirty = true
            } else if (ageSec >= WAIT_TASK_REMINDER_SEC && !alertState.lastReminderAt) {
              await this.emitMaintenanceAlert(state.currentTurn, {
                kind: 'wait_task_reminder',
                severity: 'warning',
                message: `WAITING_EXTERNAL task still pending; reminder emitted (${task.id}).`,
                refs: [task.id]
              })
              alertState.lastReminderAt = nowIso
              maintenance.waitTaskAlerts[task.id] = alertState
              dirty = true
            }
          }
        }
      }
    }

    const tokenRatio = this.options.budget.maxTokens > 0
      ? state.budgetUsed.tokens / this.options.budget.maxTokens
      : 0
    const costRatio = this.options.budget.maxCostUsd > 0
      ? state.budgetUsed.costUsd / this.options.budget.maxCostUsd
      : 0
    const turnRatio = this.options.budget.maxTurns > 0
      ? state.budgetUsed.turns / this.options.budget.maxTurns
      : 0
    // Token ratio is report-only — excluded from hard-stop alerts.
    // Only cost and turn ratios drive warning/critical thresholds.
    const maxRatio = Math.max(costRatio, turnRatio)
    const budgetLevel: 'none' | 'warning' | 'critical' = maxRatio >= 0.95
      ? 'critical'
      : maxRatio >= 0.8
        ? 'warning'
        : 'none'

    if (budgetLevel !== maintenance.budgetAlertLevel) {
      if (budgetLevel === 'warning') {
        await this.emitMaintenanceAlert(state.currentTurn, {
          kind: 'budget_drift_warning',
          severity: 'warning',
          message: `Budget usage warning (${Math.round(maxRatio * 100)}%).`,
          refs: [`ratio=${maxRatio.toFixed(3)}`]
        })
      } else if (budgetLevel === 'critical') {
        await this.emitMaintenanceAlert(state.currentTurn, {
          kind: 'budget_drift_critical',
          severity: 'error',
          message: `Budget usage critical (${Math.round(maxRatio * 100)}%).`,
          refs: [`ratio=${maxRatio.toFixed(3)}`]
        })
      }
      maintenance.budgetAlertLevel = budgetLevel
      dirty = true
    }

    if (!dirty) return

    state.maintenance = maintenance
    state.updatedAt = this.now()
    await this.writeSessionState(state)
  }

  private async emitMaintenanceAlert(
    turnNumber: number,
    payload: YoloEventPayloadByType['maintenance_alert']
  ): Promise<void> {
    const seq = await this.getNextSeqForTurn(turnNumber)
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'maintenance_alert',
      payload
    } satisfies YoloEvent<'maintenance_alert'>)
  }

  private async listTurnReports(): Promise<number[]> {
    await ensureDir(this.turnsDir)
    const names = await fs.readdir(this.turnsDir)
    const turns = names
      .map(parseTurnNumberFromReportName)
      .filter((value): value is number => value !== null)
    return turns.sort((a, b) => a - b)
  }

  private async reconcileWaitingExternalOnInit(): Promise<void> {
    const state = await this.readSessionState()
    if (state.state !== 'WAITING_EXTERNAL') return
    const taskId = state.pendingExternalTaskId?.trim()
    if (!taskId) return

    const taskPath = this.waitTaskPath(taskId)
    if (!(await fileExists(taskPath))) return
    const task = await readJsonFile<ExternalWaitTask>(taskPath)
    const validation = await this.evaluateWaitTaskValidation(task)
    if (!validation.ok) return

    const from = state.state
    state.state = 'PLANNING'
    state.pendingExternalTaskId = undefined
    state.pendingQuestion = undefined
    state.updatedAt = this.now()
    await this.writeSessionState(state)
    await this.writeRuntimeCheckpoint(state, 'state_transition')

    const seq = await this.getNextSeqForTurn(state.currentTurn)
    await appendJsonLine(this.eventsPath, {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      turnNumber: state.currentTurn,
      seq,
      timestamp: this.now(),
      schemaVersion: 1,
      eventType: 'state_transition',
      payload: {
        from,
        to: 'PLANNING',
        reason: `startup check satisfied WAITING_EXTERNAL task: ${task.id}`
      }
    } satisfies YoloEvent<'state_transition'>)
  }
}
