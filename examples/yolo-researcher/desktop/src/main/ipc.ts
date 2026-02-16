import crypto from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rename as fsRename } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

import {
  buildAssetInventoryExport,
  buildClaimEvidenceTableExport,
  buildFinalBundleManifest,
  createYoloSession,
  getLanguageModelByModelId,
  type AssetRecord,
  type BranchNode,
  type ExternalWaitTask,
  type SessionPersistedState,
  type TurnReport,
  type YoloSessionOptions
} from '@yolo-researcher/index'

interface DrawerChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

interface WindowRuntimeState {
  projectPath: string
  yoloSession: ReturnType<typeof createYoloSession> | null
  sessionOptions?: YoloSessionOptions
  yoloTurnReports: TurnReport[]
  loopRunning: boolean
  pauseRequested: boolean
  stopRequested: boolean
  lastBroadcastState?: SessionPersistedState['state']
  drawerChatHistory: DrawerChatMessage[]
  activeInteractionId: string | null
}

interface DrawerChatPersistedState {
  activeInteractionId: string | null
  chatHistory: DrawerChatMessage[]
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
    lastBroadcastState: undefined,
    drawerChatHistory: [],
    activeInteractionId: null
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
  state.drawerChatHistory = []
  state.activeInteractionId = null
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

function drawerChatStatePath(projectPath: string, sessionId: string): string {
  return join(projectPath, '.yolo-researcher', 'drawer-chat', `${sessionId}.json`)
}

function parseJsonFile<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function waitTaskFilePath(projectPath: string, sessionId: string, taskId: string): string {
  return join(projectPath, 'yolo', sessionId, 'wait-tasks', `${taskId}.json`)
}

function readDrawerChatPersistedState(projectPath: string, sessionId: string): DrawerChatPersistedState {
  const parsed = parseJsonFile<DrawerChatPersistedState>(drawerChatStatePath(projectPath, sessionId))
  if (!parsed) {
    return {
      activeInteractionId: null,
      chatHistory: []
    }
  }
  const chatHistory = Array.isArray(parsed.chatHistory)
    ? parsed.chatHistory
      .filter((item): item is DrawerChatMessage => Boolean(
        item
        && typeof item === 'object'
        && (item.role === 'user' || item.role === 'assistant')
        && typeof item.content === 'string'
        && typeof item.timestamp === 'string'
      ))
      .slice(-60)
    : []
  return {
    activeInteractionId: typeof parsed.activeInteractionId === 'string' ? parsed.activeInteractionId : null,
    chatHistory
  }
}

function writeDrawerChatPersistedState(
  projectPath: string,
  sessionId: string,
  value: DrawerChatPersistedState
): void {
  const dir = join(projectPath, '.yolo-researcher', 'drawer-chat')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(drawerChatStatePath(projectPath, sessionId), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf-8',
    flag: 'w'
  })
}

function hydrateDrawerStateFromDisk(
  runtimeState: WindowRuntimeState,
  projectPath: string,
  sessionId: string
): void {
  const persisted = readDrawerChatPersistedState(projectPath, sessionId)
  runtimeState.activeInteractionId = persisted.activeInteractionId
  runtimeState.drawerChatHistory = persisted.chatHistory
}

