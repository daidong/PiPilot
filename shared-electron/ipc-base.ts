/**
 * Shared IPC handler utilities for Electron main process.
 * Provides common file operations, session management, preferences,
 * usage tracking, auth status, and folder-open helpers.
 *
 * Both personal-assistant and research-pilot-desktop import from here.
 */
import { shell } from 'electron'
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, statSync } from 'fs'
import { extname, join, resolve, isAbsolute } from 'path'
import { homedir } from 'os'
import type { BrowserWindow } from 'electron'
import type { ResolvedCoordinatorAuth } from './types'

// ─── Settings types (duplicated from shared-ui/settings-types.ts to avoid cross-rootDir import) ─
interface ResearchSettings {
  researchIntensity: 'low' | 'medium' | 'high'
  webSearchDepth: 'quick' | 'standard' | 'thorough'
  autoSaveSensitivity: 'conservative' | 'balanced' | 'aggressive'
}
interface DataAnalysisSettings {
  executionTimeLimit: 'short' | 'standard' | 'extended' | 'long'
}
export interface AppSettings {
  research: ResearchSettings
  dataAnalysis: DataAnalysisSettings
}
const DEFAULT_SETTINGS: AppSettings = {
  research: { researchIntensity: 'medium', webSearchDepth: 'standard', autoSaveSensitivity: 'balanced' },
  dataAnalysis: { executionTimeLimit: 'standard' },
}
import type { OAuthCredentials } from '@mariozechner/pi-ai/oauth'
import { TREE_MAX_ENTRIES, isWithinRoot, listTreeChildren, searchTree } from './file-tree'

// ─── API Key Config ────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), '.research-copilot')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

const API_KEY_NAMES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'BRAVE_API_KEY',
  'OPENROUTER_API_KEY'
] as const

interface AppConfig {
  apiKeys?: Record<string, string>
  settings?: AppSettings
}

function readConfig(): AppConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
    }
  } catch { /* ignore corrupt config */ }
  return {}
}

