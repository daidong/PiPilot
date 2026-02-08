import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, statSync } from 'fs'
import { basename, dirname, extname, join, relative, resolve, sep, isAbsolute } from 'path'
import { createCoordinator } from '@research-pilot/agents/coordinator'
import {
  listNotes, listLiterature, listData,
  searchEntities, deleteEntity,
  artifactCreate, artifactDelete, artifactGet, artifactList, artifactSearch, artifactUpdate,
  focusAdd, focusClear, focusList, focusPrune, focusRemove,
  taskAnchorGet, taskAnchorSet, taskAnchorUpdate,
  memoryExplainTurn, memoryExplainFact, memoryExplainBudget
} from '@research-pilot/commands/index'
import { saveNote } from '@research-pilot/commands/save-note'
import { savePaper, parseSavePaperArgs, updatePaperMetadata } from '@research-pilot/commands/save-paper'
import { RateLimiter, CircuitBreaker, DEFAULT_SEARCHER_CONFIG } from '@research-pilot/agents/rate-limiter'
import { enrichPapers, createEnrichmentConfig, countCoreFields, type PaperInput } from '@research-pilot/agents/metadata-enrichment'
import { saveData, parseSaveDataArgs } from '@research-pilot/commands/save-data'
import { parseMentions, resolveMentions, getCandidates } from '@research-pilot/mentions/index'
import { setCachedMarkdown, fileUriToPath } from '@research-pilot/mentions/document-cache'
import { PATHS, type ProjectConfig } from '@research-pilot/types'
import { createActivityFormatter } from '../../../../src/trace/activity-formatter.js'
import { loadUsageTotals, resetUsageTotals } from '../../../../src/core/usage-totals.js'
import { realtimeBuffer } from './realtime-buffer'
import {
  createAnthropicAuthManager,
  classifyAnthropicAuthFailure,
  type AnthropicResolvedMode
} from '../../../shared/anthropic-auth/index'

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
    type: 'data',
    title,
    filePath,
    mimeType: inferMimeType(filePath),
    tags: ['from-file'],
    summary: `Linked workspace file: ${toPosixPath(relative(projectPath, filePath))}`
  }, { sessionId, projectPath })
}

function addFileToFocus(filePath: string, reason: string = 'selected from workspace tree', ttl: string = '2h') {
  const dataArtifacts = listData(projectPath)
  const existing = dataArtifacts.find(item => resolve(item.filePath) === resolve(filePath))
  const artifactResult = existing ? { success: true, artifact: { id: existing.id } } : createArtifactFromWorkspaceFile(filePath)

  if (!artifactResult.success || !artifactResult.artifact) {
    return { success: false, error: artifactResult.error ?? 'Unable to register file artifact.' }
  }

  return focusAdd(projectPath, {
    sessionId,
    refType: 'artifact',
    refId: artifactResult.artifact.id,
    reason,
    source: 'manual',
    ttl
  })
}