function persistDrawerStateToDisk(
  runtimeState: WindowRuntimeState,
  projectPath: string,
  sessionId: string
): void {
  writeDrawerChatPersistedState(projectPath, sessionId, {
    activeInteractionId: runtimeState.activeInteractionId,
    chatHistory: runtimeState.drawerChatHistory.slice(-60)
  })
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
    mode: 'legacy',
    budget: {
      maxTurns: Math.max(snapshot.currentTurn + 10, snapshot.budgetUsed.turns + 10),
      maxTokens: Math.max(snapshot.budgetUsed.tokens + 500_000, 500_000),
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
  const restoredOptions: YoloSessionOptions = {
    ...(savedMeta?.options ?? buildFallbackOptions(persisted)),
    mode: savedMeta?.options?.mode ?? 'legacy'
  }

  state.yoloSession = createYoloSession({
    projectPath,
    sessionId,
    goal: restoredGoal,
    options: restoredOptions,
    onActivity: (event) => safeSend(win, 'yolo:activity', event),
    plannerConfig: {},
    coordinatorConfig: {
      allowBash: restoredOptions.mode === 'lean_v2',
      enableLiteratureTools: restoredOptions.mode === 'lean_v2'
    }
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
  hydrateDrawerStateFromDisk(state, projectPath, sessionId)

  await pushStateWithEvent(win, state, state.yoloSession, 'session_restored')
  pushQuestionIfAny(win, snapshot, state)
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
  // STOPPED and CRASHED are terminal for the purpose of yolo:start — calling start
  // (not resume) on a stopped/crashed session should create a fresh session.
  // Resuming from STOPPED still works via the dedicated yolo:resume handler.
  return state === 'COMPLETE' || state === 'FAILED' || state === 'STOPPED' || state === 'CRASHED'
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
    mode: state.sessionOptions?.mode,
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

function pushQuestionIfAny(win: BrowserWindow, snapshot: SessionPersistedState, state?: WindowRuntimeState): void {
  if (snapshot.pendingQuestion) {
    safeSend(win, 'yolo:question', snapshot.pendingQuestion)
    // Also push drawer state if state is available
    if (state) {
      const assets = loadAssetsFromDisk(state.projectPath, snapshot.sessionId)
      pushDrawerState(win, state, snapshot, assets)
    }
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
      pushQuestionIfAny(win, currentSnapshot, state)

      if (isTerminalOrBlocked(currentSnapshot.state)) {
        const assets = loadAssetsFromDisk(state.projectPath, currentSnapshot.sessionId)
        pushDrawerState(win, state, currentSnapshot, assets)
        break
      }

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
      pushQuestionIfAny(win, afterTurn, state)
      if (isTerminalOrBlocked(afterTurn.state)) {
        const turnAssets = loadAssetsFromDisk(state.projectPath, afterTurn.sessionId)
        pushDrawerState(win, state, afterTurn, turnAssets)
      }
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

// ─── InteractionDrawer types (main-process local) ────────────────────

type InteractionKind =
  | 'experiment_request'
  | 'fulltext_upload'
  | 'gate_blocker'
  | 'checkpoint_decision'
  | 'resource_extension'
  | 'general_question'
  | 'failure_recovery'

interface InteractionContextSection {
  label: string
  content: string
  collapsible?: boolean
}

interface InteractionAction {
  id: string
  label: string
  variant: 'primary' | 'secondary' | 'danger' | 'ghost'
}

interface InteractionContext {
  interactionId: string
  kind: InteractionKind
  title: string
  urgency: 'blocking' | 'advisory'
  sections: InteractionContextSection[]
  actions: InteractionAction[]
  quickReplies?: string[]
}

interface DrawerState {
  interaction: InteractionContext | null
  chatHistory: DrawerChatMessage[]
}

// ─── LLM helpers ─────────────────────────────────────────────────────

function resolveApiKey(): string | undefined {
  return [
    process.env['OPENAI_API_KEY'],
    process.env['ANTHROPIC_API_KEY'],
    process.env['DEEPSEEK_API_KEY'],
    process.env['GOOGLE_API_KEY'],
    process.env['GEMINI_API_KEY']
  ].find((v): v is string => typeof v === 'string' && v.trim().length > 0)?.trim()
}

// ─── Experiment details parser (local copy to avoid cross-build import) ──

interface ExperimentDetails {
  assetRef?: string
  why?: string
  objective?: string
  setup?: string
  protocol?: string[]
  controls?: string
  metrics?: string
  expectedResult?: string
  outputFormat?: string
  checklist?: string[]
}

function focusLabelForUi(stage: string | undefined | null): string {
  switch (stage) {
    case 'S1': return 'Problem Framing'
    case 'S2': return 'Measurement Design'
    case 'S3': return 'Execution Planning'
    case 'S4': return 'Result Analysis'
    case 'S5': return 'Final Synthesis'
    default: return 'Current Research Focus'
  }
}

const EXPERIMENT_SECTIONS = [
  'Why this experiment:',
  'Objective:',
  'Setup / Environment:',
  'Execution protocol:',
  'Controls:',
  'Metrics to report:',
  'Expected result:',
  'Output format:',
  'Submission checklist:',
] as const

function parseExperimentDetailsLocal(details: string): ExperimentDetails | null {
  const headerHits = EXPERIMENT_SECTIONS.filter((h) => details.includes(h))
  if (headerHits.length < 3) return null

  const result: ExperimentDetails = {}
  const firstLine = details.split('\n')[0]?.trim() ?? ''
  if (firstLine.startsWith('Experiment Request:')) {
    result.assetRef = firstLine.replace('Experiment Request:', '').trim()
  }

  function extract(header: string): string | undefined {
    const idx = details.indexOf(header)
    if (idx === -1) return undefined
    const start = idx + header.length
    let end = details.length
    for (const h of EXPERIMENT_SECTIONS) {
      if (h === header) continue
      const hIdx = details.indexOf(h, start)
      if (hIdx !== -1 && hIdx < end) end = hIdx
    }
    return details.slice(start, end).trim() || undefined
  }

  result.why = extract('Why this experiment:')
  result.objective = extract('Objective:')
  result.setup = extract('Setup / Environment:')
  result.controls = extract('Controls:')
  result.metrics = extract('Metrics to report:')
  result.expectedResult = extract('Expected result:')
  result.outputFormat = extract('Output format:')

  const protocolRaw = extract('Execution protocol:')
  if (protocolRaw) {
    result.protocol = protocolRaw.split('\n').map((line) => line.replace(/^\d+\.\s*/, '').trim()).filter(Boolean)
  }
  const checklistRaw = extract('Submission checklist:')
  if (checklistRaw) {
    result.checklist = checklistRaw.split('\n').map((line) => line.replace(/^\d+\.\s*/, '').trim()).filter(Boolean)
  }
  return result
}

function readStringFieldFromPayload(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function readStringListFieldFromPayload(payload: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = payload[key]
    if (Array.isArray(value)) {
      const normalized = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
      if (normalized.length > 0) return normalized
    }
    if (typeof value === 'string' && value.trim()) {
      return value
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter(Boolean)
    }
  }
  return []
}

function parseExperimentDetailsFromAsset(asset: AssetRecord): ExperimentDetails | null {
  if (asset.type !== 'ExperimentRequest' && asset.type !== 'ExperimentRequirement') return null
  const payload = asset.payload as Record<string, unknown>
  const methodSteps = readStringListFieldFromPayload(payload, ['methodSteps', 'steps', 'procedureSteps', 'executionSteps'])
  const method = readStringFieldFromPayload(payload, ['method', 'plan', 'procedure', 'approach'])
  const protocol = methodSteps.length > 0 ? methodSteps : method ? [method] : []

  const details: ExperimentDetails = {
    assetRef: asset.id,
    why: readStringFieldFromPayload(payload, ['why', 'rationale', 'reason']),
    objective: readStringFieldFromPayload(payload, ['objective', 'goal', 'experimentGoal']),
    setup: readStringFieldFromPayload(payload, ['setup', 'environment', 'setupRequirements']),
    protocol: protocol.length > 0 ? protocol : undefined,
    controls: readStringFieldFromPayload(payload, ['controls', 'controlPlan']),
    metrics: readStringFieldFromPayload(payload, ['metrics', 'measurementPlan', 'measurements']),
    expectedResult: readStringFieldFromPayload(payload, ['expectedResult', 'expectedOutcome', 'expected', 'successCriteria']),
    outputFormat: readStringFieldFromPayload(payload, ['outputFormat', 'deliverables', 'reportFormat', 'submissionFormat']),
    checklist: readStringListFieldFromPayload(payload, ['submissionChecklist', 'uploadChecklist', 'checklist'])
  }

  if (!details.why && !details.objective && !details.protocol?.length) return null
  return details
}

function extractExperimentRequiredFilesFromAsset(asset: AssetRecord): string[] {
  if (asset.type !== 'ExperimentRequest' && asset.type !== 'ExperimentRequirement') return []
  const payload = asset.payload as Record<string, unknown>
  const files = new Set<string>()
  const append = (value: unknown) => {
    if (typeof value !== 'string') return
    const normalized = value.trim()
    if (normalized) files.add(normalized)
  }

  const fromPayload = payload.requiredFiles
  if (Array.isArray(fromPayload)) {
    for (const item of fromPayload) append(item)
  }
  if (typeof fromPayload === 'string') append(fromPayload)
  const fromSnakeCase = payload.required_files
  if (Array.isArray(fromSnakeCase)) {
    for (const item of fromSnakeCase) append(item)
  }
  if (typeof fromSnakeCase === 'string') append(fromSnakeCase)

  return [...files]
}

function looksLikeExperimentDataQuestion(pendingQuestion: SessionPersistedState['pendingQuestion']): boolean {
  if (!pendingQuestion) return false
  if (Array.isArray(pendingQuestion.requiredFiles) && pendingQuestion.requiredFiles.length > 0) return true
  const text = `${pendingQuestion.question ?? ''}\n${pendingQuestion.context ?? ''}`.toLowerCase()
  const asksForArtifacts = /\bupload\b|\bpaste\b|\battach\b|\bjsonl\b|\bcsv\b|\blog\b|\btrace\b|\bresult\b|\bfile\b/.test(text)
  const experimentSignals = /\bexperiment\b|\bprotocol\b|\bworkload\b|\bbenchmark\b|\blatency\b|\bperf\b|\bebpf\b|\bbpftrace\b|\btimestamp\b|\btool-call\b/.test(text)
  return asksForArtifacts && experimentSignals
}

function findRelatedExperimentAsset(
  pendingQuestion: SessionPersistedState['pendingQuestion'],
  assets: AssetRecord[]
): { asset: AssetRecord; details: ExperimentDetails; requiredFiles: string[] } | null {
  if (!looksLikeExperimentDataQuestion(pendingQuestion)) return null

  const ids = Array.isArray(pendingQuestion?.referencedAssetIds)
    ? pendingQuestion.referencedAssetIds
    : []

  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const candidates: AssetRecord[] = []
  for (const id of ids) {
    const asset = byId.get(id)
    if (!asset) continue
    if (asset.type === 'ExperimentRequest' || asset.type === 'ExperimentRequirement') {
      candidates.push(asset)
    }
  }

  if (candidates.length === 0) {
    const latest = [...assets]
      .filter((asset) => asset.type === 'ExperimentRequest' || asset.type === 'ExperimentRequirement')
      .sort((a, b) => b.createdByTurn - a.createdByTurn || b.id.localeCompare(a.id))
      .at(0)
    if (latest) candidates.push(latest)
  }

  for (const asset of candidates) {
    const details = parseExperimentDetailsFromAsset(asset)
    if (!details) continue
    const requiredFiles = extractExperimentRequiredFilesFromAsset(asset)
    return { asset, details, requiredFiles }
  }

  return null
}

// ─── InteractionDrawer context assembly ──────────────────────────────

function assembleInteractionContext(
  runtimeState: WindowRuntimeState,
  snapshot: SessionPersistedState,
  turnReports: TurnReport[],
  assets: AssetRecord[]
): InteractionContext | null {
  const sessionState = snapshot.state

  // Find active wait task if any
  let waitTask: ExternalWaitTask | null = null
  if (snapshot.pendingExternalTaskId?.trim()) {
    waitTask = parseJsonFile<ExternalWaitTask>(
      waitTaskFilePath(runtimeState.projectPath, snapshot.sessionId, snapshot.pendingExternalTaskId.trim())
    )
  }

  const pendingQuestion = snapshot.pendingQuestion
  const questionText = `${pendingQuestion?.question ?? ''} ${pendingQuestion?.context ?? ''}`.toLowerCase()
  const relatedExperiment = findRelatedExperimentAsset(pendingQuestion, assets)
  const latestTurn = turnReports[turnReports.length - 1]
  const latestGateBlockers = latestTurn?.gateImpact?.gateResult?.hardBlockers ?? []
  const latestConsensusBlockers = latestTurn?.reviewerSnapshot?.status === 'completed'
    ? (latestTurn.reviewerSnapshot.consensusBlockers ?? [])
    : []
  const looksLikeGateBlocker = Boolean(
    pendingQuestion
    && pendingQuestion.checkpoint === 'final-scope'
    && (
      questionText.includes('blocker')
      || questionText.includes('consensus')
      || questionText.includes('scope negotiation')
      || latestGateBlockers.length > 0
      || latestConsensusBlockers.length > 0
    )
  )

  // Detect interaction kind (first match wins)
  let kind: InteractionKind | null = null

  if (sessionState === 'WAITING_EXTERNAL' && waitTask) {
    // Check if it's an experiment request by trying to parse details
    const parsed = waitTask.details ? parseExperimentDetailsLocal(waitTask.details) : null
    kind = parsed ? 'experiment_request' : 'fulltext_upload'
  } else if (sessionState === 'WAITING_FOR_USER' && snapshot.pendingResourceExtension) {
    kind = 'resource_extension'
  } else if (sessionState === 'WAITING_FOR_USER' && looksLikeGateBlocker) {
    kind = 'gate_blocker'
  } else if (sessionState === 'WAITING_FOR_USER' && snapshot.pendingQuestion?.checkpoint) {
    kind = 'checkpoint_decision'
  } else if (sessionState === 'WAITING_FOR_USER' && snapshot.pendingQuestion) {
    kind = 'general_question'
  } else if (sessionState === 'FAILED' || sessionState === 'CRASHED') {
    kind = 'failure_recovery'
  }

  if (!kind) return null

  const sections: InteractionContextSection[] = []
  const actions: InteractionAction[] = []
  let quickReplies: string[] | undefined
  let title = ''
  let interactionId = ''
  const urgency: 'blocking' | 'advisory' = 'blocking'

  // Find the originating turn for experiment requests — match by asset type (more robust than action string)
  const originTurn = [...turnReports].reverse().find((t) =>
    t.assetDiff?.created?.some((id) => id.startsWith('ExperimentRequest'))
  )

  switch (kind) {
    case 'experiment_request': {
      const parsed = waitTask!.details ? parseExperimentDetailsLocal(waitTask!.details) : null
      interactionId = waitTask!.id
      title = waitTask!.title || 'Experiment Request'

      if (originTurn) {
        sections.push({
          label: 'What Led To This',
          content: `${originTurn.turnSpec.objective}${originTurn.execution?.actionRationale ? `\n\n${originTurn.execution.actionRationale}` : ''}`,
          collapsible: true
        })
      }
      if (parsed) {
        if (parsed.why) sections.push({ label: 'Why This Experiment', content: parsed.why })
        if (parsed.objective) sections.push({ label: 'Objective', content: parsed.objective })
        if (parsed.setup) sections.push({ label: 'Setup / Environment', content: parsed.setup, collapsible: true })
        if (parsed.protocol?.length) {
          sections.push({ label: 'Execution Protocol', content: parsed.protocol.map((s, i) => `${i + 1}. ${s}`).join('\n'), collapsible: true })
        }
        if (parsed.controls) sections.push({ label: 'Controls', content: parsed.controls, collapsible: true })
        if (parsed.metrics) sections.push({ label: 'Metrics to Report', content: parsed.metrics })
        if (parsed.expectedResult) sections.push({ label: 'Expected Result', content: parsed.expectedResult })
        if (parsed.outputFormat) sections.push({ label: 'Output Format', content: parsed.outputFormat, collapsible: true })
        if (parsed.checklist?.length) {
          sections.push({ label: 'Submission Checklist', content: parsed.checklist.map((s, i) => `${i + 1}. ${s}`).join('\n'), collapsible: true })
        }
      } else if (waitTask!.details) {
        sections.push({ label: 'Details', content: waitTask!.details, collapsible: true })
      }

      if (waitTask!.requiredArtifacts?.length) {
        sections.push({
          label: 'Required Files',
          content: waitTask!.requiredArtifacts.map((a) => `${a.kind}: ${a.description}${a.pathHint ? ` (${a.pathHint})` : ''}`).join('\n')
        })
      }

      actions.push(
        { id: 'upload', label: 'Upload Files', variant: 'primary' },
        { id: 'resolve', label: 'Done & Resume', variant: 'primary' },
        { id: 'skip', label: 'Skip', variant: 'ghost' }
      )
      break
    }

    case 'fulltext_upload': {
      interactionId = waitTask!.id
      title = waitTask!.title || 'Full-Text Upload Required'

      if (waitTask!.reason) sections.push({ label: 'Citation', content: waitTask!.reason })
      if (waitTask!.requiredArtifacts?.length) {
        sections.push({
          label: 'Required Files',
          content: waitTask!.requiredArtifacts.map((a) => `${a.kind}: ${a.description}${a.pathHint ? ` (${a.pathHint})` : ''}`).join('\n')
        })
      }
      if (waitTask!.uploadDir) {
        sections.push({ label: 'Upload Directory', content: waitTask!.uploadDir })
      }

      actions.push(
        { id: 'upload', label: 'Upload Files', variant: 'primary' },
        { id: 'resolve', label: 'Done & Resume', variant: 'primary' },
        { id: 'skip', label: 'Skip', variant: 'ghost' }
      )
      break
    }

    case 'checkpoint_decision': {
      const q = snapshot.pendingQuestion!
      interactionId = q.id ?? `checkpoint-${snapshot.currentTurn}`
      title = q.checkpoint === 'problem-freeze' ? 'Problem Definition Checkpoint'
        : q.checkpoint === 'baseline-freeze' ? 'Baseline Checkpoint'
        : q.checkpoint === 'claim-freeze' ? 'Claim Freeze Checkpoint'
        : q.checkpoint === 'final-scope' ? 'Final Scope Checkpoint'
        : 'Checkpoint Decision'

      sections.push({ label: 'Question', content: q.question })
      if (q.context) sections.push({ label: 'Context', content: q.context, collapsible: true })

      // Explain what each checkpoint type means
      const meaning: Record<string, string> = {
        'problem-freeze': 'Confirming this locks the problem definition. The research will proceed based on this framing.',
        'baseline-freeze': 'Confirming this freezes the measurement baseline. Future cycles will compare against this reference.',
        'claim-freeze': 'Confirming this freezes the claims. No new claims can be added after this point.',
        'final-scope': 'Confirming this locks the final research scope. The system will begin synthesis.',
      }
      if (q.checkpoint && meaning[q.checkpoint]) {
        sections.push({ label: 'What This Means', content: meaning[q.checkpoint] })
      }

      sections.push({
        label: 'Current Progress',
        content: `Cycle ${snapshot.currentTurn} · Focus ${focusLabelForUi(snapshot.activeStage)} · ${assets.length} artifacts`
      })

      if (q.options?.length) {
        quickReplies = q.options
        for (const opt of q.options) {
          actions.push({ id: 'quick_reply', label: opt, variant: 'primary' })
        }
      } else {
        actions.push(
          { id: 'confirm', label: 'Confirm', variant: 'primary' },
          { id: 'quick_reply', label: 'Reject', variant: 'danger' }
        )
        quickReplies = ['Confirm', 'Edit', 'Reject']
      }
      actions.push({ id: 'submit_text', label: 'Send Custom Reply', variant: 'secondary' })
      break
    }

    case 'gate_blocker': {
      const q = snapshot.pendingQuestion!
      interactionId = q.id ?? `gate-blocker-${snapshot.currentTurn}`
      title = 'Gate Blocker Requires Decision'

      sections.push({ label: 'Decision Request', content: q.question })
      if (q.context) sections.push({ label: 'Context', content: q.context, collapsible: true })

      const hardBlockerLabels = latestGateBlockers
        .map((item) => item.label)
        .filter((label, index, arr) => arr.indexOf(label) === index)
      if (hardBlockerLabels.length > 0) {
        sections.push({
          label: 'Gate Blockers',
          content: hardBlockerLabels.join(', ')
        })
      }
      const consensusLabels = latestConsensusBlockers
        .map((item) => item.label)
        .filter((label, index, arr) => arr.indexOf(label) === index)
      if (consensusLabels.length > 0) {
        sections.push({
          label: 'Semantic Consensus',
          content: consensusLabels.join(', ')
        })
      }
      sections.push({
        label: 'What Happens Next',
        content: 'Provide scope decision or mitigation so the autonomous loop can resume with a concrete direction.'
      })

      quickReplies = q.options?.length
        ? q.options
        : ['Narrow scope and continue', 'Need alternative plan', 'Override and proceed']
      for (const reply of quickReplies) {
        actions.push({ id: 'quick_reply', label: reply, variant: 'primary' })
      }
      actions.push({ id: 'submit_text', label: 'Send Custom Decision', variant: 'secondary' })
      break
    }

    case 'resource_extension': {
      const ext = snapshot.pendingResourceExtension!
      interactionId = ext.id
      title = 'Budget Extension Request'

      sections.push({ label: 'Rationale', content: ext.rationale })
      const delta = ext.delta
      const parts: string[] = []
      if (delta.maxTurns) parts.push(`+${delta.maxTurns} cycles`)
      if (delta.maxTokens) parts.push(`+${delta.maxTokens.toLocaleString()} tokens`)
      if (delta.maxCostUsd) parts.push(`+$${delta.maxCostUsd.toFixed(2)}`)
      sections.push({ label: 'Requested Increase', content: parts.join(', ') || 'No specific amount' })

      const used = snapshot.budgetUsed
      sections.push({
        label: 'Current Budget Usage',
        content: `${used.turns} cycles · ${used.tokens.toLocaleString()} tokens · $${used.costUsd.toFixed(2)}`
      })

      actions.push(
        { id: 'approve', label: 'Approve', variant: 'primary' },
        { id: 'reject', label: 'Reject', variant: 'danger' }
      )
      break
    }

    case 'general_question': {
      const q = snapshot.pendingQuestion!
      interactionId = q.id ?? `question-${snapshot.currentTurn}`
      title = 'Question From Research Agent'

      sections.push({ label: 'Question', content: q.question })
      if (relatedExperiment) {
        sections.push({
          label: 'Why This Is Needed',
          content: relatedExperiment.details.why
            ?? `The agent needs externally executed data to validate ${relatedExperiment.asset.id}.`
        })
        if (relatedExperiment.details.objective) {
          sections.push({
            label: 'Experiment Objective',
            content: relatedExperiment.details.objective
          })
        }
        if (relatedExperiment.details.protocol?.length) {
          sections.push({
            label: 'How To Run It',
            content: relatedExperiment.details.protocol.map((line, idx) => `${idx + 1}. ${line}`).join('\n'),
            collapsible: true
          })
        }
        if (relatedExperiment.details.metrics) {
          sections.push({
            label: 'Metrics To Report',
            content: relatedExperiment.details.metrics
          })
        }
        const requiredUploads = (Array.isArray(q.requiredFiles) && q.requiredFiles.length > 0)
          ? q.requiredFiles
          : relatedExperiment.requiredFiles
        if (requiredUploads.length > 0) {
          sections.push({
            label: 'Files To Upload',
            content: requiredUploads.map((name) => `- ${name}`).join('\n')
          })
        }
        if (relatedExperiment.details.outputFormat) {
          sections.push({
            label: 'Expected Output Format',
            content: relatedExperiment.details.outputFormat,
            collapsible: true
          })
        }
      }
      if (q.context) {
        sections.push({ label: 'Context', content: q.context, collapsible: true })
      } else {
        const latestObjective = latestTurn?.turnSpec?.objective?.trim()
        const latestRationale = latestTurn?.execution?.actionRationale?.trim()
        const latestSummary = latestTurn?.summary?.trim()
        const contextLines: string[] = []
        if (latestObjective) {
          contextLines.push(`Current focus: ${latestObjective}`)
        }
        if (latestRationale || latestSummary) {
          contextLines.push(`Why this is asked now: ${latestRationale || latestSummary}`)
        }
        if (Array.isArray(q.requiredFiles) && q.requiredFiles.length > 0) {
          contextLines.push(`Files expected: ${q.requiredFiles.join(', ')}`)
        }
        if (contextLines.length > 0) {
          sections.push({
            label: 'Context',
            content: contextLines.join('\n'),
            collapsible: true
          })
        }
      }
      const needsUploadAction = (
        (Array.isArray(q.requiredFiles) && q.requiredFiles.length > 0)
        || /\bupload\b|\bpaste\b|\battach\b|\bjsonl\b|\bcsv\b|\blog\b|\btrace\b|\bresult\b|\bfile\b/.test(questionText)
      )
      if (needsUploadAction) {
        actions.push({ id: 'upload', label: 'Upload Files', variant: 'primary' })
      }

      sections.push({
        label: 'What Happens Next',
        content: 'Your reply is merged into the next cycle input. The agent then resumes automatically with this decision.'
      })

      if (q.options?.length) {
        quickReplies = q.options
        for (const opt of q.options) {
          actions.push({ id: 'quick_reply', label: opt, variant: needsUploadAction ? 'secondary' : 'primary' })
        }
      }
      actions.push({ id: 'submit_text', label: 'Send Custom Reply', variant: 'secondary' })
      break
    }

    case 'failure_recovery': {
      interactionId = `failure-${snapshot.currentTurn}`
      title = 'Research Session Failed'

      // Determine error info
      const lastTurn = turnReports[turnReports.length - 1]
      const reason = lastTurn?.summary ?? 'Unknown runtime failure'
      const lower = reason.toLowerCase()
      const category = lower.includes('budget') ? 'Budget Exhausted'
        : lower.includes('deadlock') ? 'Unrecoverable Deadlock'
        : lower.includes('gate') || lower.includes('constraint') ? 'Quality Gate Failure'
        : 'Runtime Error'

      sections.push({ label: 'Error', content: `${category}: ${reason}` })
      if (lastTurn) {
        sections.push({ label: 'Last Insight', content: lastTurn.summary, collapsible: true })
      }
      sections.push({
        label: 'Recovery Options',
        content: 'You can restart the session from scratch or restore from the latest checkpoint.'
      })

      actions.push(
        { id: 'restart', label: 'Restart', variant: 'primary' },
        { id: 'restore', label: 'Restore Checkpoint', variant: 'secondary' }
      )
      break
    }
  }

  return { interactionId, kind, title, urgency, sections, actions, quickReplies }
}

function buildDrawerSystemPrompt(
  snapshot: SessionPersistedState,
  context: InteractionContext,
  turnReports: TurnReport[]
): string {
  const lines: string[] = [
    'You are a research advisor helping the user understand a decision point in their autonomous research session.',
    'Answer concisely and concretely.',
    'If the user is confused, explain in this order: why this request exists, exact step-by-step actions, and what outputs/files to submit.',
    'Do not ask for uploads without giving runnable instructions; if context lacks commands, explicitly say what is missing and provide a minimal template request.',
    '',
    `Research Goal: ${snapshot.goal}`,
    `Current mission focus: ${focusLabelForUi(snapshot.activeStage)}`,
    `Cycle: ${snapshot.currentTurn}, Budget: $${snapshot.budgetUsed.costUsd.toFixed(2)} spent`,
    '',
    `## Current Decision: ${context.title}`,
  ]

  for (const section of context.sections) {
    lines.push(`### ${section.label}`)
    lines.push(section.content)
    lines.push('')
  }

  // Add recent research activity
  const recentTurns = turnReports.slice(-3)
  if (recentTurns.length > 0) {
    lines.push('## Recent Research Activity')
    for (const turn of recentTurns) {
      lines.push(`- Cycle ${turn.turnNumber}: ${turn.summary}`)
    }
  }

  return lines.join('\n')
}

function pushDrawerState(
  win: BrowserWindow,
  state: WindowRuntimeState,
  snapshot: SessionPersistedState,
  assets: AssetRecord[]
): void {
  const interaction = assembleInteractionContext(state, snapshot, state.yoloTurnReports, assets)
  const drawerState: DrawerState = {
    interaction,
    chatHistory: state.drawerChatHistory
  }
  // Update active interaction tracking
  if (interaction) {
    if (state.activeInteractionId !== interaction.interactionId) {
      // New interaction — clear chat history
      state.drawerChatHistory = []
      drawerState.chatHistory = []
      state.activeInteractionId = interaction.interactionId
    }
  } else {
    state.activeInteractionId = null
  }
  persistDrawerStateToDisk(state, state.projectPath, snapshot.sessionId)
  safeSend(win, 'drawer:state-changed', drawerState)
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

// ─── File tree helpers ────────────────────────────────────────────────

interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
  hasChildren?: boolean
  modifiedAt: number
}

interface GitIgnoreRule {
  negated: boolean
  directoryOnly: boolean
  regex: RegExp
}

const TREE_MAX_ENTRIES = 500

function toPosixPath(input: string): string {
  return input.split(sep).join('/')
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const normalizedRoot = resolve(rootPath)
  const normalizedTarget = resolve(targetPath)
  if (normalizedRoot === normalizedTarget) return true
  return normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
}

function readGitIgnoreRules(rootPath: string): GitIgnoreRule[] {
  const filePath = join(rootPath, '.gitignore')
  if (!existsSync(filePath)) return []
  let raw = ''
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const negated = line.startsWith('!')
      let pattern = negated ? line.slice(1) : line
      const directoryOnly = pattern.endsWith('/')
      if (directoryOnly) pattern = pattern.slice(0, -1)

      const anchored = pattern.startsWith('/')
      if (anchored) pattern = pattern.slice(1)

      const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')

      let regexPattern = ''
      if (anchored) {
        regexPattern = `^${escaped}${directoryOnly ? '(?:/.*)?' : '$'}`
      } else if (pattern.includes('/')) {
        regexPattern = `(?:^|/)${escaped}${directoryOnly ? '(?:/.*)?' : '$'}`
      } else {
        regexPattern = `(?:^|/)${escaped}${directoryOnly ? '(?:/.*)?' : '(?:$|/)'}`
      }

      return {
        negated,
        directoryOnly,
        regex: new RegExp(regexPattern)
      } satisfies GitIgnoreRule
    })
}

function isHiddenPath(relativePath: string): boolean {
  return toPosixPath(relativePath)
    .split('/')
    .some(segment => segment.startsWith('.'))
}

function isIgnored(relativePath: string, isDirectory: boolean, rules: GitIgnoreRule[], showIgnored: boolean): boolean {
  if (showIgnored) return false
  if (isHiddenPath(relativePath)) return true

  const normalized = toPosixPath(relativePath)
  let ignored = false
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory && !normalized.includes('/')) continue
    if (rule.regex.test(normalized)) {
      ignored = !rule.negated
    }
  }
  return ignored
}

function hasVisibleChildren(dirPath: string, relativePath: string, rules: GitIgnoreRule[], showIgnored: boolean): boolean {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name
      if (!isIgnored(childRelative, entry.isDirectory(), rules, showIgnored)) {
        return true
      }
    }
  } catch {
    return false
  }
  return false
}

