/**
 * Skill Type Definitions
 *
 * Skills encapsulate procedural knowledge that can be lazily loaded
 * to optimize token usage in LLM interactions.
 *
 * Key differences from Tools:
 * - Tools are deterministic operations (read, write, fetch)
 * - Skills are knowledge + guidance that help LLMs use tools effectively
 * - Skills support progressive disclosure (summary → procedures → examples)
 */

/**
 * Loading strategy for skills
 * - 'eager': Always loaded at agent initialization
 * - 'lazy': Loaded on first use of associated tools
 * - 'on-demand': Only loaded when explicitly requested
 */
export type SkillLoadingStrategy = 'eager' | 'lazy' | 'on-demand'

/**
 * Skill telemetry verbosity mode
 */
export type SkillTelemetryMode = 'basic' | 'verbose' | 'off'

/**
 * Skill telemetry sink
 */
export type SkillTelemetrySink = 'console' | 'trace' | 'both'

/**
 * Skill telemetry configuration
 */
export interface SkillTelemetryConfig {
  enabled?: boolean
  mode?: SkillTelemetryMode
  sink?: SkillTelemetrySink
}

/**
 * Skill script metadata discovered from a skill directory.
 */
export interface SkillScriptMetadata {
  name: string
  fileName?: string
  relativePath?: string
  filePath?: string
  runner?: 'bash' | 'node' | 'python' | 'executable'
}

/**
 * Skill instruction sections for progressive disclosure
 */
export interface SkillInstructions {
  /**
   * Brief summary (~100 tokens)
   * Always included in system prompt when skill is registered
   */
  summary: string

  /**
   * Detailed procedures (~500 tokens)
   * Loaded on first use or when detailed guidance needed
   */
  procedures?: string

  /**
   * Usage examples (~300 tokens)
   * Loaded on-demand or when examples are requested
   */
  examples?: string

  /**
   * Troubleshooting guide
   * Loaded when errors occur or when explicitly requested
   */
  troubleshooting?: string
}

// Phase 3.1: SkillScripts interface removed (dead code - never executed)

/**
 * Token usage estimates for budget planning
 */
export interface SkillTokenEstimates {
  /**
   * Tokens for summary section (always loaded)
   */
  summary: number

  /**
   * Tokens for full skill content (all sections)
   */
  full: number
}

/**
 * Skill definition - runtime instance
 * Phase 3.1: Generic type parameters removed (scripts property removed)
 */
export interface Skill {
  /**
   * Unique skill identifier (kebab-case recommended)
   * e.g., 'llm-compute-skill', 'git-workflow-skill'
   */
  id: string

  /**
   * Human-readable skill name
   * e.g., 'LLM Sub-Computations', 'Git Workflow'
   */
  name: string

  /**
   * Short description for matching (<100 chars)
   * Used for skill discovery and selection
   */
  shortDescription: string

  /**
   * Structured instructions for progressive disclosure
   */
  instructions: SkillInstructions

  // Phase 3.1: scripts property removed (dead code - never executed)

  /**
   * Tool names this skill provides guidance for
   * Used for lazy loading: skill loads when any bound tool is first used
   */
  tools?: string[]

  /**
   * Loading strategy
   * @default 'lazy'
   */
  loadingStrategy: SkillLoadingStrategy

  /**
   * Token usage estimates for budget planning
   */
  estimatedTokens: SkillTokenEstimates

  /**
   * Tags for categorization and discovery
   */
  tags?: string[]

  /**
   * Optional metadata for external/dynamic skills
   */
  meta?: {
    approvedByUser?: boolean
    sourceType?: 'builtin' | 'community-builtin' | 'project-local' | 'external'
    filePath?: string
    skillDir?: string
    scripts?: SkillScriptMetadata[]
    [key: string]: unknown
  }
}

/**
 * Skill configuration for defineSkill factory
 */
export interface SkillConfig {
  id: string
  name: string
  shortDescription: string
  instructions: SkillInstructions
  // Phase 3.1: scripts property removed (dead code - never executed)
  tools?: string[]
  loadingStrategy?: SkillLoadingStrategy
  estimatedTokens?: Partial<SkillTokenEstimates>
  tags?: string[]
  meta?: {
    approvedByUser?: boolean
    sourceType?: 'builtin' | 'community-builtin' | 'project-local' | 'external'
    filePath?: string
    skillDir?: string
    scripts?: SkillScriptMetadata[]
    [key: string]: unknown
  }
}

/**
 * Skill loading configuration for packs
 */
export interface SkillLoadingConfig {
  /**
   * Skills to always load at initialization
   */
  eager?: string[]

  /**
   * Skills to load on first use of associated tools
   */
  lazy?: string[]

  /**
   * Skills to load only when explicitly requested
   */
  onDemand?: string[]
}

/**
 * Skill state in the manager
 */
export type SkillState = 'registered' | 'summary-loaded' | 'fully-loaded'

/**
 * Loaded skill content
 */
export interface LoadedSkillContent {
  /**
   * Current loading state
   */
  state: SkillState

  /**
   * Skill definition
   */
  skill: Skill

  /**
   * Currently loaded content (concatenated from loaded sections)
   */
  content: string

  /**
   * Timestamp of last access
   */
  lastAccessed: number

  /**
   * Number of times this skill has been accessed
   */
  accessCount: number
}

/**
 * Registration options for SkillManager.register()
 */
export interface SkillRegistrationOptions {
  approvedByUser?: boolean
  source?: 'builtin' | 'external' | 'community-builtin' | 'project-local'
  filePath?: string
}

/**
 * Token savings snapshot for current skill loading state
 */
export interface SkillTokenSavings {
  summaryOnlyTokens: number
  fullyLoadedTokens: number
  estimatedSavedTokens: number
}

/**
 * Events emitted by SkillManager
 */
export interface SkillManagerEvents {
  'skill:registered': { skillId: string; skill: Skill }
  'skill:loaded': { skillId: string; state: SkillState; tokensLoaded: number }
  'skill:accessed': { skillId: string; accessCount: number }
  'skill:unloaded': { skillId: string }
  'skill:blocked': { skillId: string; reason: string }
  'skill:token-savings': { runId?: string; sessionId?: string; savings: SkillTokenSavings }
}
