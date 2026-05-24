import { app, ipcMain, BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from 'electron'
// electron-updater is CJS-only; the named-export form breaks the packaged
// ESM build (`out/main/index.mjs`). Default-import the namespace and pull
// `autoUpdater` off it.
import electronUpdater from 'electron-updater'
const { autoUpdater } = electronUpdater
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'fs'
import { stat as statAsync, readdir as readdirAsync } from 'fs/promises'
import { basename, dirname, extname, join, relative, resolve, isAbsolute } from 'path'
import { createCoordinator } from '../../../lib/agents/coordinator'
import {
  listNotes, listLiterature, listData,
  searchEntities, deleteEntity,
  artifactCreate, artifactDelete, artifactGet, artifactList, artifactSearch, artifactUpdate,
  memoryExplainTurn,
  sessionSummaryGet,
  enrichPaperArtifacts
} from '../../../lib/commands/index'
import { importBibtexFile, importBibtexString, type BibImportResult, type BibImportProgressEvent } from '../../../lib/importers/bibtex'
import {
  generatePaperPackReport,
  readReportState as readPaperReportState,
  type ReportProgressEvent as PaperReportProgressEvent,
} from '../../../lib/reports/index'
import { parseMentions, resolveMentions, getCandidates, invalidateEntityCache } from '../../../lib/mentions/index'
import { buildSkillManifests, writeEnabledSkills, installSkillToWorkspace, readEnabledSkills, setBuiltinSkillsRoot } from '../../../lib/skills/loader'
import { setCachedMarkdown } from '../../../lib/mentions/document-cache'
import { PATHS, type ProjectConfig, type RecapRecord } from '../../../lib/types'
import { ensureAgentMd, migrateLegacyArtifacts } from '../../../lib/memory-v2/store'
import { rebuildIndex, readIndex } from '../../../lib/memory-v2/indexer'
import { migrateToFilesAsCarrier } from '../../../lib/memory-v2/migrate-files'
import { ensureWorkspaceGitignore } from '../../../lib/memory-v2/workspace-gitignore'
import { readLatestRecap, writeLatestRecap } from '../../../lib/memory-v2/recaps'
import {
  checkSharingPreflight,
  getSharingStatus,
  shareProject,
  syncProject,
  pollRemote,
  inviteMember,
  removeMember,
  promoteMember,
  acceptInvite,
  listInvitations,
  type ShareOptions,
} from '../../../lib/sharing/index'
import {
  migrateAgentMemoryToFile,
  listMemoryFiles,
  readMemoryFile,
  writeMemoryFile,
  deleteMemoryFile,
  memoryFilename,
  updateAgentMdIndex,
  withIndexLock,
  type MemoryEntry,
  type MemoryType
} from '../../../lib/memory/memory-utils'
import { createRealtimeBuffer, type RealtimeBuffer } from './realtime-buffer'
import { PipilotTracer, migrateProjectConfig, runSubLlmText, loadTraceSnapshot, createTracingStateLogger, readTelemetryPrefs, writeTelemetryPrefs, type LiveSpanSummary } from '../../../lib/telemetry/index'
import { createUserResponseSignalsWriter, createViewLogWriter } from '../../../lib/ledger/index'
import { ROOT_CONTEXT } from '@opentelemetry/api'
import { createHash } from 'crypto'
import { probeStaticProfile } from '../../../lib/local-compute/environment-model'
import { inferProviderFromModelId } from '../../../lib/models'
import { projectGraph, checkTelemetryPresence } from '../../../lib/audit-graph/index'
import { AwsCredentialProvider, toSdkCredentials } from '../../../lib/aws/credentials'
// RFC-008 §7.5: compute IPC migrated to a single discriminated-event
// channel; the PR #62 helpers (PendingPlanStore reach-through,
// per-target formatters, compute-run-events bridge) are gone.

// ─── Shared utilities from shared-electron ──────────────────────────────────
import {
  getFileName,
  inferMimeType,
  safeSend,
  loadOrCreateSessionId,
  resolveCoordinatorAuth,
  loadCodexCredentials,
  saveCodexCredentials,
  loadAnthropicSubCredentials,
  saveAnthropicSubCredentials,
  isWithinRoot,
  toPosixPath,
  registerFileHandlers,
  registerSessionHandlers,
  registerPrefsHandlers,
  registerUsageHandlers,
  registerAuthHandlers,
  registerFolderOpenHandler,
  registerConfigHandlers,
  registerSettingsHandlers,
  loadSettingsFromConfig,
  pickPreferredModelId,
  listRecentProjects,
  addRecentProject,
  removeRecentProject,
} from '../../../shared-electron/index'

// ─── Tool render registry (Layer 4) ─
import { getToolRenderConfig } from '../../../shared-ui/tool-renderers/registry'
import { resolveSettings, resolveWikiPacing } from '../../../shared-ui/settings-types'

// ─── Wiki agent ──────────────────────────────────────────────────────────
import { createWikiAgent, countPaperPages, countConceptPages, countByFulltextStatus, readRecentLog, listWikiPages, readWikiPage, wikiSlugForPaperArtifact, buildPaperSlugMap, listWikiPaperMeta, reconcileIdentityDrift, type WikiAgent as WikiAgentType, type WikiStatus } from '../../../lib/wiki/index'

// ─── SVG rasterizer (Electron-only) ──────────────────────────────────────
import { rasterizeSvg } from './svg-rasterizer'

// One-time warning flag for the Linux recursive-watch limitation (see startFsWatcher).
let loggedLinuxWatchWarning = false


// ─── Simple activity formatter ─
interface ActivityLabel { label: string; icon: string; detail?: Record<string, unknown> }

/** Map tool names to human-readable activity labels with structured detail.
 *  Uses the tool render registry (Layer 4) for registered tools, with fallback for unknown tools. */
function formatToolCall(tool: string, args: unknown): ActivityLabel {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const config = getToolRenderConfig(tool)

  if (config) {
    return {
      label: `${config.displayName}: ${config.formatCallSummary(a)}`,
      icon: config.icon,
      detail: config.formatCallDetail(a),
    }
  }

  // Fallback for unregistered tools
  return { label: `${tool}`, icon: 'tool' }
}

/** Format tool result into a human-readable label with structured detail.
 *  Uses the tool render registry (Layer 4) for registered tools, with fallback for unknown tools. */
function formatToolResult(tool: string, result: unknown, args?: unknown): ActivityLabel {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  const success = r.success !== false
  const config = getToolRenderConfig(tool)

  // On failure, show error label regardless of registry — registry formatters
  // assume success and would produce misleading summaries like "Search completed"
  if (config && success) {
    return {
      label: config.formatResultSummary(result, a),
      icon: config.icon,
      detail: config.formatResultDetail(result, a),
    }
  }
  if (config && !success) {
    const errorMsg = (r.error as string) || ''
    const brief = errorMsg.length > 60 ? errorMsg.slice(0, 57) + '...' : errorMsg
    return {
      label: brief ? `${config.displayName} failed: ${brief}` : `${config.displayName} failed`,
      icon: config.icon,
      detail: config.formatResultDetail(result, a),
    }
  }

  // Fallback for unregistered tools
  return { label: success ? `${tool} completed` : `${tool} failed`, icon: 'tool', detail: { success } }
}

// ─── Persistent per-project usage totals ────────────────────────────────────
import {
  loadUsageTotals,
  accumulateUsage,
  resetUsageTotals,
  ensurePreTraceCutoff,
  readTraceAggregatedTotals
} from './usage-totals'

interface WindowRuntimeState {
  coordinator: Awaited<ReturnType<typeof createCoordinator>> | null
  currentModel: string
  currentReasoningEffort: 'max' | 'high' | 'medium' | 'low'
  currentAuthMode: 'api-key' | 'subscription' | 'none'
  projectPath: string
  sessionId: string
  isClosing: boolean
  realtimeBuffer: RealtimeBuffer
  fsWatcher: FSWatcher | null
  // Telemetry-trace IPC envelope (spec §4.1). Set on every `agent:send`; consumed
  // by the trace path. `lastTurnId` propagates as `pipilot.turn.id` on every span
  // emitted during the corresponding chat() call.
  lastTurnId?: string
  lastClientTimestamp?: number
  /** PipilotTracer for this window/project. Null when telemetry is disabled. */
  tracer: PipilotTracer | null
  /** Previous user turnId — written into user-response-signals.previousTurnId. */
  previousTurnId?: string
  /** Wall-clock ms of last assistant response — drives gapMsSincePreviousAssistant. */
  lastAssistantTimestamp?: number
  /**
   * In-flight auto-recap generation. Aborted when a new turn starts (so the
   * recap never reads agent.state mid-mutation) or when a newer recap kicks
   * off. See generateAndPushRecap.
   */
  recapAbort?: AbortController
}

const windowStates = new Map<number, WindowRuntimeState>()
let ipcHandlersRegistered = false

// ─── Wiki agent singleton (shared across all windows) ────────────────────
let wikiAgent: WikiAgentType | null = null
let activeCoordinatorCount = 0
let wikiIdleTimer: ReturnType<typeof setTimeout> | null = null
let lastWikiStatus: WikiStatus = { state: 'disabled', processed: 0, pending: 0, totalInWiki: 0 }

function broadcastWikiStatus(status: WikiStatus): void {
  lastWikiStatus = status
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win, 'wiki:status', status)
  }
}

function onCoordinatorActive(): void {
  activeCoordinatorCount++
  if (wikiIdleTimer) { clearTimeout(wikiIdleTimer); wikiIdleTimer = null }
  wikiAgent?.pause()
}

function onCoordinatorIdle(): void {
  activeCoordinatorCount = Math.max(0, activeCoordinatorCount - 1)
  if (activeCoordinatorCount === 0 && wikiAgent) {
    wikiIdleTimer = setTimeout(() => {
      wikiAgent?.resume()
      wikiIdleTimer = null
    }, 30_000)
  }
}

function createWindowRuntimeState(): WindowRuntimeState {
  return {
    coordinator: null,
    currentModel: 'openai:gpt-5.5',
    currentReasoningEffort: 'medium',
    currentAuthMode: 'none',
    projectPath: '',
    sessionId: crypto.randomUUID(),
    isClosing: false,
    realtimeBuffer: createRealtimeBuffer(),
    fsWatcher: null,
    tracer: null,
  }
}

function getOrCreateWindowState(win: BrowserWindow): WindowRuntimeState {
  const key = win.webContents.id
  let state = windowStates.get(key)
  if (!state) {
    state = createWindowRuntimeState()
    windowStates.set(key, state)
  }
  return state
}

function getWindowContext(event: IpcMainInvokeEvent): { win: BrowserWindow; state: WindowRuntimeState } {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) {
    throw new Error('Unable to resolve BrowserWindow from IPC sender.')
  }
  return { win, state: getOrCreateWindowState(win) }
}

/**
 * Generate + persist the auto-recap, then push it to the renderer. Requested by
 * the renderer (`recap:generate`) when the user goes away — NOT after every
 * turn — to mirror Claude Code's background-while-away model and avoid per-turn
 * cost. The renderer owns the trigger gating (≥2 min idle, ≥3 turns, dedup);
 * this just runs the same-model recap and persists the latest. Never throws.
 *
 * Caveat (accepted trade-off): firing on away rather than at turn-end means the
 * prompt cache may have expired (5 min TTL) if the user lingered after the last
 * turn before leaving — the recap still works, it just may not get a cache hit.
 */
async function generateAndPushRecap(
  state: WindowRuntimeState,
  win: BrowserWindow
): Promise<void> {
  if (!state.coordinator || !state.projectPath || !state.sessionId) return

  // Supersede any still-running recap.
  state.recapAbort?.abort()
  const ac = new AbortController()
  state.recapAbort = ac
  try {
    const recap = await state.coordinator.generateRecap(ac.signal)
    if (!recap || ac.signal.aborted) return
    const record: RecapRecord = {
      sessionId: state.sessionId,
      did: recap.did,
      next: recap.next,
      createdAt: new Date().toISOString()
    }
    writeLatestRecap(state.projectPath, record)
    safeSend(win, 'recap:update', record)
  } catch {
    // Recap is a convenience; never let it surface as a user-visible error.
  } finally {
    if (state.recapAbort === ac) state.recapAbort = undefined
  }
}

// RFC-008 §7.5: sendModalAvailability, sendPendingModalPlan, and
// unwrapToolResult helpers were retired. Backend availability flows
// through the ComputeRegistry's `availability-changed` event; pending
// plans come back via compute:hydrate; tool results no longer carry
// implicit compute events.

export function registerWindow(win: BrowserWindow): void {
  const key = win.webContents.id
  getOrCreateWindowState(win)
  win.on('closed', () => {
    const state = windowStates.get(key)
    if (!state) return
    if (state.fsWatcher) {
      state.fsWatcher.close()
      state.fsWatcher = null
    }
    if (state.coordinator) {
      state.coordinator.destroy().catch(() => {})
    }
    windowStates.delete(key)
  })
}

/**
 * Recursively sum the on-disk size of `path`. Returns 0 when the path is
 * missing, unreadable, or a special file. Used by the telemetry footprint
 * IPC — must never throw, since the agent path runs through the same
 * handler block.
 *
 * Async/parallel: trace + blob trees can hold tens of thousands of small
 * files. A sync recursive walk would block the Electron main process for
 * hundreds of ms. Per-directory we fan out with Promise.all so the walk
 * is bounded by the deepest path, not the total file count.
 */
