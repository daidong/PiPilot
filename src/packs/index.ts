/**
 * Packs - Pack 导出
 *
 * 分层架构：
 * - safe: 核心安全工具（默认启用）
 * - exec: 执行能力（需显式启用）
 * - network: 网络能力（需显式启用）
 * - compute: 计算能力（需显式启用）
 * - 领域 Pack: repo, git, exploration, python, browser
 */

// ============ 分层核心 Pack ============

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

// ============ 领域 Pack ============

export { repo } from './repo.js'
export { git } from './git.js'
export { exploration } from './exploration.js'
export { python } from './python.js'
export { browserPack } from './browser.js'
export { kvMemory } from './kv-memory.js'
export { sessionMemory } from './session-memory.js'
export { docs } from './docs.js'
export { discovery } from './discovery.js'

// ============ 组合与工厂 ============

import type { Pack } from '../types/pack.js'
import { mergePacks } from '../factories/define-pack.js'

import { safe } from './safe.js'
import { exec, execDev } from './exec.js'
import { network } from './network.js'
import { compute, computeStandard } from './compute.js'
import { repo } from './repo.js'
import { git } from './git.js'
import { exploration } from './exploration.js'
import { python } from './python.js'
import { browserPack } from './browser.js'
import { kvMemory } from './kv-memory.js'
import { sessionMemory } from './session-memory.js'
import { docs } from './docs.js'
import { discovery } from './discovery.js'

/**
 * 创建安全最小 Pack（仅核心安全工具）
 * 推荐作为默认起点
 */
export function minimal(): Pack {
  return safe()
}

/**
 * 创建标准 Pack（安全核心 + 执行 + 领域）
 * 适合大多数开发场景
 */
export function standard(): Pack {
  return mergePacks(
    safe(),
    execDev(),
    repo(),
    git(),
    exploration()
  )
}

/**
 * 创建完整 Pack（所有能力）
 * 适合需要完整功能的场景
 */
export function full(): Pack {
  return mergePacks(
    safe(),
    exec(),
    network(),
    computeStandard(),
    repo(),
    git(),
    exploration()
  )
}

/**
 * 创建严格模式 Pack（最小权限）
 * 适合安全敏感场景
 */
export function strict(): Pack {
  return safe()
}

/**
 * Packs 命名空间
 */
export const packs = {
  // 分层核心
  safe,
  exec,
  network,
  compute,

  // 领域 Pack
  repo,
  git,
  exploration,
  python,
  browser: browserPack,
  kvMemory,
  sessionMemory,
  docs,
  discovery,

  // 组合工厂
  minimal,
  standard,
  full,
  strict
}

/**
 * Pack 风险等级
 */
export type PackRiskLevel = 'safe' | 'elevated' | 'high'

/**
 * Pack 元信息
 */
export interface PackMeta {
  id: string
  riskLevel: PackRiskLevel
  requiresExplicitEnable: boolean
  description: string
}

/**
 * 内置 Pack 元信息
 */
export const packMeta: Record<string, PackMeta> = {
  safe: {
    id: 'safe',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: '核心安全工具：ctx-get, read, write, edit, glob, grep'
  },
  exec: {
    id: 'exec',
    riskLevel: 'high',
    requiresExplicitEnable: true,
    description: '执行能力：bash 命令'
  },
  network: {
    id: 'network',
    riskLevel: 'elevated',
    requiresExplicitEnable: true,
    description: '网络能力：HTTP 请求'
  },
  compute: {
    id: 'compute',
    riskLevel: 'elevated',
    requiresExplicitEnable: true,
    description: '计算能力：LLM 子调用'
  },
  repo: {
    id: 'repo',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: '仓库上下文'
  },
  git: {
    id: 'git',
    riskLevel: 'elevated',
    requiresExplicitEnable: false,
    description: 'Git 操作'
  },
  exploration: {
    id: 'exploration',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: '代码探索'
  },
  python: {
    id: 'python',
    riskLevel: 'elevated',
    requiresExplicitEnable: true,
    description: 'Python 执行'
  },
  browser: {
    id: 'browser',
    riskLevel: 'elevated',
    requiresExplicitEnable: true,
    description: '浏览器自动化'
  },
  'kv-memory': {
    id: 'kv-memory',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: 'Key-value memory storage for agents'
  },
  'session-memory': {
    id: 'session-memory',
    riskLevel: 'safe',
    requiresExplicitEnable: false,
    description: 'Session history and long-term memory for agents'
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
    description: 'Context source discovery: ctx.catalog, ctx.describe, ctx.route'
  }
}
