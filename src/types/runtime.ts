/**
 * Runtime Types - 运行时类型定义
 */

import type { EventBus } from '../core/event-bus.js'
import type { TraceCollector } from '../core/trace-collector.js'
import type { TokenBudget } from '../core/token-budget.js'
import type { ToolRegistry } from '../core/tool-registry.js'
import type { PolicyEngine } from '../core/policy-engine.js'
import type { ContextManager } from '../core/context-manager.js'
import type { SkillManager } from '../skills/skill-manager.js'
import type { SkillRegistry } from '../skills/skill-registry.js'
import type { MemoryStorage } from './memory.js'
import type { EntityIndex, WorkingSetResolvedEntity } from './memory-entity.js'
import type { MessageStore } from './session.js'
import type { SessionState } from './agent.js'
import type { createLLMClient } from '../llm/stream.js'

/**
 * LLM 客户端类型（从 createLLMClient 推断）
 */
export type LLMClient = ReturnType<typeof createLLMClient>

/**
 * IO 操作结果
 */
export interface IOResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
  /** 用于审计追踪 */
  traceId: string
  /** 操作耗时（毫秒） */
  durationMs?: number
  /** 元信息（count/truncated 等） */
  meta?: {
    truncated?: boolean
    count?: number
    total?: number
    lines?: number
    bytes?: number
    fallback?: boolean
    forEdit?: boolean
  }
}

/**
 * 资源限制配置
 */
export interface ResourceLimits {
  /** 最大读取字节数（默认 10MB） */
  maxBytes?: number
  /** 最大读取行数（默认 10000） */
  maxLines?: number
  /** 最大结果数（默认 1000） */
  maxResults?: number
  /** 最大写入字节数（默认 5MB） */
  maxWriteBytes?: number
  /** 超时时间（毫秒，默认 60000） */
  timeout?: number
}

/**
 * 读取文件选项
 */
export interface ReadOptions {
  encoding?: BufferEncoding
  offset?: number
  limit?: number
}

/**
 * 目录条目
 */
export interface DirEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
  size?: number
  modifiedAt?: Date
}

/**
 * 读取目录选项
 */
export interface ReaddirOptions {
  recursive?: boolean
  depth?: number
}

/**
 * 执行命令选项
 */
export interface ExecOptions {
  cwd?: string
  timeout?: number
  env?: Record<string, string>
  caller?: string
}

/**
 * 执行命令输出
 */
export interface ExecOutput {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Glob 选项
 */
export interface GlobOptions {
  cwd?: string
  ignore?: string[]
  dot?: boolean
  caller?: string
}

/**
 * Grep 选项
 */
export interface GrepOptions {
  cwd?: string
  type?: string
  limit?: number
  ignoreCase?: boolean
  caller?: string
}

/**
 * Grep 匹配结果
 */
export interface GrepMatch {
  file: string
  line: number
  text: string
}

/**
 * RuntimeIO 接口 - 受控 IO 层
 */
export interface RuntimeIO {
  /** 读取文件 */
  readFile(path: string, options?: ReadOptions): Promise<IOResult<string>>

  /** 写入文件 */
  writeFile(path: string, content: string): Promise<IOResult<void>>

  /** 读取目录 */
  readdir(path: string, options?: ReaddirOptions): Promise<IOResult<DirEntry[]>>

  /** 检查文件是否存在 */
  exists(path: string): Promise<IOResult<boolean>>

  /** 执行命令 */
  exec(command: string, options?: ExecOptions): Promise<IOResult<ExecOutput>>

  /** Glob 文件匹配 */
  glob(pattern: string, options?: GlobOptions): Promise<IOResult<string[]>>

  /** Grep 内容搜索 */
  grep(pattern: string, options?: GrepOptions): Promise<IOResult<GrepMatch[]>>

  /** 获取文件统计信息 */
  stat?(path: string): Promise<IOResult<{ size: number; lines?: number; mtimeMs?: number }>>

  /** 无限制读取文件（仅供 edit 内部使用） */
  readFileForEdit?(path: string): Promise<IOResult<string>>

  /** 获取资源限制配置 */
  getLimits?(): Required<ResourceLimits>
}

/**
 * Runtime 接口 - Agent 运行时
 */
export interface Runtime {
  /** 项目路径 */
  projectPath: string

  /** 会话 ID */
  sessionId: string

  /** 代理 ID */
  agentId: string

  /** 当前步骤 */
  step: number

  /** 受控 IO */
  io: RuntimeIO

  /** 事件总线 */
  eventBus: EventBus

  /** Trace 收集器 */
  trace: TraceCollector

  /** Token 预算 */
  tokenBudget: TokenBudget

  /** 工具注册表 */
  toolRegistry: ToolRegistry

  /** 策略引擎 */
  policyEngine: PolicyEngine

  /** 上下文管理器 */
  contextManager: ContextManager

  /** 会话状态 */
  sessionState: SessionState

  /** LLM 客户端（用于工具内 LLM 调用） */
  llmClient?: LLMClient

  /** Memory storage for KV operations */
  memoryStorage?: MemoryStorage

  /** Message store for conversation history */
  messageStore?: MessageStore

  /** WorkingSet entity index provider (disk-backed source of truth) */
  entityIndexProvider?: () => Promise<EntityIndex[]>

  /** WorkingSet entity resolver (id -> content) */
  entityResolver?: (id: string) => Promise<WorkingSetResolvedEntity | null>

  /**
   * WorkingSet continuity tracker (runtime-only).
   * Used by tools to record entity usage for continuity scoring.
   */
  workingSetTracker?: {
    recordUsage: (entityId: string, useType: 'mention' | 'tool-access' | 'update') => void
  }

  /**
   * Skill manager for lazy-loaded procedural knowledge.
   * Skills are loaded on-demand when associated tools are used.
   */
  skillManager?: SkillManager

  /**
   * Phase 3.2: Global skill registry for skill discovery and recommendations.
   * Provides query and matching capabilities across all registered skills.
   */
  skillRegistry?: SkillRegistry
}

/**
 * Runtime 配置
 */
export interface RuntimeConfig {
  projectPath: string
  sessionId?: string
  agentId: string
  onApprovalRequired?: (message: string, timeout?: number) => Promise<boolean>
  onAlert?: (level: 'info' | 'warn' | 'error', message: string) => void
}
