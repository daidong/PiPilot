import crypto from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, parse, relative } from 'node:path'

import {
  buildAssetInventoryExport,
  buildClaimEvidenceTableExport,
  buildFinalBundleManifest,
  createYoloSession,
  type AssetRecord,
  type BranchNode,
  type ExternalWaitTask,
  type SessionPersistedState,
  type TurnReport,
  type YoloSessionOptions
} from '@yolo-researcher/index'

interface WindowRuntimeState {
  projectPath: string
  yoloSession: ReturnType<typeof createYoloSession> | null
  sessionOptions?: YoloSessionOptions
  yoloTurnReports: TurnReport[]
  loopRunning: boolean
  pauseRequested: boolean
  stopRequested: boolean
  lastBroadcastState?: SessionPersistedState['state']
}

const windowStates = new Map<number, WindowRuntimeState>()
let ipcHandlersRegistered = false

interface DesktopSessionMeta {
  sessionId: string
  goal: string
  options: YoloSessionOptions
  updatedAt: string
}

interface BranchTreeFile {
  activeBranchId: string
  activeNodeId: string
  rootNodeId: string
  nodeIds: string[]
}

interface BranchSnapshot {
  activeBranchId: string
  activeNodeId: string
  rootNodeId: string
  nodes: BranchNode[]
}

interface IngressAddedFile {
  sourcePath: string
  storedPath: string
  sizeBytes: number
}

interface AddIngressFilesResult {
  uploadDir: string
  files: IngressAddedFile[]
}

function createWindowRuntimeState(): WindowRuntimeState {
  return {
    projectPath: '',
    yoloSession: null,
    sessionOptions: undefined,
    yoloTurnReports: [],
    loopRunning: false,
    pauseRequested: false,
    stopRequested: false,
    lastBroadcastState: undefined
  }
}

function getWindowState(win: BrowserWindow): WindowRuntimeState {
  const existing = windowStates.get(win.id)
  if (existing) return existing
  const created = createWindowRuntimeState()
  windowStates.set(win.id, created)
  return created
}

function getWindowContext(event: IpcMainInvokeEvent): { win: BrowserWindow; state: WindowRuntimeState } {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) throw new Error('Window not found for IPC event')
  return { win, state: getWindowState(win) }
}