async function duFileOrDirAsync(path: string): Promise<number> {
  try {
    const st = await statAsync(path)
    if (st.isFile()) return st.size
    if (!st.isDirectory()) return 0
    const entries = await readdirAsync(path)
    const sizes = await Promise.all(
      entries.map((entry) => duFileOrDirAsync(join(path, entry)))
    )
    let total = 0
    for (const s of sizes) total += s
    return total
  } catch {
    return 0
  }
}

/**
 * Per-project footprint cache — bounds how often we walk the filesystem
 * even when the Settings panel is open. The IPC handler returns the cached
 * value when fresh and triggers a refresh on stale, so the UI never blocks
 * on the walk itself.
 */
interface FootprintCacheEntry { bytes: number; computedAt: number }
const FOOTPRINT_TTL_MS = 60 * 1000
const footprintCache = new Map<string, FootprintCacheEntry>()

function createArtifactFromWorkspaceFile(state: WindowRuntimeState, filePath: string) {
  const projectPath = state.projectPath
  const sessionId = state.sessionId
  const title = basename(filePath, extname(filePath)) || basename(filePath)
  const ext = extname(filePath).toLowerCase()
  const isTextNote = ext === '.md' || ext === '.txt'
  if (isTextNote) {
    let content = ''
    try {
      content = readFileSync(filePath, 'utf-8')
      if (content.length > 200_000) {
        content = `${content.slice(0, 200_000)}\n\n[truncated: file exceeded 200000 chars]`
      }
    } catch {
      content = ''
    }
    return artifactCreate({
      type: 'note',
      title,
      content,
      filePath: toPosixPath(relative(projectPath, filePath)),
      tags: ['from-file'],
      summary: `Imported from ${title}${ext || ''}`
    }, { sessionId, projectPath })
  }

  return artifactCreate({
    type: 'data',
    title,
    filePath,
    mimeType: inferMimeType(filePath),
    tags: ['from-file'],
    summary: `Linked workspace file: ${toPosixPath(relative(projectPath, filePath))}`
  }, { sessionId, projectPath })
}

/** Initialize .research-pilot directory structure in the project folder */
function initializeProject(path: string): void {
  const dirs = [
    PATHS.root,
    PATHS.artifactsRoot,
    PATHS.notes,
    PATHS.papers,
    PATHS.data,
    PATHS.webContent,
    PATHS.toolOutputs,
    PATHS.sessions,
    PATHS.cache,
    PATHS.documentCache,
    PATHS.memoryRoot,
    PATHS.explainDir,
    PATHS.sessionSummaries,
    PATHS.skills,
    PATHS.memory
  ]

  for (const dir of dirs) {
    const fullPath = join(path, dir)
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true })
    }
  }

  const projectFile = join(path, PATHS.project)
  if (!existsSync(projectFile)) {
    const defaultConfig: ProjectConfig = {
      name: 'Research Project',
      description: 'A new research project',
      questions: [],
      userCorrections: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    writeFileSync(projectFile, JSON.stringify(defaultConfig, null, 2))
  }

  // Ensure agent.md note exists (pinned, always-present)
  ensureAgentMd(path)
  migrateAgentMemoryToFile(path)  // one-time: convert free-text Agent Memory to indexed files
  const migration = migrateLegacyArtifacts(path)
  if (migration.updatedFiles > 0 && process.env.RESEARCH_COPILOT_DEBUG) {
    console.log(`[ResearchPilot] migrated legacy artifacts: files=${migration.updatedFiles}, literature->paper=${migration.convertedLiteratureType}, data.name removed=${migration.removedDataNameField}`)
  }

  // RFC-014 files-as-carrier: convert legacy artifact JSON to workspace files
  // (one-time, backed up to artifacts-legacy/), (re)build the derived index, and
  // keep the index + backup out of git. All best-effort — never block open.
  try {
    const filesMig = migrateToFilesAsCarrier(path)
    if (!filesMig.skipped && filesMig.migrated > 0 && process.env.RESEARCH_COPILOT_DEBUG) {
      console.log(`[ResearchPilot] files-as-carrier migration: ${filesMig.migrated} artifact(s) → files`)
    }
    rebuildIndex(path)
    ensureWorkspaceGitignore(path)
  } catch (err) {
    if (process.env.RESEARCH_COPILOT_DEBUG) {
      console.warn('[ResearchPilot] artifact index/migration init failed:', err)
    }
  }

  // Telemetry-trace v0.10: ensure traces/blobs dirs + run ProjectConfig migration
  // (idempotent — adds id/telemetry/configSchemaVersion if absent).
  for (const dir of [PATHS.traces, PATHS.blobs]) {
    const fullPath = join(path, dir)
    if (!existsSync(fullPath)) mkdirSync(fullPath, { recursive: true })
  }
  try {
    migrateProjectConfig(path)
  } catch (err) {
    // Migration failures must not block project open. The next start retries.
    if (process.env.RESEARCH_COPILOT_DEBUG) {
      console.warn('[ResearchPilot] ProjectConfig telemetry migration failed:', err)
    }
  }
  // §14.3: snapshot pre-trace usage totals on first telemetry-aware load.
  // Idempotent — only writes on first call when the snapshot is absent.
  try {
    ensurePreTraceCutoff(join(path, PATHS.root))
  } catch {
    /* best effort */
  }

  // Keep process cwd stable; each window passes explicit projectPath.
}

