import { ipcMain, BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, statSync } from 'fs'
import { basename, dirname, extname, join, relative, resolve, sep, isAbsolute } from 'path'
import { createCoordinator } from '@research-pilot/agents/coordinator'
import {
  listNotes, listLiterature, listData,
  searchEntities, deleteEntity,
  artifactCreate, artifactDelete, artifactGet, artifactList, artifactSearch, artifactUpdate,
  memoryExplainTurn,
  sessionSummaryGet,
  enrichPaperArtifacts
} from '@research-pilot/commands/index'
import { savePaper, parseSavePaperArgs } from '@research-pilot/commands/save-paper'
import { saveData, parseSaveDataArgs } from '@research-pilot/commands/save-data'
import { parseMentions, resolveMentions, getCandidates } from '@research-pilot/mentions/index'
import { setCachedMarkdown } from '@research-pilot/mentions/document-cache'
import { PATHS, type ProjectConfig } from '@research-pilot/types'
import { ensureAgentMd } from '@research-pilot/memory-v2/store'
import { createActivityFormatter } from '../../../../src/trace/activity-formatter.js'
import { loadUsageTotals, resetUsageTotals } from '../../../../src/core/usage-totals.js'
import { createRealtimeBuffer, type RealtimeBuffer } from './realtime-buffer'

/** Extract just the filename from a path */
function getFileName(path: string): string {
  if (!path) return ''
  return path.split('/').pop() || path
}

