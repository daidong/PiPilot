import { app, ipcMain, BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { basename, extname, join, relative, resolve, isAbsolute } from 'path'
import { createCoordinator } from '@personal-assistant/agents/coordinator'
import {
  listNotes, listDocs, listTodos, listEmailMessages, listCalendarEvents,
  searchEntities, deleteEntity,
  toggleTodoComplete,
  artifactCreate, artifactDelete, artifactGet, artifactList, artifactSearch, artifactUpdate,
  sessionSummaryGet
} from '@personal-assistant/commands/index'
import { parseMentions, resolveMentions, getCandidates } from '@personal-assistant/mentions/index'
import { setCachedMarkdown, fileUriToPath } from '@personal-assistant/mentions/document-cache'
import { PATHS, type ProjectConfig } from '@personal-assistant/types'
import { Scheduler } from '@personal-assistant/scheduler/scheduler'
import { NotificationStore } from '@personal-assistant/scheduler/notifications'
import { ensureAgentMd } from '@personal-assistant/memory-v2/store'
import { createActivityFormatter } from '../../../../src/trace/activity-formatter.js'
import { loadUsageTotals, resetUsageTotals } from '../../../../src/core/usage-totals.js'
import { realtimeBuffer } from './realtime-buffer'

// ─── Shared utilities from @shared-electron ─────────────────────────────────
import {
  getFileName,
  inferMimeType,
  safeSend,
  isValidProjectDirectory,
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
} from '@shared-electron'

function createArtifactFromWorkspaceFile(filePath: string) {
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
      tags: ['from-file'],
      summary: `Imported from ${title}${ext || ''}`
    }, { sessionId, projectPath })
  }

  return artifactCreate({
    type: 'doc',
    title,
    filePath,
    mimeType: inferMimeType(filePath),
    tags: ['from-file'],
    summary: `Linked workspace file: ${toPosixPath(relative(projectPath, filePath))}`
  }, { sessionId, projectPath })
}

const fmt = createActivityFormatter({
  // Lazy getter: registry becomes available after coordinator is created
  toolRegistry: () => coordinator?.agent?.runtime?.toolRegistry,
  customRules: [
    {
      match: 'convert_to_markdown',
      formatCall: (_, a) => ({ label: `Convert: ${getFileName((a.path as string) || (a.uri as string) || '')}`, icon: 'file' }),
      formatResult: (_, _r, a) => ({ label: `Converted ${getFileName((a?.path as string) || (a?.uri as string) || '')}`, icon: 'file' }),
    },
    {
      match: 'artifact-create',
      formatCall: (_, a) => {
        const type = ((a.type as string) || 'artifact').toLowerCase()
        const title = ((a.title as string) || type).slice(0, 35)
        return { label: `Create ${type}: ${title}`, icon: 'file' }
      },
      formatResult: (_, r) => {
        const data = (r.data as any) || {}
        const type = (data.type as string) || 'artifact'
        const title = (data.title as string) || ''
        return { label: title ? `Created ${type}: ${title.slice(0, 30)}` : `Created ${type}`, icon: 'file' }
      }
    },
  ]
})

let coordinator: ReturnType<typeof createCoordinator> | null = null
let scheduler: Scheduler | null = null
let notificationStore: NotificationStore | null = null
let currentModel = 'gpt-5.4'
let currentReasoningEffort: 'high' | 'medium' | 'low' = 'medium'
let currentAuthMode: 'api-key' | 'none' = 'none'
// Active project path (auto-restored from last-opened project when available)
let projectPath = ''
let sessionId = crypto.randomUUID()
let isClosing = false

function lastProjectFilePath(): string {
  return join(app.getPath('userData'), 'personal-assistant-last-project.json')
}

function loadLastProjectPath(): string | null {
  const file = lastProjectFilePath()
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { projectPath?: string }
    const value = typeof raw.projectPath === 'string' ? raw.projectPath.trim() : ''
    return value || null
  } catch {
    return null
  }
}

