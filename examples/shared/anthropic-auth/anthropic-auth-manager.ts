import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type {
  AnthropicAuthState,
  AnthropicAuthStatus,
  AnthropicAuthStatusView,
  AnthropicResolvedCredential
} from './anthropic-auth-types'

type AppMemoryRoot = '.personal-assistant-v2' | '.research-pilot' | '.research-pilot-v2'

interface AnthropicAuthManagerConfig {
  appMemoryRoot: AppMemoryRoot
  logger?: (message: string) => void
}

export interface ResolveAnthropicCredentialOptions {
  model: string
  projectPath: string
  anthropicApiKey?: string
}

export interface AnthropicAuthManager {
  isAnthropicModel(model: string): boolean
  getStatus(projectPath: string, anthropicApiKey?: string): AnthropicAuthStatusView
  resolveCredential(options: ResolveAnthropicCredentialOptions): AnthropicResolvedCredential
  saveSetupToken(projectPath: string, token: string): AnthropicAuthStatusView
  clearSetupToken(projectPath: string, anthropicApiKey?: string): AnthropicAuthStatusView
  invalidateSetupToken(projectPath: string, reason: string, anthropicApiKey?: string): AnthropicAuthStatusView
  markSetupTokenValid(projectPath: string, anthropicApiKey?: string): AnthropicAuthStatusView
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeSetupToken(token: string): string {
  return token.trim()
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}

function ensureSecureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dirPath, 0o700)
  } catch {
    // best effort only
  }
}

function isLikelyAnthropicToken(token: string): boolean {
  return token.startsWith('sk-ant-') || token.length >= 20
}

function readJson(path: string): AnthropicAuthState | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AnthropicAuthState>
    if (parsed.provider !== 'anthropic' || parsed.mode !== 'setup-token') return null
    return {
      provider: 'anthropic',
      mode: 'setup-token',
      status: parsed.status ?? 'unknown',
      setupToken: typeof parsed.setupToken === 'string' ? parsed.setupToken : undefined,
      lastError: parsed.lastError ?? null,
      lastValidatedAt: parsed.lastValidatedAt,
      updatedAt: parsed.updatedAt ?? nowIso()
    }
  } catch {
    return null
  }
}

function writeJson(path: string, state: AnthropicAuthState): void {
  ensureParentDir(path)
  writeFileSync(path, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // best effort only
  }
}

function toStatusView(
  state: AnthropicAuthState | null,
  anthropicApiKey?: string
): AnthropicAuthStatusView {
  const hasSetupToken = !!state?.setupToken
  const hasApiKeyFallback = !!anthropicApiKey
  const authStatus: AnthropicAuthStatus = state?.status ?? 'missing'

  let authMode: AnthropicAuthStatusView['authMode'] = 'none'
  if (hasSetupToken && authStatus !== 'invalid') {
    authMode = 'setup-token'
  } else if (hasApiKeyFallback) {
    authMode = 'api-key'
  }

  return {
    authMode,
    authStatus,
    hasSetupToken,
    hasApiKeyFallback,
    lastError: state?.lastError ?? null,
    updatedAt: state?.updatedAt,
    lastValidatedAt: state?.lastValidatedAt
  }
}