function resolveDesktopCommunitySkillsDir(): string | undefined {
  const envOverride = (process.env.AGENT_FOUNDRY_COMMUNITY_SKILLS_DIR || '').trim()
  const resourcesPath = process.resourcesPath
  const candidates = [
    envOverride,
    resourcesPath ? join(resourcesPath, 'skills', 'community-builtin') : '',
    resourcesPath ? join(resourcesPath, 'app.asar.unpacked', 'skills', 'community-builtin') : '',
    resolve(process.cwd(), 'src', 'skills', 'community-builtin'),
    resolve(process.cwd(), 'dist', 'skills', 'community-builtin')
  ].filter(Boolean)

  return candidates.find(candidate => existsSync(candidate))
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

interface WindowRuntimeState {
  coordinator: ReturnType<typeof createCoordinator> | null
  currentModel: string
  currentReasoningEffort: 'high' | 'medium' | 'low'
  currentAuthMode: 'api-key' | 'none'
  projectPath: string
  sessionId: string
  isClosing: boolean
  realtimeBuffer: RealtimeBuffer
  fmt: ReturnType<typeof createActivityFormatter>
}

const windowStates = new Map<number, WindowRuntimeState>()
let ipcHandlersRegistered = false

function createWindowActivityFormatter(state: WindowRuntimeState) {
  return createActivityFormatter({
    // Lazy getter: registry becomes available after coordinator is created
    toolRegistry: () => state.coordinator?.agent?.runtime?.toolRegistry,
    customRules: [
      {
        match: 'literature-search',
        formatCall: (_, a) => ({ label: `Search: ${((a.query as string) || '').slice(0, 40)}${((a.query as string) || '').length > 40 ? '...' : ''}`, icon: 'search' }),
        formatResult: (_, r) => {
          const data = r.data as Record<string, unknown> | undefined
          // v2 compressed result format
          const totalFound = (data?.totalPapersFound as number) ?? 0
          const saved = (data?.papersAutoSaved as number) ?? 0
          const coverage = data?.coverage as { score?: number } | undefined
          if (totalFound > 0) {
            let summary = `Found ${totalFound} papers`
            if (coverage?.score != null) summary += ` (coverage: ${Math.round(coverage.score * 100)}%)`
            if (saved > 0) summary += `, saved ${saved}`
            return { label: summary, icon: 'search' }
          }
          // v1 fallback
          const local = (data?.localPapersUsed as number) ?? 0
          const external = (data?.externalPapersUsed as number) ?? 0
          const savedV1 = (data?.savedPapers as number) ?? 0
          let summary = `Found ${local + external} papers`
          if (local > 0) summary += ` (${local} local)`
          if (savedV1 > 0) summary += `, saved ${savedV1}`
          return { label: summary, icon: 'search' }
        }
      },
      // Sub-topic search progress (ACTIVITY, not PROGRESS)
      {
        match: 'lit-subtopic',
        formatCall: (_, a) => ({ label: (a._summary as string) || 'Searching sub-topic', icon: 'search' }),
        formatResult: (_, r) => ({ label: (r.data as string) || 'Search completed', icon: 'search' }),
      },
      // Metadata enrichment progress
      {
        match: 'lit-enrich',
        formatCall: (_, a) => ({ label: (a._summary as string) || 'Enriching paper metadata', icon: 'search' }),
        formatResult: (_, r) => ({ label: (r.data as string) || 'Enriched metadata', icon: 'search' }),
      },
      // Auto-save papers
      {
        match: 'lit-autosave',
        formatCall: (_, a) => ({ label: (a._summary as string) || 'Saving papers', icon: 'file' }),
        formatResult: (_, r) => ({ label: (r.data as string) || 'Saved papers', icon: 'file' }),
      },
      {
        match: 'data-analyze',
        formatCall: (_, a) => ({ label: `Analyze: ${getFileName((a.filePath as string) || '') || 'data'}`, icon: 'file' }),
      },
      {
        match: 'convert_to_markdown',
        formatCall: (_, a) => {
          const sourcePath = ((a.path as string) || (a.uri as string) || '')
          return { label: `Convert: ${getFileName(sourcePath)}`, icon: 'file' }
        },
        formatResult: (_, r, a) => {
          const sourcePath = ((a?.path as string) || (a?.uri as string) || '')
          const data = (r.data as Record<string, unknown> | undefined) ?? {}
          const skill = typeof data.converterSkill === 'string' ? data.converterSkill : ''
          const script = typeof data.converterScript === 'string' ? data.converterScript : ''
          if (skill && script) {
            return { label: `Converted ${getFileName(sourcePath)} via ${skill}/${script}`, icon: 'file' }
          }
          if (skill) {
            return { label: `Converted ${getFileName(sourcePath)} via ${skill}`, icon: 'file' }
          }
          return { label: `Converted ${getFileName(sourcePath)}`, icon: 'file' }
        },
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
}

function createWindowRuntimeState(): WindowRuntimeState {
  const state: WindowRuntimeState = {
    coordinator: null,
    currentModel: 'gpt-5.2',
    currentReasoningEffort: 'medium',
    currentAuthMode: 'none',
    projectPath: '',
    sessionId: crypto.randomUUID(),
    isClosing: false,
    realtimeBuffer: createRealtimeBuffer(),
    fmt: undefined as unknown as ReturnType<typeof createActivityFormatter>
  }
  state.fmt = createWindowActivityFormatter(state)
  return state
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
    PATHS.sessionSummaries
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

  // Keep process cwd stable; each window passes explicit projectPath.
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

/** Safely send an IPC message — no-op if the window has been destroyed. */
function safeSend(win: BrowserWindow, channel: string, ...args: unknown[]) {
  if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
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
    const communitySkillsDir = resolveDesktopCommunitySkillsDir()

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
      communitySkillsDir,
      debug: true,
      onStream: (chunk: string) => {
        state.realtimeBuffer.appendChunk(chunk)
        safeSend(win, 'agent:stream-chunk', chunk)
      },
      onToolCall: (tool: string, args: unknown) => {
        // Send activity event for tool invocation
        const summary = state.fmt.formatToolCall(tool, args).label
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
        const summary = state.fmt.formatToolResult(tool, result, args).label
        const actEvent = { type: 'tool-result', tool, summary, success, error }
        state.realtimeBuffer.pushActivity(actEvent)
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
          authMode: state.currentAuthMode,
          billingSource: resolvedAuth.billingSource,
          cacheHitRate: usage.promptTokens > 0
            ? (usage.cacheReadInputTokens ?? 0) / usage.promptTokens
            : 0
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

  const handleWindow = <T extends unknown[], R>(
    channel: string,
    handler: (ctx: { win: BrowserWindow; state: WindowRuntimeState }, ...args: T) => Promise<R> | R
  ) => {
    ipcMain.handle(channel, (event, ...args) => handler(getWindowContext(event), ...(args as T)))
  }

  // Agent chat
  handleWindow('agent:send', async ({ win, state }, message: string, rawMentions?: string, model?: string) => {
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
    let mentions: any[] = []
    if (rawMentions) {
      const parsed = parseMentions(rawMentions)
      if (parsed.mentions.length > 0) {
        mentions = await resolveMentions(parsed.mentions, state.projectPath)
      }
    }
    try {
      const result = await coord.chat(message, mentions)
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

  // Commands - save
  handleWindow('cmd:save-paper', ({ state }, argsStr: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const args = parseSavePaperArgs(argsStr)
    return savePaper(args.title, args, { sessionId: state.sessionId, projectPath: state.projectPath })
  })
  handleWindow('cmd:save-data', ({ state }, argsStr: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
    const args = parseSaveDataArgs(argsStr)
    return saveData(args.name, args, { sessionId: state.sessionId, projectPath: state.projectPath })
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


  // Mentions — signature: getCandidates(projectPath, typeFilter?, query?)
  handleWindow('mention:candidates', ({ state }, query: string, type?: string) => {
    if (!state.projectPath) return []
    try {
      return getCandidates(state.projectPath, type as any, query)
    } catch {
      return []
    }
  })

  // List files in the project root folder (non-recursive, files only)
  handleWindow('file:list-root', ({ state }) => {
    if (!state.projectPath) return []
    try {
      const entries = readdirSync(state.projectPath)
      const files: { path: string; name: string }[] = []
      for (const entry of entries) {
        // Skip hidden directories/files like .research-pilot, .git, etc.
        if (entry.startsWith('.')) continue
        const fullPath = join(state.projectPath, entry)
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

  // File reading for working folder preview
  handleWindow('file:read', ({ state }, filePath: string) => {
    try {
      const absPath = isAbsolute(filePath) ? filePath : resolve(state.projectPath, filePath)
      if (!existsSync(absPath)) {
        return { success: false, error: 'File not found' }
      }
      const content = readFileSync(absPath, 'utf-8')
      return { success: true, content, path: absPath }
    } catch (err: any) {
      return { success: false, error: err.message }
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

  // Resolve a file path to an absolute path (for file:// URLs)
  handleWindow('file:resolve-path', ({ state }, filePath: string) => {
    try {
      const absPath = isAbsolute(filePath) ? filePath : resolve(state.projectPath, filePath)
      if (!existsSync(absPath)) {
        return { success: false, error: 'File not found' }
      }
      return { success: true, absPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Open a file in the system default application
  handleWindow('file:open-external', ({ state }, filePath: string) => {
    const absPath = isAbsolute(filePath) ? filePath : resolve(state.projectPath, filePath)
    if (!existsSync(absPath)) return { success: false, error: 'File not found' }
    shell.openPath(absPath)
    return { success: true }
  })

  // Move a workspace file or directory to system trash
  handleWindow('file:trash', async ({ state }, filePath: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
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

  // Drop file into a specific workspace directory
  handleWindow('file:drop-to-dir', ({ state }, fileName: string, base64Content: string, targetDirRelPath: string) => {
    if (!state.projectPath) return { success: false, error: 'No project folder selected.' }
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

  // Binary file reading (images, PDFs) — returns base64
  handleWindow('file:read-binary', ({ state }, filePath: string) => {
    try {
      const absPath = isAbsolute(filePath) ? filePath : resolve(state.projectPath, filePath)
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

      const name = fileName.replace(/\.\w+$/, '')
      const ext = fileName.split('.').pop()?.toLowerCase() || ''
      const mimeMap: Record<string, string> = { csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json' }
      return saveData(name, { filePath: destPath, mimeType: mimeMap[ext] }, { sessionId: state.sessionId, projectPath: state.projectPath })
    }

    if (tab === 'papers') {
      // Save as a literature reference with content as abstract
      const title = fileName.replace(/\.\w+$/, '')
      return savePaper(title, { authors: [], abstract: content }, { sessionId: state.sessionId, projectPath: state.projectPath })
    }

    return { success: false, error: `Unknown tab: ${tab}` }
  })

  // Preferences persistence
  handleWindow('prefs:load', ({ state }) => {
    if (!state.projectPath) return null
    const file = join(state.projectPath, PATHS.root, 'preferences.json')
    if (!existsSync(file)) return null
    try { return JSON.parse(readFileSync(file, 'utf-8')) } catch { return null }
  })
  handleWindow('prefs:save', ({ state }, prefs: { selectedModel?: string; reasoningEffort?: string }) => {
    if (!state.projectPath) return
    const file = join(state.projectPath, PATHS.root, 'preferences.json')
    const data = { ...prefs, updatedAt: new Date().toISOString() }
    writeFileSync(file, JSON.stringify(data, null, 2))
    // Invalidate coordinator if model or reasoning effort changed so it gets recreated
    const modelChanged = prefs.selectedModel && prefs.selectedModel !== state.currentModel
    const effortChanged = prefs.reasoningEffort && prefs.reasoningEffort !== state.currentReasoningEffort
    if (prefs.selectedModel) state.currentModel = prefs.selectedModel
    if (prefs.reasoningEffort) state.currentReasoningEffort = prefs.reasoningEffort as any
    if ((modelChanged || effortChanged) && state.coordinator) {
      state.coordinator.destroy().catch(() => {})
      state.coordinator = null
    }
  })

  // Usage totals (framework persistence)
  handleWindow('usage:get-totals', ({ state }) => {
    if (!state.projectPath) return null
    const baseDir = join(state.projectPath, '.agentfoundry')
    return loadUsageTotals(baseDir)
  })
  handleWindow('usage:reset-totals', ({ state }) => {
    if (!state.projectPath) return null
    const baseDir = join(state.projectPath, '.agentfoundry')
    return resetUsageTotals(baseDir)
  })

  // Open working folder with specified app
  handleWindow('folder:open-with', async ({ state }, app: 'finder' | 'zed' | 'cursor' | 'vscode') => {
    if (!state.projectPath) return { success: false, error: 'No project open' }

    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)

    try {
      switch (app) {
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
          return { success: false, error: `Unknown app: ${app}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to open folder' }
    }
  })

  // Session - chat history persistence
  handleWindow('session:save-message', ({ state }, sid: string, msg: any) => {
    if (!state.projectPath) return
    const dir = join(state.projectPath, PATHS.sessions)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sid}.jsonl`)
    appendFileSync(file, JSON.stringify(msg) + '\n')
  })

  handleWindow('session:load-messages', ({ state }, sid: string, offset: number, limit: number) => {
    if (!state.projectPath) return []
    const file = join(state.projectPath, PATHS.sessions, `${sid}.jsonl`)
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    // offset=0 means most recent batch; we read from the end
    const start = Math.max(0, lines.length - offset - limit)
    const end = lines.length - offset
    return lines.slice(start, end).map((l) => JSON.parse(l))
  })

  handleWindow('session:get-total-count', ({ state }, sid: string) => {
    if (!state.projectPath) return 0
    const file = join(state.projectPath, PATHS.sessions, `${sid}.jsonl`)
    if (!existsSync(file)) return 0
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean).length
  })

  handleWindow('session:mark-saved', ({ state }, sid: string, messageId: string) => {
    if (!state.projectPath) return
    const file = join(state.projectPath, PATHS.sessions, `${sid}.saved.json`)
    let ids: string[] = []
    if (existsSync(file)) {
      try { ids = JSON.parse(readFileSync(file, 'utf-8')) } catch { ids = [] }
    }
    if (!ids.includes(messageId)) {
      ids.push(messageId)
      writeFileSync(file, JSON.stringify(ids))
    }
  })

  handleWindow('session:load-saved-ids', ({ state }, sid: string) => {
    if (!state.projectPath) return []
    const file = join(state.projectPath, PATHS.sessions, `${sid}.saved.json`)
    if (!existsSync(file)) return []
    try { return JSON.parse(readFileSync(file, 'utf-8')) } catch { return [] }
  })

  // Session
  handleWindow('session:current', ({ state }) => ({ sessionId: state.sessionId, projectPath: state.projectPath }))

  // Project - pick folder and initialize
  handleWindow('project:pick-folder', async ({ win, state }) => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (!result.canceled && result.filePaths[0]) {
      state.projectPath = result.filePaths[0]
      // Initialize .research-pilot directory structure
      initializeProject(state.projectPath)
      // Reset coordinator and memory storage for new project
      if (state.coordinator) {
        await state.coordinator.destroy()
        state.coordinator = null
      }
      // Reuse persistent session ID for this project folder
      state.sessionId = loadOrCreateSessionId(state.projectPath)
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
      state.currentModel = 'gpt-5.2'
      state.currentReasoningEffort = 'medium'
      state.currentAuthMode = 'none'
    } finally {
      state.isClosing = false
    }
  })
}
