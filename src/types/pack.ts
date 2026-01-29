/**
 * Pack Types - 能力包类型定义
 * Pack 是 Tools + Policies + ContextSources 的组合单元
 */

import type { Tool } from './tool.js'
import type { Policy } from './policy.js'
import type { ContextSource } from './context.js'
import type { Runtime } from './runtime.js'

/**
 * Pack 定义
 */
export interface Pack {
  /** Pack ID */
  id: string
  /** Pack 描述 */
  description: string
  /** 包含的工具 */
  tools?: Tool[]
  /** 包含的策略 */
  policies?: Policy[]
  /** 包含的上下文源 */
  contextSources?: ContextSource[]
  /** Prompt 片段（会被编译到系统提示中） */
  promptFragment?: string
  /** 依赖的其他 Pack */
  dependencies?: string[]
  /** 初始化钩子 */
  onInit?: (runtime: Runtime) => Promise<void>
  /** 销毁钩子 */
  onDestroy?: (runtime: Runtime) => Promise<void>
}

/**
 * Pack 配置（用于 definePack）
 */
export interface PackConfig {
  id: string
  description: string
  tools?: Tool[]
  policies?: Policy[]
  contextSources?: ContextSource[]
  promptFragment?: string
  dependencies?: string[]
  onInit?: (runtime: Runtime) => Promise<void>
  onDestroy?: (runtime: Runtime) => Promise<void>
}

/**
 * 内置 Pack 名称
 */
export type BuiltinPackName =
  // 分层核心
  | 'safe'
  | 'exec'
  | 'network'
  | 'compute'
  // 领域 Pack
  | 'repo'
  | 'git'
  | 'exploration'
  | 'python'
  | 'web'

/**
 * Pack 风险等级
 */
export type PackRiskLevel = 'safe' | 'elevated' | 'high'
