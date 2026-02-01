/**
 * Packs - Pack exports
 *
 * Layered architecture:
 * - safe: Core safe tools (default)
 * - exec: Execution capability (requires explicit enable)
 * - network: Network capability (requires explicit enable)
 * - compute: Compute capability (requires explicit enable)
 * - Domain Packs: git, exploration, python, memory, docs
 */

// ============ Layered Core Packs ============

export { safe, safePack } from './safe.js'
export { exec, execPack, execStrict, execDev } from './exec.js'
export type { ExecPackOptions } from './exec.js'
export { network, networkPack, networkStrict, networkApi, networkGitHub, DEFAULT_DENY_IP_RANGES } from './network.js'
export type { NetworkPackOptions } from './network.js'
export {
  compute, computePack, computeEconomy, computeStandard, computePremium, computeWithApproval,
  getSessionTokenUsage, resetSessionTokenUsage
} from './compute.js'
export type { ComputePackOptions } from './compute.js'

// ============ Domain Packs ============

export { git } from './git.js'
export { exploration } from './exploration.js'
export { python } from './python.js'
export { kvMemory } from './kv-memory.js'
export { sessionHistory } from './session-history.js'
export { docs } from './docs.js'
export { discovery } from './discovery.js'
export { documents } from './documents.js'
export type { DocumentsPackOptions } from './documents.js'
export { sqlite } from './sqlite.js'
export type { SqlitePackOptions } from './sqlite.js'
export { web } from './web.js'
export type { WebPackOptions } from './web.js'
export { contextPipeline, contextPipelinePack } from './context-pipeline.js'
export type { ContextPipelinePackOptions } from './context-pipeline.js'
export { todo } from './todo.js'

// ============ Composite & Factory ============

import type { Pack } from '../types/pack.js'
import { mergePacks } from '../factories/define-pack.js'

import { safe } from './safe.js'
import { exec, execDev } from './exec.js'
import { network } from './network.js'
import { compute, computeStandard } from './compute.js'
import { git } from './git.js'
import { exploration } from './exploration.js'
import { python } from './python.js'
import { kvMemory } from './kv-memory.js'
import { sessionHistory } from './session-history.js'
import { docs } from './docs.js'
import { discovery } from './discovery.js'
import { documents } from './documents.js'
import { sqlite } from './sqlite.js'
import { web } from './web.js'
import { contextPipeline } from './context-pipeline.js'
import { todo } from './todo.js'

/**
 * Create minimal safe pack (core safe tools only)
 * Recommended as default starting point
 */
export function minimal(): Pack {
  return safe()
}

/**
 * Create standard pack (safe core + exec + git + exploration)
 * Suitable for most development scenarios
 */
export function standard(): Pack {
  return mergePacks(
    safe(),
    execDev(),
    git(),
    exploration()
  )
}

/**
 * Create full pack (all capabilities)
 * For scenarios requiring full functionality
 */
export function full(): Pack {
  return mergePacks(
    safe(),
    exec(),
    network(),
    computeStandard(),
    git(),
    exploration()
  )
}

/**
 * Create strict mode pack (minimal permissions)
 * For security-sensitive scenarios
 */
export function strict(): Pack {
  return safe()
}

/**
 * Packs namespace
 */
export const packs = {
  // Layered core
  safe,
  exec,
  network,
  compute,

  // Domain Packs
  git,
  exploration,
  python,
  kvMemory,
  sessionHistory,
  docs,
  discovery,
  documents,
  sqlite,
  web,
  contextPipeline,
  todo,

  // Composite factories
  minimal,
  standard,
  full,
  strict
}

/**
 * Pack risk level
 */
export type PackRiskLevel = 'safe' | 'elevated' | 'high'

/**
 * Pack metadata
 */
export interface PackMeta {
  id: string
  riskLevel: PackRiskLevel
  requiresExplicitEnable: boolean
  description: string
}

/**
 * Built-in pack metadata
 */
export const packMeta: Record<string, PackMeta> = {
  safe: {
    id: 'safe',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: 'Core safe tools: ctx-get, read, write, edit, glob, grep'
  },
  exec: {
    id: 'exec',
    riskLevel: 'high',
    requiresExplicitEnable: true,
    description: 'Execution capability: bash commands'
  },
  network: {
    id: 'network',
    riskLevel: 'elevated',
    requiresExplicitEnable: true,
    description: 'Network capability: HTTP requests'
  },
  compute: {
    id: 'compute',
    riskLevel: 'elevated',
    requiresExplicitEnable: true,
    description: 'Compute capability: LLM sub-calls'
  },
  git: {
    id: 'git',
    riskLevel: 'elevated',
    requiresExplicitEnable: false,
    description: 'Git operations'
  },
  exploration: {
    id: 'exploration',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: 'Code exploration'
  },
  python: {
    id: 'python',
    riskLevel: 'elevated',
    requiresExplicitEnable: true,
    description: 'Python execution'
  },
  'kv-memory': {
    id: 'kv-memory',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: 'Key-value memory storage for agents'
  },
  'session-history': {
    id: 'session-history',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: 'Session history viewing: messages, trace, search, thread'
  },
  docs: {
    id: 'docs',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: 'Document library management: docs.index, docs.search, docs.open'
  },
  discovery: {
    id: 'discovery',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: 'Context source discovery: ctx.catalog, ctx.describe'
  },
  documents: {
    id: 'documents',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: 'Document processing via MarkItDown: PDF, Word, Excel, PPT, Images, Audio'
  },
  sqlite: {
    id: 'sqlite',
    riskLevel: 'elevated',
    requiresExplicitEnable: true,
    description: 'SQLite database access via MCP: read_query, write_query, create_table, list_tables, describe_table'
  },
  web: {
    id: 'web',
    riskLevel: 'elevated',
    requiresExplicitEnable: true,
    description: 'Web search & fetch via Brave Search MCP + built-in fetch tool'
  },
  'context-pipeline': {
    id: 'context-pipeline',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: 'Context assembly pipeline with history compression and on-demand expansion'
  },
  todo: {
    id: 'todo',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: 'Task tracking: todo-add, todo-update, todo-complete, todo-remove + todo.list, todo.get'
  }
}