function saveLastProjectPath(path: string): void {
  try {
    writeFileSync(lastProjectFilePath(), JSON.stringify({ projectPath: path }, null, 2), 'utf-8')
  } catch {
    // best-effort persistence only
  }
}

function clearLastProjectPath(): void {
  try {
    writeFileSync(lastProjectFilePath(), JSON.stringify({ projectPath: '' }, null, 2), 'utf-8')
  } catch {
    // best-effort persistence only
  }
}

/** Initialize .personal-assistant-v2 directory structure in the project folder */
function initializeProject(path: string): void {
  const dirs = [
    PATHS.root,
    PATHS.artifactsRoot,
    PATHS.notes,
    PATHS.docs,
    PATHS.todos,
    PATHS.emailMessages,
    PATHS.emailThreads,
    PATHS.calendarEvents,
    PATHS.schedulerRuns,
    PATHS.toolOutputs,
    PATHS.sessions,
    PATHS.cache,
    PATHS.documentCache,
    PATHS.memoryRoot,
    PATHS.sessionSummaries,
    PATHS.explainDir
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
      name: 'Personal Assistant Project',
      description: 'A new personal assistant project',
      questions: [],
      userCorrections: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    writeFileSync(projectFile, JSON.stringify(defaultConfig, null, 2))
  }

  ensureAgentMd(path)

  // Change cwd so relative PATHS in save commands resolve correctly
  process.chdir(path)
}

function activateProject(path: string): { projectPath: string; sessionId: string } {
  projectPath = path
  initializeProject(projectPath)

  sessionId = loadOrCreateSessionId(PATHS.root, projectPath)

  const prefsFile = join(projectPath, PATHS.root, 'preferences.json')
  if (existsSync(prefsFile)) {
    try {
      const prefs = JSON.parse(readFileSync(prefsFile, 'utf-8'))
      if (prefs.selectedModel) currentModel = prefs.selectedModel
      if (prefs.reasoningEffort) currentReasoningEffort = prefs.reasoningEffort
    } catch {
      // ignore corrupt file
    }
  }

  saveLastProjectPath(projectPath)
  return { projectPath, sessionId }
}