function listTreeChildren(
  rootPath: string,
  relativePath: string = '',
  showIgnored: boolean = false,
  limit: number = TREE_MAX_ENTRIES
): FileTreeNode[] {
  const basePath = resolve(rootPath, relativePath || '.')
  if (!isWithinRoot(rootPath, basePath)) return []
  if (!existsSync(basePath) || !statSync(basePath).isDirectory()) return []

  const rules = readGitIgnoreRules(rootPath)
  const entries = readdirSync(basePath, { withFileTypes: true })
  const out: FileTreeNode[] = []

  entries
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .some(entry => {
      const childRelative = toPosixPath(relativePath ? `${relativePath}/${entry.name}` : entry.name)
      const childPath = join(basePath, entry.name)
      if (isIgnored(childRelative, entry.isDirectory(), rules, showIgnored)) return false

      let modifiedAt = 0
      try {
        modifiedAt = statSync(childPath).mtimeMs
      } catch {
        modifiedAt = Date.now()
      }

      out.push({
        name: entry.name,
        path: childPath,
        relativePath: childRelative,
        type: entry.isDirectory() ? 'directory' : 'file',
        hasChildren: entry.isDirectory() ? hasVisibleChildren(childPath, childRelative, rules, showIgnored) : undefined,
        modifiedAt
      })
      return out.length >= limit
    })

  return out
}

