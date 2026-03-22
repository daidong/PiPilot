import { ipcMain, BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
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
import { parseMentions, resolveMentions, getCandidates } from '../../../lib/mentions/index'
import { buildSkillManifests, writeEnabledSkills, installSkillToWorkspace, readEnabledSkills, setBuiltinSkillsRoot } from '../../../lib/skills/loader'
import { setCachedMarkdown } from '../../../lib/mentions/document-cache'
import { PATHS, type ProjectConfig } from '../../../lib/types'
import { ensureAgentMd, migrateLegacyArtifacts } from '../../../lib/memory-v2/store'
import { createRealtimeBuffer, type RealtimeBuffer } from './realtime-buffer'

// ─── Shared utilities from shared-electron ──────────────────────────────────
import {
  getFileName,
  inferMimeType,
  safeSend,
  loadOrCreateSessionId,
  resolveCoordinatorAuth,
  isWithinRoot,
  toPosixPath,
  registerFileHandlers,
  registerSessionHandlers,
  registerPrefsHandlers,
  registerUsageHandlers,
  registerAuthHandlers,
  registerFolderOpenHandler,
} from '../../../shared-electron/index'

// ─── Simple activity formatter (replaces AgentFoundry's createActivityFormatter) ─
interface ActivityLabel { label: string; icon: string }

/** Map tool names to human-readable activity labels */
function formatToolCall(tool: string, args: unknown): ActivityLabel {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>

  // Custom research-pilot tool labels
  switch (tool) {
    case 'literature-search':
      return { label: `Search: ${((a.query as string) || '').slice(0, 40)}${((a.query as string) || '').length > 40 ? '...' : ''}`, icon: 'search' }
    case 'lit-subtopic':
      return { label: (a._summary as string) || 'Searching sub-topic', icon: 'search' }
    case 'lit-enrich':
      return { label: (a._summary as string) || 'Enriching paper metadata', icon: 'search' }
    case 'lit-autosave':
      return { label: (a._summary as string) || 'Saving papers', icon: 'file' }
    case 'data-analyze':
      return { label: `Analyze: ${getFileName((a.filePath as string) || '') || 'data'}`, icon: 'file' }
    case 'convert_to_markdown': {
      const sourcePath = ((a.path as string) || (a.uri as string) || '')
      return { label: `Convert: ${getFileName(sourcePath)}`, icon: 'file' }
    }
    case 'artifact-create': {
      const type = ((a.type as string) || 'artifact').toLowerCase()
      const title = ((a.title as string) || type).slice(0, 35)
      return { label: `Create ${type}: ${title}`, icon: 'file' }
    }
    // Generic tool labels
    case 'read': return { label: `Read: ${getFileName((a.path as string) || '')}`, icon: 'file' }
    case 'write': return { label: `Write: ${getFileName((a.path as string) || '')}`, icon: 'file' }
    case 'edit': return { label: `Edit: ${getFileName((a.path as string) || '')}`, icon: 'file' }
    case 'bash': return { label: `Run command`, icon: 'terminal' }
    case 'glob': return { label: `Search files: ${(a.pattern as string) || ''}`, icon: 'search' }
    case 'grep': return { label: `Search content: ${((a.pattern as string) || '').slice(0, 30)}`, icon: 'search' }
    case 'fetch': return { label: `Fetch: ${((a.url as string) || '').slice(0, 40)}`, icon: 'network' }
    default: return { label: `${tool}`, icon: 'tool' }
  }
}

function formatToolResult(tool: string, result: unknown, args?: unknown): ActivityLabel {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const data = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>

  switch (tool) {
    case 'literature-search': {
      const totalFound = (data.totalPapersFound as number) ?? 0
      const saved = (data.papersAutoSaved as number) ?? 0
      const coverage = data.coverage as { score?: number } | undefined
      if (totalFound > 0) {
        let summary = `Found ${totalFound} papers`
        if (coverage?.score != null) summary += ` (coverage: ${Math.round(coverage.score * 100)}%)`
        if (saved > 0) summary += `, saved ${saved}`
        return { label: summary, icon: 'search' }
      }
      const local = (data.localPapersUsed as number) ?? 0
      const external = (data.externalPapersUsed as number) ?? 0
      const savedV1 = (data.savedPapers as number) ?? 0
      let summary = `Found ${local + external} papers`
      if (local > 0) summary += ` (${local} local)`
      if (savedV1 > 0) summary += `, saved ${savedV1}`
      return { label: summary, icon: 'search' }
    }
    case 'lit-subtopic':
      return { label: (r.data as string) || 'Search completed', icon: 'search' }
    case 'lit-enrich':
      return { label: (r.data as string) || 'Enriched metadata', icon: 'search' }
    case 'lit-autosave':
      return { label: (r.data as string) || 'Saved papers', icon: 'file' }
    case 'convert_to_markdown': {
      const sourcePath = ((a.path as string) || (a.uri as string) || '')
      const skill = typeof data.converterSkill === 'string' ? data.converterSkill : ''
      const script = typeof data.converterScript === 'string' ? data.converterScript : ''
      if (skill && script) return { label: `Converted ${getFileName(sourcePath)} via ${skill}/${script}`, icon: 'file' }
      if (skill) return { label: `Converted ${getFileName(sourcePath)} via ${skill}`, icon: 'file' }
      return { label: `Converted ${getFileName(sourcePath)}`, icon: 'file' }
    }
    case 'artifact-create': {
      const type = (data.type as string) || 'artifact'
      const title = (data.title as string) || ''
      return { label: title ? `Created ${type}: ${title.slice(0, 30)}` : `Created ${type}`, icon: 'file' }
    }
    default: {
      const success = r.success !== false
      return { label: success ? `${tool} completed` : `${tool} failed`, icon: 'tool' }
    }
  }
}

// ─── Persistent per-project usage totals ────────────────────────────────────
import {
  loadUsageTotals,
  accumulateUsage,
  resetUsageTotals
} from './usage-totals'

interface WindowRuntimeState {
  coordinator: ReturnType<typeof createCoordinator> | null
  currentModel: string
  currentReasoningEffort: 'high' | 'medium' | 'low'
  currentAuthMode: 'api-key' | 'none'
  projectPath: string
  sessionId: string
  isClosing: boolean
  realtimeBuffer: RealtimeBuffer
}

const windowStates = new Map<number, WindowRuntimeState>()
let ipcHandlersRegistered = false

function createWindowRuntimeState(): WindowRuntimeState {
  return {
    coordinator: null,
    currentModel: 'gpt-5.4',
    currentReasoningEffort: 'medium',
    currentAuthMode: 'none',
    projectPath: '',
    sessionId: crypto.randomUUID(),
    isClosing: false,
    realtimeBuffer: createRealtimeBuffer(),
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

export function registerWindow(win: BrowserWindow): void {
  const key = win.webContents.id
  getOrCreateWindowState(win)
  win.on('closed', () => {
    const state = windowStates.get(key)
    if (!state) return
    if (state.coordinator) {
      state.coordinator.destroy().catch(() => {})
    }
    windowStates.delete(key)
  })
}

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
    PATHS.skills
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
  const migration = migrateLegacyArtifacts(path)
  if (migration.updatedFiles > 0) {
    console.log(`[ResearchPilot] migrated legacy artifacts: files=${migration.updatedFiles}, literature->paper=${migration.convertedLiteratureType}, data.name removed=${migration.removedDataNameField}`)
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

  if (!state.coordinator) {
    const apiKey = resolvedAuth.apiKey
    const runProjectPath = state.projectPath

    // Notify UI that we're initializing (includes MCP servers like MarkItDown)
    const initEvent = { type: 'system', summary: 'Initializing agent (first run may take 1-2 minutes for document processing setup)...' }
    state.realtimeBuffer.pushActivity(initEvent)
    safeSend(win, 'agent:activity', initEvent)

    state.coordinator = await createCoordinator({
      apiKey,
      model: state.currentModel,
      reasoningEffort: state.currentReasoningEffort,
      projectPath: state.projectPath,
      sessionId: state.sessionId,
      debug: true,
      onStream: (chunk: string) => {
        state.realtimeBuffer.appendChunk(chunk)
        safeSend(win, 'agent:stream-chunk', chunk)
      },
      onToolCall: (tool: string, args: unknown) => {
        // Send activity event for tool invocation
        const summary = formatToolCall(tool, args).label
        const event = { type: 'tool-call', tool, summary }
        state.realtimeBuffer.pushActivity(event)
        safeSend(win, 'agent:activity', event)
      },
      onToolResult: (tool: string, result: unknown, args?: unknown) => {
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

        // Track extracted markdown files created by convert_to_markdown
        if (tool === 'convert_to_markdown' && result && typeof result === 'object' && 'success' in result) {
          const r2 = result as any
          if (r2.success && r2.data?.outputFile) {
            safeSend(win, 'agent:file-created', r2.data.outputFile)
          }
        }

        // Cache convert_to_markdown results for document files (path-based wrapper)
        if (tool === 'convert_to_markdown' && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success && r.data?.outputFile && args && typeof args === 'object' && 'path' in args) {
            const sourcePath = (args as { path: string }).path
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

        // Notify UI to refresh entity lists when artifacts are created.
        if (tool === 'artifact-create' && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success) {
            safeSend(win, 'agent:entity-created', {
              type: r.data?.type || 'artifact',
              id: r.data?.id,
              title: r.data?.title
            })
            // Also track the artifact's source file in Working Folder
            if (r.data?.filePath) {
              const absPath = isAbsolute(r.data.filePath) ? r.data.filePath : resolve(runProjectPath, r.data.filePath)
              safeSend(win, 'agent:file-created', absPath)
            }
          }
        }

        // Send activity event for tool result
        const r = result as any
        const success = r?.success !== false
        const error = !success ? (r?.error || 'Unknown error') : undefined
        const summary = formatToolResult(tool, result, args).label
        const actEvent = { type: 'tool-result', tool, summary, success, error }
        state.realtimeBuffer.pushActivity(actEvent)
        safeSend(win, 'agent:activity', actEvent)
      },

      // Skill activation tracking
      onSkillLoaded: (skillName: string) => {
        safeSend(win, 'agent:skill-loaded', skillName)
      },

      // Token usage tracking
      // pi-mono Usage type: { input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }
      onUsage: (usage: any, cost: any) => {
        const rawCost = cost?.total ?? 0
        const promptTokens = usage.input ?? 0
        const completionTokens = usage.output ?? 0
        const cachedTokens = usage.cacheRead ?? 0

        // Persist to disk (per-project accumulated totals)
        const baseDir = join(runProjectPath, PATHS.root)
        accumulateUsage(baseDir, promptTokens, completionTokens, cachedTokens, rawCost)

        const usageEvent = {
          promptTokens,
          completionTokens,
          cachedTokens,
          cost: rawCost,
          rawCost,
          billableCost: rawCost,
          authMode: state.currentAuthMode,
          billingSource: resolvedAuth.billingSource,
          cacheHitRate: (promptTokens + cachedTokens) > 0 ? cachedTokens / (promptTokens + cachedTokens) : 0
        }
        safeSend(win, 'agent:usage', usageEvent)
      }
    })

    // Notify UI that initialization is complete
    const readyEvent = { type: 'system', summary: 'Agent ready' }
    state.realtimeBuffer.pushActivity(readyEvent)
    safeSend(win, 'agent:activity', readyEvent)
  }
  return state.coordinator
}


export function registerIpcHandlers(): void {
  if (ipcHandlersRegistered) return
  ipcHandlersRegistered = true

  // Set the builtin skills root so the loader can find SKILL.md files
  // __dirname in the bundled main process is app/out/main/ (or app/src/main/ in dev)
  // lib/skills/ is 3 levels up at the repo root
  setBuiltinSkillsRoot(join(__dirname, '..', '..', '..', 'lib', 'skills'))

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
  registerFolderOpenHandler(sharedHandle, getCtx)

  // ─── App-specific handlers ──────────────────────────────────────────────

  // Agent chat
  handleWindow('agent:send', async ({ win, state }, message: string, rawMentions?: string, model?: string, images?: Array<{ base64: string; mimeType: string }>) => {
    if (!state.projectPath) {
      const errResult = { success: false, error: 'No project folder selected. Please select a folder first.' }
      safeSend(win, 'agent:done', errResult)
      return errResult
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
      const result = await coord.chat(message, mentions, images)
      state.realtimeBuffer.finishStreaming()
      safeSend(win, 'agent:done', result)
      return result
    } catch (err: any) {
      state.realtimeBuffer.finishStreaming()
      const errResult = { success: false, error: err.message }
      safeSend(win, 'agent:done', errResult)
      return errResult
    }
  })

  // Realtime state recovery (renderer calls this on mount to restore lost state)
  handleWindow('agent:get-realtime-snapshot', ({ state }) => {
    return state.realtimeBuffer.getSnapshot()
  })

  // Stop running agent
  handleWindow('agent:stop', ({ state }) => {
    if (state.coordinator) {
      (state.coordinator as any).agent.stop()
    }
  })

  // Clear session memory
  handleWindow('agent:clear-memory', async ({ state }) => {
    if (state.coordinator) {
      await (state.coordinator as any).clearSessionMemory()
    }
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
    return deleteEntity(id, state.projectPath)
  })

  // Commands - Artifact (RFC-012 canonical)
  handleWindow('cmd:artifact-create', ({ state }, input: Record<string, unknown>) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    return artifactCreate(input as any, { sessionId: state.sessionId, projectPath: state.projectPath })
  })
  handleWindow('cmd:artifact-update', ({ state }, artifactId: string, patch: Record<string, unknown>) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    return artifactUpdate(state.projectPath, artifactId, patch as any)
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
    return artifactDelete(state.projectPath, artifactId)
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
      debug: true,
      onProgress: (event) => {
        safeSend(win, 'enrich:progress', event)
      }
    })
  })


  // Mentions -- signature: getCandidates(projectPath, typeFilter?, query?)
  handleWindow('mention:candidates', ({ state }, query: string, type?: string) => {
    if (!state.projectPath) {
      console.warn('[mention:candidates] No projectPath set')
      return []
    }
    try {
      const result = getCandidates(state.projectPath, type as any, query)
      console.log(`[mention:candidates] query="${query}" type=${type} → ${result.length} candidates (project: ${state.projectPath})`)
      return result
    } catch (err) {
      console.error('[mention:candidates] Error:', err)
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

  // Project - pick folder and initialize
  handleWindow('project:pick-folder', async ({ win, state }) => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (!result.canceled && result.filePaths[0]) {
      // Clean up previous project (same as project:close)
      if (state.coordinator) {
        try { (state.coordinator as any).agent.stop() } catch { /* may not be running */ }
        try { await state.coordinator.destroy() } catch { /* best effort */ }
        state.coordinator = null
      }
      state.realtimeBuffer.reset()

      // Set up new project
      state.projectPath = result.filePaths[0]
      // Initialize .research-pilot directory structure
      initializeProject(state.projectPath)
      // Reuse persistent session ID for this project folder
      state.sessionId = loadOrCreateSessionId(PATHS.root, state.projectPath)
      // Restore persisted model + reasoning preferences
      const prefsFile = join(state.projectPath, PATHS.root, 'preferences.json')
      if (existsSync(prefsFile)) {
        try {
          const prefs = JSON.parse(readFileSync(prefsFile, 'utf-8'))
          if (prefs.selectedModel) state.currentModel = prefs.selectedModel
          if (prefs.reasoningEffort) state.currentReasoningEffort = prefs.reasoningEffort
        } catch { /* ignore corrupt file */ }
      }
      return { projectPath: state.projectPath, sessionId: state.sessionId }
    }
    return null
  })

  // Close project: stop agent, destroy coordinator, reset state
  handleWindow('project:close', async ({ state }) => {
    state.isClosing = true
    try {
      // Stop any running agent
      if (state.coordinator) {
        try {
          ;(state.coordinator as any).agent.stop()
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

      // Reset main-process state
      state.realtimeBuffer.reset()
      state.projectPath = ''
      state.sessionId = crypto.randomUUID()
      state.currentModel = 'gpt-5.4'
      state.currentReasoningEffort = 'medium'
      state.currentAuthMode = 'none'
    } finally {
      state.isClosing = false
    }
  })
}