async function ensureCoordinator(
  win: BrowserWindow,
  model?: string,
  options?: { forceRecreate?: boolean }
) {
  if (isClosing) throw new Error('Project is closing')
  const requestedModel = model || currentModel
  const resolvedAuth = resolveCoordinatorAuth(requestedModel)
  // Recreate coordinator if model/auth mode changed (reasoning effort changes handled by prefs:save)
  if (
    coordinator
    && (
      options?.forceRecreate
      || requestedModel !== currentModel
      || resolvedAuth.authMode !== currentAuthMode
    )
  ) {
    coordinator.destroy().catch(() => {})
    coordinator = null
  }
  currentModel = requestedModel
  currentAuthMode = resolvedAuth.authMode

  if (!coordinator) {
    const apiKey = resolvedAuth.apiKey

    // Notify UI that we're initializing (includes MCP servers like MarkItDown)
    const initEvent = { type: 'system', summary: 'Initializing agent (first run may take 1-2 minutes for document processing setup)...' }
    realtimeBuffer.pushActivity(initEvent)
    safeSend(win, 'agent:activity', initEvent)

    // Initialize notification store and scheduler before coordinator
    if (!notificationStore) {
      notificationStore = new NotificationStore(projectPath)
    }
    if (!scheduler) {
      scheduler = new Scheduler({
        projectPath,
        onTrigger: async (task) => {
          try {
            const coord = await coordinator
            if (!coord) return
            const result = await coord.chat(`[SCHEDULED: ${task.id}] ${task.instruction}`)
            artifactCreate({
              type: 'scheduler-run',
              title: `Scheduled task: ${task.id}`,
              scheduledTaskId: task.id,
              instruction: task.instruction,
              status: result.success ? 'success' : 'failed',
              output: result.success ? result.response : undefined,
              error: result.success ? undefined : result.error,
              triggeredAt: new Date().toISOString(),
              tags: ['scheduler', result.success ? 'success' : 'failed'],
              summary: result.success
                ? (result.response?.slice(0, 280) ?? `Task ${task.id} completed`)
                : (result.error ?? `Task ${task.id} failed`)
            }, { sessionId, projectPath })
            if (result.success && result.response && notificationStore) {
              const n = notificationStore.add({
                type: 'info',
                title: task.instruction.slice(0, 60),
                body: result.response,
                scheduledTaskId: task.id
              })
              safeSend(win, 'notification:new', notificationStore.list())
            }
          } catch (err) {
            console.error(`[Scheduler] onTrigger error for ${task.id}:`, err)
          }
        }
      })
    }

    coordinator = await createCoordinator({
      apiKey,
      model: currentModel,
      reasoningEffort: currentReasoningEffort,
      projectPath,
      sessionId,
      emailDbPath: process.env.EMAIL_DB_PATH,
      debug: true,
      onStream: (chunk: string) => {
        realtimeBuffer.appendChunk(chunk)
        safeSend(win, 'agent:stream-chunk', chunk)
      },
      onToolCall: (tool: string, args: unknown) => {
        // Send activity event for tool invocation
        const summary = fmt.formatToolCall(tool, args).label
        const event = { type: 'tool-call', tool, summary }
        realtimeBuffer.pushActivity(event)
        safeSend(win, 'agent:activity', event)
      },
      onToolResult: (tool: string, result: unknown, args?: unknown) => {
        if (tool.startsWith('todo-') && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success && r.item) {
            realtimeBuffer.upsertProgressItem(r.item)
            safeSend(win, 'agent:todo-update', r.item)
          }
        }

        // Track files created/modified by write and edit tools
        if ((tool === 'write' || tool === 'edit') && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success && r.data?.path) {
            // Normalize to absolute path so renderer can compare reliably
            const absPath = isAbsolute(r.data.path) ? r.data.path : resolve(projectPath, r.data.path)
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

        // Cache convert_to_markdown results for document files
        if (tool === 'convert_to_markdown' && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success && r.data?.content && args && typeof args === 'object' && 'uri' in args) {
            const uri = (args as { uri: string }).uri
            const filePath = fileUriToPath(uri)
            if (filePath && projectPath) {
              setCachedMarkdown(filePath, r.data.content, projectPath)
            }
          }
        }

        // Notify UI to refresh entity lists when artifacts are created.
        if (tool === 'artifact-create' && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success) {
            const entityType = r.data?.type || 'artifact'
            safeSend(win, 'agent:entity-created', {
              type: entityType,
              id: r.data?.id,
              title: r.data?.title
            })
            // Also track the artifact's source file in Working Folder
            if (r.data?.filePath) {
              const absPath = isAbsolute(r.data.filePath) ? r.data.filePath : resolve(projectPath, r.data.filePath)
              safeSend(win, 'agent:file-created', absPath)
            }
          }
        }

        // Send activity event for tool result
        const r = result as any
        const success = r?.success !== false
        const error = !success ? (r?.error || 'Unknown error') : undefined
        const summary = fmt.formatToolResult(tool, result, args).label
        const actEvent = { type: 'tool-result', tool, summary, success, error }
        realtimeBuffer.pushActivity(actEvent)
        safeSend(win, 'agent:activity', actEvent)
      },

      // Token usage tracking
      onUsage: (usage: any, cost: any) => {
        const rawCost = cost.totalCost ?? 0
        const usageEvent = {
          promptTokens: usage.promptTokens ?? 0,
          completionTokens: usage.completionTokens ?? 0,
          cachedTokens: usage.cacheReadInputTokens ?? 0,
          cost: rawCost,
          rawCost,
          billableCost: rawCost,
          authMode: currentAuthMode,
          billingSource: resolvedAuth.billingSource,
          cacheHitRate: usage.promptTokens > 0
            ? (usage.cacheReadInputTokens ?? 0) / usage.promptTokens
            : 0
        }
        safeSend(win, 'agent:usage', usageEvent)
      }
    })

    // Start scheduler after coordinator is ready
    scheduler?.start()

    // Notify UI that initialization is complete
    const readyEvent = { type: 'system', summary: 'Agent ready' }
    realtimeBuffer.pushActivity(readyEvent)
    safeSend(win, 'agent:activity', readyEvent)
  }
  return coordinator
}