function writeConfig(config: AppConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

/**
 * Load API keys from ~/.research-copilot/config.json into process.env.
 * Only sets keys that are NOT already in the environment (env takes priority).
 */
export function loadApiKeysFromConfig(): void {
  const config = readConfig()
  if (!config.apiKeys) return
  for (const key of API_KEY_NAMES) {
    const envVal = (process.env[key] || '').trim()
    const configVal = (config.apiKeys[key] || '').trim()
    if (!envVal && configVal) {
      process.env[key] = configVal
    }
  }
}

/**
 * Register IPC handlers for API key configuration.
 */
export function registerConfigHandlers(
  handleRaw: (channel: string, handler: (...args: any[]) => any) => void
) {
  /** Returns which keys are configured (boolean map, never exposes values) */
  handleRaw('config:get-api-key-status', () => {
    const result: Record<string, boolean> = {}
    for (const key of API_KEY_NAMES) {
      result[key] = !!(process.env[key] || '').trim()
    }
    return result
  })

  /** Save an API key to config file AND load into current process.env */
  handleRaw('config:save-api-key', (keyName: string, value: string) => {
    if (!API_KEY_NAMES.includes(keyName as any)) {
      return { success: false, error: `Unknown key: ${keyName}` }
    }
    const config = readConfig()
    if (!config.apiKeys) config.apiKeys = {}
    const trimmed = value.trim()
    if (trimmed) {
      config.apiKeys[keyName] = trimmed
      process.env[keyName] = trimmed
    } else {
      delete config.apiKeys[keyName]
      delete process.env[keyName]
    }
    writeConfig(config)
    return { success: true }
  })
}

// ─── Settings (research / data-analysis presets) ────────────────────────────

/**
 * Load app settings from ~/.research-copilot/config.json.
 * Returns DEFAULT_SETTINGS if none are stored yet.
 * Safe to call from main process at any time.
 */
export function loadSettingsFromConfig(): AppSettings {
  const config = readConfig()
  if (!config.settings) return { ...DEFAULT_SETTINGS }
  // Merge with defaults to handle new fields added in future versions
  return {
    research: { ...DEFAULT_SETTINGS.research, ...config.settings.research },
    dataAnalysis: { ...DEFAULT_SETTINGS.dataAnalysis, ...config.settings.dataAnalysis },
  }
}

/**
 * Check whether at least one LLM auth method is configured
 * (API key for Anthropic/OpenAI OR Codex OAuth credentials).
 */
export function hasLlmAuth(): boolean {
  const hasAnthropicKey = !!(process.env.ANTHROPIC_API_KEY || '').trim()
  const hasOpenaiKey = !!(process.env.OPENAI_API_KEY || '').trim()
  const hasCodex = !!loadCodexCredentials()
  return hasAnthropicKey || hasOpenaiKey || hasCodex
}

/**
 * Register IPC handlers for unified settings (research presets, data-analysis, etc.).
 */
export function registerSettingsHandlers(
  handleRaw: (channel: string, handler: (...args: any[]) => any) => void
) {
  /** Returns true if at least one LLM auth is configured */
  handleRaw('config:has-llm-auth', () => hasLlmAuth())

  /** Load settings (returns full AppSettings, never partial) */
  handleRaw('settings:load', () => loadSettingsFromConfig())

  /** Save settings (expects a COMPLETE AppSettings snapshot, replaces config.settings) */
  handleRaw('settings:save', (settings: AppSettings) => {
    const config = readConfig()
    config.settings = settings
    writeConfig(config)
    return { success: true }
  })
}

// ─── Utility helpers ────────────────────────────────────────────────────────

/** Extract just the filename from a path */
export function getFileName(path: string): string {
  if (!path) return ''
  return path.split('/').pop() || path
}

export function inferMimeType(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.md' || ext === '.txt') return 'text/plain'
  if (ext === '.csv') return 'text/csv'
  if (ext === '.tsv') return 'text/tab-separated-values'
  if (ext === '.json') return 'application/json'
  if (ext === '.pdf') return 'application/pdf'
  return 'application/octet-stream'
}

/** Safely send an IPC message -- no-op if the window has been destroyed. */
export function safeSend(win: BrowserWindow, channel: string, ...args: unknown[]) {
  if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

export function isValidProjectDirectory(path: string): boolean {
  try {
    return !!path && existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Load or create a persistent session ID for a project folder */
export function loadOrCreateSessionId(rootPathKey: string, path: string): string {
  const sessionFile = join(path, rootPathKey, 'session.json')
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

// ─── OpenAI Codex OAuth credential store ──────────────────────────────────
const CODEX_CRED_FILE = join(CONFIG_DIR, 'openai-codex-credentials.json')

export function loadCodexCredentials(): OAuthCredentials | null {
  // First try our own store
  try {
    if (existsSync(CODEX_CRED_FILE)) {
      const data = JSON.parse(readFileSync(CODEX_CRED_FILE, 'utf-8'))
      if (data.access && data.refresh) return data as OAuthCredentials
    }
  } catch { /* ignore */ }
  // Fallback: try reading Codex CLI's auth.json
  try {
    const codexHome = join(homedir(), '.codex')
    const codexAuth = join(codexHome, 'auth.json')
    if (existsSync(codexAuth)) {
      const data = JSON.parse(readFileSync(codexAuth, 'utf-8'))
      if (data.tokens?.access_token && data.tokens?.refresh_token) {
        return {
          access: data.tokens.access_token,
          refresh: data.tokens.refresh_token,
          expires: data.tokens.expires_at ? data.tokens.expires_at * 1000 : Date.now() + 3600_000,
          accountId: data.tokens.account_id
        }
      }
    }
  } catch { /* ignore */ }
  return null
}

export function saveCodexCredentials(creds: OAuthCredentials): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CODEX_CRED_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 })
}

export function clearCodexCredentials(): void {
  try {
    if (existsSync(CODEX_CRED_FILE)) {
      const { unlinkSync } = require('fs')
      unlinkSync(CODEX_CRED_FILE)
    }
  } catch { /* ignore */ }
}

/**
 * Parse a composite model key and resolve auth credentials.
 * Supports: 'openai:gpt-5.4', 'anthropic:claude-opus-4-6', 'openai-codex:gpt-5.4'
 * Legacy keys like 'gpt-5.4' or 'claude-opus-4-6' are auto-migrated.
 */
export function resolveCoordinatorAuth(compositeKey: string): ResolvedCoordinatorAuth {
  const openaiApiKey = (process.env.OPENAI_API_KEY || '').trim()
  const anthropicApiKey = (process.env.ANTHROPIC_API_KEY || '').trim()

  // Parse provider:modelId
  const i = compositeKey.indexOf(':')
  let provider: string
  if (i > 0) {
    provider = compositeKey.slice(0, i)
  } else {
    // Legacy format fallback
    provider = compositeKey.startsWith('claude-') ? 'anthropic' : 'openai'
  }

  switch (provider) {
    case 'openai-codex': {
      const creds = loadCodexCredentials()
      if (!creds) {
        throw new Error('ChatGPT subscription login required. Please sign in via the model selector.')
      }
      return {
        apiKey: creds.access,
        authMode: 'subscription',
        isAnthropicModel: false,
        billingSource: 'subscription',
        piProvider: 'openai-codex'
      }
    }
    case 'anthropic': {
      if (!anthropicApiKey) {
        throw new Error('ANTHROPIC_API_KEY is required for the selected Anthropic model.')
      }
      return { apiKey: anthropicApiKey, authMode: 'api-key', isAnthropicModel: true, billingSource: 'api-key' }
    }
    default: {
      // openai and any other provider
      if (!openaiApiKey) {
        throw new Error('OPENAI_API_KEY is required for the selected OpenAI model.')
      }
      return { apiKey: openaiApiKey, authMode: 'api-key', isAnthropicModel: false, billingSource: 'api-key' }
    }
  }
}

// ─── Shared IPC handler registrations ───────────────────────────────────────
// Each function takes `ipcMain.handle` (or a wrapper) and project-path getter
// so the caller controls how state is accessed.

export interface SharedHandlerContext {
  /** Current project path (empty string = no project) */
  projectPath: string
}

/**
 * Register file operation IPC handlers that are identical across apps.
 * The `handle` callback should match `ipcMain.handle` signature or an equivalent wrapper.
 *
 * @param handle  - function to register an IPC handler: (channel, handler) => void
 * @param getCtx  - returns the current project path and any other shared state
 */
export function registerFileHandlers(
  handle: (channel: string, handler: (...args: any[]) => any) => void,
  getCtx: () => SharedHandlerContext
) {
  // List files in the project root folder (non-recursive, files only)
  handle('file:list-root', () => {
    const { projectPath } = getCtx()
    if (!projectPath) return []
    try {
      const entries = readdirSync(projectPath)
      const files: { path: string; name: string }[] = []
      for (const entry of entries) {
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

  // Workspace file tree - lazy by directory level
  handle('file:list-tree', (options?: { relativePath?: string; showIgnored?: boolean; limit?: number }) => {
    const { projectPath } = getCtx()
    if (!projectPath) return []
    const relativePath = options?.relativePath ?? ''
    const showIgnored = options?.showIgnored ?? false
    const limit = options?.limit ?? TREE_MAX_ENTRIES
    return listTreeChildren(projectPath, relativePath, showIgnored, limit)
  })

  handle('file:search-tree', (query: string, options?: { showIgnored?: boolean; maxResults?: number }) => {
    const { projectPath } = getCtx()
    if (!projectPath) return []
    return searchTree(projectPath, query, options?.showIgnored ?? false, options?.maxResults ?? 200)
  })

  // File reading for working folder preview
  handle('file:read', (filePath: string) => {
    const { projectPath } = getCtx()
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

  // Resolve a file path to an absolute path (for file:// URLs)
  handle('file:resolve-path', (filePath: string) => {
    const { projectPath } = getCtx()
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
  handle('file:open-external', (filePath: string) => {
    const { projectPath } = getCtx()
    const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
    if (!existsSync(absPath)) return { success: false, error: 'File not found' }
    shell.openPath(absPath)
    return { success: true }
  })

  // Move a workspace file or directory to system trash
  handle('file:trash', async (filePath: string) => {
    const { projectPath } = getCtx()
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
  handle('file:drop-to-dir', (fileName: string, base64Content: string, targetDirRelPath: string) => {
    const { projectPath } = getCtx()
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

  // Binary file reading (images, PDFs) -- returns base64
  handle('file:read-binary', (filePath: string) => {
    const { projectPath } = getCtx()
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
}

/**
 * Register session (chat history persistence) IPC handlers.
 */
export function registerSessionHandlers(
  handle: (channel: string, handler: (...args: any[]) => any) => void,
  getCtx: () => SharedHandlerContext,
  sessionsPathKey: string
) {
  handle('session:save-message', (sid: string, msg: any) => {
    const { projectPath } = getCtx()
    if (!projectPath) return
    const dir = join(projectPath, sessionsPathKey)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sid}.jsonl`)
    appendFileSync(file, JSON.stringify(msg) + '\n')
  })

  handle('session:load-messages', (sid: string, offset: number, limit: number) => {
    const { projectPath } = getCtx()
    if (!projectPath) return []
    const file = join(projectPath, sessionsPathKey, `${sid}.jsonl`)
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    // offset=0 means most recent batch; we read from the end
    const start = Math.max(0, lines.length - offset - limit)
    const end = lines.length - offset
    return lines.slice(start, end).map((l) => JSON.parse(l))
  })

  handle('session:get-total-count', (sid: string) => {
    const { projectPath } = getCtx()
    if (!projectPath) return 0
    const file = join(projectPath, sessionsPathKey, `${sid}.jsonl`)
    if (!existsSync(file)) return 0
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean).length
  })

  handle('session:mark-saved', (sid: string, messageId: string) => {
    const { projectPath } = getCtx()
    if (!projectPath) return
    const file = join(projectPath, sessionsPathKey, `${sid}.saved.json`)
    let ids: string[] = []
    if (existsSync(file)) {
      try { ids = JSON.parse(readFileSync(file, 'utf-8')) } catch { ids = [] }
    }
    if (!ids.includes(messageId)) {
      ids.push(messageId)
      writeFileSync(file, JSON.stringify(ids))
    }
  })

  handle('session:load-saved-ids', (sid: string) => {
    const { projectPath } = getCtx()
    if (!projectPath) return []
    const file = join(projectPath, sessionsPathKey, `${sid}.saved.json`)
    if (!existsSync(file)) return []
    try { return JSON.parse(readFileSync(file, 'utf-8')) } catch { return [] }
  })
}

/**
 * Register preferences IPC handlers.
 */
export function registerPrefsHandlers(
  handle: (channel: string, handler: (...args: any[]) => any) => void,
  getCtx: () => SharedHandlerContext,
  rootPathKey: string,
  callbacks: {
    onModelChange: (model: string) => void
    onReasoningEffortChange: (effort: string) => void
    invalidateCoordinator: () => void
    getCurrentModel: () => string
    getCurrentReasoningEffort: () => string
  }
) {
  handle('prefs:load', () => {
    const { projectPath } = getCtx()
    if (!projectPath) return null
    const file = join(projectPath, rootPathKey, 'preferences.json')
    if (!existsSync(file)) return null
    try { return JSON.parse(readFileSync(file, 'utf-8')) } catch { return null }
  })

  handle('prefs:save', (prefs: { selectedModel?: string; reasoningEffort?: string }) => {
    const { projectPath } = getCtx()
    if (!projectPath) return
    const file = join(projectPath, rootPathKey, 'preferences.json')
    const data = { ...prefs, updatedAt: new Date().toISOString() }
    writeFileSync(file, JSON.stringify(data, null, 2))
    const modelChanged = prefs.selectedModel && prefs.selectedModel !== callbacks.getCurrentModel()
    const effortChanged = prefs.reasoningEffort && prefs.reasoningEffort !== callbacks.getCurrentReasoningEffort()
    if (prefs.selectedModel) callbacks.onModelChange(prefs.selectedModel)
    if (prefs.reasoningEffort) callbacks.onReasoningEffortChange(prefs.reasoningEffort)
    if (modelChanged || effortChanged) {
      callbacks.invalidateCoordinator()
    }
  })
}

/**
 * Register usage totals IPC handlers.
 */
export function registerUsageHandlers(
  handle: (channel: string, handler: (...args: any[]) => any) => void,
  getCtx: () => SharedHandlerContext,
  loadUsageTotals: (baseDir: string) => any,
  resetUsageTotals: (baseDir: string) => any
) {
  handle('usage:get-totals', () => {
    const { projectPath } = getCtx()
    if (!projectPath) return null
    const baseDir = join(projectPath, '.research-pilot')
    return loadUsageTotals(baseDir)
  })

  handle('usage:reset-totals', () => {
    const { projectPath } = getCtx()
    if (!projectPath) return null
    const baseDir = join(projectPath, '.research-pilot')
    return resetUsageTotals(baseDir)
  })
}

/**
 * Register auth status IPC handlers (stateless, no project needed).
 */
export function registerAuthHandlers(
  handleRaw: (channel: string, handler: (...args: any[]) => any) => void
) {
  handleRaw('auth:get-anthropic-status', () => {
    const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || '').trim()
    return {
      authMode: hasApiKey ? 'api-key' : 'none',
      authStatus: hasApiKey ? 'valid' : 'missing',
      hasSetupToken: false,
      hasApiKeyFallback: hasApiKey,
      lastError: null
    }
  })

  handleRaw('auth:get-openai-status', () => {
    return {
      hasApiKey: !!(process.env.OPENAI_API_KEY || '').trim()
    }
  })

  // ─── OpenAI Codex (ChatGPT Subscription) OAuth ──────────────────────────
  handleRaw('auth:get-openai-codex-status', () => {
    const creds = loadCodexCredentials()
    return {
      isLoggedIn: !!creds,
      isExpired: creds ? creds.expires < Date.now() : false
    }
  })

  handleRaw('auth:openai-codex-login', async () => {
    const { loginOpenAICodex } = await import('@mariozechner/pi-ai/oauth')
    const { shell } = await import('electron')
    try {
      const creds = await loginOpenAICodex({
        onAuth: (info) => { shell.openExternal(info.url) },
        onPrompt: async (prompt) => {
          // This shouldn't be called in normal browser flow
          console.warn('[OAuth] Unexpected prompt:', prompt.message)
          return ''
        },
        onProgress: (msg) => { console.log('[OAuth]', msg) }
      })
      saveCodexCredentials(creds)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message || 'OAuth login failed' }
    }
  })

  handleRaw('auth:openai-codex-logout', () => {
    clearCodexCredentials()
    return { success: true }
  })

  handleRaw('auth:openai-codex-refresh', async () => {
    const creds = loadCodexCredentials()
    if (!creds) return { success: false, error: 'Not logged in' }
    try {
      const { refreshOpenAICodexToken } = await import('@mariozechner/pi-ai/oauth')
      const newCreds = await refreshOpenAICodexToken(creds)
      saveCodexCredentials(newCreds)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message || 'Token refresh failed' }
    }
  })
}

/**
 * Register folder:open-with IPC handler.
 */
export function registerFolderOpenHandler(
  handle: (channel: string, handler: (...args: any[]) => any) => void,
  getCtx: () => SharedHandlerContext
) {
  handle('folder:open-with', async (appName: 'finder' | 'zed' | 'cursor' | 'vscode') => {
    const { projectPath } = getCtx()
    if (!projectPath) return { success: false, error: 'No project open' }

    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)

    try {
      switch (appName) {
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
          return { success: false, error: `Unknown app: ${appName}` }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to open folder' }
    }
  })
}
