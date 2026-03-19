/**
 * Runtime Types - Runtime type definitions
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
import type { SessionState } from './agent.js'
import type { createLLMClient } from '../llm/stream.js'
import type { KernelV2 } from '../kernel-v2/kernel.js'

/**
 * LLM client type (inferred from createLLMClient)
 */
export type LLMClient = ReturnType<typeof createLLMClient>

/**
 * IO operation result
 */
export interface IOResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
  /** For audit trail */
  traceId: string
  /** Operation duration (milliseconds) */
  durationMs?: number
  /** Metadata (count/truncated, etc.) */
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
 * Resource limits configuration
 */
export interface ResourceLimits {
  /** Maximum read bytes (default: 10MB) */
  maxBytes?: number
  /** Maximum read lines (default: 10000) */
  maxLines?: number
  /** Maximum results (default: 1000) */
  maxResults?: number
  /** Maximum write bytes (default: 5MB) */
  maxWriteBytes?: number
  /** Timeout (milliseconds, default: 60000) */
  timeout?: number
}

/**
 * File read options
 */
export interface ReadOptions {
  encoding?: BufferEncoding
  offset?: number
  limit?: number
}

/**
 * Directory entry
 */
export interface DirEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
  size?: number
  modifiedAt?: Date
}

/**
 * Directory read options
 */
export interface ReaddirOptions {
  recursive?: boolean
  depth?: number
}

/**
 * Command execution options
 */
export interface ExecOptions {
  cwd?: string
  timeout?: number
  env?: Record<string, string>
  caller?: string
  /** Abort signal — when aborted, the child process is sent SIGTERM */
  signal?: AbortSignal
}

/**
 * Command execution output
 */
export interface ExecOutput {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Glob options
 */
export interface GlobOptions {
  cwd?: string
  ignore?: string[]
  dot?: boolean
  caller?: string
}

/**
 * Grep options
 */
export interface GrepOptions {
  cwd?: string
  type?: string
  limit?: number
  ignoreCase?: boolean
  caller?: string
}

/**
 * Grep match result
 */
export interface GrepMatch {
  file: string
  line: number
  text: string
}

/**
 * RuntimeIO interface - controlled IO layer
 */
export interface RuntimeIO {
  /** Read a file */
  readFile(path: string, options?: ReadOptions): Promise<IOResult<string>>

  /** Write a file */
  writeFile(path: string, content: string): Promise<IOResult<void>>

  /** Read a directory */
  readdir(path: string, options?: ReaddirOptions): Promise<IOResult<DirEntry[]>>

  /** Check if a file exists */
  exists(path: string): Promise<IOResult<boolean>>

  /** Execute a command */
  exec(command: string, options?: ExecOptions): Promise<IOResult<ExecOutput>>

  /** Glob file matching */
  glob(pattern: string, options?: GlobOptions): Promise<IOResult<string[]>>

  /** Grep content search */
  grep(pattern: string, options?: GrepOptions): Promise<IOResult<GrepMatch[]>>

  /** Get file statistics */
  stat?(path: string): Promise<IOResult<{ size: number; lines?: number; mtimeMs?: number }>>

  /** Unrestricted file read (for internal use by edit only) */
  readFileForEdit?(path: string): Promise<IOResult<string>>

  /** Get resource limits configuration */
  getLimits?(): Required<ResourceLimits>
}

/**
 * Runtime interface - Agent runtime
 */
export interface Runtime {
  /** Project path */
  projectPath: string

  /** Session ID */
  sessionId: string

  /** Agent ID */
  agentId: string

  /** Current step */
  step: number

  /** Controlled IO */
  io: RuntimeIO

  /** Event bus */
  eventBus: EventBus

  /** Trace collector */
  trace: TraceCollector

  /** Token budget */
  tokenBudget: TokenBudget

  /** Tool registry */
  toolRegistry: ToolRegistry

  /** Policy engine */
  policyEngine: PolicyEngine

  /** Context manager */
  contextManager: ContextManager

  /** Session state */
  sessionState: SessionState

  /** LLM client (for in-tool LLM calls) */
  llmClient?: LLMClient

  /** Memory storage for KV operations */
  memoryStorage?: MemoryStorage

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

  /** RFC-011 long-horizon kernel runtime (optional, feature-flagged) */
  kernelV2?: KernelV2
}

/**
 * Runtime configuration
 */
export interface RuntimeConfig {
  projectPath: string
  sessionId?: string
  agentId: string
  onApprovalRequired?: (message: string, timeout?: number) => Promise<boolean>
  onAlert?: (level: 'info' | 'warn' | 'error', message: string) => void
}