export function createAnthropicAuthManager(config: AnthropicAuthManagerConfig): AnthropicAuthManager {
  const { appMemoryRoot } = config
  const log = config.logger ?? (() => {})

  function sharedBaseDir(): string {
    const configured = (process.env.AGENTFOUNDRY_HOME || '').trim()
    return configured || join(homedir(), '.agentfoundry')
  }

  function sharedCredentialsDir(): string {
    return join(sharedBaseDir(), 'credentials')
  }

  function ensureSharedStoreReady(): void {
    ensureSecureDir(sharedBaseDir())
    ensureSecureDir(sharedCredentialsDir())
  }

  function legacyAuthFilePath(projectPath: string): string {
    return join(projectPath, appMemoryRoot, 'auth', 'anthropic.json')
  }

  function sharedAuthFilePath(): string {
    return join(sharedCredentialsDir(), 'anthropic.json')
  }

  function scrubLegacyToken(projectPath: string, legacyState: AnthropicAuthState): void {
    const legacyPath = legacyAuthFilePath(projectPath)
    const scrubbed: AnthropicAuthState = {
      ...legacyState,
      status: 'missing',
      setupToken: undefined,
      lastError: 'migrated-to-shared-credentials',
      updatedAt: nowIso()
    }
    try {
      writeJson(legacyPath, scrubbed)
    } catch {
      // best effort cleanup
    }
  }

  function readCurrentState(projectPath: string): AnthropicAuthState | null {
    const sharedPath = sharedAuthFilePath()
    const sharedState = readJson(sharedPath)
    const legacyPath = legacyAuthFilePath(projectPath)
    const legacyState = readJson(legacyPath)

    if (legacyState?.setupToken) {
      if (!sharedState?.setupToken) {
        const migrated: AnthropicAuthState = {
          ...legacyState,
          updatedAt: nowIso()
        }
        ensureSharedStoreReady()
        writeJson(sharedPath, migrated)
        log('[anthropic-auth] migrated setup token to shared credentials store (~/.agentfoundry)')
      }
      scrubLegacyToken(projectPath, legacyState)
    }

    return readJson(sharedPath) ?? sharedState ?? legacyState
  }

  function getStatus(projectPath: string, anthropicApiKey?: string): AnthropicAuthStatusView {
    const state = readCurrentState(projectPath)
    return toStatusView(state, anthropicApiKey)
  }

  function resolveCredential(options: ResolveAnthropicCredentialOptions): AnthropicResolvedCredential {
    const { model, projectPath, anthropicApiKey } = options
    if (!isAnthropicModel(model)) {
      return { mode: 'not-applicable', reason: 'model is not anthropic' }
    }
    const status = getStatus(projectPath, anthropicApiKey)
    if (status.authMode === 'setup-token') {
      const state = readCurrentState(projectPath)
      if (state?.setupToken) {
        return { mode: 'setup-token', apiKey: state.setupToken }
      }
    }
    if (status.authMode === 'api-key' && anthropicApiKey) {
      return { mode: 'api-key', apiKey: anthropicApiKey }
    }
    return { mode: 'none', reason: 'missing setup token and api key' }
  }

  function saveSetupToken(projectPath: string, token: string): AnthropicAuthStatusView {
    const normalized = normalizeSetupToken(token)
    if (!normalized) {
      throw new Error('Setup token is required.')
    }
    if (!isLikelyAnthropicToken(normalized)) {
      throw new Error('Setup token format looks invalid.')
    }
    const next: AnthropicAuthState = {
      provider: 'anthropic',
      mode: 'setup-token',
      status: 'unknown',
      setupToken: normalized,
      lastError: null,
      updatedAt: nowIso()
    }
    ensureSharedStoreReady()
    writeJson(sharedAuthFilePath(), next)
    log('[anthropic-auth] setup token saved')
    return toStatusView(next)
  }

  function clearSetupToken(projectPath: string, anthropicApiKey?: string): AnthropicAuthStatusView {
    const next: AnthropicAuthState = {
      provider: 'anthropic',
      mode: 'setup-token',
      status: 'missing',
      setupToken: undefined,
      lastError: null,
      updatedAt: nowIso()
    }
    ensureSharedStoreReady()
    writeJson(sharedAuthFilePath(), next)
    const legacyState = readJson(legacyAuthFilePath(projectPath))
    if (legacyState?.setupToken) scrubLegacyToken(projectPath, legacyState)
    log('[anthropic-auth] setup token cleared')
    return toStatusView(next, anthropicApiKey)
  }

  function invalidateSetupToken(
    projectPath: string,
    reason: string,
    anthropicApiKey?: string
  ): AnthropicAuthStatusView {
    const existing = readCurrentState(projectPath)
    const next: AnthropicAuthState = {
      provider: 'anthropic',
      mode: 'setup-token',
      status: 'invalid',
      setupToken: existing?.setupToken,
      lastError: reason,
      lastValidatedAt: existing?.lastValidatedAt,
      updatedAt: nowIso()
    }
    ensureSharedStoreReady()
    writeJson(sharedAuthFilePath(), next)
    log(`[anthropic-auth] setup token invalidated: ${reason}`)
    return toStatusView(next, anthropicApiKey)
  }

  function markSetupTokenValid(projectPath: string, anthropicApiKey?: string): AnthropicAuthStatusView {
    const existing = readCurrentState(projectPath)
    if (!existing?.setupToken) {
      return toStatusView(existing, anthropicApiKey)
    }
    const next: AnthropicAuthState = {
      ...existing,
      status: 'valid',
      lastError: null,
      lastValidatedAt: nowIso(),
      updatedAt: nowIso()
    }
    ensureSharedStoreReady()
    writeJson(sharedAuthFilePath(), next)
    return toStatusView(next, anthropicApiKey)
  }

  return {
    isAnthropicModel,
    getStatus,
    resolveCredential,
    saveSetupToken,
    clearSetupToken,
    invalidateSetupToken,
    markSetupTokenValid
  }
}

export function isAnthropicModel(model: string): boolean {
  const id = model.toLowerCase()
  return id.startsWith('claude') || id.includes('anthropic')
}