async function ensureCoordinator(
  state: WindowRuntimeState,
  win: BrowserWindow,
  model?: string,
  options?: { forceRecreate?: boolean }
) {
  if (state.isClosing) throw new Error('Project is closing')
  const requestedModel = model || state.currentModel
  const resolvedAuth = resolveCoordinatorAuth(requestedModel)
  const previousModel = state.currentModel
  // Recreate coordinator if model/auth mode changed (reasoning effort changes handled by prefs:save)
  if (
    state.coordinator
    && (
      options?.forceRecreate
      || requestedModel !== state.currentModel
      || resolvedAuth.authMode !== state.currentAuthMode
    )
  ) {
    state.coordinator.destroy().catch(() => {})
    state.coordinator = null
  }
  state.currentModel = requestedModel
  state.currentAuthMode = resolvedAuth.authMode

  // Telemetry §10.1: log mid-session model changes to tracing-state.jsonl.
  // The next root invoke_agent span will reflect the new model in
  // gen_ai.request.model, but the change point itself was previously
  // invisible. Best-effort — failures must not block coordinator setup.
  if (state.projectPath && previousModel && previousModel !== requestedModel) {
    try {
      const logger = createTracingStateLogger(state.projectPath)
      void logger.append({
        kind: 'model-change',
        fromState: previousModel,
        toState: requestedModel,
        actor: 'user'
      })
    } catch {
      // ignore
    }
  }

  if (!state.coordinator) {
    const apiKey = resolvedAuth.apiKey
    const runProjectPath = state.projectPath

    // Build dynamic token getter for subscription auth
    let getApiKeyOverride: (() => Promise<string>) | undefined
    if (resolvedAuth.authMode === 'subscription' && resolvedAuth.piProvider === 'anthropic-sub') {
      getApiKeyOverride = async () => {
        const creds = loadAnthropicSubCredentials()
        if (!creds) throw new Error('Claude subscription credentials not found. Please sign in again.')
        if (creds.expires < Date.now() + 60_000) {
          try {
            const { refreshAnthropicToken } = await import('@mariozechner/pi-ai/oauth')
            const newCreds = await refreshAnthropicToken(creds.refresh)
            saveAnthropicSubCredentials(newCreds)
            return newCreds.access
          } catch {
            return creds.access
          }
        }
        return creds.access
      }
    } else if (resolvedAuth.authMode === 'subscription') {
      getApiKeyOverride = async () => {
        const creds = loadCodexCredentials()
        if (!creds) throw new Error('ChatGPT subscription credentials not found. Please sign in again.')
        if (creds.expires < Date.now() + 60_000) {
          try {
            const { refreshOpenAICodexToken } = await import('@mariozechner/pi-ai/oauth')
            const newCreds = await refreshOpenAICodexToken(creds.refresh)
            saveCodexCredentials(newCreds)
            return newCreds.access
          } catch {
            return creds.access
          }
        }
        return creds.access
      }
    }

    // Notify UI that we're initializing (includes MCP servers like MarkItDown)
    const initEvent = { type: 'system', summary: 'Initializing agent (first run may take 1-2 minutes for document processing setup)...' }
    state.realtimeBuffer.pushActivity(initEvent)
    safeSend(win, 'agent:activity', initEvent)

    // Build a live diagram-auth getter — reads env + anthropic-sub creds
    // each call so that API-key edits or subscription sign-ins propagate
    // to generate_diagram without requiring a coordinator rebuild.
    const getDiagramAuth = () => {
      const openaiKey = (process.env.OPENAI_API_KEY || '').trim() || null
      const envAnthropic = (process.env.ANTHROPIC_API_KEY || '').trim()
      if (envAnthropic) {
        return { openaiKey, anthropic: { token: envAnthropic, isOAuth: false } }
      }
      const creds = loadAnthropicSubCredentials()
      if (creds?.access) {
        const refreshTokenSymbol = creds.refresh
        return {
          openaiKey,
          anthropic: {
            token: creds.access,
            isOAuth: true,
            refresh: async () => {
              const { refreshAnthropicToken } = await import('@mariozechner/pi-ai/oauth')
              const fresh = await refreshAnthropicToken(refreshTokenSymbol)
              saveAnthropicSubCredentials(fresh)
              return fresh.access
            },
          },
        }
      }
      return { openaiKey, anthropic: null }
    }

    state.coordinator = await createCoordinator({
      apiKey,
      getApiKeyOverride,
      model: state.currentModel,
      reasoningEffort: state.currentReasoningEffort,
      resolvedSettings: resolveSettings(loadSettingsFromConfig()),
      // Live settings reader: re-reads ~/.research-copilot/config.json per
      // tool call so diagram review-provider choice (and similar
      // presentation-layer settings) take effect without restart.
      getResolvedSettings: () => resolveSettings(loadSettingsFromConfig()),
      getDiagramAuth,
      // RFC-008 §7.5: compute configuration. Modal credentials + cost
      // threshold flow through here as live accessors so the
      // coordinator's backends pick up settings changes without a
      // restart. The registry itself is built inside createCoordinator
      // and exposed on its return value (state.coordinator.computeRegistry).
      compute: {
        getModalCredentials: () => ({
          tokenId: (process.env.MODAL_TOKEN_ID || '').trim() || undefined,
          tokenSecret: (process.env.MODAL_TOKEN_SECRET || '').trim() || undefined,
        }),
        getComputeSettings: () => {
          const s = resolveSettings(loadSettingsFromConfig())
          return {
            modalCostThresholdUsd: (s.compute.backends.modal?.costThresholdUsd ?? 5) as number,
            forceApprovalForAll: s.compute.requireApprovalForAllBackends,
          }
        },
        // RFC-009 §3.1: AWS settings accessor. Returns the non-sensitive
        // bits from settings JSON; sensitive fields (accessKeyId,
        // secretAccessKey, sessionToken) flow through process.env via
        // the existing saveApiKey IPC, picked up by the credential
        // provider's env-fallback. Returning empty when no AWS section
        // is configured signals "AWS support off" — the coordinator
        // then skips registering the EC2 backend and S3 tools.
        //
        // No hardcoded region fallback here: defaults flow through
        // loadSettingsFromConfig's per-backend deep merge, so an empty
        // stored `aws-ec2` entry already comes back with the default
        // 'us-east-1'. If region is genuinely missing despite that, the
        // credential provider's diagnostic error is the right signal —
        // it tells the user exactly which field is empty rather than
        // silently routing their workload to us-east-1.
        getAwsSettings: () => {
          const s = resolveSettings(loadSettingsFromConfig())
          const aws = (s.compute.backends['aws-ec2'] ?? {}) as Record<string, unknown>
          return {
            region: typeof aws.region === 'string' ? aws.region : undefined,
            profile: typeof aws.profile === 'string' ? aws.profile : undefined,
          }
        },
        getAwsEc2CostThresholdUsd: () => {
          const s = resolveSettings(loadSettingsFromConfig())
          return (s.compute.backends['aws-ec2']?.costThresholdUsd ?? 5) as number
        },
        // Subscribe BEFORE backends register (see coordinator.ts comment).
        // This must be the canonical subscriber — adding another after
        // createCoordinator returns would double-deliver every event.
        onEvent: (event) => safeSend(win, 'compute:event', event),
      },
      // Only wired in Electron's main process; pure-Node contexts (tests)
      // will leave this undefined and the tool will degrade to source-
      // level SVG review.
      rasterizeSvg,
      projectPath: state.projectPath,
      sessionId: state.sessionId,
      debug: !!process.env.RESEARCH_COPILOT_DEBUG,
      onStream: (chunk: string) => {
        state.realtimeBuffer.appendChunk(chunk)
        safeSend(win, 'agent:stream-chunk', chunk)
      },
      onToolCall: (tool: string, args: unknown, toolCallId?: string) => {
        // Send activity event for tool invocation with structured detail
        // Use pi-agent-core's toolCallId for reliable call→result correlation
        const id = toolCallId || randomUUID()
        const { label, detail } = formatToolCall(tool, args)
        const event = { type: 'tool-call', tool, toolCallId: id, summary: label, detail }
        state.realtimeBuffer.pushActivity(event)
        // Mirror to tool events buffer for renderer remount recovery
        state.realtimeBuffer.pushToolEvent({ type: 'tool-call', tool, toolCallId: id, summary: label, detail })
        safeSend(win, 'agent:activity', event)
      },
      onToolResult: (tool: string, result: unknown, args?: unknown, toolCallId?: string) => {
        if (tool.startsWith('todo-') && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success && r.item) {
            state.realtimeBuffer.upsertProgressItem(r.item)
            safeSend(win, 'agent:todo-update', r.item)
          }
        }

        // Track files created/modified by write and edit tools
        if ((tool === 'write' || tool === 'edit') && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success && r.data?.path) {
            // Normalize to absolute path so renderer listeners can compare reliably
            const absPath = isAbsolute(r.data.path) ? r.data.path : resolve(runProjectPath, r.data.path)
            safeSend(win, 'agent:file-created', absPath)
          }
        }

        // Track extracted markdown files created by convert_document
        if (tool === 'convert_document' && result && typeof result === 'object' && 'success' in result) {
          const r2 = result as any
          if (r2.success && r2.data?.outputFile) {
            safeSend(win, 'agent:file-created', r2.data.outputFile)
          }
        }

        // Cache convert_document results for document files (path-based wrapper)
        if (tool === 'convert_document' && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success && r.data?.outputFile && args && typeof args === 'object' && 'source' in args) {
            const sourcePath = (args as { source: string }).source
            const absSourcePath = isAbsolute(sourcePath) ? sourcePath : resolve(runProjectPath, sourcePath)
            const absOutputPath = resolve(runProjectPath, r.data.outputFile as string)

            if (existsSync(absOutputPath)) {
              try {
                const markdown = readFileSync(absOutputPath, 'utf-8')
                if (markdown.trim()) {
                  setCachedMarkdown(absSourcePath, markdown, runProjectPath)
                }
              } catch {
                // ignore cache failures
              }
            }
          }
        }

        // Notify UI to refresh entity lists when an agent run creates new
        // artifacts. Renderer debounces the resulting refresh so bursts of
        // tool calls coalesce.
        //
        // Three tool names trigger this:
        //   - artifact-create / artifact-update: native AgentTools that return
        //     toAgentResult-wrapped payloads — the AgentToolResult shape is
        //     { content, details: { success, tool_name } } (so 'success' is
        //     nested under details, not on the top level).
        //   - literature-search: AgentTool that auto-saves Paper artifacts
        //     directly via upsertPaperArtifact(), then returns its own
        //     toAgentResult-wrapped payload.
        //
        // Without this branch, every agent-driven artifact creation (notes,
        // papers, data) would only become visible in the Library/Papers tab
        // after the user re-opened the project — EntityTabs.tsx mounts once
        // and otherwise relies on this 'agent:entity-created' event for
        // incremental refreshes.
        //
        // Defensive about result shape: read success from both r.details
        // (wrapped, the current code path) and r.success (raw, in case a
        // future router emits the unwrapped ToolResult), so this branch
        // survives a routing change. r.data is only populated on the raw
        // form — the wrapped form keeps payload data inside content[0].text
        // — so the file-created sub-event below only fires when r.data is
        // available. The workspace fs watcher (state.fsWatcher) catches the
        // new file independently for the file-tree view, so missing this
        // event in the wrapped path costs only the working-files UIStore
        // signal, not visibility.
        const triggersEntityRefresh =
          tool === 'artifact-create' ||
          tool === 'artifact-update' ||
          tool === 'literature-search'
        if (triggersEntityRefresh && result && typeof result === 'object') {
          const r = result as any
          const success = r.details?.success ?? r.success
          if (success === true) {
            invalidateEntityCache(runProjectPath)
            safeSend(win, 'agent:entity-created', {
              type: tool === 'literature-search'
                ? 'paper'
                : (r.data?.type || 'artifact'),
              id: r.data?.id ?? '',
              title: r.data?.title ?? `${tool} batch`
            })
            if (tool === 'artifact-create' && r.data?.filePath) {
              const absPath = isAbsolute(r.data.filePath) ? r.data.filePath : resolve(runProjectPath, r.data.filePath)
              safeSend(win, 'agent:file-created', absPath)
            }
          }
        }

        // RFC-008 §7.5: compute run/plan events come from the
        // ComputeRegistry's subscribe stream (wired below in
        // ensureCoordinator) — NOT from inspecting tool results here.
        // The per-tool inspection block PR #62 added is gone.

        // Send activity event for tool result with structured detail and duration
        const r = result as any
        const success = r?.success !== false
        const error = !success ? (r?.error || 'Unknown error') : undefined
        const { label: resultLabel, detail: resultDetail } = formatToolResult(tool, result, args)
        // Use the toolCallId passed from coordinator (pi-agent-core's ctx.toolCall.id)
        const startTime = toolCallId ? state.realtimeBuffer.popToolCallStartTime(toolCallId) : undefined
        const durationMs = startTime ? Date.now() - startTime : undefined
        const actEvent = { type: 'tool-result', tool, toolCallId, summary: resultLabel, success, error, resultDetail, durationMs }
        state.realtimeBuffer.pushActivity(actEvent)
        // Mirror to tool events buffer for renderer remount recovery
        if (toolCallId) {
          state.realtimeBuffer.updateToolEvent(toolCallId, {
            type: 'tool-result', summary: resultLabel, success, resultDetail, durationMs
          })
        }
        safeSend(win, 'agent:activity', actEvent)
      },

      // Tool execution progress (real-time updates during tool execution)
      onToolProgress: (tool: string, toolCallId: string, phase: string, data: unknown) => {
        safeSend(win, 'agent:tool-progress', { tool, toolCallId, phase, data, timestamp: Date.now() })
      },

      // Skill activation tracking
      onSkillLoaded: (skillName: string) => {
        safeSend(win, 'agent:skill-loaded', skillName)
      },

      // Transient LLM-failure retry notice (e.g. 529 overloaded)
      onRetryNotice: (info: { attempt: number; nextDelayMs: number; error: string }) => {
        safeSend(win, 'agent:retry-notice', { ...info, timestamp: Date.now() })
      },

      // Token usage tracking
      // pi-mono Usage type: { input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }
      onUsage: (usage: any, cost: any) => {
        const rawCost = cost?.total ?? 0
        const promptTokens = usage.input ?? 0
        const completionTokens = usage.output ?? 0
        const cachedTokens = usage.cacheRead ?? 0
        const cacheWriteTokens = usage.cacheWrite ?? 0

        // Persist to disk (per-project accumulated totals)
        const baseDir = join(runProjectPath, PATHS.root)
        accumulateUsage(baseDir, promptTokens, completionTokens, cachedTokens, cacheWriteTokens, rawCost)
        // §11 P1: dual-write reconciliation. Compare classic accumulator total
        // against trace-aggregated total; in debug mode, log the delta so a
        // regression in the trace path is observable. Acceptable delta = the
        // pre-cutoff snapshot + the current in-flight chat (digest writes lag).
        if (process.env.RESEARCH_COPILOT_DEBUG) {
          try {
            const classic = loadUsageTotals(baseDir)
            const traceTotals = readTraceAggregatedTotals(runProjectPath)
            const cutoff = classic.preTraceCutoffTotals?.tokens ?? 0
            const traceTokens = traceTotals.tokens.input + traceTotals.tokens.output + traceTotals.tokens.cacheRead
            const expected = classic.totals.tokens - cutoff
            const delta = expected - traceTokens
            console.log(`[Usage dual-write] classic=${classic.totals.tokens} cutoff=${cutoff} trace=${traceTokens} delta=${delta}`)
          } catch {
            /* best effort */
          }
        }

        // G3 (v0.13): Anthropic splits input into 3 buckets (uncached + cache_read
        // + cache_creation). True hit rate uses all 3 in the denominator —
        // previously cacheWriteTokens was excluded, inflating the displayed
        // rate when a turn populated new cache entries.
        const inputTotal = promptTokens + cachedTokens + cacheWriteTokens
        const usageEvent = {
          promptTokens,
          completionTokens,
          cachedTokens,
          cacheWriteTokens,
          cost: rawCost,
          rawCost,
          billableCost: rawCost,
          authMode: state.currentAuthMode,
          billingSource: resolvedAuth.billingSource,
          cacheHitRate: inputTotal > 0 ? cachedTokens / inputTotal : 0
        }
        safeSend(win, 'agent:usage', usageEvent)
      },

      // Telemetry-trace v0.10: pass per-window tracer + auth-mode + turnId getter.
      // The coordinator wraps every sub-LLM call in a `chat` span and stamps
      // `pipilot.turn.id` on every span via the IPC envelope.
      tracer: state.tracer,
      authMode:
        state.currentAuthMode === 'subscription'
          ? (resolvedAuth.piProvider === 'anthropic-sub' ? 'anthropic-subscription' : 'openai-codex')
          : state.currentAuthMode === 'api-key'
          ? 'api-key'
          : undefined,
      getTurnId: () => state.lastTurnId
    })

    // RFC-008 §7.5 + RFC-009 fix: the event subscriber is wired INSIDE
    // createCoordinator via the `compute.onEvent` callback above. That
    // way subscription happens BEFORE backends register, so initial
    // availability probes that resolve on the next microtask (Modal's
    // execSync path) don't get dropped. Subscribing here instead would
    // miss those events; subscribing here ON TOP of the in-coordinator
    // subscriber would double-deliver. Either way: don't add a second
    // subscriber here.

    // Notify UI that initialization is complete
    const readyEvent = { type: 'system', summary: 'Agent ready' }
    state.realtimeBuffer.pushActivity(readyEvent)
    safeSend(win, 'agent:activity', readyEvent)
  }
  return state.coordinator
}


/**
 * Destroy all coordinators (and their compute runners) across all windows.
 * Called from before-quit to ensure compute processes are cleaned up.
 */
export async function destroyAllCoordinators(): Promise<void> {
  // Destroy wiki agent
  if (wikiAgent) {
    wikiAgent.destroy()
    wikiAgent = null
  }
  if (wikiIdleTimer) { clearTimeout(wikiIdleTimer); wikiIdleTimer = null }

  const promises: Promise<void>[] = []
  for (const [, state] of windowStates) {
    if (state.coordinator) {
      promises.push(
        (state.coordinator as any).destroy().catch(() => {})
      )
    }
  }
  // Wait up to 8s for all coordinators to destroy
  await Promise.race([
    Promise.all(promises),
    new Promise<void>(resolve => setTimeout(resolve, 8000)),
  ])
}

