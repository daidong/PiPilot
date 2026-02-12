import { app, ipcMain, BrowserWindow, dialog, shell } from 'electron'
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, statSync } from 'fs'
import { basename, extname, join, relative, resolve, sep, isAbsolute } from 'path'
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

/** Extract just the filename from a path */
function getFileName(path: string): string {
  if (!path) return ''
  return path.split('/').pop() || path
}

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

function inferMimeType(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.md' || ext === '.txt') return 'text/plain'
  if (ext === '.csv') return 'text/csv'
  if (ext === '.tsv') return 'text/tab-separated-values'
  if (ext === '.json') return 'application/json'
  if (ext === '.pdf') return 'application/pdf'
  return 'application/octet-stream'
}

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
let currentModel = 'gpt-5.2'
let currentReasoningEffort: 'high' | 'medium' | 'low' = 'medium'
let currentAuthMode: 'api-key' | 'none' = 'none'
// Active project path (auto-restored from last-opened project when available)
let projectPath = ''
let sessionId = crypto.randomUUID()
let isClosing = false

interface ResolvedCoordinatorAuth {
  apiKey: string
  authMode: 'api-key' | 'none'
  isAnthropicModel: boolean
  billingSource: 'api-key' | 'none'
}

function resolveCoordinatorAuth(modelId: string): ResolvedCoordinatorAuth {
  const openaiApiKey = (process.env.OPENAI_API_KEY || '').trim()
  const anthropicApiKey = (process.env.ANTHROPIC_API_KEY || '').trim()
  const isAnthropic = modelId.startsWith('claude-')

  if (!isAnthropic) {
    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY is required for the selected OpenAI model.')
    }
    return {
      apiKey: openaiApiKey,
      authMode: 'api-key',
      isAnthropicModel: false,
      billingSource: 'api-key'
    }
  }

  if (!anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for the selected Anthropic model.')
  }

  return {
    apiKey: anthropicApiKey,
    authMode: 'api-key',
    isAnthropicModel: true,
    billingSource: 'api-key'
  }
}

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

