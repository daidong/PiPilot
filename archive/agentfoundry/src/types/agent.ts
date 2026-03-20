/**
 * Agent Types - Agent type definitions
 */

import type { Pack } from './pack.js'
import type { Policy } from './policy.js'
import type { TraceEvent } from './trace.js'
import type { ContextSelection } from './context-pipeline.js'
import type { Runtime } from './runtime.js'
import type { UsageSummary } from '../llm/provider.types.js'
import type { SkillTelemetryConfig } from './skill.js'
import type { KernelV2Config } from '../kernel-v2/types.js'
import type { ResourceLimits } from './runtime.js'
import type { AgentRunHandle } from '../agent/agent-run-handle.js'

/**
 * Model configuration
 */
export interface ModelConfig {
  /** Default model */
  default: string
  /** Fallback model */
  fallback?: string
  /** Maximum number of tokens */
  maxTokens?: number
}

/**
 * Agent definition
 */
export interface AgentDefinition {
  /** Agent ID */
  id: string
  /** Agent name */
  name: string
  /** Core identity (never trimmed) */
  identity: string
  /** Packs to use */
  packs: Pack[]
  /** Additional policies */
  policies?: Policy[]
  /** Constraint rules (never trimmed) */
  constraints: string[]
  /** Context usage guide */
  contextGuide?: string
  /** Model configuration */
  model?: ModelConfig
  /** Maximum number of steps */
  maxSteps?: number
}

/**
 * LLM provider type
 */
export type LLMProvider = 'openai' | 'anthropic'

/**
 * Agent configuration (for createAgent)
 */
export interface AgentConfig {
  /** API key */
  apiKey?: string
  /** LLM provider */
  provider?: LLMProvider
  /** Model name */
  model?: string
  /** Working directory */
  projectPath?: string
  /** Packs to use */
  packs?: Pack[]
  /** Additional policies */
  policies?: Policy[]
  /** Disable all policy registration (pack/definition/config policies) */
  disablePolicies?: boolean
  /** Maximum number of steps */
  maxSteps?: number
  /** Maximum number of tokens */
  maxTokens?: number
  /** Runtime IO limits (timeout/maxBytes/etc.) */
  ioLimits?: Partial<ResourceLimits>
  /** Temperature for LLM generation */
  temperature?: number
  /** Reasoning effort for reasoning models (low, medium, high, max) */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  /** Hard stop after this many consecutive tool-only rounds (default: threshold * 2) */
  maxConsecutiveToolRounds?: number
  /** Approval handler */
  onApprovalRequired?: (message: string, timeout?: number) => Promise<boolean>
  /** Streaming output handler */
  onStream?: (chunk: string) => void
  /** Tool call handler */
  onToolCall?: (tool: string, input: unknown) => void
  /** Tool result handler */
  onToolResult?: (tool: string, result: unknown, args?: unknown) => void
  /** Persistent session ID (reuse across restarts for history continuity) */
  sessionId?: string
  /** External skills directory (default: .agentfoundry/skills under projectPath) */
  externalSkillsDir?: string
  /** Community skills directory (default: src/skills/community-builtin in framework project) */
  communitySkillsDir?: string
  /** Watch external skill files for hot-reload (default: true) */
  watchExternalSkills?: boolean
  /** Watch community skill files for hot-reload (default: false) */
  watchCommunitySkills?: boolean
  /** Disable built-in resourceful philosophy skill (default: false) */
  disableResourcefulSkill?: boolean
  /** Skill lifecycle telemetry options (default: enabled basic logs) */
  skillTelemetry?: SkillTelemetryConfig
  /** Pre-compaction callback — fired once per run() when context usage >= 80% */
  onPreCompaction?: (agent: Agent) => Promise<void>
  /** Trace export configuration */
  trace?: {
    export?: {
      enabled?: boolean
      dir?: string
      writeJsonl?: boolean
      writeSummary?: boolean
    }
  }
  /**
   * Error strike policy (3-strike protocol by default)
   * - After warnAfter strikes: advise alternate approach
   * - After disableAfter strikes: block same tool+args+category call
   */
  errorStrikePolicy?: {
    warnAfter?: number
    disableAfter?: number
  }

  /** RFC-011 Kernel V2 runtime configuration */
  kernelV2?: KernelV2Config

  /** Inject style normalization for non-Anthropic providers to produce more natural output (default: true) */
  normalizeProviderStyle?: boolean
}

/**
 * Agent run result
 */
export interface AgentRunResult {
  /** Whether the run succeeded */
  success: boolean
  /** Final output */
  output: string
  /** Error message */
  error?: string
  /** Number of steps executed */
  steps: number
  /** Trace events */
  trace: TraceEvent[]
  /** Total duration (milliseconds) */
  durationMs: number
  /** Token usage and cost summary */
  usage?: UsageSummary
}

/**
 * Options for agent.run()
 */
export interface AgentRunOptions {
  /** User-selected context to include */
  selectedContext?: ContextSelection[]
  /** Additional system-level instructions for this run */
  additionalInstructions?: string
  /** Override token budget for this run */
  tokenBudget?: number
}

/**
 * Agent instance
 */
export interface Agent {
  /** Agent ID */
  id: string
  /** Runtime instance (for advanced use: memory sync, session state, etc.) */
  runtime: Runtime
  /** Ensure packs are initialized (idempotent, called automatically by run()) */
  ensureInit: () => Promise<void>
  /** Run the Agent */
  run: (prompt: string, options?: AgentRunOptions) => AgentRunHandle
  /** Stop the run */
  stop: () => void
  /** Destroy the Agent */
  destroy: () => Promise<void>
}

/**
 * Session state
 */
export interface SessionState {
  /** Get a state value */
  get: <T>(key: string) => T | undefined
  /** Set a state value */
  set: <T>(key: string, value: T) => void
  /** Delete a state value */
  delete: (key: string) => void
  /** Check if a key exists */
  has: (key: string) => boolean
}