export function registerIpcHandlers(): void {
  if (ipcHandlersRegistered) return
  ipcHandlersRegistered = true

  // ─── Auto-update via electron-updater ──────────────────────────────────────
  // Checks GitHub Releases for newer signed+notarized builds, downloads in
  // background, and surfaces an "update ready" state to the renderer. The
  // user clicks "Restart to upgrade" → quitAndInstall().
  //
  // Disabled in dev (no signature). On Linux outside AppImage the updater
  // also auto-disables itself; .deb users must apt-update themselves.
  const currentVersion = app.getVersion()
  let updateState: {
    status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
    version: string
    current: string
    progress?: number
    error?: string
  } = { status: 'idle', version: currentVersion, current: currentVersion }

  const broadcastUpdateState = (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('update:state', updateState)
    }
  }

  if (app.isPackaged) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => {
      updateState = { ...updateState, status: 'checking' }
      broadcastUpdateState()
    })
    autoUpdater.on('update-available', (info) => {
      updateState = { ...updateState, status: 'downloading', version: info.version, progress: 0 }
      broadcastUpdateState()
    })
    autoUpdater.on('update-not-available', () => {
      updateState = { ...updateState, status: 'idle' }
      broadcastUpdateState()
    })
    autoUpdater.on('download-progress', (p) => {
      updateState = { ...updateState, status: 'downloading', progress: Math.round(p.percent) }
      broadcastUpdateState()
    })
    autoUpdater.on('update-downloaded', (info) => {
      updateState = { status: 'ready', version: info.version, current: currentVersion, progress: 100 }
      broadcastUpdateState()
    })
    autoUpdater.on('error', (err) => {
      updateState = { ...updateState, status: 'error', error: err?.message || 'Unknown updater error' }
      broadcastUpdateState()
    })

    // Initial check after a short delay so the window is up first
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {})
    }, 5000)

    // Re-check every 4 hours while the app is running
    setInterval(() => {
      if (updateState.status === 'ready' || updateState.status === 'downloading') return
      autoUpdater.checkForUpdates().catch(() => {})
    }, 4 * 60 * 60 * 1000)
  }

  // Renderer can pull the current state any time (e.g. on mount, after
  // navigating to a tab) without waiting for the next event broadcast.
  ipcMain.handle('update:get-state', () => updateState)

  ipcMain.handle('update:check-now', async () => {
    if (!app.isPackaged) return { ok: false, reason: 'dev-mode' }
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: (err as Error)?.message || 'check failed' }
    }
  })

  ipcMain.handle('update:quit-and-install', () => {
    if (updateState.status !== 'ready') return { ok: false, reason: 'not-ready' }
    // isSilent=false (show progress on Windows), isForceRunAfter=true (relaunch)
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return { ok: true }
  })

  // Theme is a global app-wide preference. When any window flips it, fan out
  // to every other window so all renderers re-apply the <html> class together.
  // Sender included on purpose — its own listener is idempotent (no-ops when
  // its store already matches), and treating sender like everyone else keeps
  // the broadcast logic uniform.
  ipcMain.handle('theme:set', (_event, theme: 'light' | 'dark' | 'high-contrast' | 'system') => {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'high-contrast' && theme !== 'system') return
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send('theme:changed', theme)
    }
  })

  // Set the builtin skills root so the loader can find SKILL.md files.
  // Dev: source tree at repo-root/lib/skills/builtin/
  // Production: electron-builder extraResources copies to Resources/skills/builtin/
  const builtinSkillsRoot = app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(__dirname, '..', '..', '..', 'lib', 'skills')
  setBuiltinSkillsRoot(builtinSkillsRoot)

  const handleWindow = <T extends unknown[], R>(
    channel: string,
    handler: (ctx: { win: BrowserWindow; state: WindowRuntimeState }, ...args: T) => Promise<R> | R
  ) => {
    ipcMain.handle(channel, (event, ...args) => handler(getWindowContext(event), ...(args as T)))
  }

  // ─── Register shared handlers from @shared-electron ─────────────────────
  // The shared registration functions expect a simpler `handle` signature where
  // the handler receives only the args (no event). We wrap them so they resolve
  // the correct per-window state.

  const makeSharedHandle = (getState: (event: IpcMainInvokeEvent) => WindowRuntimeState) => {
    return (channel: string, handler: (...args: any[]) => any) => {
      ipcMain.handle(channel, (event, ...args) => {
        // Bind the per-window context so shared handlers see the right projectPath
        const state = getState(event)
        // Temporarily override getCtx return in the closure
        currentSharedState = state
        try {
          return handler(...args)
        } finally {
          currentSharedState = null
        }
      })
    }
  }

  // Shared state bridge: the shared handler registrations call getCtx() which
  // returns { projectPath } from this variable set by the wrapper above.
  let currentSharedState: WindowRuntimeState | null = null
  const getCtx = () => ({
    projectPath: currentSharedState?.projectPath ?? ''
  })

  const sharedHandle = makeSharedHandle((event) => getWindowContext(event).state)

  registerFileHandlers(sharedHandle, getCtx)
  registerSessionHandlers(sharedHandle, getCtx, PATHS.sessions)
  registerPrefsHandlers(sharedHandle, getCtx, PATHS.root, {
    onModelChange: (m) => { if (currentSharedState) currentSharedState.currentModel = m },
    onReasoningEffortChange: (e) => { if (currentSharedState) currentSharedState.currentReasoningEffort = e as any },
    invalidateCoordinator: () => {
      if (currentSharedState?.coordinator) {
        currentSharedState.coordinator.destroy().catch(() => {})
        currentSharedState.coordinator = null
      }
    },
    getCurrentModel: () => currentSharedState?.currentModel ?? '',
    getCurrentReasoningEffort: () => currentSharedState?.currentReasoningEffort ?? 'medium'
  })
  registerUsageHandlers(sharedHandle, getCtx, loadUsageTotals, resetUsageTotals)
  registerAuthHandlers(sharedHandle)
  registerConfigHandlers(sharedHandle)
  registerSettingsHandlers(sharedHandle)
  registerFolderOpenHandler(sharedHandle, getCtx)

  // ─── Wiki agent startup (async, fire-and-forget) ────────────────────────
  ;(async () => {
    const wikiSettings = loadSettingsFromConfig().wikiAgent
    // Resolve 'auto' to the highest-priority available provider (sub > api).
    // 'none' (default) disables the wiki agent entirely — user must opt in.
    let wikiModel = wikiSettings?.model ?? 'none'
    if (wikiModel === 'auto') {
      const preferred = pickPreferredModelId()
      if (!preferred) {
        if (process.env.RESEARCH_COPILOT_DEBUG) {
          console.log('[wiki-agent] auto mode but no auth configured; skipping startup')
        }
        return
      }
      wikiModel = preferred
    }
    if (wikiSettings && wikiModel !== 'none') {
      try {
        const { getModel: getPiModel } = await import('@mariozechner/pi-ai')
        const wikiAuth = resolveCoordinatorAuth(wikiModel)
        const [rawProvider, modelId] = wikiModel.split(':')
        // Map subscription providers to their pi-ai provider name
        const piProvider = rawProvider === 'anthropic-sub' ? 'anthropic' : rawProvider
        const model = getPiModel(piProvider as any, modelId)

        // Build async key getter (handles subscription token refresh)
        let resolveApiKey: () => Promise<string>
        if (wikiAuth.authMode === 'subscription' && wikiAuth.piProvider === 'anthropic-sub') {
          resolveApiKey = async () => {
            const creds = loadAnthropicSubCredentials()
            if (!creds) throw new Error('Claude subscription credentials not found')
            if (creds.expires < Date.now() + 60_000) {
              try {
                const { refreshAnthropicToken } = await import('@mariozechner/pi-ai/oauth')
                const newCreds = await refreshAnthropicToken(creds.refresh)
                saveAnthropicSubCredentials(newCreds)
                return newCreds.access
              } catch { return creds.access }
            }
            return creds.access
          }
        } else if (wikiAuth.authMode === 'subscription') {
          resolveApiKey = async () => {
            const creds = loadCodexCredentials()
            if (!creds) throw new Error('Codex credentials not found')
            if (creds.expires < Date.now() + 60_000) {
              try {
                const { refreshOpenAICodexToken } = await import('@mariozechner/pi-ai/oauth')
                const newCreds = await refreshOpenAICodexToken(creds.refresh)
                saveCodexCredentials(newCreds)
                return newCreds.access
              } catch { return creds.access }
            }
            return creds.access
          }
        } else {
          resolveApiKey = async () => wikiAuth.apiKey
        }

        const callLlm = async (system: string, user: string) => {
          const currentKey = await resolveApiKey()
          // Wiki bg agent walks across projects: pick the first window's tracer
          // if any. Spec §6.5: this lives on its own trace (no parent context),
          // detached from any active user-task trace.
          let firstTracer: PipilotTracer | null = null
          let firstWin: BrowserWindow | null = null
          let firstState: WindowRuntimeState | null = null
          for (const [w, s] of windowStates) {
            if (s.tracer) { firstTracer = s.tracer; firstWin = w; firstState = s; break }
          }
          // G1 (telemetry-trace v0.13): attribute wiki-bg tokens to the first
          // window's project. Cross-project wiki traffic was previously
          // invisible to usage.json + StatusBar despite being billable.
          // First-window pick mirrors the tracer-pick policy above.
          const wikiOnUsage = firstWin && firstState && firstState.projectPath
            ? (usage: any, cost: any) => {
                const rawCost = cost?.total ?? 0
                const promptTokens = usage.input ?? 0
                const completionTokens = usage.output ?? 0
                const cachedTokens = usage.cacheRead ?? 0
                const cacheWriteTokens = usage.cacheWrite ?? 0
                accumulateUsage(
                  join(firstState!.projectPath, PATHS.root),
                  promptTokens, completionTokens, cachedTokens, cacheWriteTokens, rawCost
                )
                const inputTotal = promptTokens + cachedTokens + cacheWriteTokens
                safeSend(firstWin!, 'agent:usage', {
                  promptTokens,
                  completionTokens,
                  cachedTokens,
                  cacheWriteTokens,
                  cost: rawCost,
                  rawCost,
                  billableCost: rawCost,
                  authMode: firstState!.currentAuthMode,
                  billingSource: 'api-key',
                  cacheHitRate: inputTotal > 0 ? cachedTokens / inputTotal : 0
                })
              }
            : undefined
          return runSubLlmText({
            model,
            systemPrompt: system,
            userContent: user,
            apiKey: currentKey,
            maxTokens: 4096,
            tracer: firstTracer,
            parent: ROOT_CONTEXT,
            purpose: 'wiki-bg',
            ...(wikiOnUsage && { onUsage: wikiOnUsage })
          })
        }

        const pacing = resolveWikiPacing(wikiSettings.speed || 'medium')

        wikiAgent = createWikiAgent({
          callLlm,
          projectPaths: () => {
            const paths: string[] = []
            for (const [, s] of windowStates) {
              if (s.projectPath) paths.push(s.projectPath)
            }
            return [...new Set(paths)]
          },
          pacing,
          onStatus: (status) => broadcastWikiStatus(status),
          debug: !!process.env.RESEARCH_COPILOT_DEBUG,
        })
        wikiAgent.start()
      } catch (err) {
        // Wiki agent failed to start — coordinator unchanged
        if (process.env.RESEARCH_COPILOT_DEBUG) {
          console.error('[wiki-agent] failed to start:', err)
        }
      }
    }
  })().catch(() => {})

  // ─── Wiki IPC handlers ─────────────────────────────────────────────────
  ipcMain.handle('wiki:get-status', () => {
    // Return the cached status from the most recent onStatus callback.
    // This preserves real processed/pending/state counters from the wiki agent.
    return lastWikiStatus
  })

  ipcMain.handle('wiki:get-stats', () => {
    const ftStatus = countByFulltextStatus()
    return {
      papers: countPaperPages(),
      concepts: countConceptPages(),
      fulltext: ftStatus.fulltext,
      abstractOnly: ftStatus.abstractOnly + ftStatus.abstractFallback,
    }
  })

  ipcMain.handle('wiki:get-log', () => readRecentLog(20))

  ipcMain.handle('wiki:pause', () => {
    if (!wikiAgent) return { success: false, error: 'Wiki agent not running' }
    wikiAgent.pause()
    return { success: true }
  })

  ipcMain.handle('wiki:resume', () => {
    if (!wikiAgent) return { success: false, error: 'Wiki agent not running' }
    wikiAgent.resume()
    return { success: true }
  })

  ipcMain.handle('wiki:list-pages', () => listWikiPages())

  ipcMain.handle('wiki:read-page', (_event: any, slug: string) => readWikiPage(slug))

  ipcMain.handle('wiki:slug-for-paper', (_event: any, artifactId: string, projectPath: string) =>
    wikiSlugForPaperArtifact(artifactId, projectPath)
  )

  ipcMain.handle('wiki:paper-slug-map', () => buildPaperSlugMap())

  ipcMain.handle('wiki:list-paper-meta', () => listWikiPaperMeta())

  ipcMain.handle('wiki:reconcile-identity', async (_event: any, opts?: { dryRun?: boolean }) => {
    const dryRun = opts?.dryRun !== false  // default to dry-run for safety
    try {
      const report = await reconcileIdentityDrift({ dryRun })
      return { success: true, report }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ─── App-specific handlers ──────────────────────────────────────────────

  // Agent chat
  handleWindow(
    'agent:send',
    async (
      { win, state },
      message: string,
      rawMentions?: string,
      model?: string,
      images?: Array<{ base64: string; mimeType: string }>,
      // Telemetry envelope (spec §4.1). `clientMessageId` becomes the canonical
      // turnId; `clientTimestamp` is the ms-since-epoch of the user's send press.
      // P0: optional + minted if absent (so older renderer builds keep working).
      // P1 will make this required and consume turnId in the trace path.
      envelope?: { clientMessageId: string; clientTimestamp: number }
    ) => {
    if (!state.projectPath) {
      const errResult = { success: false, error: 'No project folder selected. Please select a folder first.' }
      safeSend(win, 'agent:done', errResult)
      return errResult
    }

    // Resolve telemetry envelope: prefer renderer-supplied id, fall back to mint.
    // Stored on the per-window state so P1 can read it from the coordinator path.
    const turnId = envelope?.clientMessageId ?? `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const clientTimestamp = envelope?.clientTimestamp ?? Date.now()
    state.lastTurnId = turnId
    state.lastClientTimestamp = clientTimestamp

    // Telemetry §8.3: append a user-response-signals ledger row. Pure facts:
    // turnId, content hash, length, prior-turn link, gap-since-prev. No
    // approval/rejection/confidence labels — that's Layer 3.
    if (state.tracer && state.projectPath) {
      try {
        const writer = createUserResponseSignalsWriter(state.projectPath)
        const contentHash =
          'sha256:' + createHash('sha256').update(message ?? '').digest('hex')
        const prevTimestamp = state.lastClientTimestamp ?? clientTimestamp
        void writer.append({
          turnId,
          previousTurnId: state.previousTurnId,
          gapMsSincePreviousAssistant: state.lastAssistantTimestamp
            ? clientTimestamp - state.lastAssistantTimestamp
            : undefined,
          messageContentHash: contentHash,
          messageCharLen: (message ?? '').length,
          referencedArtifactIds: []
        })
        state.previousTurnId = turnId
        void prevTimestamp
      } catch {
        // ignore — ledger write must never block the agent
      }
    }

    const requestedModel = model || state.currentModel
    let coord: Awaited<ReturnType<typeof ensureCoordinator>>
    try {
      coord = await ensureCoordinator(state, win, requestedModel)
    } catch (err: any) {
      const errResult = { success: false, error: err.message || 'Failed to initialize coordinator.' }
      safeSend(win, 'agent:done', errResult)
      return errResult
    }
    // Abort any recap still generating from the previous turn before this turn
    // mutates agent.state.messages — keeps generateRecap from reading a
    // half-written context.
    state.recapAbort?.abort()
    // Only clear activity (per-run), NOT progress/todos (persist across turns)
    state.realtimeBuffer.clearActivity()
    safeSend(win, 'agent:activity-clear')
    // Always parse mentions from the message text itself — mention tokens
    // like @file:"path" are inline in the user's message.
    let mentions: any[] = []
    const parsed = parseMentions(message)
    if (parsed.mentions.length > 0) {
      mentions = await resolveMentions(parsed.mentions, state.projectPath)
    }
    try {
      // Wiki activity broker: pause wiki agent during coordinator activity
      onCoordinatorActive()
      const result = await coord.chat(message, mentions, images)
      onCoordinatorIdle()
      state.realtimeBuffer.finishStreaming()
      // Telemetry §8.3: stamp completion time so the next user-response-signal
      // row can compute gapMsSincePreviousAssistant.
      state.lastAssistantTimestamp = Date.now()
      safeSend(win, 'agent:done', result)
      return result
    } catch (err: any) {
      onCoordinatorIdle()
      state.realtimeBuffer.finishStreaming()
      const errResult = { success: false, error: err.message }
      safeSend(win, 'agent:done', errResult)
      return errResult
    }
    }
  )

  // Realtime state recovery (renderer calls this on mount to restore lost state)
  handleWindow('agent:get-realtime-snapshot', ({ state }) => {
    return state.realtimeBuffer.getSnapshot()
  })

  // Stop running agent
  handleWindow('agent:stop', ({ state }) => {
    if (state.coordinator) {
      state.coordinator.abort()
    }
  })

  // Clear session memory
  handleWindow('agent:clear-memory', async ({ state }) => {
    if (state.coordinator) {
      await (state.coordinator as any).clearSessionMemory()
    }
  })

  // Auto-recap: latest persisted recap for this session (null when none).
  // Read on project reopen so the "where you left off" card can show the recap
  // generated after the last response.
  handleWindow('recap:get-latest', ({ state }): RecapRecord | null => {
    if (!state.projectPath || !state.sessionId) return null
    return readLatestRecap(state.projectPath, state.sessionId)
  })

  // Auto-recap: generate now (requested by the renderer when the user goes
  // away). The renderer gates the trigger conditions; this runs + persists +
  // pushes via 'recap:update'. Awaited so the renderer's promise settles, but
  // it never rejects.
  handleWindow('recap:generate', async ({ win, state }): Promise<{ ok: boolean }> => {
    await generateAndPushRecap(state, win)
    return { ok: true }
  })

  // Commands - entities
  handleWindow('cmd:list-notes', ({ state }) => {
    if (!state.projectPath) return []
    return listNotes(state.projectPath)
  })
  handleWindow('cmd:list-literature', ({ state }) => {
    if (!state.projectPath) return []
    return listLiterature(state.projectPath)
  })
  handleWindow('cmd:list-data', ({ state }) => {
    if (!state.projectPath) return []
    return listData(state.projectPath)
  })
  handleWindow('cmd:search', ({ state }, query: string) => {
    if (!state.projectPath) return []
    return searchEntities(state.projectPath, query)
  })
  handleWindow('cmd:delete', ({ state }, id: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const result = deleteEntity(id, state.projectPath)
    invalidateEntityCache(state.projectPath)
    return result
  })

  // Commands - Artifact (RFC-012 canonical)
  handleWindow('cmd:artifact-create', ({ state }, input: Record<string, unknown>) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const result = artifactCreate(input as any, { sessionId: state.sessionId, projectPath: state.projectPath })
    if (result && typeof result === 'object' && 'success' in result && (result as any).success) {
      invalidateEntityCache(state.projectPath)
    }
    return result
  })
  handleWindow('cmd:artifact-update', ({ state }, artifactId: string, patch: Record<string, unknown>) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const result = artifactUpdate(state.projectPath, artifactId, patch as any)
    if (result && typeof result === 'object' && 'success' in result && (result as any).success) {
      invalidateEntityCache(state.projectPath)
    }
    return result
  })
  handleWindow('cmd:artifact-get', ({ state }, artifactId: string) => {
    if (!state.projectPath) return null
    return artifactGet(state.projectPath, artifactId)
  })
  handleWindow('cmd:artifact-list', ({ state }, types?: string[]) => {
    if (!state.projectPath) return []
    return artifactList(state.projectPath, types as any)
  })
  handleWindow('cmd:artifact-search', ({ state }, query: string, types?: string[]) => {
    if (!state.projectPath) return []
    return artifactSearch(state.projectPath, query, types as any)
  })
  handleWindow('cmd:artifact-delete', ({ state }, artifactId: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const result = artifactDelete(state.projectPath, artifactId)
    if (result && typeof result === 'object' && 'success' in result && (result as any).success) {
      invalidateEntityCache(state.projectPath)
    }
    return result
  })

  // Memory (auto-memory) — files under .research-pilot/memory/, indexed in
  // agent.md. Mirrors lib/memory/memory-tools (which the agent uses) but
  // surfaced to the user via the Library panel.
  handleWindow('cmd:memory-list', ({ state }) => {
    if (!state.projectPath) return [] as MemoryEntry[]
    return listMemoryFiles(state.projectPath)
  })
  handleWindow('cmd:memory-get', ({ state }, filename: string) => {
    if (!state.projectPath) return null
    return readMemoryFile(state.projectPath, filename)
  })
  // Save handles both create and update. When `filename` is omitted a new
  // file is written; when provided and the resulting filename differs (the
  // user changed name or type), the old file is removed before writing.
  // The agent.md index is rebuilt under withIndexLock on every save so the
  // list the agent sees stays in lockstep with disk.
  handleWindow(
    'cmd:memory-save',
    async (
      { state },
      input: { filename?: string; name: string; type: MemoryType; description: string; content: string },
    ) => {
      if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
      const projectPath = state.projectPath
      try {
        return await withIndexLock(() => {
          const newFilename = memoryFilename(input.type, input.name)
          if (input.filename && input.filename !== newFilename) {
            deleteMemoryFile(projectPath, input.filename)
          }
          writeMemoryFile(projectPath, {
            frontmatter: {
              name: input.name,
              description: input.description,
              type: input.type,
            },
            content: input.content,
            filename: newFilename,
          })
          const entries = listMemoryFiles(projectPath)
          const indexResult = updateAgentMdIndex(projectPath, entries)
          if (!indexResult.success) {
            return {
              success: false,
              error: `agent.md index would exceed size limit (${indexResult.charCount} chars).`,
            }
          }
          invalidateEntityCache(projectPath)
          return { success: true, filename: newFilename }
        })
      } catch (err: any) {
        return { success: false, error: err?.message || 'Failed to save memory.' }
      }
    },
  )
  handleWindow('cmd:memory-delete', async ({ state }, filename: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const projectPath = state.projectPath
    try {
      return await withIndexLock(() => {
        const removed = deleteMemoryFile(projectPath, filename)
        if (!removed) return { success: false, error: 'Memory file not found.' }
        const entries = listMemoryFiles(projectPath)
        updateAgentMdIndex(projectPath, entries)
        invalidateEntityCache(projectPath)
        return { success: true }
      })
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to delete memory.' }
    }
  })

  // Commands - Context debug (read-only)
  handleWindow('cmd:turn-explain-get', ({ state }) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    return memoryExplainTurn(state.projectPath)
  })

  // Commands - Session summary
  handleWindow('cmd:session-summary-get', ({ state }) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    return sessionSummaryGet(state.projectPath, state.sessionId)
  })

  // Commands - enrich all papers
  handleWindow('cmd:enrich-papers', async ({ win, state }, paperIds?: string[]) => {
    if (!state.projectPath) return { success: false, enriched: 0, skipped: 0, failed: 0 }
    return enrichPaperArtifacts({
      sessionId: state.sessionId,
      projectPath: state.projectPath,
      paperIds,
      debug: !!process.env.RESEARCH_COPILOT_DEBUG,
      onProgress: (event) => {
        safeSend(win, 'enrich:progress', event)
      }
    })
  })

  // Commands - import BibTeX (RFC-006 PR-3)
  //
  // Two flavors:
  //   cmd:import-bibtex          → caller supplies a file path on disk
  //   cmd:import-bibtex-string   → caller supplies the .bib text directly
  //                                (used when the wizard reads the file in
  //                                the renderer for size-check / preview)
  //
  // Both emit `import:progress` events with one entry per parsed
  // BibTeX entry (added / merged / merged-no-change / duplicate-in-file
  // / failed). The result includes `importedPaperIds`, which the caller
  // is expected to chain into `cmd:enrich-papers` so CrossRef and
  // Semantic Scholar fill in missing fields.
  //
  // Both handlers return a failure-shaped result instead of throwing for
  // known soft errors (no project open, hard-fail from the importer) so
  // the renderer can render them in the UI. For unexpected errors we
  // still let the IPC layer surface the throw via `safeSend`.
  handleWindow(
    'cmd:import-bibtex',
    async ({ win, state }, bibPath: string): Promise<{ success: true; result: BibImportResult } | { success: false; error: string }> => {
      if (!state.projectPath) {
        return { success: false, error: 'No project folder selected.' }
      }
      if (typeof bibPath !== 'string' || !bibPath.trim()) {
        return { success: false, error: 'BibTeX file path is required.' }
      }
      try {
        const result = await importBibtexFile(bibPath, {
          ctx: { sessionId: state.sessionId, projectPath: state.projectPath, debug: false },
          onProgress: (event: BibImportProgressEvent) => safeSend(win, 'import:progress', event)
        })
        return { success: true, result }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        return { success: false, error }
      }
    }
  )

  handleWindow(
    'cmd:import-bibtex-string',
    async ({ win, state }, contents: string): Promise<{ success: true; result: BibImportResult } | { success: false; error: string }> => {
      if (!state.projectPath) {
        return { success: false, error: 'No project folder selected.' }
      }
      if (typeof contents !== 'string') {
        return { success: false, error: 'BibTeX content is required.' }
      }
      try {
        const result = await importBibtexString(contents, {
          ctx: { sessionId: state.sessionId, projectPath: state.projectPath, debug: false },
          onProgress: (event: BibImportProgressEvent) => safeSend(win, 'import:progress', event)
        })
        return { success: true, result }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        return { success: false, error }
      }
    }
  )

  // Native file picker scoped to .bib files. Used by the Quickstart
  // wizard (PR-4) so it doesn't need its own dialog wiring. Returns
  // the absolute path the user chose, or null if they canceled.
  handleWindow('cmd:pick-bibtex-file', async ({ win }) => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select a BibTeX file',
      properties: ['openFile'],
      filters: [
        { name: 'BibTeX', extensions: ['bib', 'bibtex'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  // ─── Paper Pack Report (RFC-007 PR-B) ────────────────────────────────
  //
  // Generation uses the user's currently-configured chat model. The
  // single LLM call inside the generator is wrapped with the same
  // subscription-token refresh logic the wiki agent uses (lines 1063+).
  //
  // We guard against double-clicks by checking the persisted state up
  // front — the renderer-side state machine already disables the button
  // during 'generating', but a fast double-RPC can race that.
  handleWindow('cmd:generate-paper-report', async ({ win, state }, opts?: { force?: boolean }) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }

    // Quick double-fire guard: refuse if a run is already in flight.
    const existing = readPaperReportState(state.projectPath)
    if (existing?.status === 'running' && !opts?.force) {
      return { success: false, error: 'A report generation is already running.' }
    }

    // Resolve model + auth — same pattern as the wiki agent's callLlm.
    const modelStr = state.currentModel
    const auth = resolveCoordinatorAuth(modelStr)

    // piModel is typed as the dynamic-import getModel's return type; we
    // resolve it inline because the import is async (lazy).
    let piModel: unknown = null
    let resolveApiKey: () => Promise<string>
    try {
      const { getModel: piGetModelLocal } = await import('@mariozechner/pi-ai')
      const [rawProvider, modelId] = modelStr.split(':')
      // Match the existing wiki-agent cast: pi-ai's getModel has an
      // exhaustive provider literal, but our currentModel string is
      // dynamic. Cast to any (same pattern as line ~1027).
      const piProvider = rawProvider === 'anthropic-sub' ? 'anthropic' : rawProvider
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      piModel = piGetModelLocal(piProvider as any, modelId)

      if (auth.authMode === 'subscription' && auth.piProvider === 'anthropic-sub') {
        resolveApiKey = async () => {
          const creds = loadAnthropicSubCredentials()
          if (!creds) throw new Error('Claude subscription credentials not found.')
          if (creds.expires < Date.now() + 60_000) {
            const { refreshAnthropicToken } = await import('@mariozechner/pi-ai/oauth')
            const fresh = await refreshAnthropicToken(creds.refresh)
            saveAnthropicSubCredentials(fresh)
            return fresh.access
          }
          return creds.access
        }
      } else if (auth.authMode === 'subscription') {
        resolveApiKey = async () => {
          const creds = loadCodexCredentials()
          if (!creds) throw new Error('Codex credentials not found.')
          if (creds.expires < Date.now() + 60_000) {
            const { refreshOpenAICodexToken } = await import('@mariozechner/pi-ai/oauth')
            const fresh = await refreshOpenAICodexToken(creds.refresh)
            saveCodexCredentials(fresh)
            return fresh.access
          }
          return creds.access
        }
      } else {
        resolveApiKey = async () => auth.apiKey
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }

    const callLlm = async (system: string, user: string): Promise<string> => {
      const apiKey = await resolveApiKey()
      // authMode is intentionally omitted — the semantic-registry's
      // narrower string union differs from resolveCoordinatorAuth's,
      // and the field is optional. Skipping it just affects one OTel
      // span attribute, not behavior.
      return runSubLlmText({
        model: piModel as unknown as Parameters<typeof runSubLlmText>[0]['model'],
        systemPrompt: system,
        userContent: user,
        apiKey,
        purpose: 'paper-pack-report',
        tracer: state.tracer ?? null,
      })
    }

    const result = await generatePaperPackReport({
      projectPath: state.projectPath,
      callLlm,
      force: opts?.force,
      onProgress: (event: PaperReportProgressEvent) => {
        safeSend(win, 'report:progress', event)
      },
    })
    return result
  })

  // Read persisted state — used by the renderer on app startup to
  // hydrate the report-store, and after every generation to confirm
  // what landed on disk.
  handleWindow('cmd:get-paper-report-state', ({ state }) => {
    if (!state.projectPath) return null
    return readPaperReportState(state.projectPath)
  })

  // Open the generated HTML in the user's default browser.
  // shell.openPath handles cross-platform file:// resolution.
  handleWindow('cmd:open-paper-report', async ({ state }) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const reportState = readPaperReportState(state.projectPath)
    if (!reportState?.htmlPath) return { success: false, error: 'No report has been generated yet.' }
    const result = await shell.openPath(reportState.htmlPath)
    if (result) return { success: false, error: result }  // shell returns error string on failure
    return { success: true }
  })


  // Mentions -- signature: getCandidates(projectPath, typeFilter?, query?)
  handleWindow('mention:candidates', async ({ state }, query: string, type?: string) => {
    if (!state.projectPath) return []
    try {
      return await getCandidates(state.projectPath, type as any, query)
    } catch {
      return []
    }
  })

  handleWindow('file:write', ({ state }, filePath: string, content: string) => {
    try {
      if (!state.projectPath) {
        return { success: false, error: 'No project folder selected.' }
      }
      if (typeof content !== 'string') {
        return { success: false, error: 'Invalid content.' }
      }
      const absPath = isAbsolute(filePath) ? filePath : resolve(state.projectPath, filePath)
      if (!isWithinRoot(state.projectPath, absPath)) {
        return { success: false, error: 'Path is outside current workspace.' }
      }
      if (!existsSync(absPath)) {
        return { success: false, error: 'File not found' }
      }

      const ext = extname(absPath).toLowerCase()
      const editableTextExts = new Set([
        '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.xml', '.log', '.ini', '.toml', '.cfg'
      ])
      if (ext && !editableTextExts.has(ext)) {
        return { success: false, error: 'Only text files can be edited in preview.' }
      }

      writeFileSync(absPath, content, 'utf-8')
      return { success: true, path: absPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handleWindow('file:create-artifact', ({ state }, filePath: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const absPath = isAbsolute(filePath) ? filePath : resolve(state.projectPath, filePath)
    if (!isWithinRoot(state.projectPath, absPath)) {
      return { success: false, error: 'Path is outside current workspace.' }
    }
    if (!existsSync(absPath)) {
      return { success: false, error: 'File not found.' }
    }
    return createArtifactFromWorkspaceFile(state, absPath)
  })

  // New file creation
  handleWindow('file:create', ({ state }, relativePath: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const absPath = resolve(state.projectPath, relativePath)
    if (!isWithinRoot(state.projectPath, absPath)) {
      return { success: false, error: 'Path is outside current workspace.' }
    }
    if (existsSync(absPath)) {
      return { success: false, error: 'File already exists.' }
    }
    try {
      const parentDir = dirname(absPath)
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })
      writeFileSync(absPath, '', 'utf-8')
      return { success: true, absPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // New directory creation
  handleWindow('file:create-dir', ({ state }, relativePath: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const absPath = resolve(state.projectPath, relativePath)
    if (!isWithinRoot(state.projectPath, absPath)) {
      return { success: false, error: 'Path is outside current workspace.' }
    }
    if (existsSync(absPath)) {
      return { success: false, error: 'Directory already exists.' }
    }
    try {
      mkdirSync(absPath, { recursive: true })
      return { success: true, absPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Rename file or directory
  handleWindow('file:rename', async ({ state }, oldRelPath: string, newRelPath: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const { rename: fsRename } = await import('fs/promises')
    const oldAbs = resolve(state.projectPath, oldRelPath)
    const newAbs = resolve(state.projectPath, newRelPath)
    if (!isWithinRoot(state.projectPath, oldAbs) || !isWithinRoot(state.projectPath, newAbs)) {
      return { success: false, error: 'Path is outside current workspace.' }
    }
    if (!existsSync(oldAbs)) {
      return { success: false, error: 'Source path not found.' }
    }
    if (existsSync(newAbs)) {
      return { success: false, error: 'Destination already exists.' }
    }
    try {
      const parentDir = dirname(newAbs)
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })
      await fsRename(oldAbs, newAbs)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Drop file handler -- copies file into project and creates entity
  // ─── File conversion (PDF, DOCX → text for chat attachment) ───────────
  handleWindow('file:convert-to-text', async ({ state }, fileName: string, base64Data: string) => {
    try {
      const { tmpdir } = await import('os')
      const tmpDir = join(tmpdir(), 'research-pilot-convert')
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })

      const tmpPath = join(tmpDir, `${Date.now()}-${fileName}`)
      const buffer = Buffer.from(base64Data, 'base64')
      writeFileSync(tmpPath, buffer)

      const ext = extname(fileName).replace('.', '').toLowerCase()

      // Try markitdown first
      const { execFile: execFileCb } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFileCb)

      let content: string
      try {
        const { stdout } = await execFileAsync('markitdown', [tmpPath], {
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024
        })
        content = stdout
      } catch {
        // Fallback: for text-like formats, read directly
        const textFormats = ['txt', 'md', 'csv', 'json', 'xml', 'html']
        if (textFormats.includes(ext)) {
          content = readFileSync(tmpPath, 'utf-8')
        } else {
          // Try pypdf for PDF
          if (ext === 'pdf') {
            try {
              const { stdout } = await execFileAsync('python3', [
                '-c',
                `import pypdf; r=pypdf.PdfReader("${tmpPath}"); print("\\n".join(p.extract_text() or "" for p in r.pages))`
              ], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })
              content = stdout
            } catch {
              // Clean up tmp file
              try { (await import('fs/promises')).unlink(tmpPath).catch(() => {}) } catch {}
              return { success: false, error: 'No converter available. Install markitdown (pip install markitdown[all]) or pypdf.' }
            }
          } else {
            // Clean up tmp file
            try { (await import('fs/promises')).unlink(tmpPath).catch(() => {}) } catch {}
            return { success: false, error: `Cannot convert .${ext} files. Install markitdown (pip install markitdown[all]).` }
          }
        }
      }

      // Clean up tmp file
      try { (await import('fs/promises')).unlink(tmpPath).catch(() => {}) } catch {}

      // Truncate if too large (500K chars max)
      if (content.length > 500_000) {
        content = content.slice(0, 500_000) + '\n\n[... content truncated ...]'
      }

      return { success: true, content }
    } catch (err: any) {
      return { success: false, error: err.message || 'Conversion failed' }
    }
  })

  handleWindow('file:drop', async ({ state }, fileName: string, content: string, tab: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }

    if (tab === 'notes') {
      // Save text content as a note entity
      const title = fileName.replace(/\.\w+$/, '')
      return artifactCreate(
        {
          type: 'note',
          title,
          content,
          provenance: {
            source: 'user',
            extractedFrom: 'file-import'
          }
        },
        { sessionId: state.sessionId, projectPath: state.projectPath, lastAgentResponse: '' }
      )
    }

    if (tab === 'data') {
      // Write file into .research-pilot/data/ and register as data entity
      const dataDir = join(state.projectPath, PATHS.data)
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
      const destPath = join(dataDir, fileName)
      writeFileSync(destPath, content, 'utf-8')

      const ext = fileName.split('.').pop()?.toLowerCase() || ''
      const mimeMap: Record<string, string> = { csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json' }
      return artifactCreate(
        {
          type: 'data',
          title: fileName.replace(/\.\w+$/, ''),
          filePath: destPath,
          mimeType: mimeMap[ext],
          provenance: {
            source: 'user',
            extractedFrom: 'file-import'
          }
        },
        { sessionId: state.sessionId, projectPath: state.projectPath, lastAgentResponse: '' }
      )
    }

    if (tab === 'papers') {
      // Save as a literature reference with content as abstract
      const title = fileName.replace(/\.\w+$/, '')
      const stamp = Date.now()
      return artifactCreate(
        {
          type: 'paper',
          title,
          authors: ['Unknown'],
          abstract: content,
          citeKey: `unknown${stamp}`,
          doi: `unknown:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'paper'}`,
          bibtex: `@article{unknown${stamp},\n  title = {${title}}\n}`,
          provenance: {
            source: 'user',
            extractedFrom: 'file-import'
          }
        },
        { sessionId: state.sessionId, projectPath: state.projectPath, lastAgentResponse: '' }
      )
    }

    return { success: false, error: `Unknown tab: ${tab}` }
  })

  // ─── Skills ───────────────────────────────────────────────────────────
  handleWindow('skills:list', ({ state }) => {
    if (!state.projectPath) return []
    return buildSkillManifests(state.projectPath)
  })

  handleWindow('skills:set-enabled', async ({ win, state }, enabledSkills: string[]) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    writeEnabledSkills(state.projectPath, enabledSkills)
    // Recreate coordinator so it picks up the new skill set
    if (state.coordinator) {
      state.coordinator.destroy().catch(() => {})
      state.coordinator = null
    }
    return { success: true }
  })

  handleWindow('skills:upload', async ({ state }, fileName: string, base64Data: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const os = await import('os')
    const tmpDir = join(os.tmpdir(), `rp-skill-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      // Decode base64 zip
      const buffer = Buffer.from(base64Data, 'base64')
      const AdmZip = (await import('adm-zip')).default
      const zip = new AdmZip(buffer)
      zip.extractAllTo(tmpDir, true)

      // Find SKILL.md in the extracted content
      const { readdirSync, statSync } = await import('fs')
      let skillMdDir: string | null = null

      // Check root level
      if (existsSync(join(tmpDir, 'SKILL.md'))) {
        skillMdDir = tmpDir
      } else {
        // Check one level deep (single folder inside zip)
        const entries = readdirSync(tmpDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory() && existsSync(join(tmpDir, entry.name, 'SKILL.md'))) {
            skillMdDir = join(tmpDir, entry.name)
            break
          }
        }
      }

      if (!skillMdDir) {
        return { success: false, error: 'No SKILL.md found in the uploaded ZIP.' }
      }

      // Read SKILL.md to get the skill name
      const skillContent = readFileSync(join(skillMdDir, 'SKILL.md'), 'utf-8')
      const nameMatch = skillContent.match(/^---\n[\s\S]*?^name:\s*(.+)$/m)
      if (!nameMatch) {
        return { success: false, error: 'SKILL.md missing required "name" field in frontmatter.' }
      }
      const skillName = nameMatch[1].trim().replace(/^["']|["']$/g, '')

      // Install to workspace
      installSkillToWorkspace(state.projectPath, skillName, skillMdDir)

      // Auto-enable the newly installed skill
      const current = readEnabledSkills(state.projectPath)
      if (current !== null && !current.includes(skillName)) {
        writeEnabledSkills(state.projectPath, [...current, skillName])
      }

      // Invalidate coordinator
      if (state.coordinator) {
        state.coordinator.destroy().catch(() => {})
        state.coordinator = null
      }

      return { success: true, skillName }
    } catch (err: any) {
      return { success: false, error: err.message }
    } finally {
      // Cleanup temp dir
      try {
        const { rmSync } = await import('fs')
        rmSync(tmpDir, { recursive: true, force: true })
      } catch { /* best effort */ }
    }
  })

  // Session
  handleWindow('session:current', ({ state }) => ({ sessionId: state.sessionId, projectPath: state.projectPath }))

  // ─── Telemetry: project config (§10.2) + storage stats ────────────────
  // Project-scoped — distinct from global AppSettings IPC. Returns the full
  // config plus a derived `storageFootprintBytes` summary (sum of stats rows).
  handleWindow('telemetry:get-project-config', async ({ state }, force?: boolean) => {
    if (!state.projectPath) return null
    try {
      const projectFile = join(state.projectPath, PATHS.project)
      const config = JSON.parse(readFileSync(projectFile, 'utf8')) as ProjectConfig
      // Schema v2: telemetry config lives in the LOCAL preferences.json, not the
      // shared project.json (RFC-013). Default 'disabled' matches opt-in policy.
      const tp = readTelemetryPrefs(state.projectPath)
      const tracingMode = tp.tracingMode
      const bufferCapacity = tp.bufferCapacity
      // Storage footprint: walk the filesystem under .research-pilot/ for every
      // telemetry-owned file/dir per spec §5+§8. This is the honest "what's on
      // disk" answer — includes pre-existing traces from before live readout,
      // crash-recovered runs, every UTC day's spans file, blobs, ledgers, and
      // the various .jsonl logs.
      const telemetryPaths = [
        PATHS.traces,
        PATHS.blobs,
        PATHS.traceDigest,
        PATHS.traceStorageStats,
        PATHS.tracingState,
        PATHS.userResponseSignals,
        PATHS.viewLog,
        PATHS.ledgerArtifact,
        PATHS.ledgerMemory
      ]
      // TTL-cached: the Settings panel can call this on every manual refresh,
      // and an active project may also poll opportunistically. Walking
      // .research-pilot/ on every call would re-scan thousands of blob files.
      const cached = footprintCache.get(state.projectPath)
      const now = Date.now()
      let storageFootprintBytes: number
      if (!force && cached && now - cached.computedAt < FOOTPRINT_TTL_MS) {
        storageFootprintBytes = cached.bytes
      } else {
        const sizes = await Promise.all(
          telemetryPaths.map((rel) => duFileOrDirAsync(join(state.projectPath, rel)))
        )
        storageFootprintBytes = sizes.reduce((a, b) => a + b, 0)
        footprintCache.set(state.projectPath, { bytes: storageFootprintBytes, computedAt: now })
      }
      // In-flight bytes is the live counter inside TraceStore — bytes
      // queued/written THIS session but the filesystem stat may lag a few ms
      // for the very latest flush. Reported separately so the UI can show
      // "X in current session" when it's nonzero.
      const inFlight = state.tracer?.store.inFlightDailyBytes ?? { date: '', approxBytes: 0 }
      return {
        projectId: config.id ?? 'unknown',
        tracingMode,
        bufferCapacity,
        storageFootprintBytes,
        inFlightBytes: inFlight.approxBytes,
        persistedBytes: storageFootprintBytes
      }
    } catch (err: any) {
      return { error: err?.message ?? 'failed' }
    }
  })

  handleWindow(
    'telemetry:set-tracing-mode',
    async ({ state }, mode: 'enabled' | 'disabled') => {
      if (!state.projectPath) return { success: false, error: 'no project' }
      try {
        // Schema v2: persist to LOCAL preferences.json (RFC-013), not the shared
        // project.json — telemetry on/off is a per-member choice that must never
        // propagate via sync.
        writeTelemetryPrefs(state.projectPath, { tracingMode: mode })
        // Apply at runtime: drain queue or rebuild tracer on toggle.
        if (state.tracer) {
          if (mode === 'disabled') {
            await state.tracer.store.disable('user-toggle')
          } else {
            state.tracer.store.enable('user-toggle')
          }
        } else if (mode === 'enabled') {
          // Rebuild tracer if it had been torn down.
          state.tracer = await createTracerForProject(state.projectPath, state.sessionId).catch(() => null)
        }
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err?.message }
      }
    }
  )

  // ─── Telemetry: trace snapshot (P2.2 — remount recovery) ──────────────
  handleWindow('telemetry:trace-snapshot', ({ state }, traceId: string) => {
    if (!state.projectPath) return { traceId, spans: [] }
    if (typeof traceId !== 'string' || !/^[0-9a-f]{32}$/.test(traceId)) {
      return { traceId, spans: [], error: 'invalid traceId' }
    }
    try {
      return loadTraceSnapshot(state.projectPath, traceId)
    } catch (err: any) {
      return { traceId, spans: [], error: err?.message ?? 'snapshot failed' }
    }
  })

  // ─── Telemetry: view log (§8.4) ────────────────────────────────────────
  // Renderer pushes passive view events (artifact opened, summary scrolled).
  // Disabled when tracingMode=disabled (no tracer = no writer).
  handleWindow(
    'telemetry:view-log',
    async (
      { state },
      payload: {
        viewId: string
        target: { kind: 'artifact' | 'memory' | 'trace' | 'session-summary'; id: string }
        op: 'view' | 'hover' | 'scroll' | 'dismiss'
        durationMs?: number
        turnId?: string
      }
    ) => {
      if (!state.tracer || !state.projectPath) return { success: false, reason: 'tracing-disabled' }
      try {
        const projectFile = join(state.projectPath, PATHS.project)
        const config = JSON.parse(readFileSync(projectFile, 'utf8')) as ProjectConfig
        const writer = createViewLogWriter(state.projectPath)
        await writer.append({
          viewId: payload.viewId,
          projectId: config.id ?? 'unknown',
          sessionId: state.sessionId,
          turnId: payload.turnId,
          target: payload.target,
          op: payload.op,
          durationMs: payload.durationMs
        })
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err?.message }
      }
    }
  )

  // RFC-008 §7.5: compute IPC consolidated to three handlers + one
  // outbound `compute:event` channel (subscribed inside
  // ensureCoordinator). Old handlers — compute:probe-environment,
  // compute:hydrate-runs, compute:modal-approve, compute:modal-reject —
  // are replaced by compute:hydrate / compute:approve-plan /
  // compute:reject-plan, each backend-agnostic.

  handleWindow('compute:hydrate', async ({ state }) => {
    // Coordinator is initialized eagerly on project open (see
    // openProjectFolder), so the registry should be present by the time
    // the renderer asks. Return an empty snapshot if the renderer races
    // ahead of init — applyEvent will fill in once availability-changed
    // events arrive.
    if (!state.coordinator?.computeRegistry) {
      return { runs: [], pendingPlans: [] }
    }
    return state.coordinator.computeRegistry.hydrate()
  })

  handleWindow('compute:approve-plan', ({ state }, payload: { backend: string; planId: string }) => {
    if (!state.coordinator?.computeRegistry) return { success: false, error: 'Compute registry not initialized' }
    if (!payload || typeof payload.backend !== 'string' || typeof payload.planId !== 'string') {
      return { success: false, error: 'backend and planId are required' }
    }
    return state.coordinator.computeRegistry.approvePlan(payload.backend, payload.planId)
  })

  handleWindow('compute:reject-plan', ({ state }, payload: { backend: string; planId: string; comments: string }) => {
    if (!state.coordinator?.computeRegistry) return { success: false, error: 'Compute registry not initialized' }
    if (!payload || typeof payload.backend !== 'string' || typeof payload.planId !== 'string') {
      return { success: false, error: 'backend and planId are required' }
    }
    return state.coordinator.computeRegistry.rejectPlan(payload.backend, payload.planId, typeof payload.comments === 'string' ? payload.comments : '')
  })

  handleWindow('compute:refresh-availability', async ({ state }) => {
    if (!state.coordinator?.computeRegistry) {
      return { success: false, error: 'Compute registry not initialized' }
    }
    try {
      await state.coordinator.computeRegistry.refreshAvailability()
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  // RFC-009 §3.3: per-service AWS connection test. Hits sts:GetCallerIdentity
  // plus per-service capability probes (S3 / EC2). Returns a structured
  // report the AWS settings section renders inline.
  handleWindow('compute:test-aws-connection', async () => {
    try {
      const aws = (resolveSettings(loadSettingsFromConfig()).compute.backends['aws-ec2'] ?? {}) as Record<string, unknown>
      const provider = new AwsCredentialProvider({
        getSettings: () => ({
          region: typeof aws.region === 'string' ? aws.region : undefined,
          profile: typeof aws.profile === 'string' ? aws.profile : undefined,
        }),
      })
      let resolution: any
      try {
        resolution = provider.resolve()
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) }
      }

      const sts = await provider.validate(resolution.credentials)
      if (!sts.valid) {
        return {
          success: true,
          source: resolution.source,
          stsValid: false,
          stsError: sts.error,
          accountId: undefined,
          arn: undefined,
          s3: { ok: false, error: 'Skipped (STS failed)' },
          ec2: { ok: false, error: 'Skipped (STS failed)' },
        }
      }

      const s3Result = await (async () => {
        try {
          const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3')
          const client = new S3Client({
            region: resolution.credentials.region,
            credentials: toSdkCredentials(resolution.credentials),
          })
          await client.send(new ListBucketsCommand({}))
          return { ok: true as const }
        } catch (err: any) {
          return { ok: false as const, error: err?.message || String(err) }
        }
      })()
      const ec2Result = await (async () => {
        try {
          const { EC2Client, DescribeRegionsCommand } = await import('@aws-sdk/client-ec2')
          const client = new EC2Client({
            region: resolution.credentials.region,
            credentials: toSdkCredentials(resolution.credentials),
          })
          await client.send(new DescribeRegionsCommand({}))
          return { ok: true as const }
        } catch (err: any) {
          return { ok: false as const, error: err?.message || String(err) }
        }
      })()
      return {
        success: true,
        source: resolution.source,
        stsValid: true,
        accountId: sts.accountId,
        arn: sts.arn,
        s3: s3Result,
        ec2: ec2Result,
      }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  handleWindow('compute:stop-run', async ({ state }, payload: { runId: string }) => {
    if (!state.coordinator?.computeRegistry) return { success: false, error: 'Compute registry not initialized' }
    if (!payload || typeof payload.runId !== 'string' || !payload.runId.trim()) {
      return { success: false, error: 'runId is required' }
    }
    try {
      await state.coordinator.computeRegistry.stop(payload.runId.trim())
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  // Export all chat messages as Markdown
  handleWindow('chat:export', async ({ win, state }) => {
    if (!state.projectPath || !state.sessionId) {
      return { success: false, error: 'No project open' }
    }
    const file = join(state.projectPath, PATHS.sessions, `${state.sessionId}.jsonl`)
    if (!existsSync(file)) {
      return { success: false, error: 'No chat history found' }
    }
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    if (lines.length === 0) {
      return { success: false, error: 'Chat history is empty' }
    }

    // Build markdown
    const projectName = basename(state.projectPath)
    const mdParts: string[] = [`# Chat Export — ${projectName}\n`]
    mdParts.push(`> Exported on ${new Date().toLocaleString()}\n`)

    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        const time = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : ''
        const roleLabel = msg.role === 'user' ? '**You**' : msg.role === 'assistant' ? '**Assistant**' : '**System**'
        mdParts.push(`---\n\n### ${roleLabel}  \n<sub>${time}</sub>\n\n${msg.content}\n`)
      } catch { /* skip malformed lines */ }
    }

    const markdown = mdParts.join('\n')

    // Show save dialog
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Chat History',
      defaultPath: join(app.getPath('documents'), `${projectName}-chat-export.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Cancelled' }
    }
    writeFileSync(result.filePath, markdown, 'utf-8')
    return { success: true, path: result.filePath }
  })

  // ─── Filesystem watcher for auto-refreshing the file tree ──────────────
  const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.research-pilot'])
  // Editor temp files / OS metadata — saving a file in VS Code, vim, etc.
  // generates a flurry of these. Filtering them at the watcher cuts the
  // refresh storm at the source.
  const NOISY_BASENAME_RE = /^(\.DS_Store|\.#.*|.*\.swp|.*\.swx|.*~|.*\.tmp|\d+\..*\.tmp)$/

  function startFsWatcher(state: WindowRuntimeState, win: BrowserWindow): void {
    // Tear down any existing watcher
    if (state.fsWatcher) {
      state.fsWatcher.close()
      state.fsWatcher = null
    }
    if (!state.projectPath) return

    // Node's `recursive: true` is only supported on macOS and Windows. On Linux
    // it silently falls back to watching just the top-level directory, so
    // subdirectory changes won't trigger an auto-refresh. Surface this once so
    // Linux users aren't left wondering why the tree looks stale.
    if (process.platform === 'linux' && !loggedLinuxWatchWarning) {
      loggedLinuxWatchWarning = true
      console.warn(
        '[fs-watcher] Recursive fs.watch is not supported on Linux. ' +
        'Only top-level changes in the workspace will auto-refresh the file tree; ' +
        'changes in subdirectories will require a manual refresh.'
      )
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    // Coalesce all parent dirs touched within the debounce window into one
    // payload so the renderer can do targeted reloads instead of refreshing
    // every expanded directory.
    const pendingParents = new Set<string>()
    let sawUnknownParent = false

    try {
      state.fsWatcher = watch(state.projectPath, { recursive: true }, (_event, filename) => {
        let parentRel: string | null = null
        if (filename) {
          const rel = filename.toString()
          const segments = rel.split(/[/\\]/)
          if (segments.some((s) => IGNORED_SEGMENTS.has(s))) return
          const base = segments[segments.length - 1] || ''
          if (NOISY_BASENAME_RE.test(base)) return
          // Parent directory relative to project root. Empty string == root.
          parentRel = segments.slice(0, -1).join('/')
        } else {
          // Some platforms fire callbacks without a filename — fall back to
          // a full refresh in that case.
          sawUnknownParent = true
        }

        if (parentRel !== null) pendingParents.add(parentRel)

        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          debounceTimer = null
          const payload = sawUnknownParent
            ? { parents: null }
            : { parents: Array.from(pendingParents) }
          pendingParents.clear()
          sawUnknownParent = false
          // RFC-014: re-derive the artifact index so direct file edits (the
          // agent's edit/write tools, an external editor) reflect in the Library.
          // Our own store writes keep the index fresh via upsert; this covers the
          // out-of-band edits. Best-effort.
          try {
            if (state.projectPath) rebuildIndex(state.projectPath)
          } catch {
            /* index is a derived cache; ignore */
          }
          safeSend(win, 'fs:external-change', payload)
        }, 500)
      })
      // Handle runtime errors (e.g., watched dir deleted, permission revoked,
      // OS watcher limit hit). Without this, an emitted 'error' would crash the
      // main process. Tear down cleanly; the next project open will re-arm.
      state.fsWatcher.on('error', () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = null
        }
        pendingParents.clear()
        sawUnknownParent = false
        state.fsWatcher?.close()
        state.fsWatcher = null
      })
    } catch {
      // fs.watch can throw on unsupported platforms or permission issues — non-fatal
    }
  }

  /**
   * Build a PipilotTracer bound to the given project. Honors the project's
   * `telemetry.tracingMode` (returns null if disabled). Resource attrs carry
   * process/build identity only; per-project state goes onto span attributes
   * via the tracer's project scope.
   */
  async function createTracerForProject(
    projectPath: string,
    sessionId: string
  ): Promise<PipilotTracer | null> {
    const projectFile = join(projectPath, PATHS.project)
    if (!existsSync(projectFile)) return null
    const config = JSON.parse(readFileSync(projectFile, 'utf8')) as ProjectConfig
    // Schema v2: tracingMode/bufferCapacity come from the LOCAL preferences.json
    // (RFC-013). project.json still owns the shared project id.
    const tp = readTelemetryPrefs(projectPath)
    if (tp.tracingMode === 'disabled') return null
    const projectId = config.id ?? 'unknown'
    const serviceVersion = app.getVersion()
    return new PipilotTracer({
      projectPath,
      serviceVersion,
      appBuildCommit: process.env.RESEARCH_COPILOT_BUILD_COMMIT ?? 'dev',
      projectId,
      sessionId,
      bufferCapacity: tp.bufferCapacity
    })
  }

  /**
   * Initialize a project folder: tear down any previous coordinator, set up
   * state, hydrate per-project preferences, record the path in the recent
   * projects list. Used by both the folder-picker dialog and direct-open
   * paths (FolderGate recent list, deep links, tests).
   *
   * Returns the standard `{ projectPath, sessionId }` shape that the
   * renderer's session store expects, or `null` if the path is unusable.
   */
  async function openProjectFolder(
    state: any,
    win: BrowserWindow,
    projectPath: string,
  ): Promise<{ projectPath: string; sessionId: string } | null> {
    if (!projectPath || !existsSync(projectPath)) return null

    // Clean up previous project (same as project:close)
    if (state.coordinator) {
      try { await state.coordinator.destroy() } catch { /* best effort */ }
      state.coordinator = null
    }
    if (state.tracer) {
      try { await state.tracer.shutdown() } catch { /* best effort */ }
      state.tracer = null
    }
    state.realtimeBuffer.reset()

    // Set up new project
    state.projectPath = projectPath
    initializeProject(state.projectPath)
    startFsWatcher(state, win)
    state.sessionId = loadOrCreateSessionId(PATHS.root, state.projectPath)

    // Telemetry-trace bootstrap (P1 §3.2). Builds a per-window PipilotTracer
    // tied to this project. Reads tracingMode from the local preferences.json
    // (schema v2, RFC-013); defaults to 'disabled' (opt-in).
    state.tracer = await createTracerForProject(state.projectPath, state.sessionId).catch((err) => {
      if (process.env.RESEARCH_COPILOT_DEBUG) {
        console.warn('[ResearchPilot] tracer bootstrap failed:', err)
      }
      return null
    })
    // Telemetry §6.7: forward live span summaries to the renderer over the
    // `trace:live` IPC channel. The Zustand trace-store on the renderer side
    // accumulates spans for a flame-graph / inspector view. Subscription is
    // cleared on project close (via tracer.shutdown → live.clear).
    if (state.tracer) {
      state.tracer.live.subscribe((summary: LiveSpanSummary) => {
        safeSend(win, 'trace:live', summary)
      })
    }

    // Restore persisted model + reasoning preferences
    const prefsFile = join(state.projectPath, PATHS.root, 'preferences.json')
    if (existsSync(prefsFile)) {
      try {
        const prefs = JSON.parse(readFileSync(prefsFile, 'utf-8'))
        if (prefs.selectedModel) {
          const m = prefs.selectedModel as string
          if (!m.includes(':')) {
            // `openai` matches the historical default for unrecognized bare ids.
            const provider = inferProviderFromModelId(m) ?? 'openai'
            state.currentModel = `${provider}:${m}`
          } else {
            state.currentModel = m
          }
        }
        if (prefs.reasoningEffort) state.currentReasoningEffort = prefs.reasoningEffort
      } catch { /* ignore corrupt file */ }
    }

    // RFC-008 §7.5: build the ComputeRegistry eagerly on project open
    // instead of waiting for the first chat. Without this, the Compute
    // tab renders "No backends registered" until the user sends a
    // message — because ensureCoordinator() (which builds the registry)
    // is otherwise only invoked from the chat path.
    //
    // Fire-and-forget: opening a project must not block on coordinator
    // init (which can take 1-2 min on first run for MCP setup). Errors
    // are swallowed — if the user hasn't signed in yet, the next chat
    // attempt will re-trigger ensureCoordinator and surface the auth
    // error properly there.
    void ensureCoordinator(state, win).catch((err) => {
      if (process.env.RESEARCH_COPILOT_DEBUG) {
        console.warn('[compute] eager coordinator init failed:', err?.message || err)
      }
    })

    win.setTitle(basename(state.projectPath))

    // Record in the recents list so FolderGate can surface it next time.
    try { addRecentProject(state.projectPath) } catch { /* best effort */ }

    return { projectPath: state.projectPath, sessionId: state.sessionId }
  }

  // Project - pick folder via native dialog + initialize
  handleWindow('project:pick-folder', async ({ win, state }) => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return openProjectFolder(state, win, result.filePaths[0])
  })

  // Project - open an already-known folder (FolderGate recents list)
  handleWindow('project:open-path', async ({ win, state }, projectPath: string) => {
    return openProjectFolder(state, win, projectPath)
  })

  // ─── RFC-013 Shared Workspaces ──────────────────────────────────────────
  // All sharing actions shell to the user's git/gh (the app owns no creds).
  // Detect-but-never-auto-apply: poll only reports; files move only on sync.

  ipcMain.handle('sharing:preflight', () => checkSharingPreflight())

  handleWindow('sharing:status', async ({ state }) => {
    if (!state.projectPath) return { shared: false, members: [], me: null }
    return getSharingStatus(state.projectPath)
  })

  handleWindow('sharing:share', async ({ state }, opts: ShareOptions) => {
    if (!state.projectPath) return { ok: false, invited: [], inviteErrors: [], error: 'No project open.' }
    return shareProject(state.projectPath, opts)
  })

  handleWindow('sharing:sync', async ({ state }) => {
    if (!state.projectPath) return { ok: false, pushed: false, pulled: false, ahead: 0, behind: 0, conflict: false, conflictedFiles: [], error: 'No project open.' }
    const result = await syncProject(state.projectPath)
    // A pull may have landed others' files — rebuild the derived index so the
    // Library reflects them. The fs-watcher also debounces a rebuild, but doing
    // it here makes the post-sync state deterministic for the renderer refresh.
    if (result.pulled) {
      try { rebuildIndex(state.projectPath) } catch { /* best effort */ }
    }
    return result
  })

  handleWindow('sharing:poll', async ({ state }) => {
    if (!state.projectPath) return { updatesAvailable: false, reachable: false }
    return pollRemote(state.projectPath)
  })

  handleWindow('sharing:invite', async ({ state }, login: string) => {
    if (!state.projectPath) return { ok: false, error: 'No project open.' }
    return inviteMember(state.projectPath, login)
  })

  handleWindow('sharing:remove-member', async ({ state }, login: string) => {
    if (!state.projectPath) return { ok: false, error: 'No project open.' }
    return removeMember(state.projectPath, login)
  })

  handleWindow('sharing:promote-member', async ({ state }, login: string) => {
    if (!state.projectPath) return { ok: false, error: 'No project open.' }
    return promoteMember(state.projectPath, login)
  })

  // Pick an EMPTY destination folder for the join/clone flow (does not open a project).
  handleWindow('sharing:pick-dest-folder', async ({ win }) => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose an empty folder to clone the shared project into',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  // Pending invitations this user has received (so they can join without the
  // Lead telling them the repo slug out of band).
  ipcMain.handle('sharing:list-invitations', () => listInvitations())

  // Accept an invitation: (optionally accept the GitHub invite, then) clone into
  // the chosen folder. The renderer then opens the returned path through the
  // normal project-open flow (keeps stores in sync).
  ipcMain.handle('sharing:accept-invite', (_event: any, opts: { repo: string; destFolder: string; displayName: string; invitationId?: number }) =>
    acceptInvite(opts)
  )

  // Recent projects CRUD
  ipcMain.handle('project:list-recents', () => listRecentProjects())
  ipcMain.handle('project:remove-recent', (_event: any, projectPath: string) => {
    const removed = removeRecentProject(projectPath)
    return { success: removed > 0 }
  })

  /**
   * Batch artifact stats lookup for the FolderGate recent projects list.
   * Reads the `.research-pilot/artifacts/*` subdirectories for each given
   * path and returns file counts — no project initialization, no state
   * mutation, just synchronous file system reads. `initialized=false` means
   * the folder exists but has no `.research-pilot` directory (pristine
   * project about to be set up on first open).
   */
  ipcMain.handle('project:stats-batch', (_event: any, paths: string[]) => {
    const result: Record<string, { papers: number; notes: number; data: number; initialized: boolean; shared: boolean }> = {}
    const countFiles = (dir: string): number => {
      try {
        return readdirSync(dir).filter((f: string) => !f.startsWith('.')).length
      } catch {
        return 0
      }
    }
    // RFC-013: a project is "shared" iff its project.json carries a `share` binding.
    const isShared = (p: string): boolean => {
      try {
        const cfg = JSON.parse(readFileSync(join(p, PATHS.project), 'utf8')) as ProjectConfig
        return !!cfg.share
      } catch {
        return false
      }
    }
    // Count by artifact type from the derived index (RFC-014: artifacts live in
    // rp-artifacts/<type>/, possibly per-actor subdirs — counting fixed legacy
    // dirs reported 0). `readIndex` only reads already-built shards; it never
    // triggers a full workspace scan, so this stays cheap on the welcome screen.
    // Fall back to the legacy JSON count for projects not yet opened in a
    // files-as-carrier build (no index yet).
    const countByType = (p: string): { papers: number; notes: number; data: number } => {
      const idx = readIndex(p)
      if (idx) {
        let papers = 0, notes = 0, data = 0
        for (const a of idx) {
          if (a.type === 'paper') papers++
          else if (a.type === 'note') notes++
          else if (a.type === 'data') data++
        }
        return { papers, notes, data }
      }
      return {
        papers: countFiles(join(p, PATHS.papers)),
        notes: countFiles(join(p, PATHS.notes)),
        data: countFiles(join(p, PATHS.data)),
      }
    }
    for (const p of paths || []) {
      if (!p || !existsSync(p)) {
        result[p] = { papers: 0, notes: 0, data: 0, initialized: false, shared: false }
        continue
      }
      const initialized = existsSync(join(p, PATHS.root))
      result[p] = {
        ...countByType(p),
        initialized,
        shared: initialized && isShared(p),
      }
    }
    return result
  })

  /**
   * Audit graph — derive a provenance projection from telemetry on demand.
   * Read-only. Returns the full graph plus a presence flag so the renderer
   * can render the empty state without a second round-trip.
   */
  handleWindow('audit:get-graph', async ({ state }) => {
    if (!state.projectPath) {
      return { presence: { present: false, reason: 'no-root', spanFileCount: 0 }, graph: null }
    }
    const presence = await checkTelemetryPresence(state.projectPath)
    if (!presence.present) return { presence, graph: null }
    const graph = await projectGraph(state.projectPath)
    return { presence, graph }
  })

  // Close project: stop agent, destroy coordinator, reset state
  handleWindow('project:close', async ({ state }) => {
    state.isClosing = true
    try {
      // Stop filesystem watcher
      if (state.fsWatcher) {
        state.fsWatcher.close()
        state.fsWatcher = null
      }

      // Stop any running agent
      if (state.coordinator) {
        try {
          state.coordinator.abort()
        } catch {
          /* agent may not be running */
        }
      }

      // Destroy coordinator (agent + MCP servers + subagents)
      if (state.coordinator) {
        try {
          await state.coordinator.destroy()
        } catch (err) {
          console.error('[Close] coordinator.destroy() error:', err)
        }
        state.coordinator = null
      }

      // Shut down telemetry tracer (flushes pending span batches; 5s budget)
      if (state.tracer) {
        try {
          await state.tracer.shutdown()
        } catch (err) {
          console.error('[Close] tracer.shutdown() error:', err)
        }
        state.tracer = null
      }

      // Reset main-process state
      state.realtimeBuffer.reset()
      state.projectPath = ''
      state.sessionId = crypto.randomUUID()
      // Reset window title to app name when project is closed
      const win = BrowserWindow.getAllWindows().find(w => windowStates.get(w.webContents.id) === state)
      if (win) win.setTitle('Research Pilot')
      state.currentModel = 'openai:gpt-5.5'
      state.currentReasoningEffort = 'medium'
      state.currentAuthMode = 'none'
    } finally {
      state.isClosing = false
    }
  })
}