export function registerIpcHandlers(win: BrowserWindow): void {
  if (!projectPath) {
    const lastProjectPath = loadLastProjectPath()
    if (lastProjectPath && isValidProjectDirectory(lastProjectPath)) {
      activateProject(lastProjectPath)
    } else if (lastProjectPath) {
      clearLastProjectPath()
    }
  }

  // ─── Shared handler context getter ──────────────────────────────────────
  const getCtx = () => ({ projectPath })

  // Wrapper that strips the IpcMainInvokeEvent from ipcMain.handle before
  // passing to the shared handler registrations.
  const handle = (channel: string, handler: (...args: any[]) => any) => {
    ipcMain.handle(channel, (_e, ...args) => handler(...args))
  }

  // ─── Register shared handlers from @shared-electron ─────────────────────
  registerFileHandlers(handle, getCtx)
  registerSessionHandlers(handle, getCtx, PATHS.sessions)
  registerPrefsHandlers(handle, getCtx, PATHS.root, {
    onModelChange: (m) => { currentModel = m },
    onReasoningEffortChange: (e) => { currentReasoningEffort = e as any },
    invalidateCoordinator: () => {
      if (coordinator) {
        coordinator.destroy().catch(() => {})
        coordinator = null
      }
    },
    getCurrentModel: () => currentModel,
    getCurrentReasoningEffort: () => currentReasoningEffort
  })
  registerUsageHandlers(handle, getCtx, loadUsageTotals, resetUsageTotals)
  registerAuthHandlers(handle)
  registerFolderOpenHandler(handle, getCtx)

  // ─── App-specific handlers ──────────────────────────────────────────────

  // Agent chat
  ipcMain.handle('agent:send', async (_e, message: string, rawMentions?: string, model?: string) => {
    if (!projectPath) {
      const errResult = { success: false, error: 'No project folder selected. Please select a folder first.' }
      safeSend(win, 'agent:done', errResult)
      return errResult
    }

    const requestedModel = model || currentModel
    let coord: Awaited<ReturnType<typeof ensureCoordinator>>
    try {
      coord = await ensureCoordinator(win, requestedModel)
    } catch (err: any) {
      const errResult = { success: false, error: err.message || 'Failed to initialize coordinator.' }
      safeSend(win, 'agent:done', errResult)
      return errResult
    }
    // Only clear activity (per-run), NOT progress/todos (persist across turns)
    realtimeBuffer.clearActivity()
    safeSend(win, 'agent:activity-clear')
    let mentions: any[] = []
    if (rawMentions) {
      const parsed = parseMentions(rawMentions)
      if (parsed.mentions.length > 0) {
        mentions = await resolveMentions(parsed.mentions, projectPath)
      }
    }
    try {
      const result = await coord.chat(message, mentions)

      // Auto-complete any orphaned in-progress todos (prevents permanent spinners)
      const progressItems = realtimeBuffer.getProgressItems()
      for (const item of progressItems) {
        if (item.status === 'in_progress') {
          const completed = { ...item, status: 'done' as const, completedAt: new Date().toISOString() }
          realtimeBuffer.upsertProgressItem(completed)
          safeSend(win, 'agent:todo-update', completed)
        }
      }

      realtimeBuffer.finishStreaming()
      safeSend(win, 'agent:done', result)
      return result
    } catch (err: any) {
      realtimeBuffer.finishStreaming()
      const errResult = { success: false, error: err.message }
      safeSend(win, 'agent:done', errResult)
      return errResult
    }
  })

  // Realtime state recovery (renderer calls this on mount to restore lost state)
  ipcMain.handle('agent:get-realtime-snapshot', () => {
    return realtimeBuffer.getSnapshot()
  })

  // Stop running agent
  ipcMain.handle('agent:stop', () => {
    if (coordinator) {
      (coordinator as any).agent.stop()
    }
  })

  // Clear session memory
  ipcMain.handle('agent:clear-memory', async () => {
    if (coordinator) {
      await (coordinator as any).clearSessionMemory()
    }
  })

  // Commands - entities
  ipcMain.handle('cmd:list-notes', () => {
    if (!projectPath) return []
    return listNotes(projectPath)
  })
  ipcMain.handle('cmd:list-docs', () => {
    if (!projectPath) return []
    return listDocs(projectPath)
  })
  ipcMain.handle('cmd:list-todos', () => {
    if (!projectPath) return []
    return listTodos(projectPath)
  })
  ipcMain.handle('cmd:list-mail', () => {
    if (!projectPath) return []
    return listEmailMessages(projectPath)
  })
  ipcMain.handle('cmd:list-calendar', () => {
    if (!projectPath) return []
    return listCalendarEvents(projectPath)
  })
  ipcMain.handle('cmd:toggle-todo-complete', (_e, id: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return toggleTodoComplete(id, projectPath)
  })
  ipcMain.handle('cmd:search', (_e, query: string) => {
    if (!projectPath) return []
    return searchEntities(projectPath, query)
  })
  ipcMain.handle('cmd:delete', (_e, id: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return deleteEntity(id, projectPath)
  })

  // Commands - Artifact (RFC-013 canonical)
  ipcMain.handle('cmd:artifact-create', (_e, input: Record<string, unknown>) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return artifactCreate(input as any, { sessionId, projectPath })
  })
  ipcMain.handle('cmd:artifact-update', (_e, artifactId: string, patch: Record<string, unknown>) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return artifactUpdate(projectPath, artifactId, patch as any)
  })
  ipcMain.handle('cmd:artifact-get', (_e, artifactId: string) => {
    if (!projectPath) return null
    return artifactGet(projectPath, artifactId)
  })
  ipcMain.handle('cmd:artifact-list', (_e, types?: string[]) => {
    if (!projectPath) return []
    return artifactList(projectPath, types as any)
  })
  ipcMain.handle('cmd:artifact-search', (_e, query: string, types?: string[]) => {
    if (!projectPath) return []
    return artifactSearch(projectPath, query, types as any)
  })
  ipcMain.handle('cmd:artifact-delete', (_e, artifactId: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return artifactDelete(projectPath, artifactId)
  })

  ipcMain.handle('cmd:session-summary-get', () => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return sessionSummaryGet(projectPath, sessionId)
  })

  // Mentions -- signature: getCandidates(projectPath, typeFilter?, query?)
  ipcMain.handle('mention:candidates', (_e, query: string, type?: string) => {
    if (!projectPath) return []
    try {
      return getCandidates(projectPath, type as any, query)
    } catch {
      return []
    }
  })

  ipcMain.handle('file:create-artifact', (_e, filePath: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
    if (!isWithinRoot(projectPath, absPath)) {
      return { success: false, error: 'Path is outside current workspace.' }
    }
    if (!existsSync(absPath)) {
      return { success: false, error: 'File not found.' }
    }
    return createArtifactFromWorkspaceFile(absPath)
  })

  // Drop file handler -- copies file into project and creates entity
  // Content arrives as base64-encoded binary data from the renderer
  ipcMain.handle('file:drop', async (_e, fileName: string, base64Content: string, tab: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }

    const binaryBuffer = Buffer.from(base64Content, 'base64')

    if (tab === 'notes') {
      // Notes are text -- decode as UTF-8
      const textContent = binaryBuffer.toString('utf-8')
      const title = fileName.replace(/\.\w+$/, '')
      return artifactCreate(
        {
          type: 'note',
          title,
          content: textContent,
          provenance: {
            source: 'user',
            extractedFrom: 'file-import'
          }
        },
        { sessionId, projectPath, lastAgentResponse: '' }
      )
    }

    if (tab === 'docs') {
      // Write original binary file to docs/ directory
      const docsDir = join(projectPath, PATHS.docs)
      if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true })
      const destPath = join(docsDir, fileName)
      writeFileSync(destPath, binaryBuffer)

      const title = fileName.replace(/\.\w+$/, '')

      // Auto-convert supported formats via MarkItDown (PDF, Word, Excel, PPT, etc.)
      const convertExts = new Set(['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'html', 'htm', 'rtf', 'csv'])
      const ext = fileName.split('.').pop()?.toLowerCase() || ''
      let extractedContent: string | undefined

      if (convertExts.has(ext)) {
        try {
          const coord = await coordinator
          if (coord) {
            const result = await coord.chat(
              `Convert the document "${fileName}" to markdown using convert_to_markdown. ` +
              `Do not summarize — just convert and confirm the output file path.`
            )
            if (result.success && result.response) {
              // Try to read the extracted .md file
              const extractedPath = join(projectPath, fileName.replace(/\.\w+$/, '') + '.extracted.md')
              if (existsSync(extractedPath)) {
                extractedContent = readFileSync(extractedPath, 'utf-8')
              }
            }
          }
        } catch (err) {
          console.warn(`[file:drop] MarkItDown conversion failed for ${fileName}:`, err)
        }
      }

      return artifactCreate({
        type: 'doc',
        title,
        filePath: destPath,
        content: extractedContent,
        summary: extractedContent
          ? `Converted from ${fileName} (markdown extracted)`
          : `Imported document ${fileName}`,
        provenance: {
          source: 'user',
          extractedFrom: 'file-import'
        }
      }, { sessionId, projectPath })
    }

    return { success: false, error: `Unknown tab: ${tab}` }
  })

  // Notifications
  ipcMain.handle('notification:list', () => {
    return notificationStore?.list() ?? []
  })
  ipcMain.handle('notification:mark-read', (_e, id: string) => {
    notificationStore?.markRead(id)
  })
  ipcMain.handle('notification:mark-all-read', () => {
    notificationStore?.markAllRead()
  })
  ipcMain.handle('notification:unread-count', () => {
    return notificationStore?.unreadCount() ?? 0
  })

  // Session
  ipcMain.handle('session:current', () => ({ sessionId, projectPath }))

  // Project - pick folder and initialize
  ipcMain.handle('project:pick-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (!result.canceled && result.filePaths[0]) {
      // Reset coordinator and memory storage for new project
      if (coordinator) {
        await coordinator.destroy()
        coordinator = null
      }
      return activateProject(result.filePaths[0])
    }
    return null
  })

  // Close project: stop agent, destroy coordinator, reset state
  ipcMain.handle('project:close', async () => {
    isClosing = true
    try {
      // Stop any running agent
      if (coordinator) {
        try {
          ;(coordinator as any).agent.stop()
        } catch {
          /* agent may not be running */
        }
      }

      // Stop scheduler
      if (scheduler) {
        scheduler.stop()
        scheduler = null
      }
      notificationStore = null

      // Destroy coordinator (agent + MCP servers + subagents)
      if (coordinator) {
        try {
          await coordinator.destroy()
        } catch (err) {
          console.error('[Close] coordinator.destroy() error:', err)
        }
        coordinator = null
      }

      // Reset main-process state
      realtimeBuffer.reset()
      projectPath = ''
      sessionId = crypto.randomUUID()
      currentModel = 'gpt-5.4'
      currentAuthMode = 'none'
      clearLastProjectPath()
    } finally {
      isClosing = false
    }
  })
}