function searchTree(rootPath: string, query: string, showIgnored: boolean = false, maxResults: number = 200): FileTreeNode[] {
  const trimmedQuery = query.trim().toLowerCase()
  if (!trimmedQuery) return []

  const rules = readGitIgnoreRules(rootPath)
  const root = resolve(rootPath)
  const stack: Array<{ absPath: string; relativePath: string }> = [{ absPath: root, relativePath: '' }]
  const out: FileTreeNode[] = []

  while (stack.length > 0 && out.length < maxResults) {
    const node = stack.pop()!
    let entries: ReturnType<typeof readdirSync> = []
    try {
      entries = readdirSync(node.absPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const rel = toPosixPath(node.relativePath ? `${node.relativePath}/${entry.name}` : entry.name)
      const abs = join(node.absPath, entry.name)
      if (isIgnored(rel, entry.isDirectory(), rules, showIgnored)) continue

      if (entry.name.toLowerCase().includes(trimmedQuery)) {
        let modifiedAt = 0
        try {
          modifiedAt = statSync(abs).mtimeMs
        } catch {
          modifiedAt = Date.now()
        }
        out.push({
          name: entry.name,
          path: abs,
          relativePath: rel,
          type: entry.isDirectory() ? 'directory' : 'file',
          hasChildren: entry.isDirectory() ? true : undefined,
          modifiedAt
        })
        if (out.length >= maxResults) break
      }

      if (entry.isDirectory()) {
        stack.push({ absPath: abs, relativePath: rel })
      }
    }
  }

  return out
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

    const normalizedOptions: YoloSessionOptions = {
      ...options,
      mode: options.mode ?? 'lean_v2'
    }

    const trimmedGoal = goal.trim()
    let sessionId = loadOrCreateSessionId(state.projectPath)

    if (state.yoloSession) {
      const current = await state.yoloSession.getSnapshot()
      if (
        current.goal !== trimmedGoal
        || isSessionTerminal(current.state)
        || state.sessionOptions?.mode !== normalizedOptions.mode
      ) {
        await stopSessionIfNeeded(state)
        sessionId = crypto.randomUUID()
        persistSessionId(state.projectPath, sessionId)
        state.yoloSession = null
        state.yoloTurnReports = []
        state.loopRunning = false
        state.stopRequested = false
      } else {
        writeSessionMeta(state.projectPath, {
          sessionId,
          goal: trimmedGoal,
          options: normalizedOptions,
          updatedAt: new Date().toISOString()
        })
        state.sessionOptions = normalizedOptions
        state.pauseRequested = false
        hydrateDrawerStateFromDisk(state, state.projectPath, sessionId)
        await pushStateWithEvent(win, state, state.yoloSession, 'session_continue')
        void runYoloLoop(win, state)
        return state.yoloSession.getSnapshot()
      }
    }

    writeSessionMeta(state.projectPath, {
      sessionId,
      goal: trimmedGoal,
      options: normalizedOptions,
      updatedAt: new Date().toISOString()
    })

    state.yoloSession = createYoloSession({
      projectPath: state.projectPath,
      goal: trimmedGoal,
      options: normalizedOptions,
      sessionId,
      onActivity: (event) => safeSend(win, 'yolo:activity', event),
      plannerConfig: {},
      coordinatorConfig: {
        allowBash: normalizedOptions.mode === 'lean_v2',
        enableLiteratureTools: normalizedOptions.mode === 'lean_v2'
      }
    })
    state.sessionOptions = normalizedOptions
    state.yoloTurnReports = loadTurnReportsFromDisk(state.projectPath, sessionId)
    state.pauseRequested = false
    state.lastBroadcastState = undefined
    state.drawerChatHistory = []
    state.activeInteractionId = null
    persistDrawerStateToDisk(state, state.projectPath, sessionId)

    await state.yoloSession.init()
    await pushStateWithEvent(win, state, state.yoloSession, 'session_started')
    safeSend(win, 'yolo:event', {
      type: 'session_started',
      goal: trimmedGoal
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
      mode: state.sessionOptions?.mode,
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
    pushQuestionIfAny(win, snapshot, state)
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
    const extAssets = loadAssetsFromDisk(state.projectPath, snapshot.sessionId)
    pushDrawerState(win, state, snapshot, extAssets)
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
    const resolvedAssets = loadAssetsFromDisk(state.projectPath, snapshot.sessionId)
    pushDrawerState(win, state, snapshot, resolvedAssets)
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

  // ─── InteractionDrawer IPC handlers ──────────────────────────────────

  handleWindow('drawer:get-state', async ({ state }): Promise<DrawerState> => {
    if (!state.yoloSession) {
      return { interaction: null, chatHistory: [] }
    }
    const snapshot = await state.yoloSession.getSnapshot()
    hydrateDrawerStateFromDisk(state, state.projectPath, snapshot.sessionId)
    const assets = loadAssetsFromDisk(state.projectPath, snapshot.sessionId)
    const interaction = assembleInteractionContext(state, snapshot, state.yoloTurnReports, assets)
    // Track interaction id changes
    if (interaction && state.activeInteractionId !== interaction.interactionId) {
      state.drawerChatHistory = []
      state.activeInteractionId = interaction.interactionId
    } else if (!interaction) {
      state.activeInteractionId = null
    }
    persistDrawerStateToDisk(state, state.projectPath, snapshot.sessionId)
    return { interaction, chatHistory: state.drawerChatHistory }
  })

  handleWindow('drawer:chat', async (
    { state },
    payload: { message: string; interactionId: string }
  ): Promise<DrawerChatMessage> => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')

    // Build system prompt from assembled context
    const snapshot = await state.yoloSession.getSnapshot()
    hydrateDrawerStateFromDisk(state, state.projectPath, snapshot.sessionId)
    const assets = loadAssetsFromDisk(state.projectPath, snapshot.sessionId)
    const context = assembleInteractionContext(state, snapshot, state.yoloTurnReports, assets)

    if (!context) {
      const fallbackMsg: DrawerChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'No active interaction context is available. The session may have moved past this decision point.',
        timestamp: new Date().toISOString()
      }
      state.drawerChatHistory.push(fallbackMsg)
      persistDrawerStateToDisk(state, state.projectPath, snapshot.sessionId)
      return fallbackMsg
    }
    if (payload.interactionId !== context.interactionId) {
      throw new Error('Stale interaction id for drawer chat. Please reopen the drawer and try again.')
    }
    if (state.activeInteractionId !== context.interactionId) {
      state.activeInteractionId = context.interactionId
      state.drawerChatHistory = []
    }

    const userMsg: DrawerChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: payload.message,
      timestamp: new Date().toISOString()
    }
    state.drawerChatHistory.push(userMsg)
    persistDrawerStateToDisk(state, state.projectPath, snapshot.sessionId)

    const systemPrompt = buildDrawerSystemPrompt(snapshot, context, state.yoloTurnReports)

    // Build messages array for the LLM
    const llmMessages = state.drawerChatHistory.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content
    }))

    let assistantContent = 'I apologize, but I was unable to generate a response. Please try again or check your API key configuration.'

    try {
      const modelId = state.sessionOptions?.models?.planner ?? 'gpt-4o'
      const apiKey = resolveApiKey()
      if (!apiKey) {
        assistantContent = 'No API key found. Please set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider key in your environment.'
      } else {
        const aiModule = await import(/* @vite-ignore */ 'ai')
        const model = getLanguageModelByModelId(modelId, { apiKey })
        const result = await aiModule.generateText({
          model,
          system: systemPrompt,
          messages: llmMessages
        })
        assistantContent = result.text || assistantContent
      }
    } catch (err) {
      assistantContent = `Error generating response: ${err instanceof Error ? err.message : String(err)}`
    }

    const assistantMsg: DrawerChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: assistantContent,
      timestamp: new Date().toISOString()
    }
    state.drawerChatHistory.push(assistantMsg)
    persistDrawerStateToDisk(state, state.projectPath, snapshot.sessionId)
    return assistantMsg
  })

  handleWindow('drawer:action', async (
    { win, state },
    payload: { interactionId: string; actionId: string; text?: string }
  ): Promise<{ success: boolean }> => {
    if (!state.yoloSession) throw new Error('No active YOLO session.')

    const snapshot = await state.yoloSession.getSnapshot()
    hydrateDrawerStateFromDisk(state, state.projectPath, snapshot.sessionId)
    const context = assembleInteractionContext(
      state,
      snapshot,
      state.yoloTurnReports,
      loadAssetsFromDisk(state.projectPath, snapshot.sessionId)
    )
    if (!context) {
      throw new Error('No active interaction to apply action.')
    }
    if (payload.interactionId !== context.interactionId) {
      throw new Error('Stale interaction id for drawer action. Please reopen the drawer and retry.')
    }
    const allowedActionIds = new Set(context.actions.map((item) => item.id))
    const { actionId, text } = payload
    if (!allowedActionIds.has(actionId)) {
      throw new Error(`Action "${actionId}" is not allowed for this interaction.`)
    }

    switch (actionId) {
      case 'upload': {
        const uploadDirAbs = await state.yoloSession.ensureIngressUploadDir()
        const uploadDirRel = relative(state.yoloSession.sessionDir, uploadDirAbs)
        mkdirSync(uploadDirAbs, { recursive: true })

        const picked = await dialog.showOpenDialog(win, {
          properties: ['openFile', 'multiSelections']
        })
        if (!picked.canceled && picked.filePaths.length > 0) {
          for (const sourcePath of picked.filePaths) {
            const destPath = uniqueDestinationPath(uploadDirAbs, sourcePath)
            copyFileSync(sourcePath, destPath)
          }
          safeSend(win, 'yolo:event', {
            type: 'ingress_files_added',
            uploadDir: uploadDirRel,
            fileCount: picked.filePaths.length
          })
        }
        break
      }

      case 'resolve': {
        const taskId = snapshot.pendingExternalTaskId
        if (taskId) {
          await state.yoloSession.resolveExternalWaitTask(taskId, text ?? 'Resolved from drawer')
          const afterSnapshot = await pushStateWithEvent(win, state, state.yoloSession, 'wait_external_resolved')
          safeSend(win, 'yolo:event', { type: 'wait_external_resolved', id: taskId, state: afterSnapshot.state })
          if (afterSnapshot.state === 'PLANNING') void runYoloLoop(win, state)
        }
        break
      }

      case 'skip': {
        const taskId = snapshot.pendingExternalTaskId
        if (taskId) {
          await state.yoloSession.cancelExternalWaitTask(taskId, text ?? 'Skipped from drawer')
          const afterSnapshot = await pushStateWithEvent(win, state, state.yoloSession, 'wait_external_cancelled')
          safeSend(win, 'yolo:event', { type: 'wait_external_cancelled', id: taskId, state: afterSnapshot.state })
          if (afterSnapshot.state === 'PLANNING') void runYoloLoop(win, state)
        }
        break
      }

      case 'approve': {
        const result = await state.yoloSession.resolveResourceExtension({ approved: true, note: text })
        if (state.sessionOptions) state.sessionOptions.budget = { ...result.budget }
        const afterSnapshot = await pushStateWithEvent(win, state, state.yoloSession, 'resource_extension_resolved')
        safeSend(win, 'yolo:event', {
          type: 'resource_extension_resolved',
          requestId: result.requestId,
          approved: true,
          budget: result.budget
        })
        if (afterSnapshot.state === 'PLANNING') void runYoloLoop(win, state)
        break
      }

      case 'reject': {
        // Detect if this is a resource extension reject or something else
        if (snapshot.pendingResourceExtension) {
          const result = await state.yoloSession.resolveResourceExtension({ approved: false, note: text })
          await pushStateWithEvent(win, state, state.yoloSession, 'resource_extension_resolved')
          safeSend(win, 'yolo:event', {
            type: 'resource_extension_resolved',
            requestId: result.requestId,
            approved: false,
            budget: result.budget
          })
        }
        break
      }

      case 'confirm':
      case 'quick_reply':
      case 'submit_text': {
        const reply = text ?? 'Confirm'
        state.yoloSession.enqueueInput(reply, 'urgent', 'chat')
        const decisionAssetId = await state.yoloSession.recordCheckpointDecision(reply)
        if (decisionAssetId) {
          safeSend(win, 'yolo:event', { type: 'checkpoint_confirmed', decisionAssetId })
        }
        await state.yoloSession.resume()
        await pushStateWithEvent(win, state, state.yoloSession, 'user_reply_resume')
        void runYoloLoop(win, state)
        break
      }

      case 'restart': {
        await state.yoloSession.stop().catch(() => {})
        await pushStateWithEvent(win, state, state.yoloSession, 'stop')
        // The renderer should call yolo:start after this
        break
      }

      case 'restore': {
        const restored = await state.yoloSession.restoreFromLatestCheckpoint()
        const afterSnapshot = await pushStateWithEvent(win, state, state.yoloSession, restored ? 'restore_checkpoint' : 'restore_checkpoint_noop')
        safeSend(win, 'yolo:event', { type: 'checkpoint_restored', restored, turn: afterSnapshot.currentTurn, state: afterSnapshot.state })
        if (restored && afterSnapshot.state === 'PLANNING') void runYoloLoop(win, state)
        break
      }
    }

    // Clear chat history after action and push updated drawer state
    state.drawerChatHistory = []
    state.activeInteractionId = null
    persistDrawerStateToDisk(state, state.projectPath, snapshot.sessionId)
    const updatedSnapshot = await state.yoloSession.getSnapshot()
    const updatedAssets = loadAssetsFromDisk(state.projectPath, updatedSnapshot.sessionId)
    pushDrawerState(win, state, updatedSnapshot, updatedAssets)

    return { success: true }
  })

  handleWindow('drawer:clear-chat', async ({ state }) => {
    state.drawerChatHistory = []
    if (!state.yoloSession) return
    const snapshot = await state.yoloSession.getSnapshot()
    persistDrawerStateToDisk(state, state.projectPath, snapshot.sessionId)
  })

  // ─── File tree handlers ──────────────────────────────────────────────

  handleWindow('file:list-tree', ({ state }, options?: { relativePath?: string; showIgnored?: boolean; limit?: number }) => {
    if (!state.projectPath) return []
    const relativePath = options?.relativePath ?? ''
    const showIgnored = options?.showIgnored ?? false
    const limit = options?.limit ?? TREE_MAX_ENTRIES
    return listTreeChildren(state.projectPath, relativePath, showIgnored, limit)
  })

  handleWindow('file:search-tree', ({ state }, query: string, options?: { showIgnored?: boolean; maxResults?: number }) => {
    if (!state.projectPath) return []
    return searchTree(state.projectPath, query, options?.showIgnored ?? false, options?.maxResults ?? 200)
  })

  handleWindow('file:create', ({ state }, relativePath: string) => {
    if (!state.projectPath) return { success: false, error: 'No project open' }
    const absPath = resolve(state.projectPath, relativePath)
    if (!isWithinRoot(state.projectPath, absPath)) return { success: false, error: 'Path is outside workspace.' }
    const parentDir = dirname(absPath)
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })
    if (existsSync(absPath)) return { success: false, error: 'File already exists.' }
    writeFileSync(absPath, '', { encoding: 'utf-8' })
    return { success: true, path: absPath }
  })

  handleWindow('file:create-dir', ({ state }, relativePath: string) => {
    if (!state.projectPath) return { success: false, error: 'No project open' }
    const absPath = resolve(state.projectPath, relativePath)
    if (!isWithinRoot(state.projectPath, absPath)) return { success: false, error: 'Path is outside workspace.' }
    if (existsSync(absPath)) return { success: false, error: 'Directory already exists.' }
    mkdirSync(absPath, { recursive: true })
    return { success: true, path: absPath }
  })

  handleWindow('file:rename', async ({ state }, oldRelativePath: string, newName: string) => {
    if (!state.projectPath) return { success: false, error: 'No project open' }
    const absOld = resolve(state.projectPath, oldRelativePath)
    if (!isWithinRoot(state.projectPath, absOld)) return { success: false, error: 'Path is outside workspace.' }
    if (!existsSync(absOld)) return { success: false, error: 'File not found.' }
    const absNew = join(dirname(absOld), newName)
    if (!isWithinRoot(state.projectPath, absNew)) return { success: false, error: 'New path is outside workspace.' }
    if (existsSync(absNew)) return { success: false, error: 'A file with that name already exists.' }
    await fsRename(absOld, absNew)
    return { success: true, path: absNew }
  })

  handleWindow('file:open-external', ({ state }, filePath: string) => {
    const absPath = isAbsolute(filePath) ? filePath : resolve(state.projectPath, filePath)
    if (!existsSync(absPath)) return { success: false, error: 'File not found' }
    shell.openPath(absPath)
    return { success: true }
  })

  handleWindow('file:trash', async ({ state }, filePath: string) => {
    if (!state.projectPath) return { success: false, error: 'No project open' }
    const absPath = isAbsolute(filePath) ? filePath : resolve(state.projectPath, filePath)
    if (!isWithinRoot(state.projectPath, absPath)) return { success: false, error: 'Path is outside workspace.' }
    if (!existsSync(absPath)) return { success: false, error: 'File not found.' }
    try {
      await shell.trashItem(absPath)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handleWindow('file:drop-to-dir', ({ state }, fileName: string, base64Content: string, targetDirRelPath: string) => {
    if (!state.projectPath) return { success: false, error: 'No project open' }
    const targetDir = targetDirRelPath ? resolve(state.projectPath, targetDirRelPath) : state.projectPath
    if (!isWithinRoot(state.projectPath, targetDir)) return { success: false, error: 'Target outside workspace.' }
    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) return { success: false, error: 'Invalid directory.' }
    const destPath = join(targetDir, fileName)
    if (existsSync(destPath)) return { success: false, error: `"${fileName}" already exists.` }
    try {
      writeFileSync(destPath, Buffer.from(base64Content, 'base64'))
      return { success: true, path: destPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handleWindow('file:read-text', ({ state }, filePath: string) => {
    if (!state.projectPath) return { success: false, error: 'No project open' }
    const absPath = isAbsolute(filePath) ? filePath : resolve(state.projectPath, filePath)
    if (!isWithinRoot(state.projectPath, absPath)) return { success: false, error: 'Path is outside workspace.' }
    if (!existsSync(absPath)) return { success: false, error: 'File not found.' }
    try {
      const stats = statSync(absPath)
      if (stats.size > 200 * 1024) return { success: false, error: 'File exceeds 200 KB limit.' }
      const content = readFileSync(absPath, 'utf-8')
      return { success: true, content, path: absPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── research.md handlers ───────────────────────────────────────────

  handleWindow('research:read', ({ state }) => {
    if (!state.projectPath) return { success: false, error: 'No project open' }
    const mdPath = resolve(state.projectPath, 'research.md')
    if (!existsSync(mdPath)) return { success: true, content: '', exists: false }
    const content = readFileSync(mdPath, 'utf-8')
    return { success: true, content, exists: true }
  })

  handleWindow('research:save', ({ state }, content: string) => {
    if (!state.projectPath) return { success: false, error: 'No project open' }
    if (content.length > 5000) return { success: false, error: 'Content exceeds 5000 character limit.' }
    const mdPath = resolve(state.projectPath, 'research.md')
    writeFileSync(mdPath, content, 'utf-8')
    return { success: true }
  })

  // ─── Paper library handlers ─────────────────────────────────────────

  handleWindow('papers:list', ({ state }) => {
    if (!state.projectPath) return []
    const dir = join(state.projectPath, '.yolo-researcher', 'papers')
    if (!existsSync(dir)) return []
    const papers: Array<Record<string, unknown>> = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'))
        if (raw.type === 'paper' && raw.id && raw.title) {
          papers.push({
            id: raw.id,
            title: raw.title,
            authors: Array.isArray(raw.authors) ? raw.authors : [],
            year: typeof raw.year === 'number' ? raw.year : undefined,
            venue: typeof raw.venue === 'string' ? raw.venue : undefined,
            abstract: typeof raw.abstract === 'string' ? raw.abstract : '',
            doi: typeof raw.doi === 'string' ? raw.doi : '',
            url: typeof raw.url === 'string' ? raw.url : undefined,
            pdfUrl: typeof raw.pdfUrl === 'string' ? raw.pdfUrl : undefined,
            relevanceScore: typeof raw.relevanceScore === 'number' ? raw.relevanceScore : undefined,
            citationCount: typeof raw.citationCount === 'number' ? raw.citationCount : undefined,
            citeKey: typeof raw.citeKey === 'string' ? raw.citeKey : '',
            tags: Array.isArray(raw.tags) ? raw.tags : [],
            searchKeywords: Array.isArray(raw.searchKeywords) ? raw.searchKeywords : undefined,
            externalSource: typeof raw.externalSource === 'string' ? raw.externalSource : undefined,
            createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
          })
        }
      } catch {
        // Skip invalid paper records.
      }
    }
    papers.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return papers
  })

  handleWindow('papers:list-reviews', ({ state }) => {
    if (!state.projectPath) return []
    const dir = join(state.projectPath, '.yolo-researcher', 'reviews')
    if (!existsSync(dir)) return []
    const reviews: Array<{ id: string; path: string; createdAt: string; paperCount: number }> = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      const stem = file.replace(/\.md$/, '')
      const mdPath = join(dir, file)
      try {
        const stats = statSync(mdPath)
        let paperCount = 0
        const companionPath = join(dir, `${stem}-papers.json`)
        if (existsSync(companionPath)) {
          try {
            const companionData = JSON.parse(readFileSync(companionPath, 'utf-8'))
            if (Array.isArray(companionData)) paperCount = companionData.length
          } catch {
            // Skip invalid companion file.
          }
        }
        reviews.push({
          id: stem,
          path: relative(state.projectPath, mdPath),
          createdAt: stats.mtime.toISOString(),
          paperCount,
        })
      } catch {
        // Skip unreadable files.
      }
    }
    reviews.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return reviews
  })

  handleWindow('papers:read-review', ({ state }, reviewId: string) => {
    if (!state.projectPath) return { content: '' }
    const mdPath = join(state.projectPath, '.yolo-researcher', 'reviews', `${reviewId}.md`)
    if (!existsSync(mdPath)) return { content: '' }
    try {
      const content = readFileSync(mdPath, 'utf-8')
      return { content }
    } catch {
      return { content: '' }
    }
  })

  handleWindow('folder:open-with', async ({ state }, appName: 'finder' | 'zed' | 'cursor' | 'vscode') => {
    if (!state.projectPath) return { success: false, error: 'No project open' }
    const { exec } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execAsync = promisify(exec)
    try {
      switch (appName) {
        case 'finder':
          await execAsync(`open "${state.projectPath}"`)
          break
        case 'zed':
          await execAsync(`zed "${state.projectPath}"`)
          break
        case 'cursor':
          await execAsync(`cursor "${state.projectPath}"`)
          break
        case 'vscode':
          await execAsync(`code "${state.projectPath}"`)
          break
        default:
          return { success: false, error: `Unknown app: ${appName}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to open folder' }
    }
  })
}