function safeSend(win: BrowserWindow, channel: string, payload?: unknown): void {
  if (!win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

async function stopSessionIfNeeded(state: WindowRuntimeState): Promise<void> {
  if (!state.yoloSession) return
  try {
    await state.yoloSession.stop()
  } catch {
    // Best effort stop for an example app.
  }
}

function clearWindowState(state: WindowRuntimeState): void {
  state.yoloSession = null
  state.sessionOptions = undefined
  state.yoloTurnReports = []
  state.projectPath = ''
  state.loopRunning = false
  state.pauseRequested = false
  state.stopRequested = false
  state.lastBroadcastState = undefined
}

function desktopStatePath(): string {
  return join(app.getPath('userData'), 'yolo-researcher-desktop-state.json')
}

function readDesktopState(): { lastProjectPath?: string } {
  try {
    const raw = readFileSync(desktopStatePath(), 'utf-8')
    return JSON.parse(raw) as { lastProjectPath?: string }
  } catch {
    return {}
  }
}

function writeDesktopState(next: { lastProjectPath?: string }): void {
  try {
    writeFileSync(desktopStatePath(), `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', flag: 'w' })
  } catch {
    // Ignore desktop preference persistence failures.
  }
}

function getLastProjectPath(): string | '' {
  const saved = readDesktopState().lastProjectPath?.trim()
  if (!saved) return ''
  return existsSync(saved) ? saved : ''
}

function setLastProjectPath(projectPath: string | ''): void {
  if (projectPath) {
    writeDesktopState({ lastProjectPath: projectPath })
    return
  }
  writeDesktopState({})
}

function sessionStatePath(projectPath: string, sessionId: string): string {
  return join(projectPath, 'yolo', sessionId, 'session.json')
}

function turnReportsDirPath(projectPath: string, sessionId: string): string {
  return join(projectPath, 'yolo', sessionId, 'turns')
}

function eventsFilePath(projectPath: string, sessionId: string): string {
  return join(projectPath, 'yolo', sessionId, 'events.jsonl')
}

function exportsDirPath(projectPath: string, sessionId: string): string {
  return join(projectPath, 'yolo', sessionId, 'exports')
}

function branchTreeFilePath(projectPath: string, sessionId: string): string {
  return join(projectPath, 'yolo', sessionId, 'branches', 'tree.json')
}

function branchNodesDirPath(projectPath: string, sessionId: string): string {
  return join(projectPath, 'yolo', sessionId, 'branches', 'nodes')
}

function assetsDirPath(projectPath: string, sessionId: string): string {
  return join(projectPath, 'yolo', sessionId, 'assets')
}

function sessionMetaPath(projectPath: string): string {
  return join(projectPath, '.yolo-researcher', 'desktop-runtime.json')
}

function parseJsonFile<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function readSessionStateFromDisk(projectPath: string, sessionId: string): SessionPersistedState | null {
  return parseJsonFile<SessionPersistedState>(sessionStatePath(projectPath, sessionId))
}

function readSessionMeta(projectPath: string): DesktopSessionMeta | null {
  return parseJsonFile<DesktopSessionMeta>(sessionMetaPath(projectPath))
}

function writeSessionMeta(projectPath: string, meta: DesktopSessionMeta): void {
  const metaDir = join(projectPath, '.yolo-researcher')
  if (!existsSync(metaDir)) {
    mkdirSync(metaDir, { recursive: true })
  }
  writeFileSync(sessionMetaPath(projectPath), `${JSON.stringify(meta, null, 2)}\n`, {
    encoding: 'utf-8',
    flag: 'w'
  })
}

async function closeProjectState(
  win: BrowserWindow,
  state: WindowRuntimeState,
  notifyRenderer: boolean,
  clearDesktopPreference: boolean
): Promise<void> {
  await stopSessionIfNeeded(state)
  clearWindowState(state)
  if (clearDesktopPreference) {
    setLastProjectPath('')
  }
  if (notifyRenderer) {
    safeSend(win, 'project:closed')
  }
}

function loadOrCreateSessionId(projectPath: string): string {
  const metaDir = join(projectPath, '.yolo-researcher')
  const sessionFile = join(metaDir, 'desktop-session-id.txt')
  if (!existsSync(metaDir)) {
    mkdirSync(metaDir, { recursive: true })
  }
  if (existsSync(sessionFile)) {
    const saved = readFileSync(sessionFile, 'utf-8').trim()
    if (saved) return saved
  }
  const sid = crypto.randomUUID()
  persistSessionId(projectPath, sid)
  return sid
}

function persistSessionId(projectPath: string, sessionId: string): void {
  const metaDir = join(projectPath, '.yolo-researcher')
  const sessionFile = join(metaDir, 'desktop-session-id.txt')
  if (!existsSync(metaDir)) {
    mkdirSync(metaDir, { recursive: true })
  }
  writeFileSync(sessionFile, `${sessionId}\n`, { encoding: 'utf-8', flag: 'w' })
}

async function pickProjectFolder(win: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  return result.filePaths[0]
}

function loadTurnReportsFromDisk(projectPath: string, sessionId: string): TurnReport[] {
  const turnsDir = turnReportsDirPath(projectPath, sessionId)
  if (!existsSync(turnsDir)) return []

  const names = readdirSync(turnsDir)
    .filter((name) => /^\d+\.report\.json$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))

  const reports: TurnReport[] = []
  for (const name of names) {
    const parsed = parseJsonFile<TurnReport>(join(turnsDir, name))
    if (parsed) reports.push(parsed)
  }
  return reports
}

function loadBranchSnapshotFromDisk(projectPath: string, sessionId: string): BranchSnapshot | null {
  const tree = parseJsonFile<BranchTreeFile>(branchTreeFilePath(projectPath, sessionId))
  if (!tree) return null

  const nodesDir = branchNodesDirPath(projectPath, sessionId)
  if (!existsSync(nodesDir)) {
    return {
      activeBranchId: tree.activeBranchId,
      activeNodeId: tree.activeNodeId,
      rootNodeId: tree.rootNodeId,
      nodes: []
    }
  }

  const nodeMap = new Map<string, BranchNode>()
  const names = readdirSync(nodesDir).filter((name) => name.endsWith('.json'))
  for (const name of names) {
    const node = parseJsonFile<BranchNode>(join(nodesDir, name))
    if (node) nodeMap.set(node.nodeId, node)
  }

  const nodes: BranchNode[] = []
  for (const nodeId of tree.nodeIds) {
    const node = nodeMap.get(nodeId)
    if (node) nodes.push(node)
  }

  return {
    activeBranchId: tree.activeBranchId,
    activeNodeId: tree.activeNodeId,
    rootNodeId: tree.rootNodeId,
    nodes
  }
}

function loadAssetsFromDisk(projectPath: string, sessionId: string): AssetRecord[] {
  const assetsDir = assetsDirPath(projectPath, sessionId)
  if (!existsSync(assetsDir)) return []

  const names = readdirSync(assetsDir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort((a, b) => a.localeCompare(b))

  const assets: AssetRecord[] = []
  for (const name of names) {
    const parsed = parseJsonFile<AssetRecord>(join(assetsDir, name))
    if (parsed) assets.push(parsed)
  }
  return assets
}

function loadRecentEventsFromDisk(
  projectPath: string,
  sessionId: string,
  limit: number = 120
): Array<Record<string, unknown>> {
  const eventsPath = eventsFilePath(projectPath, sessionId)
  if (!existsSync(eventsPath)) return []

  const raw = readFileSync(eventsPath, 'utf-8')
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit)

  const events: Array<Record<string, unknown>> = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        eventType?: string
        timestamp?: string
        turnNumber?: number
        payload?: Record<string, unknown>
      }
      const payload = parsed.payload ?? {}
      events.push({
        type: parsed.eventType ?? 'event',
        timestamp: parsed.timestamp,
        turn: parsed.turnNumber,
        ...payload
      })
    } catch {
      // Ignore malformed log rows.
    }
  }
  return events.reverse()
}

function loadRuntimeStatusFromDisk(
  projectPath: string,
  sessionId: string
): {
  lease?: Record<string, unknown>
  latestCheckpoint?: Record<string, unknown>
  checkpointCount: number
} {
  const runtimeDir = join(projectPath, 'yolo', sessionId, 'runtime')
  const lease = parseJsonFile<Record<string, unknown>>(join(runtimeDir, 'lease.json')) ?? undefined
  const checkpointsDir = join(runtimeDir, 'checkpoints')
  const latestCheckpoint = parseJsonFile<Record<string, unknown>>(join(checkpointsDir, 'latest.json')) ?? undefined

  let checkpointCount = 0
  if (existsSync(checkpointsDir)) {
    checkpointCount = readdirSync(checkpointsDir)
      .filter((name) => name.endsWith('.json') && name !== 'latest.json')
      .length
  }

  return {
    lease,
    latestCheckpoint,
    checkpointCount
  }
}

function buildSessionSummary(input: {
  snapshot: SessionPersistedState
  turnReports: TurnReport[]
  assets: AssetRecord[]
  branchSnapshot: BranchSnapshot | null
  recentEvents: Array<Record<string, unknown>>
}): Record<string, unknown> {
  const countIdsInRiskNote = (riskDelta: string[] | undefined, prefix: string): number => {
    if (!Array.isArray(riskDelta)) return 0
    const matched = riskDelta.find((note) => typeof note === 'string' && note.startsWith(prefix))
    if (!matched) return 0
    const idx = matched.indexOf(':')
    if (idx === -1) return 0
    return matched
      .slice(idx + 1)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .length
  }

  const { snapshot, turnReports, assets, branchSnapshot, recentEvents } = input
  const turns = turnReports.length
  const assetsCreated = turnReports.reduce((sum, turn) => sum + (turn.assetDiff?.created?.length ?? 0), 0)
  const nonProgressTurns = turnReports.filter((turn) => turn.nonProgress).length
  const lastTurn = turnReports[turnReports.length - 1]
  const latestReproducibility = lastTurn?.gateImpact?.snapshotManifest?.reproducibility
  const latestEvidencePolicy = lastTurn?.gateImpact?.snapshotManifest?.evidencePolicy
  const latestCausality = lastTurn?.gateImpact?.snapshotManifest?.causality
  const latestClaimDecisionBinding = lastTurn?.gateImpact?.snapshotManifest?.claimDecisionBinding
  const latestDirectEvidence = lastTurn?.gateImpact?.snapshotManifest?.directEvidence
  const latestClaimEvidenceTable = assets
    .filter((asset) => asset.type === 'ClaimEvidenceTable')
    .sort((a, b) => a.createdByTurn - b.createdByTurn || a.id.localeCompare(b.id))
    .at(-1)
  const latestReadiness = lastTurn?.readinessSnapshot
  const latestReviewerSnapshot = lastTurn?.reviewerSnapshot
  const crossBranchDefaultedCount = countIdsInRiskNote(
    lastTurn?.riskDelta,
    'cross-branch evidence defaulted to cite_only'
  )
  const crossBranchAutoUpgradedCount = countIdsInRiskNote(
    lastTurn?.riskDelta,
    'cross-branch evidence auto-upgraded to countable'
  )
  const overrideDecisions = assets
    .filter((asset) => asset.type === 'Decision')
    .map((asset) => {
      const payload = asset.payload as Record<string, unknown>
      return {
        id: asset.id,
        kind: payload.kind,
        targetNodeId: payload.targetNodeId,
        rationale: payload.rationale,
        riskAccepted: payload.riskAccepted,
        recordedAt: payload.recordedAt
      }
    })
    .filter((item) => item.kind === 'override')
  const claimFreezeDecisions = assets
    .filter((asset) => asset.type === 'Decision')
    .map((asset) => {
      const payload = asset.payload as Record<string, unknown>
      return {
        id: asset.id,
        kind: payload.kind,
        checkpoint: payload.checkpoint,
        choice: payload.choice ?? payload.responseText,
        rationale: payload.rationale,
        recordedAt: payload.recordedAt ?? payload.madeAt
      }
    })
    .filter((item) => item.kind === 'claim-freeze' || item.checkpoint === 'claim-freeze')
  const invalidatedNodes = (branchSnapshot?.nodes ?? [])
    .filter((node) => node.status === 'invalidated')
    .map((node) => ({
      nodeId: node.nodeId,
      branchId: node.branchId,
      stage: node.stage,
      summary: node.summary,
      createdByTurn: node.createdByTurn
    }))
  const maintenanceAlerts = recentEvents
    .filter((event) => event.type === 'maintenance_alert')
    .map((event) => ({
      timestamp: event.timestamp,
      kind: event.kind,
      severity: event.severity,
      message: event.message
    }))

  return {
    sessionId: snapshot.sessionId,
    goal: snapshot.goal,
    phase: snapshot.phase,
    state: snapshot.state,
    currentTurn: snapshot.currentTurn,
    activeStage: snapshot.activeStage,
    budgetUsed: snapshot.budgetUsed,
    stats: {
      turns,
      assetsCreated,
      nonProgressTurns
    },
    governance: {
      overrideDecisions: {
        count: overrideDecisions.length,
        items: overrideDecisions
      },
      claimFreezeDecisions: {
        count: claimFreezeDecisions.length,
        items: claimFreezeDecisions
      },
      invalidatedNodes: {
        count: invalidatedNodes.length,
        items: invalidatedNodes
      },
      maintenanceAlerts: {
        count: maintenanceAlerts.length,
        items: maintenanceAlerts
      },
      readiness: latestReadiness
        ? {
            phase: latestReadiness.phase,
            stage: latestReadiness.stage,
            pass: latestReadiness.pass,
            requiredFailed: latestReadiness.requiredFailed ?? []
          }
        : null,
      semanticReview: latestReviewerSnapshot
        ? {
            status: latestReviewerSnapshot.status,
            reviewerCount: latestReviewerSnapshot.status === 'completed'
              ? latestReviewerSnapshot.reviewerPasses.length
              : 0,
            consensusBlockers: latestReviewerSnapshot.status === 'completed'
              ? latestReviewerSnapshot.consensusBlockers
              : [],
            notes: latestReviewerSnapshot.notes ?? []
          }
        : null,
      reproducibility: latestReproducibility
        ? {
            keyRunRecordCount: latestReproducibility.keyRunRecordCount ?? 0,
            keyRunRecordWithCompleteTripleCount: latestReproducibility.keyRunRecordWithCompleteTripleCount ?? 0,
            missingRunRecordRefs: latestReproducibility.missingRunRecordRefs ?? [],
            runRecordsMissingTriple: latestReproducibility.runRecordsMissingTriple ?? []
          }
        : null,
      evidencePolicyNormalization: {
        crossBranchDefaultedCount,
        crossBranchAutoUpgradedCount
      },
      evidencePolicy: latestEvidencePolicy
        ? {
            crossBranchCountableLinkIds: latestEvidencePolicy.crossBranchCountableLinkIds ?? [],
            keyRunMissingParityContractLinkIds: latestEvidencePolicy.keyRunMissingParityContractLinkIds ?? [],
            invalidCountableLinkIds: latestEvidencePolicy.invalidCountableLinkIds ?? []
          }
        : null,
      causality: latestCausality
        ? {
            requiredClaims: latestCausality.requiredClaims ?? 0,
            satisfiedClaims: latestCausality.satisfiedClaims ?? 0,
            interventionLinkCount: latestCausality.interventionLinkCount ?? 0,
            counterfactualLinkCount: latestCausality.counterfactualLinkCount ?? 0,
            correlationOnlyLinkCount: latestCausality.correlationOnlyLinkCount ?? 0,
            missingClaimIds: latestCausality.missingClaimIds ?? []
          }
        : null,
      claimDecisionBinding: latestClaimDecisionBinding
        ? {
            assertedClaimCount: latestClaimDecisionBinding.assertedClaimCount ?? 0,
            assertedClaimWithFreezeRefCount: latestClaimDecisionBinding.assertedClaimWithFreezeRefCount ?? 0,
            missingFreezeRefClaimIds: latestClaimDecisionBinding.missingFreezeRefClaimIds ?? []
          }
        : null,
      directEvidence: latestDirectEvidence
        ? {
            requiredClaims: latestDirectEvidence.requiredClaims ?? 0,
            satisfiedClaims: latestDirectEvidence.satisfiedClaims ?? 0,
            missingClaimIds: latestDirectEvidence.missingClaimIds ?? []
          }
        : null,
      claimEvidenceTable: latestClaimEvidenceTable
        ? {
            assetId: latestClaimEvidenceTable.id,
            createdByTurn: latestClaimEvidenceTable.createdByTurn,
            sourceManifestId: (latestClaimEvidenceTable.payload as Record<string, unknown>).sourceManifestId ?? null,
            coverage: (latestClaimEvidenceTable.payload as Record<string, unknown>).coverage ?? null,
            completeness: (latestClaimEvidenceTable.payload as Record<string, unknown>).completeness ?? null,
            rowCount: Array.isArray((latestClaimEvidenceTable.payload as Record<string, unknown>).rows)
              ? ((latestClaimEvidenceTable.payload as Record<string, unknown>).rows as unknown[]).length
              : 0
          }
        : null
    },
    lastTurn: lastTurn
      ? {
          turnNumber: lastTurn.turnNumber,
          stage: lastTurn.turnSpec?.stage,
          objective: lastTurn.turnSpec?.objective,
          summary: lastTurn.summary,
          gateStatus: lastTurn.gateImpact?.status ?? 'none'
        }
      : null
  }
}

function exportSessionSummaryToDisk(
  projectPath: string,
  snapshot: SessionPersistedState,
  turnReports: TurnReport[]
): string {
  const dir = exportsDirPath(projectPath, snapshot.sessionId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputPath = join(dir, `session-summary-${stamp}.json`)
  const assets = loadAssetsFromDisk(projectPath, snapshot.sessionId)
  const branchSnapshot = loadBranchSnapshotFromDisk(projectPath, snapshot.sessionId)
  const recentEvents = loadRecentEventsFromDisk(projectPath, snapshot.sessionId, 600)
  const summary = buildSessionSummary({
    snapshot,
    turnReports,
    assets,
    branchSnapshot,
    recentEvents
  })
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf-8', flag: 'w' })
  return outputPath
}

function exportClaimEvidenceTableToDisk(
  projectPath: string,
  snapshot: SessionPersistedState,
  assets: AssetRecord[]
): string {
  const dir = exportsDirPath(projectPath, snapshot.sessionId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputPath = join(dir, `claim-evidence-table-${stamp}.json`)
  const table = buildClaimEvidenceTableExport(snapshot, assets)
  writeFileSync(outputPath, `${JSON.stringify(table, null, 2)}\n`, { encoding: 'utf-8', flag: 'w' })
  return outputPath
}

function exportAssetInventoryToDisk(
  projectPath: string,
  snapshot: SessionPersistedState,
  assets: AssetRecord[]
): string {
  const dir = exportsDirPath(projectPath, snapshot.sessionId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const inventory = buildAssetInventoryExport(snapshot, assets)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputPath = join(dir, `asset-inventory-${stamp}.json`)
  writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, { encoding: 'utf-8', flag: 'w' })
  return outputPath
}

function exportFinalBundleToDisk(
  projectPath: string,
  snapshot: SessionPersistedState,
  turnReports: TurnReport[],
  assets: AssetRecord[]
): { manifestPath: string; summaryPath: string; claimEvidenceTablePath: string; assetInventoryPath: string } {
  const summaryPath = exportSessionSummaryToDisk(projectPath, snapshot, turnReports)
  const claimEvidenceTablePath = exportClaimEvidenceTableToDisk(projectPath, snapshot, assets)
  const assetInventoryPath = exportAssetInventoryToDisk(projectPath, snapshot, assets)
  const dir = exportsDirPath(projectPath, snapshot.sessionId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const manifestPath = join(dir, `final-bundle-${stamp}.manifest.json`)
  const manifest = buildFinalBundleManifest(snapshot, {
    sessionSummary: summaryPath,
    claimEvidenceTable: claimEvidenceTablePath,
    assetInventory: assetInventoryPath
  })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf-8', flag: 'w' })
  return { manifestPath, summaryPath, claimEvidenceTablePath, assetInventoryPath }
}

function uniqueDestinationPath(targetDir: string, sourcePath: string): string {
  const sourceName = basename(sourcePath)
  const parsed = parse(sourceName)
  let suffix = 0

  while (true) {
    const candidateName = suffix === 0
      ? sourceName
      : `${parsed.name}-${suffix}${parsed.ext}`
    const candidatePath = join(targetDir, candidateName)
    if (!existsSync(candidatePath)) return candidatePath
    suffix += 1
  }
}

function buildFallbackOptions(snapshot: SessionPersistedState): YoloSessionOptions {
  return {
    phase: snapshot.phase,
    budget: {
      maxTurns: Math.max(snapshot.currentTurn + 10, snapshot.budgetUsed.turns + 10),
      maxTokens: Math.max(snapshot.budgetUsed.tokens + 120_000, 120_000),
      maxCostUsd: Math.max(Math.ceil(snapshot.budgetUsed.costUsd + 12), 12)
    },
    models: {
      planner: 'gpt-5.2',
      coordinator: 'gpt-5.2'
    }
  }
}

async function restoreSessionFromDisk(
  win: BrowserWindow,
  state: WindowRuntimeState,
  projectPath: string
): Promise<boolean> {
  const sessionId = loadOrCreateSessionId(projectPath)
  const persisted = readSessionStateFromDisk(projectPath, sessionId)
  if (!persisted) return false

  const savedMeta = readSessionMeta(projectPath)
  const restoredGoal = savedMeta?.goal ?? persisted.goal
  const restoredOptions = savedMeta?.options ?? buildFallbackOptions(persisted)

  state.yoloSession = createYoloSession({
    projectPath,
    sessionId,
    goal: restoredGoal,
    options: restoredOptions,
    plannerConfig: {}
  })
  state.sessionOptions = restoredOptions
  await state.yoloSession.init()

  let snapshot = await state.yoloSession.getSnapshot()
  if (snapshot.state === 'PLANNING' || snapshot.state === 'EXECUTING') {
    await state.yoloSession.recoverFromCrash()
    snapshot = await state.yoloSession.getSnapshot()
  }

  state.yoloTurnReports = loadTurnReportsFromDisk(projectPath, sessionId)
  state.pauseRequested = false
  state.lastBroadcastState = undefined

  await pushStateWithEvent(win, state, state.yoloSession, 'session_restored')
  pushQuestionIfAny(win, snapshot)
  safeSend(win, 'yolo:event', {
    type: 'session_restored',
    sessionId,
    turn: snapshot.currentTurn,
    state: snapshot.state,
    reports: state.yoloTurnReports.length
  })

  return true
}

function isTerminalOrBlocked(state: SessionPersistedState['state']): boolean {
  return state === 'WAITING_FOR_USER'
    || state === 'WAITING_EXTERNAL'
    || state === 'PAUSED'
    || state === 'STOPPED'
    || state === 'COMPLETE'
    || state === 'FAILED'
}

function isSessionTerminal(state: SessionPersistedState['state']): boolean {
  return state === 'STOPPED' || state === 'COMPLETE' || state === 'FAILED'
}

async function pushState(
  win: BrowserWindow,
  state: WindowRuntimeState,
  session: ReturnType<typeof createYoloSession>
): Promise<SessionPersistedState> {
  const snapshot = await session.getSnapshot()
  const runtimeStatus = state.projectPath
    ? loadRuntimeStatusFromDisk(state.projectPath, snapshot.sessionId)
    : { checkpointCount: 0 }
  safeSend(win, 'yolo:state', {
    ...snapshot,
    budgetCaps: state.sessionOptions?.budget,
    runtimeStatus
  })
  return snapshot
}

async function pushStateWithEvent(
  win: BrowserWindow,
  state: WindowRuntimeState,
  session: ReturnType<typeof createYoloSession>,
  reason: string
): Promise<SessionPersistedState> {
  const snapshot = await pushState(win, state, session)
  if (state.lastBroadcastState !== snapshot.state) {
    safeSend(win, 'yolo:event', {
      type: 'state_changed',
      from: state.lastBroadcastState ?? null,
      to: snapshot.state,
      reason,
      turn: snapshot.currentTurn
    })
    state.lastBroadcastState = snapshot.state
  }
  return snapshot
}

function pushQuestionIfAny(win: BrowserWindow, snapshot: SessionPersistedState): void {
  if (snapshot.pendingQuestion) {
    safeSend(win, 'yolo:question', snapshot.pendingQuestion)
  }
}

async function runYoloLoop(win: BrowserWindow, state: WindowRuntimeState): Promise<void> {
  if (state.loopRunning) return
  if (!state.yoloSession) return

  state.loopRunning = true
  state.stopRequested = false
  try {
    while (state.yoloSession) {
      // Check stop request at the top of each iteration
      if (state.stopRequested) {
        state.stopRequested = false
        break
      }

      const currentSnapshot = await pushStateWithEvent(win, state, state.yoloSession, 'loop_iter')
      pushQuestionIfAny(win, currentSnapshot)

      if (isTerminalOrBlocked(currentSnapshot.state)) break

      safeSend(win, 'yolo:event', {
        type: 'turn_planning',
        turn: currentSnapshot.currentTurn + 1,
        stage: currentSnapshot.activeStage
      })

      const result = await state.yoloSession.executeNextTurn()

      // Check stop request immediately after turn completes — discard result and exit
      if (state.stopRequested) {
        state.stopRequested = false
        safeSend(win, 'yolo:event', { type: 'loop_stopped', message: 'Stop requested — current turn discarded' })
        if (state.yoloSession) await pushStateWithEvent(win, state, state.yoloSession, 'stop_after_turn')
        break
      }

      state.yoloTurnReports.push(result.turnReport)
      safeSend(win, 'yolo:turn-report', result.turnReport)
      safeSend(win, 'yolo:event', {
        type: 'turn_committed',
        turn: result.turnReport.turnNumber,
        stage: result.turnReport.turnSpec?.stage,
        objective: result.turnReport.turnSpec?.objective,
        gateStatus: result.turnReport.gateImpact?.status ?? 'none',
        assetsCreated: result.turnReport.assetDiff?.created?.length ?? 0,
        turnTokens: result.turnReport.consumedBudgets?.turnTokens ?? 0,
        turnCostUsd: result.turnReport.consumedBudgets?.turnCostUsd ?? 0
      })

      const afterTurn = await pushStateWithEvent(win, state, state.yoloSession, 'turn_complete')
      pushQuestionIfAny(win, afterTurn)
      if (afterTurn.state === 'COMPLETE') {
        const assets = loadAssetsFromDisk(state.projectPath, afterTurn.sessionId)
        const bundle = exportFinalBundleToDisk(state.projectPath, afterTurn, state.yoloTurnReports, assets)
        safeSend(win, 'yolo:event', {
          type: 'final_bundle_exported',
          path: bundle.manifestPath,
          turn: afterTurn.currentTurn,
          auto: true
        })
      }

      if (state.pauseRequested || state.stopRequested) {
        if (state.stopRequested) {
          state.stopRequested = false
          break
        }
        await state.yoloSession.pause()
        state.pauseRequested = false
        await pushStateWithEvent(win, state, state.yoloSession, 'pause_requested')
        break
      }

      if (afterTurn.state !== 'TURN_COMPLETE') break
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    safeSend(win, 'yolo:event', { type: 'loop_error', message })
    if (state.yoloSession) await pushStateWithEvent(win, state, state.yoloSession, 'loop_error')
  } finally {
    state.loopRunning = false
    state.stopRequested = false
  }
}

export function registerWindow(win: BrowserWindow): void {
  const state = getWindowState(win)
  win.on('closed', () => {
    void stopSessionIfNeeded(state)
    clearWindowState(state)
    windowStates.delete(win.id)
  })
}

export async function closeProjectForWindow(win: BrowserWindow): Promise<void> {
  const state = getWindowState(win)
  await closeProjectState(win, state, true, true)
}

export function registerIpcHandlers(): void {
  if (ipcHandlersRegistered) return
  ipcHandlersRegistered = true

  const handleWindow = <T extends unknown[], R>(
    channel: string,
    handler: (ctx: { win: BrowserWindow; state: WindowRuntimeState }, ...args: T) => Promise<R> | R
  ) => {
    ipcMain.handle(channel, (event, ...args) => handler(getWindowContext(event), ...(args as T)))
  }

  handleWindow('session:current', async ({ win, state }) => {
    if (!state.projectPath) {
      const remembered = getLastProjectPath()
      if (remembered) {
        state.projectPath = remembered
        try {
          await restoreSessionFromDisk(win, state, remembered)
        } catch {
          // Ignore restore failures and let user start/select again.
        }
      }
    }

    return {
      projectPath: state.projectPath,
      sessionId: state.projectPath ? loadOrCreateSessionId(state.projectPath) : ''
    }
  })

  handleWindow('project:pick-folder', async ({ win, state }) => {
    const picked = await pickProjectFolder(win)
    if (!picked) return null

    await closeProjectState(win, state, false, false)

    const metaDir = join(picked, '.yolo-researcher')
    if (!existsSync(metaDir)) {
      mkdirSync(metaDir, { recursive: true })
      writeFileSync(join(metaDir, '.keep'), '', { flag: 'a' })
    }

    state.projectPath = picked
    setLastProjectPath(picked)
    try {
      await restoreSessionFromDisk(win, state, picked)
    } catch {
      // Ignore restore failures and start from clean project selection.
    }

    return {
      projectPath: picked,
      sessionId: loadOrCreateSessionId(picked)
    }
  })

  handleWindow('project:close', async ({ win, state }) => {
    await closeProjectState(win, state, true, true)
  })

  handleWindow('yolo:start', async ({ win, state }, goal: string, options: YoloSessionOptions) => {
    if (!state.projectPath) {
      throw new Error('No project folder selected.')
    }
    if (!goal?.trim()) {
      throw new Error('Goal is required.')
    }

    const trimmedGoal = goal.trim()
    let sessionId = loadOrCreateSessionId(state.projectPath)

    if (state.yoloSession) {
      const current = await state.yoloSession.getSnapshot()
      if (
        current.goal !== trimmedGoal
        || isSessionTerminal(current.state)
        || state.sessionOptions?.phase !== options.phase
      ) {
        await stopSessionIfNeeded(state)
        sessionId = crypto.randomUUID()
        persistSessionId(state.projectPath, sessionId)
        state.yoloSession = null
        state.yoloTurnReports = []
      } else {
        writeSessionMeta(state.projectPath, {
          sessionId,
          goal: trimmedGoal,
          options,
          updatedAt: new Date().toISOString()
        })
        state.sessionOptions = options
        state.pauseRequested = false
        await pushStateWithEvent(win, state, state.yoloSession, 'session_continue')
        void runYoloLoop(win, state)
        return state.yoloSession.getSnapshot()
      }
    }

    writeSessionMeta(state.projectPath, {
      sessionId,
      goal: trimmedGoal,
      options,
      updatedAt: new Date().toISOString()
    })

    state.yoloSession = createYoloSession({
      projectPath: state.projectPath,
      goal: trimmedGoal,
      options,
      sessionId,
      plannerConfig: {}
    })
    state.sessionOptions = options
    state.yoloTurnReports = loadTurnReportsFromDisk(state.projectPath, sessionId)
    state.pauseRequested = false
    state.lastBroadcastState = undefined

    await state.yoloSession.init()
    await pushStateWithEvent(win, state, state.yoloSession, 'session_started')
    safeSend(win, 'yolo:event', {
      type: 'session_started',
      goal: trimmedGoal,
      phase: options.phase
    })

    void runYoloLoop(win, state)
    return state.yoloSession.getSnapshot()
  })

  handleWindow('yolo:pause', async ({ win, state }, payload?: { immediate?: boolean }) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')

    if (payload?.immediate || !state.loopRunning) {
      await state.yoloSession.pause()
      state.pauseRequested = false
      return pushStateWithEvent(win, state, state.yoloSession, 'pause_immediate')
    }

    state.pauseRequested = true
    safeSend(win, 'yolo:event', { type: 'pause_requested' })
    return state.yoloSession.getSnapshot()
  })

  handleWindow('yolo:resume', async ({ win, state }) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')

    state.pauseRequested = false
    await state.yoloSession.resume()
    await pushStateWithEvent(win, state, state.yoloSession, 'resume')
    void runYoloLoop(win, state)
    return state.yoloSession.getSnapshot()
  })

  handleWindow('yolo:stop', async ({ win, state }) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')

    state.pauseRequested = false
    state.stopRequested = true
    await state.yoloSession.stop()
    await pushStateWithEvent(win, state, state.yoloSession, 'stop')
    return state.yoloSession.getSnapshot()
  })

  handleWindow('yolo:enqueue-input', async ({ win, state }, text: string, priority?: 'urgent' | 'normal') => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    if (!text?.trim()) throw new Error('Input text is empty.')
    const trimmedText = text.trim()

    const snapshotBeforeEnqueue = await state.yoloSession.getSnapshot()
    if (snapshotBeforeEnqueue.state === 'WAITING_FOR_USER' && snapshotBeforeEnqueue.pendingResourceExtension) {
      const normalized = trimmedText.toLowerCase()
      const approved = normalized.startsWith('approve') || normalized.startsWith('yes')
      const rejected = normalized.startsWith('reject') || normalized.startsWith('no')
      if (!approved && !rejected) {
        throw new Error('Resource extension is pending. Reply with Approve/Reject or use dedicated controls.')
      }

      const result = await state.yoloSession.resolveResourceExtension({
        approved,
        note: trimmedText
      })
      if (approved && state.sessionOptions) {
        state.sessionOptions.budget = { ...result.budget }
      }
      await pushStateWithEvent(win, state, state.yoloSession, 'resource_extension_resolved')
      safeSend(win, 'yolo:event', {
        type: 'resource_extension_resolved',
        requestId: result.requestId,
        approved: result.approved,
        budget: result.budget
      })
      void runYoloLoop(win, state)
      return {
        id: result.decisionAssetId,
        text: trimmedText,
        priority: priority ?? 'urgent',
        source: 'chat'
      }
    }

    const item = state.yoloSession.enqueueInput(trimmedText, priority ?? 'normal', 'chat')
    safeSend(win, 'yolo:event', { type: 'input_enqueued', id: item.id, priority: item.priority })
    safeSend(win, 'yolo:event', {
      type: 'input_queue_changed',
      count: state.yoloSession.getQueuedInputs().length
    })

    const snapshot = await state.yoloSession.getSnapshot()
    if (snapshot.state === 'WAITING_FOR_USER') {
      const decisionAssetId = await state.yoloSession.recordCheckpointDecision(trimmedText)
      if (decisionAssetId) {
        safeSend(win, 'yolo:event', {
          type: 'checkpoint_confirmed',
          decisionAssetId
        })
      }
      await state.yoloSession.resume()
      await pushStateWithEvent(win, state, state.yoloSession, 'user_reply_resume')
      void runYoloLoop(win, state)
    }

    return item
  })

  handleWindow('yolo:get-input-queue', async ({ state }) => {
    if (!state.yoloSession) return []
    return state.yoloSession.getQueuedInputs()
  })

  handleWindow('yolo:queue-remove', async ({ win, state }, id: string) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const removed = state.yoloSession.removeQueuedInput(id)
    safeSend(win, 'yolo:event', {
      type: 'input_queue_changed',
      count: state.yoloSession.getQueuedInputs().length
    })
    return removed
  })

  handleWindow('yolo:queue-reprioritize', async ({ win, state }, id: string, priority: 'urgent' | 'normal') => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const updated = state.yoloSession.updateQueuedInputPriority(id, priority)
    safeSend(win, 'yolo:event', {
      type: 'input_queue_changed',
      count: state.yoloSession.getQueuedInputs().length
    })
    return updated
  })

  handleWindow('yolo:queue-move', async ({ win, state }, id: string, toIndex: number) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const queue = state.yoloSession.moveQueuedInput(id, toIndex)
    safeSend(win, 'yolo:event', {
      type: 'input_queue_changed',
      count: queue.length
    })
    return queue
  })

  handleWindow('yolo:get-snapshot', async ({ state }) => {
    if (!state.yoloSession) return null
    const snapshot = await state.yoloSession.getSnapshot()
    return {
      ...snapshot,
      budgetCaps: state.sessionOptions?.budget,
      runtimeStatus: state.projectPath
        ? loadRuntimeStatusFromDisk(state.projectPath, snapshot.sessionId)
        : { checkpointCount: 0 }
    }
  })

  handleWindow('yolo:restore-checkpoint', async ({ win, state }) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const restored = await state.yoloSession.restoreFromLatestCheckpoint()
    const snapshot = await pushStateWithEvent(win, state, state.yoloSession, restored ? 'restore_checkpoint' : 'restore_checkpoint_noop')
    safeSend(win, 'yolo:event', {
      type: 'checkpoint_restored',
      restored,
      turn: snapshot.currentTurn,
      state: snapshot.state
    })
    if (restored && snapshot.state === 'PLANNING') {
      void runYoloLoop(win, state)
    }
    return {
      restored,
      snapshot
    }
  })

  handleWindow('yolo:get-turn-reports', ({ state }) => {
    return [...state.yoloTurnReports]
  })

  handleWindow('yolo:get-events', async ({ state }) => {
    if (!state.yoloSession) return []
    const snapshot = await state.yoloSession.getSnapshot()
    return loadRecentEventsFromDisk(state.projectPath, snapshot.sessionId)
  })

  handleWindow('yolo:get-branch-snapshot', async ({ state }) => {
    if (!state.yoloSession) return null
    const snapshot = await state.yoloSession.getSnapshot()
    return loadBranchSnapshotFromDisk(state.projectPath, snapshot.sessionId)
  })

  handleWindow('yolo:get-assets', async ({ state }) => {
    if (!state.yoloSession) return []
    const snapshot = await state.yoloSession.getSnapshot()
    return loadAssetsFromDisk(state.projectPath, snapshot.sessionId)
  })

  handleWindow('yolo:wait-external', async (
    { win, state },
    payload: { title: string; completionRule: string; resumeAction: string; details?: string }
  ): Promise<ExternalWaitTask> => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const task = await state.yoloSession.requestExternalWait(payload)
    await pushStateWithEvent(win, state, state.yoloSession, 'wait_external_requested')
    safeSend(win, 'yolo:event', {
      type: 'wait_external_requested',
      id: task.id,
      title: task.title
    })
    return task
  })

  handleWindow('yolo:request-fulltext-wait', async (
    { win, state },
    payload: { citation: string; requiredFiles?: string[]; reason?: string }
  ): Promise<ExternalWaitTask> => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const task = await state.yoloSession.requestFullTextUploadWait(payload)
    const snapshot = await pushStateWithEvent(win, state, state.yoloSession, 'fulltext_wait_requested')
    pushQuestionIfAny(win, snapshot)
    safeSend(win, 'yolo:event', {
      type: 'fulltext_wait_requested',
      id: task.id,
      citation: payload.citation
    })
    return task
  })

  handleWindow('yolo:cancel-wait-task', async (
    { win, state },
    payload: { taskId: string; reason: string }
  ): Promise<ExternalWaitTask> => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const task = await state.yoloSession.cancelExternalWaitTask(payload.taskId, payload.reason)
    const snapshot = await pushStateWithEvent(win, state, state.yoloSession, 'wait_external_cancelled')
    safeSend(win, 'yolo:event', {
      type: 'wait_external_cancelled',
      id: task.id,
      state: snapshot.state
    })
    if (snapshot.state === 'PLANNING') {
      void runYoloLoop(win, state)
    }
    return task
  })

  handleWindow('yolo:request-resource-extension', async (
    { win, state },
    payload: {
      rationale: string
      delta: { maxTurns?: number; maxTokens?: number; maxCostUsd?: number }
      requestedBy?: 'user' | 'agent'
    }
  ) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const request = await state.yoloSession.requestResourceExtension(payload)
    await pushStateWithEvent(win, state, state.yoloSession, 'resource_extension_requested')
    safeSend(win, 'yolo:event', {
      type: 'resource_extension_requested',
      requestId: request.id,
      delta: request.delta
    })
    return request
  })

  handleWindow('yolo:resolve-resource-extension', async (
    { win, state },
    payload: { approved: boolean; note?: string }
  ) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const result = await state.yoloSession.resolveResourceExtension(payload)
    if (result.approved && state.sessionOptions) {
      state.sessionOptions.budget = { ...result.budget }
    }
    const snapshot = await pushStateWithEvent(win, state, state.yoloSession, 'resource_extension_resolved')
    safeSend(win, 'yolo:event', {
      type: 'resource_extension_resolved',
      requestId: result.requestId,
      approved: result.approved,
      budget: result.budget
    })
    if (snapshot.state === 'PLANNING') {
      void runYoloLoop(win, state)
    }
    return result
  })

  handleWindow('yolo:record-override-decision', async (
    { win, state },
    payload: { targetNodeId: string; rationale: string; riskAccepted?: string }
  ) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const decisionAssetId = await state.yoloSession.recordOverrideDecision(payload)
    await pushStateWithEvent(win, state, state.yoloSession, 'override_decision_recorded')
    safeSend(win, 'yolo:event', {
      type: 'override_decision_recorded',
      decisionAssetId,
      targetNodeId: payload.targetNodeId
    })
    return { decisionAssetId }
  })

  handleWindow('yolo:list-wait-tasks', async ({ state }) => {
    if (!state.yoloSession) return []
    return state.yoloSession.listExternalWaitTasks()
  })

  handleWindow('yolo:validate-wait-task', async (
    { state },
    payload: { taskId: string }
  ) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    return state.yoloSession.validateExternalWaitTask(payload.taskId)
  })

  handleWindow('yolo:add-ingress-files', async (
    { win, state },
    payload?: { taskId?: string; turnNumber?: number }
  ): Promise<AddIngressFilesResult> => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')

    let uploadDirAbs = ''
    let uploadDirRel = ''

    if (payload?.taskId?.trim()) {
      const taskId = payload.taskId.trim()
      const tasks = await state.yoloSession.listExternalWaitTasks()
      const task = tasks.find((item) => item.id === taskId)
      if (!task) throw new Error(`Wait task not found: ${taskId}`)

      if (!task.uploadDir) {
        uploadDirAbs = await state.yoloSession.ensureIngressUploadDir(payload.turnNumber)
        uploadDirRel = relative(state.yoloSession.sessionDir, uploadDirAbs)
      } else {
        uploadDirRel = task.uploadDir
        uploadDirAbs = join(state.yoloSession.sessionDir, task.uploadDir)
      }
    } else {
      uploadDirAbs = await state.yoloSession.ensureIngressUploadDir(payload?.turnNumber)
      uploadDirRel = relative(state.yoloSession.sessionDir, uploadDirAbs)
    }

    mkdirSync(uploadDirAbs, { recursive: true })

    const picked = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    })

    if (picked.canceled || picked.filePaths.length === 0) {
      return { uploadDir: uploadDirRel, files: [] }
    }

    const files: IngressAddedFile[] = []
    for (const sourcePath of picked.filePaths) {
      const destPath = uniqueDestinationPath(uploadDirAbs, sourcePath)
      copyFileSync(sourcePath, destPath)
      files.push({
        sourcePath,
        storedPath: relative(state.yoloSession.sessionDir, destPath),
        sizeBytes: statSync(destPath).size
      })
    }

    safeSend(win, 'yolo:event', {
      type: 'ingress_files_added',
      uploadDir: uploadDirRel,
      fileCount: files.length
    })

    return { uploadDir: uploadDirRel, files }
  })

  handleWindow('yolo:resolve-wait-task', async (
    { win, state },
    payload: { taskId: string; resolutionNote: string }
  ): Promise<ExternalWaitTask> => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const task = await state.yoloSession.resolveExternalWaitTask(payload.taskId, payload.resolutionNote)
    const snapshot = await pushStateWithEvent(win, state, state.yoloSession, 'wait_external_resolved')
    safeSend(win, 'yolo:event', {
      type: 'wait_external_resolved',
      id: task.id,
      state: snapshot.state
    })
    if (snapshot.state === 'PLANNING') {
      void runYoloLoop(win, state)
    }
    return task
  })

  handleWindow('yolo:export-summary', async ({ win, state }) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const snapshot = await state.yoloSession.getSnapshot()
    const outputPath = exportSessionSummaryToDisk(state.projectPath, snapshot, state.yoloTurnReports)
    safeSend(win, 'yolo:event', { type: 'summary_exported', path: outputPath, turn: snapshot.currentTurn })
    return { path: outputPath }
  })

  handleWindow('yolo:export-claim-evidence-table', async ({ win, state }) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const snapshot = await state.yoloSession.getSnapshot()
    const assets = loadAssetsFromDisk(state.projectPath, snapshot.sessionId)
    const outputPath = exportClaimEvidenceTableToDisk(state.projectPath, snapshot, assets)
    safeSend(win, 'yolo:event', { type: 'claim_evidence_table_exported', path: outputPath, turn: snapshot.currentTurn })
    return { path: outputPath }
  })

  handleWindow('yolo:export-asset-inventory', async ({ win, state }) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const snapshot = await state.yoloSession.getSnapshot()
    const assets = loadAssetsFromDisk(state.projectPath, snapshot.sessionId)
    const outputPath = exportAssetInventoryToDisk(state.projectPath, snapshot, assets)
    safeSend(win, 'yolo:event', { type: 'asset_inventory_exported', path: outputPath, turn: snapshot.currentTurn })
    return { path: outputPath }
  })

  handleWindow('yolo:export-final-bundle', async ({ win, state }) => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')
    const snapshot = await state.yoloSession.getSnapshot()
    const assets = loadAssetsFromDisk(state.projectPath, snapshot.sessionId)
    const bundle = exportFinalBundleToDisk(state.projectPath, snapshot, state.yoloTurnReports, assets)
    safeSend(win, 'yolo:event', {
      type: 'final_bundle_exported',
      path: bundle.manifestPath,
      turn: snapshot.currentTurn
    })
    return bundle
  })
}