function isValidProjectDirectory(path: string): boolean {
  try {
    return !!path && existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
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

/** Load or create a persistent session ID for a project folder */
function loadOrCreateSessionId(path: string): string {
  const sessionFile = join(path, PATHS.root, 'session.json')
  if (existsSync(sessionFile)) {
    try {
      const data = JSON.parse(readFileSync(sessionFile, 'utf-8'))
      if (data.sessionId) return data.sessionId
    } catch {
      // Corrupted file, create new
    }
  }
  const newId = crypto.randomUUID()
  writeFileSync(sessionFile, JSON.stringify({ sessionId: newId }))
  return newId
}

function activateProject(path: string): { projectPath: string; sessionId: string } {
  projectPath = path
  initializeProject(projectPath)

  sessionId = loadOrCreateSessionId(projectPath)

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

/** Safely send an IPC message — no-op if the window has been destroyed. */
function safeSend(win: BrowserWindow, channel: string, ...args: unknown[]) {
  if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
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

  // Auth (Anthropic API key only)
  ipcMain.handle('auth:get-anthropic-status', () => {
    const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || '').trim()
    return {
      authMode: hasApiKey ? 'api-key' : 'none',
      authStatus: hasApiKey ? 'valid' : 'missing',
      hasSetupToken: false,
      hasApiKeyFallback: hasApiKey,
      lastError: null
    }
  })

  ipcMain.handle('auth:get-openai-status', () => {
    return {
      hasApiKey: !!(process.env.OPENAI_API_KEY || '').trim()
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

  // Mentions — signature: getCandidates(projectPath, typeFilter?, query?)
  ipcMain.handle('mention:candidates', (_e, query: string, type?: string) => {
    if (!projectPath) return []
    try {
      return getCandidates(projectPath, type as any, query)
    } catch {
      return []
    }
  })

  // List files in the project root folder (non-recursive, files only)
  ipcMain.handle('file:list-root', () => {
    if (!projectPath) return []
    try {
      const entries = readdirSync(projectPath)
      const files: { path: string; name: string }[] = []
      for (const entry of entries) {
        // Skip hidden directories/files like .personal-assistant-v2, .git, etc.
        if (entry.startsWith('.')) continue
        const fullPath = join(projectPath, entry)
        try {
          if (statSync(fullPath).isFile()) {
            files.push({ path: fullPath, name: entry })
          }
        } catch {
          // Skip files we can't stat
        }
      }
      return files
    } catch {
      return []
    }
  })

  // Workspace file tree - lazy by directory level.
  ipcMain.handle('file:list-tree', (_e, options?: { relativePath?: string; showIgnored?: boolean; limit?: number }) => {
    if (!projectPath) return []
    const relativePath = options?.relativePath ?? ''
    const showIgnored = options?.showIgnored ?? false
    const limit = options?.limit ?? TREE_MAX_ENTRIES
    return listTreeChildren(projectPath, relativePath, showIgnored, limit)
  })

  ipcMain.handle('file:search-tree', (_e, query: string, options?: { showIgnored?: boolean; maxResults?: number }) => {
    if (!projectPath) return []
    return searchTree(projectPath, query, options?.showIgnored ?? false, options?.maxResults ?? 200)
  })

  // File reading for working folder preview
  ipcMain.handle('file:read', (_e, filePath: string) => {
    try {
      const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
      if (!existsSync(absPath)) {
        return { success: false, error: 'File not found' }
      }
      const content = readFileSync(absPath, 'utf-8')
      return { success: true, content, path: absPath }
    } catch (err: any) {
      return { success: false, error: err.message }
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

  // Resolve a file path to an absolute path (for file:// URLs)
  ipcMain.handle('file:resolve-path', (_e, filePath: string) => {
    try {
      const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
      if (!existsSync(absPath)) {
        return { success: false, error: 'File not found' }
      }
      return { success: true, absPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Open a file in the system default application
  ipcMain.handle('file:open-external', (_e, filePath: string) => {
    const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
    if (!existsSync(absPath)) return { success: false, error: 'File not found' }
    shell.openPath(absPath)
    return { success: true }
  })

  // Move a workspace file or directory to system trash
  ipcMain.handle('file:trash', async (_e, filePath: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
    if (!isWithinRoot(projectPath, absPath)) return { success: false, error: 'Path is outside workspace.' }
    if (!existsSync(absPath)) return { success: false, error: 'File not found.' }
    try {
      await shell.trashItem(absPath)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Drop file into a specific workspace directory
  ipcMain.handle('file:drop-to-dir', (_e, fileName: string, base64Content: string, targetDirRelPath: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const targetDir = targetDirRelPath ? resolve(projectPath, targetDirRelPath) : projectPath
    if (!isWithinRoot(projectPath, targetDir)) return { success: false, error: 'Target outside workspace.' }
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

  // Binary file reading (images, PDFs) — returns base64
  ipcMain.handle('file:read-binary', (_e, filePath: string) => {
    try {
      const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
      if (!existsSync(absPath)) {
        return { success: false, error: 'File not found' }
      }
      const buffer = readFileSync(absPath)
      const base64 = buffer.toString('base64')
      const ext = absPath.split('.').pop()?.toLowerCase() || ''
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        pdf: 'application/pdf'
      }
      const mime = mimeMap[ext] || 'application/octet-stream'
      return { success: true, base64, mime, path: absPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Drop file handler — copies file into project and creates entity
  // Content arrives as base64-encoded binary data from the renderer
  ipcMain.handle('file:drop', async (_e, fileName: string, base64Content: string, tab: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }

    const binaryBuffer = Buffer.from(base64Content, 'base64')

    if (tab === 'notes') {
      // Notes are text — decode as UTF-8
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

  // Preferences persistence
  ipcMain.handle('prefs:load', () => {
    if (!projectPath) return null
    const file = join(projectPath, PATHS.root, 'preferences.json')
    if (!existsSync(file)) return null
    try { return JSON.parse(readFileSync(file, 'utf-8')) } catch { return null }
  })
  ipcMain.handle('prefs:save', (_e, prefs: { selectedModel?: string; reasoningEffort?: string }) => {
    if (!projectPath) return
    const file = join(projectPath, PATHS.root, 'preferences.json')
    const data = { ...prefs, updatedAt: new Date().toISOString() }
    writeFileSync(file, JSON.stringify(data, null, 2))
    // Invalidate coordinator if model or reasoning effort changed so it gets recreated
    const modelChanged = prefs.selectedModel && prefs.selectedModel !== currentModel
    const effortChanged = prefs.reasoningEffort && prefs.reasoningEffort !== currentReasoningEffort
    if (prefs.selectedModel) currentModel = prefs.selectedModel
    if (prefs.reasoningEffort) currentReasoningEffort = prefs.reasoningEffort as any
    if ((modelChanged || effortChanged) && coordinator) {
      coordinator.destroy().catch(() => {})
      coordinator = null
    }
  })

  // Usage totals (framework persistence)
  ipcMain.handle('usage:get-totals', () => {
    if (!projectPath) return null
    const baseDir = join(projectPath, '.agentfoundry')
    return loadUsageTotals(baseDir)
  })
  ipcMain.handle('usage:reset-totals', () => {
    if (!projectPath) return null
    const baseDir = join(projectPath, '.agentfoundry')
    return resetUsageTotals(baseDir)
  })

  // Open working folder with specified app
  ipcMain.handle('folder:open-with', async (_e, app: 'finder' | 'zed' | 'cursor' | 'vscode') => {
    if (!projectPath) return { success: false, error: 'No project open' }

    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)

    try {
      switch (app) {
        case 'finder':
          await execAsync(`open "${projectPath}"`)
          break
        case 'zed':
          await execAsync(`zed "${projectPath}"`)
          break
        case 'cursor':
          await execAsync(`cursor "${projectPath}"`)
          break
        case 'vscode':
          await execAsync(`code "${projectPath}"`)
          break
        default:
          return { success: false, error: `Unknown app: ${app}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to open folder' }
    }
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

  // Session - chat history persistence
  ipcMain.handle('session:save-message', (_e, sid: string, msg: any) => {
    if (!projectPath) return
    const dir = join(projectPath, PATHS.sessions)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sid}.jsonl`)
    appendFileSync(file, JSON.stringify(msg) + '\n')
  })

  ipcMain.handle('session:load-messages', (_e, sid: string, offset: number, limit: number) => {
    if (!projectPath) return []
    const file = join(projectPath, PATHS.sessions, `${sid}.jsonl`)
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    // offset=0 means most recent batch; we read from the end
    const start = Math.max(0, lines.length - offset - limit)
    const end = lines.length - offset
    return lines.slice(start, end).map((l) => JSON.parse(l))
  })

  ipcMain.handle('session:get-total-count', (_e, sid: string) => {
    if (!projectPath) return 0
    const file = join(projectPath, PATHS.sessions, `${sid}.jsonl`)
    if (!existsSync(file)) return 0
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean).length
  })

  ipcMain.handle('session:mark-saved', (_e, sid: string, messageId: string) => {
    if (!projectPath) return
    const file = join(projectPath, PATHS.sessions, `${sid}.saved.json`)
    let ids: string[] = []
    if (existsSync(file)) {
      try { ids = JSON.parse(readFileSync(file, 'utf-8')) } catch { ids = [] }
    }
    if (!ids.includes(messageId)) {
      ids.push(messageId)
      writeFileSync(file, JSON.stringify(ids))
    }
  })

  ipcMain.handle('session:load-saved-ids', (_e, sid: string) => {
    if (!projectPath) return []
    const file = join(projectPath, PATHS.sessions, `${sid}.saved.json`)
    if (!existsSync(file)) return []
    try { return JSON.parse(readFileSync(file, 'utf-8')) } catch { return [] }
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
      currentModel = 'gpt-5.2'
      currentAuthMode = 'none'
      clearLastProjectPath()
    } finally {
      isClosing = false
    }
  })
}
