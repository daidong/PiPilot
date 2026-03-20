/**
 * Pack Types - Capability pack type definitions
 * A Pack is a bundled unit of Tools + Policies + ContextSources + Skills
 */

import type { Tool } from './tool.js'
import type { Policy } from './policy.js'
import type { ContextSource } from './context.js'
import type { Runtime } from './runtime.js'
import type { Skill, SkillLoadingConfig } from './skill.js'

/**
 * Pack definition
 */
export interface Pack {
  /** Pack ID */
  id: string
  /** Pack description */
  description: string
  /** Included tools */
  tools?: Tool[]
  /** Included policies */
  policies?: Policy[]
  /** Included context sources */
  contextSources?: ContextSource[]
  /**
   * Included Skills
   * Skills provide procedural knowledge that can be lazily loaded
   * to optimize token usage
   */
  skills?: Skill[]
  /**
   * Skill loading configuration
   * Controls when skills are loaded into the prompt
   */
  skillLoadingConfig?: SkillLoadingConfig
  /**
   * Prompt fragment (compiled into the system prompt)
   * @deprecated Use skills instead for progressive disclosure
   */
  promptFragment?: string
  /** Dependencies on other Packs */
  dependencies?: string[]
  /** Initialization hook */
  onInit?: (runtime: Runtime) => Promise<void>
  /** Destruction hook */
  onDestroy?: (runtime: Runtime) => Promise<void>
}

/**
 * Pack configuration (for definePack)
 */
export interface PackConfig {
  id: string
  description: string
  tools?: Tool[]
  policies?: Policy[]
  contextSources?: ContextSource[]
  /**
   * Skills to include in this pack
   */
  skills?: Skill[]
  /**
   * Configuration for how skills are loaded
   */
  skillLoadingConfig?: SkillLoadingConfig
  /**
   * @deprecated Use skills instead for progressive disclosure
   */
  promptFragment?: string
  dependencies?: string[]
  onInit?: (runtime: Runtime) => Promise<void>
  onDestroy?: (runtime: Runtime) => Promise<void>
}

/**
 * Built-in Pack names
 */
export type BuiltinPackName =
  // Core packs
  | 'safe'
  | 'exec'
  | 'network'
  | 'compute'
  // Domain packs
  | 'git'
  | 'exploration'
  | 'python'
  | 'web'
  | 'kv-memory'
  | 'docs'
  | 'discovery'
  | 'todo'
  | 'documents'
  | 'sqlite'
  | 'memory-search'

/**
 * Pack risk level
 */
export type PackRiskLevel = 'safe' | 'elevated' | 'high'