const fmt = createActivityFormatter({
  // Lazy getter: registry becomes available after coordinator is created
  toolRegistry: () => coordinator?.agent?.runtime?.toolRegistry,
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
      formatCall: (_, a) => ({ label: `Convert: ${getFileName((a.uri as string) || '')}`, icon: 'file' }),
      formatResult: (_, _r, a) => ({ label: `Converted ${getFileName((a?.uri as string) || '')}`, icon: 'file' }),
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
let currentModel = 'gpt-5.2'
let currentReasoningEffort: 'high' | 'medium' | 'low' = 'medium'
let currentAuthMode: Exclude<AnthropicResolvedMode, 'not-applicable'> = 'none'
// Start with empty project path — user must select a folder
let projectPath = ''
let sessionId = crypto.randomUUID()
let isClosing = false

const anthropicAuth = createAnthropicAuthManager({
  appMemoryRoot: '.research-pilot',
  logger: (message) => console.log(message)
})

interface ResolvedCoordinatorAuth {
  apiKey: string
  authMode: Exclude<AnthropicResolvedMode, 'not-applicable'>
  isAnthropicModel: boolean
  billingSource: 'api-key' | 'setup-token' | 'none'
}

function resolveCoordinatorAuth(
  modelId: string,
  options?: { anthropicModeOverride?: 'setup-token' | 'api-key' }
): ResolvedCoordinatorAuth {
  const openaiApiKey = (process.env.OPENAI_API_KEY || '').trim()
  const anthropicApiKey = (process.env.ANTHROPIC_API_KEY || '').trim()
  const isAnthropic = anthropicAuth.isAnthropicModel(modelId)

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

  if (!projectPath) {
    throw new Error('No project folder selected. Please select a folder first.')
  }

  if (options?.anthropicModeOverride === 'api-key') {
    if (!anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is required for API-key fallback mode.')
    }
    return {
      apiKey: anthropicApiKey,
      authMode: 'api-key',
      isAnthropicModel: true,
      billingSource: 'api-key'
    }
  }

  if (options?.anthropicModeOverride === 'setup-token') {
    const status = anthropicAuth.getStatus(projectPath, anthropicApiKey)
    if (!status.hasSetupToken || status.authStatus === 'invalid') {
      throw new Error('Anthropic setup-token is missing or invalid. Please setup token first.')
    }
  }

  const resolved = anthropicAuth.resolveCredential({
    model: modelId,
    projectPath,
    anthropicApiKey
  })

  if (resolved.mode === 'setup-token' && resolved.apiKey) {
    return {
      apiKey: resolved.apiKey,
      authMode: 'setup-token',
      isAnthropicModel: true,
      billingSource: 'setup-token'
    }
  }

  if (resolved.mode === 'api-key' && resolved.apiKey) {
    return {
      apiKey: resolved.apiKey,
      authMode: 'api-key',
      isAnthropicModel: true,
      billingSource: 'api-key'
    }
  }

  throw new Error('Anthropic authentication required. Add setup-token or ANTHROPIC_API_KEY.')
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
    PATHS.focusDir,
    dirname(PATHS.artifactFactIndex),
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
      name: 'Research Project',
      description: 'A new research project',
      questions: [],
      userCorrections: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    writeFileSync(projectFile, JSON.stringify(defaultConfig, null, 2))
  }

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

/** Safely send an IPC message — no-op if the window has been destroyed. */
function safeSend(win: BrowserWindow, channel: string, ...args: unknown[]) {
  if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

async function ensureCoordinator(
  win: BrowserWindow,
  model?: string,
  options?: { forceRecreate?: boolean; anthropicModeOverride?: 'setup-token' | 'api-key' }
) {
  if (isClosing) throw new Error('Project is closing')
  const requestedModel = model || currentModel
  const resolvedAuth = resolveCoordinatorAuth(requestedModel, options)
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

    coordinator = await createCoordinator({
      apiKey,
      model: currentModel,
      reasoningEffort: currentReasoningEffort,
      projectPath,
      sessionId,
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
            safeSend(win, 'agent:file-created', r.data.path)
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
            safeSend(win, 'agent:entity-created', {
              type: r.data?.type || 'artifact',
              id: r.data?.id,
              title: r.data?.title
            })
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
        const isApiBillable = !(resolvedAuth.isAnthropicModel && resolvedAuth.billingSource === 'setup-token')
        const usageEvent = {
          promptTokens: usage.promptTokens ?? 0,
          completionTokens: usage.completionTokens ?? 0,
          cachedTokens: usage.cacheReadInputTokens ?? 0,
          cost: isApiBillable ? rawCost : 0,
          rawCost,
          billableCost: isApiBillable ? rawCost : 0,
          authMode: currentAuthMode,
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
    realtimeBuffer.pushActivity(readyEvent)
    safeSend(win, 'agent:activity', readyEvent)
  }
  return coordinator
}


export function registerIpcHandlers(win: BrowserWindow): void {
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
      let result = await coord.chat(message, mentions)

      // If setup-token is invalid/revoked, mark invalid and retry once with API key fallback.
      if (
        !result.success
        && anthropicAuth.isAnthropicModel(requestedModel)
        && currentAuthMode === 'setup-token'
      ) {
        const classified = classifyAnthropicAuthFailure(result.error)
        if (classified.isAuthInvalid) {
          const status = anthropicAuth.invalidateSetupToken(
            projectPath,
            result.error || classified.reasonCode,
            process.env.ANTHROPIC_API_KEY
          )
          safeSend(win, 'auth:anthropic-status', status)

          if ((process.env.ANTHROPIC_API_KEY || '').trim()) {
            const fallbackEvent = {
              type: 'system',
              summary: 'Anthropic setup-token invalid. Retrying with API key fallback.'
            }
            realtimeBuffer.pushActivity(fallbackEvent)
            safeSend(win, 'agent:activity', fallbackEvent)

            coordinator?.destroy().catch(() => {})
            coordinator = null

            const fallbackCoordinator = await ensureCoordinator(win, requestedModel, {
              forceRecreate: true,
              anthropicModeOverride: 'api-key'
            })
            result = await fallbackCoordinator.chat(message, mentions)
          }
        }
      }

      // Successful setup-token run marks token as valid.
      if (
        result.success
        && anthropicAuth.isAnthropicModel(requestedModel)
        && currentAuthMode === 'setup-token'
      ) {
        const status = anthropicAuth.markSetupTokenValid(projectPath, process.env.ANTHROPIC_API_KEY)
        safeSend(win, 'auth:anthropic-status', status)
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

  // Auth (Anthropic setup-token / fallback)
  ipcMain.handle('auth:get-anthropic-status', () => {
    if (!projectPath) {
      return {
        authMode: 'none',
        authStatus: 'missing',
        hasSetupToken: false,
        hasApiKeyFallback: !!(process.env.ANTHROPIC_API_KEY || '').trim(),
        lastError: null
      }
    }
    return anthropicAuth.getStatus(projectPath, process.env.ANTHROPIC_API_KEY)
  })

  ipcMain.handle('auth:save-anthropic-setup-token', (_e, token: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    try {
      const status = anthropicAuth.saveSetupToken(projectPath, token)
      if (coordinator && anthropicAuth.isAnthropicModel(currentModel)) {
        coordinator.destroy().catch(() => {})
        coordinator = null
      }
      safeSend(win, 'auth:anthropic-status', status)
      return { success: true, status }
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to save setup-token.' }
    }
  })

  ipcMain.handle('auth:clear-anthropic-setup-token', () => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const status = anthropicAuth.clearSetupToken(projectPath, process.env.ANTHROPIC_API_KEY)
    if (coordinator && anthropicAuth.isAnthropicModel(currentModel)) {
      coordinator.destroy().catch(() => {})
      coordinator = null
    }
    safeSend(win, 'auth:anthropic-status', status)
    return { success: true, status }
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
  ipcMain.handle('cmd:list-literature', () => {
    if (!projectPath) return []
    return listLiterature(projectPath)
  })
  ipcMain.handle('cmd:list-data', () => {
    if (!projectPath) return []
    return listData(projectPath)
  })
  ipcMain.handle('cmd:search', (_e, query: string) => {
    if (!projectPath) return []
    return searchEntities(projectPath, query)
  })
  ipcMain.handle('cmd:delete', (_e, id: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return deleteEntity(id, projectPath)
  })

  // Commands - Artifact (RFC-012 canonical)
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

  // Commands - Focus (RFC-012 canonical)
  ipcMain.handle('cmd:focus-add', (_e, params: {
    refType: 'artifact' | 'fact' | 'task'
    refId: string
    reason?: string
    score?: number
    source?: 'manual' | 'auto'
    ttl?: string
  }) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return focusAdd(projectPath, {
      sessionId,
      refType: params.refType,
      refId: params.refId,
      reason: params.reason ?? 'manually selected',
      score: params.score,
      source: params.source ?? 'manual',
      ttl: params.ttl ?? '2h'
    })
  })
  ipcMain.handle('cmd:focus-list', () => {
    if (!projectPath) return { success: true, entries: [] }
    return focusList(projectPath, sessionId)
  })
  ipcMain.handle('cmd:focus-remove', (_e, idOrRef: string) => {
    if (!projectPath) return { success: false, removed: false }
    return focusRemove(projectPath, sessionId, idOrRef)
  })
  ipcMain.handle('cmd:focus-clear', () => {
    if (!projectPath) return { success: false, removed: false }
    return focusClear(projectPath, sessionId)
  })
  ipcMain.handle('cmd:focus-prune', () => {
    if (!projectPath) return { success: true, expired: 0, kept: 0 }
    return focusPrune(projectPath, sessionId)
  })

  // Commands - Task anchor / explain
  ipcMain.handle('cmd:task-anchor-get', () => {
    if (!projectPath) return { success: true, anchor: null }
    return taskAnchorGet(projectPath, sessionId)
  })
  ipcMain.handle('cmd:task-anchor-set', (_e, anchor: {
    currentGoal: string
    nowDoing: string
    blockedBy: string[]
    nextAction: string
    sessionId?: string
  }) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return taskAnchorSet(projectPath, anchor.sessionId ?? sessionId, {
      currentGoal: anchor.currentGoal,
      nowDoing: anchor.nowDoing,
      blockedBy: anchor.blockedBy,
      nextAction: anchor.nextAction
    })
  })
  ipcMain.handle('cmd:task-anchor-update', (_e, patch: {
    currentGoal?: string
    nowDoing?: string
    blockedBy?: string[]
    nextAction?: string
    sessionId?: string
  }) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return taskAnchorUpdate(projectPath, patch.sessionId ?? sessionId, {
      currentGoal: patch.currentGoal,
      nowDoing: patch.nowDoing,
      blockedBy: patch.blockedBy,
      nextAction: patch.nextAction
    })
  })

  ipcMain.handle('cmd:memory-explain-turn', () => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return memoryExplainTurn(projectPath)
  })
  ipcMain.handle('cmd:memory-explain-fact', (_e, factId: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return memoryExplainFact(projectPath, factId)
  })
  ipcMain.handle('cmd:memory-explain-budget', () => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return memoryExplainBudget(projectPath)
  })

  // Commands - Facts (read from .agentfoundry/memory/facts.jsonl)
  ipcMain.handle('cmd:fact-list', () => {
    if (!projectPath) return []
    const factsFile = join(projectPath, '.agentfoundry', 'memory', 'facts.jsonl')
    if (!existsSync(factsFile)) return []
    try {
      const raw = readFileSync(factsFile, 'utf-8')
      const lines = raw.split(/\r?\n/).filter(Boolean)
      const allFacts: any[] = []
      for (const line of lines) {
        try { allFacts.push(JSON.parse(line)) } catch { /* skip malformed */ }
      }
      // Return latest version per namespace:key, only active/proposed
      const byKey = new Map<string, any>()
      for (const fact of allFacts) {
        const k = `${fact.namespace}:${fact.key}`
        const existing = byKey.get(k)
        if (!existing || fact.updatedAt > existing.updatedAt) {
          byKey.set(k, fact)
        }
      }
      return Array.from(byKey.values()).filter(
        (f: any) => f.status === 'active' || f.status === 'proposed'
      )
    } catch {
      return []
    }
  })

  ipcMain.handle('cmd:fact-promote', (_e, factId: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const factsFile = join(projectPath, '.agentfoundry', 'memory', 'facts.jsonl')
    if (!existsSync(factsFile)) return { success: false, error: 'No facts file found.' }
    try {
      const raw = readFileSync(factsFile, 'utf-8')
      const lines = raw.split(/\r?\n/).filter(Boolean)
      const updated: string[] = []
      let found = false
      for (const line of lines) {
        try {
          const fact = JSON.parse(line)
          if (fact.id === factId) {
            fact.status = 'active'
            fact.updatedAt = new Date().toISOString()
            found = true
          }
          updated.push(JSON.stringify(fact))
        } catch {
          updated.push(line)
        }
      }
      if (!found) return { success: false, error: 'Fact not found.' }
      writeFileSync(factsFile, updated.join('\n') + '\n')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('cmd:fact-demote', (_e, factId: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const factsFile = join(projectPath, '.agentfoundry', 'memory', 'facts.jsonl')
    if (!existsSync(factsFile)) return { success: false, error: 'No facts file found.' }
    try {
      const raw = readFileSync(factsFile, 'utf-8')
      const lines = raw.split(/\r?\n/).filter(Boolean)
      const updated: string[] = []
      let found = false
      for (const line of lines) {
        try {
          const fact = JSON.parse(line)
          if (fact.id === factId) {
            fact.status = 'deprecated'
            fact.updatedAt = new Date().toISOString()
            found = true
          }
          updated.push(JSON.stringify(fact))
        } catch {
          updated.push(line)
        }
      }
      if (!found) return { success: false, error: 'Fact not found.' }
      writeFileSync(factsFile, updated.join('\n') + '\n')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Commands - rename note
  ipcMain.handle('cmd:rename-note', (_e, id: string, newTitle: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    // Search across all entity directories
    const dirs = [PATHS.notes, PATHS.literature, PATHS.data]
    for (const dir of dirs) {
      const filePath = join(projectPath, dir, `${id}.json`)
      if (!existsSync(filePath)) continue
      try {
        const entity = JSON.parse(readFileSync(filePath, 'utf-8'))
        // Data entities use 'name', notes/papers use 'title'
        if (entity.type === 'data') {
          entity.name = newTitle
        } else {
          entity.title = newTitle
        }
        entity.updatedAt = new Date().toISOString()
        writeFileSync(filePath, JSON.stringify(entity, null, 2))
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
    return { success: false, error: 'Entity not found.' }
  })

  // Commands - update entity (title + content)
  ipcMain.handle('cmd:update-entity', (_e, id: string, updates: { title?: string; content?: string }) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const dirs = [PATHS.notes, PATHS.literature, PATHS.data]
    for (const dir of dirs) {
      const filePath = join(projectPath, dir, `${id}.json`)
      if (!existsSync(filePath)) continue
      try {
        const entity = JSON.parse(readFileSync(filePath, 'utf-8'))
        if (updates.title !== undefined) {
          if (entity.type === 'data') {
            entity.name = updates.title
          } else {
            entity.title = updates.title
          }
        }
        if (updates.content !== undefined) {
          if (entity.type === 'paper') {
            entity.abstract = updates.content
          } else {
            entity.content = updates.content
          }
        }
        entity.updatedAt = new Date().toISOString()
        writeFileSync(filePath, JSON.stringify(entity, null, 2))
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
    return { success: false, error: 'Entity not found.' }
  })

  // Commands - save
  // saveNote signature: saveNote(title, content, tags, context, fromLast)
  ipcMain.handle('cmd:save-note', (_e, title: string, content: string, messageId?: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return saveNote(title, content, [], { sessionId, projectPath, lastAgentResponse: '' }, false, messageId)
  })
  ipcMain.handle('cmd:save-paper', (_e, argsStr: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const args = parseSavePaperArgs(argsStr)
    return savePaper(args.title, args, { sessionId, projectPath })
  })
  ipcMain.handle('cmd:save-data', (_e, argsStr: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const args = parseSaveDataArgs(argsStr)
    return saveData(args.name, args, { sessionId, projectPath })
  })

  // Commands - enrich all papers
  ipcMain.handle('cmd:enrich-papers', async (_e, paperIds?: string[]) => {
    if (!projectPath) return { success: false, enriched: 0, skipped: 0, failed: 0 }

    // Load full Literature objects from disk (listLiterature only returns a subset of fields)
    const litDir = join(projectPath, PATHS.literature)
    if (!existsSync(litDir)) return { success: true, enriched: 0, skipped: 0, failed: 0 }
    const files = readdirSync(litDir).filter(f => f.endsWith('.json'))
    const allPapers: any[] = []
    for (const file of files) {
      try {
        allPapers.push(JSON.parse(readFileSync(join(litDir, file), 'utf-8')))
      } catch { /* skip corrupt files */ }
    }

    // Respect the order provided by the renderer (e.g. sorted by year desc)
    let papers: any[]
    if (paperIds && paperIds.length > 0) {
      const byId = new Map(allPapers.map(p => [p.id, p]))
      papers = paperIds.map(id => byId.get(id)).filter(Boolean)
    } else {
      papers = allPapers
    }
    if (papers.length === 0) return { success: true, enriched: 0, skipped: 0, failed: 0 }

    const rateLimiter = new RateLimiter(DEFAULT_SEARCHER_CONFIG.rateLimits)
    const circuitBreaker = new CircuitBreaker(DEFAULT_SEARCHER_CONFIG.circuitBreaker)
    const config = createEnrichmentConfig(rateLimiter, circuitBreaker)
    // Each paper gets its own enrichPapers() call; give generous budget
    config.maxPapersToEnrich = 1
    config.maxTimeMs = 60_000

    let enriched = 0
    let skipped = 0
    let failed = 0

    for (const paper of papers) {
      const beforeFields = {
        venue: paper.venue,
        doi: paper.doi,
        citationCount: paper.citationCount,
        url: paper.url,
        abstract: paper.abstract
      }

      const asPaperInput: PaperInput = {
        title: paper.title || '',
        authors: paper.authors,
        year: paper.year,
        venue: paper.venue,
        abstract: paper.abstract,
        doi: paper.doi,
        citationCount: paper.citationCount,
        url: paper.url,
        pdfUrl: paper.pdfUrl,
        source: paper.externalSource
      }

      // Skip papers already complete (5+ of 7 core fields)
      if (countCoreFields(asPaperInput) >= 5) {
        safeSend(win, 'enrich:progress', { paperId: paper.id, status: 'skipped' })
        skipped++
        continue
      }

      safeSend(win, 'enrich:progress', { paperId: paper.id, status: 'enriching' })

      try {
        await enrichPapers([asPaperInput], config)

        // Check if any field actually changed on the PaperInput object
        const hasNewData =
          (asPaperInput.venue && asPaperInput.venue !== beforeFields.venue) ||
          (asPaperInput.doi && asPaperInput.doi !== beforeFields.doi) ||
          (asPaperInput.citationCount != null && asPaperInput.citationCount !== beforeFields.citationCount) ||
          (asPaperInput.url && asPaperInput.url !== beforeFields.url) ||
          (asPaperInput.abstract && asPaperInput.abstract !== beforeFields.abstract)

        if (hasNewData) {
          updatePaperMetadata(paper, {
            authors: asPaperInput.authors,
            year: asPaperInput.year,
            abstract: asPaperInput.abstract,
            venue: asPaperInput.venue ?? undefined,
            url: asPaperInput.url,
            citationCount: asPaperInput.citationCount ?? undefined,
            doi: asPaperInput.doi ?? undefined,
            pdfUrl: asPaperInput.pdfUrl ?? undefined,
            enrichmentSource: (asPaperInput as any).enrichmentSource ?? undefined,
            enrichedAt: (asPaperInput as any).enrichedAt ?? undefined
          }, { sessionId, projectPath })
          enriched++
          safeSend(win, 'enrich:progress', { paperId: paper.id, status: 'done' })
        } else {
          // APIs didn't return useful data for this paper
          console.log(`[enrich] No new data found for: ${paper.title?.slice(0, 60)}`)
          skipped++
          safeSend(win, 'enrich:progress', { paperId: paper.id, status: 'skipped' })
        }
      } catch (err) {
        console.error(`[enrich] Error enriching "${paper.title?.slice(0, 60)}":`, err)
        failed++
        safeSend(win, 'enrich:progress', { paperId: paper.id, status: 'failed' })
      }
    }

    console.log(`[enrich] Done: ${enriched} enriched, ${skipped} skipped, ${failed} failed`)
    return { success: true, enriched, skipped, failed }
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
        // Skip hidden directories/files like .research-pilot, .git, etc.
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

  ipcMain.handle('file:write', (_e, filePath: string, content: string) => {
    try {
      if (!projectPath) {
        return { success: false, error: 'No project folder selected.' }
      }
      if (typeof content !== 'string') {
        return { success: false, error: 'Invalid content.' }
      }
      const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
      if (!isWithinRoot(projectPath, absPath)) {
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

  ipcMain.handle('file:add-focus', (_e, filePath: string, reason?: string, ttl?: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
    if (!isWithinRoot(projectPath, absPath)) {
      return { success: false, error: 'Path is outside current workspace.' }
    }
    if (!existsSync(absPath)) {
      return { success: false, error: 'File not found.' }
    }
    return addFileToFocus(absPath, reason, ttl)
  })

  ipcMain.handle('task:link-evidence', (_e, filePath: string, reason?: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
    if (!isWithinRoot(projectPath, absPath)) {
      return { success: false, error: 'Path is outside current workspace.' }
    }
    if (!existsSync(absPath)) {
      return { success: false, error: 'File not found.' }
    }

    const focusResult = addFileToFocus(absPath, reason ?? 'linked as task evidence', 'today')
    if (!focusResult.success) return focusResult

    const fileLabel = toPosixPath(relative(projectPath, absPath))
    const current = taskAnchorGet(projectPath)
    const blockedBy = current.anchor?.blockedBy ?? []
    const marker = `Evidence: ${fileLabel}`
    const mergedBlockedBy = blockedBy.includes(marker) ? blockedBy : [...blockedBy, marker]

    const anchorResult = taskAnchorUpdate(projectPath, {
      blockedBy: mergedBlockedBy,
      nextAction: current.anchor?.nextAction || `Review evidence file: ${fileLabel}`
    })

    return {
      success: focusResult.success && anchorResult.success,
      focus: focusResult,
      taskAnchor: anchorResult
    }
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
  ipcMain.handle('file:drop', async (_e, fileName: string, content: string, tab: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }

    if (tab === 'notes') {
      // Save text content as a note entity
      const title = fileName.replace(/\.\w+$/, '')
      return saveNote(title, content, [], { sessionId, projectPath, lastAgentResponse: '' }, false)
    }

    if (tab === 'data') {
      // Write file into .research-pilot/data/ and register as data entity
      const dataDir = join(projectPath, PATHS.data)
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
      const destPath = join(dataDir, fileName)
      writeFileSync(destPath, content, 'utf-8')

      const name = fileName.replace(/\.\w+$/, '')
      const ext = fileName.split('.').pop()?.toLowerCase() || ''
      const mimeMap: Record<string, string> = { csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json' }
      return saveData(name, { filePath: destPath, mimeType: mimeMap[ext] }, { sessionId, projectPath })
    }

    if (tab === 'papers') {
      // Save as a literature reference with content as abstract
      const title = fileName.replace(/\.\w+$/, '')
      return savePaper(title, { authors: [], abstract: content }, { sessionId, projectPath })
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
      projectPath = result.filePaths[0]
      // Initialize .research-pilot directory structure
      initializeProject(projectPath)
      // Reset coordinator and memory storage for new project
      if (coordinator) {
        await coordinator.destroy()
        coordinator = null
      }
      // Reuse persistent session ID for this project folder
      sessionId = loadOrCreateSessionId(projectPath)
      // Restore persisted model + reasoning preferences
      const prefsFile = join(projectPath, PATHS.root, 'preferences.json')
      if (existsSync(prefsFile)) {
        try {
          const prefs = JSON.parse(readFileSync(prefsFile, 'utf-8'))
          if (prefs.selectedModel) currentModel = prefs.selectedModel
          if (prefs.reasoningEffort) currentReasoningEffort = prefs.reasoningEffort
        } catch { /* ignore corrupt file */ }
      }
      return { projectPath, sessionId }
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
    } finally {
      isClosing = false
    }
  })
}
