/**
 * Provider Types - provider manifest and metadata
 */

import type { Pack } from './pack.js'

/**
 * Permissions (for policy and audit)
 */
export interface ProviderPermissions {
  file?: {
    read?: string[]
    write?: string[]
  }
  network?: {
    allow?: string[]
    deny?: string[]
  }
  exec?: {
    allow?: string[]
    deny?: string[]
  }
  env?: string[]
}

/**
 * Budgets (for safety and stability)
 */
export interface ProviderBudgets {
  timeoutMs?: number
  maxOutputBytes?: number
  maxRequests?: number
}

/**
 * Pack descriptor (for manifest display)
 */
export interface ProviderPackDescriptor {
  id: string
  description?: string
  tools?: string[]
  permissions?: ProviderPermissions
  budgets?: ProviderBudgets
}

/**
 * Provider manifest
 */
export interface ToolProviderManifest {
  id: string
  name: string
  version: string
  description?: string
  entry?: string
  packs?: ProviderPackDescriptor[]
  permissions?: ProviderPermissions
  budgets?: ProviderBudgets
  engines?: {
    agentFoundry?: string
  }
  author?: string
  license?: string
  homepage?: string
  repository?: string
  signature?: {
    algorithm: string
    value: string
  }
}

/**
 * Provider create options
 */
export interface ProviderCreateOptions {
  config?: Record<string, unknown>
}

/**
 * Provider definition
 */
export interface ToolProvider {
  manifest: ToolProviderManifest
  createPacks: (options?: ProviderCreateOptions) => Promise<Pack[]> | Pack[]
}

/**
 * Provider config (for defineProvider)
 */
export interface ToolProviderConfig {
  manifest: ToolProviderManifest
  createPacks: (options?: ProviderCreateOptions) => Promise<Pack[]> | Pack[]
}
