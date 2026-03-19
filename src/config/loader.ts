/**
 * Config Loader - Configuration loader
 *
 * Load and parse agent.yaml configuration files
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'yaml'

import type { MCPServerConfig } from '../mcp/index.js'

/**
 * Inline provider definition in agent.yaml.
 *
 * Allows users to register a custom OpenAI-compatible provider directly
 * in their YAML config without writing code.
 *
 * ```yaml
 * model:
 *   default: "my-model"
 *   provider:
 *     id: "my-provider"
 *     name: "My Provider"              # optional, defaults to id
 *     baseUrl: "https://my-llm.internal/v1"
 *     apiProtocol: "openai-chat"       # optional, defaults to openai-chat
 *     apiKeyEnv: "MY_LLM_KEY"
 *     compat:                          # optional
 *       maxTokensField: "max_tokens"
 *       supportsDeveloperRole: false
 *     models:                          # optional (if you only use model.default)
 *       - id: "my-model"
 *         name: "My Model"
 *         maxContext: 32000
 *         maxOutput: 4096
 * ```
 */
export interface ProviderConfigEntry {
  /** Unique provider slug */
  id: string
  /** Display name (defaults to id) */
  name?: string
  /** API protocol — defaults to 'openai-chat' */
  apiProtocol?: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'google-generative'
  /** Base URL for API requests */
  baseUrl: string
  /** Environment variable name holding the API key */
  apiKeyEnv: string
  /** Optional compat flags for OpenAI-compatible quirks */
  compat?: {
    supportsDeveloperRole?: boolean
    maxTokensField?: 'max_tokens' | 'max_completion_tokens'
    supportsReasoningEffort?: boolean
    supportsStrictMode?: boolean
    requiresToolResultName?: boolean
    supportsCaching?: boolean
    supportsStreamOptions?: boolean
  }
  /** Static headers to add to every request */
  headers?: Record<string, string>
  /** Models hosted by this provider (optional) */
  models?: Array<{
    id: string
    name?: string
    maxContext?: number
    maxOutput?: number
    toolcall?: boolean
    reasoning?: boolean
    vision?: boolean
  }>
}

/**
 * Agent YAML configuration structure
 */
export interface AgentYAMLConfig {
  /** Agent ID */
  id: string

  /** Agent name */
  name?: string

  /** Agent identity description */
  identity?: string

  /** Constraints */
  constraints?: string[]

  /** Packs to use */
  packs?: Array<string | PackConfigEntry>

  /** MCP server configuration */
  mcp?: MCPConfigEntry[]

  /** Model configuration */
  model?: {
    default?: string
    /** Provider: string ID for built-in providers, or inline object for custom providers */
    provider?: string | ProviderConfigEntry
    maxTokens?: number
    temperature?: number
    reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  }

  /** Runner configuration (used by CLI run command) */
  runner?: RunnerConfigEntry

  /** Maximum number of steps */
  maxSteps?: number

  /**
   * Execute independent tool calls in a single LLM round concurrently.
   * Default: true. Set to false to force sequential execution.
   */
  parallelToolExecution?: boolean

  /**
   * Compaction settings for long-running sessions.
   */
  compaction?: {
    /**
     * Use LLM to generate semantic summaries when compacting context.
     * Default: true. Set to false to use the fast heuristic instead.
     */
    llmSummarization?: boolean
  }

  /**
   * Skill dependencies — declare skills to auto-install on first run.
   *
   * ```yaml
   * skills:
   *   - id: "my-local-skill"                          # already in .agentfoundry/skills/
   *   - github: "user/repo/skills/my-skill"            # fetch from GitHub
   *   - url: "https://example.com/skill.tar.gz"        # fetch from URL
   * ```
   */
  skills?: SkillDependencyEntry[]

  /** Custom configuration */
  custom?: Record<string, unknown>
}

/**
 * Skill dependency entry in agent.yaml.
 * Exactly one of `id`, `github`, or `url` must be set.
 */
export interface SkillDependencyEntry {
  /** Reference a local skill already in .agentfoundry/skills/ */
  id?: string
  /** GitHub path: "owner/repo" or "owner/repo/path/to/skill-dir" */
  github?: string
  /** Direct URL to a SKILL.md file or a tar.gz/zip archive */
  url?: string
}

/**
 * Pack configuration entry
 */
export interface PackConfigEntry {
  name: string
  options?: Record<string, unknown>
}

/**
 * Runner configuration entry
 */
export interface RunnerConfigEntry {
  mode?: 'single' | 'autonomous'
  stopCondition?: string
  maxTurns?: number
  continuePrompt?: string
  additionalInstructions?: string
}

/**
 * MCP configuration entry
 */
export interface MCPConfigEntry {
  name: string
  package?: string
  transport: {
    type: 'stdio' | 'http'
    command?: string
    args?: string[]
    cwd?: string
    url?: string
    headers?: Record<string, string>
    timeout?: number
    startTimeout?: number
  }
  env?: string[] | Record<string, string>
}

/**
 * Default configuration file names
 */
export const DEFAULT_CONFIG_FILENAMES = [
  'agent.yaml',
  'agent.yml',
  '.agent.yaml',
  '.agent.yml'
]

/**
 * Supported pack names for agent.yaml.
 * Note: "python" is intentionally excluded because it requires a non-serializable PythonBridge instance.
 */
export const SUPPORTED_YAML_PACKS = [
  'safe', 'compute', 'network', 'exec', 'git', 'exploration',
  'kv-memory', 'kvMemory', 'docs', 'discovery', 'todo',
  'web', 'documents', 'sqlite', 'memory-search', 'memorySearch'
] as const

/**
 * Find configuration file
 */
export function findConfigFile(dir: string = process.cwd()): string | null {
  for (const filename of DEFAULT_CONFIG_FILENAMES) {
    const filepath = path.join(dir, filename)
    if (fs.existsSync(filepath)) {
      return filepath
    }
  }
  return null
}

/**
 * Load configuration file
 */
export function loadConfig(filepath: string): AgentYAMLConfig {
  const content = fs.readFileSync(filepath, 'utf-8')
  const config = yaml.parse(content) as AgentYAMLConfig

  // Validate required fields
  if (!config.id) {
    throw new Error(`Config file ${filepath} missing required field: id`)
  }

  return config
}

/**
 * Try to load config file (if it exists)
 */
export function tryLoadConfig(dir: string = process.cwd()): AgentYAMLConfig | null {
  const filepath = findConfigFile(dir)
  if (!filepath) {
    return null
  }

  try {
    return loadConfig(filepath)
  } catch (error) {
    console.warn(`[Config] Failed to load ${filepath}:`, error)
    return null
  }
}

/**
 * Save configuration file
 */
export function saveConfig(
  config: AgentYAMLConfig,
  filepath: string = 'agent.yaml'
): void {
  const content = yaml.stringify(config, {
    lineWidth: 100,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'QUOTE_DOUBLE'
  })

  fs.writeFileSync(filepath, content, 'utf-8')
}

/**
 * Merge configurations (parameters override file configuration)
 */
export function mergeConfigs(
  fileConfig: AgentYAMLConfig | null,
  paramConfig: Partial<AgentYAMLConfig>
): AgentYAMLConfig {
  if (!fileConfig) {
    if (!paramConfig.id) {
      throw new Error('Agent ID is required')
    }
    return paramConfig as AgentYAMLConfig
  }

  return {
    ...fileConfig,
    ...paramConfig,
    // Deep merge specific fields
    packs: paramConfig.packs ?? fileConfig.packs,
    mcp: paramConfig.mcp ?? fileConfig.mcp,
    model: {
      ...fileConfig.model,
      ...paramConfig.model
    },
    runner: {
      ...fileConfig.runner,
      ...paramConfig.runner
    },
    constraints: paramConfig.constraints ?? fileConfig.constraints,
    custom: {
      ...fileConfig.custom,
      ...paramConfig.custom
    }
  }
}

/**
 * Normalize Pack configurations into a list of Pack names
 */
export function normalizePackConfigs(
  packs?: Array<string | PackConfigEntry>
): Array<{ name: string; options?: Record<string, unknown> }> {
  if (!packs) return []

  return packs.map(pack => {
    if (typeof pack === 'string') {
      return { name: pack }
    }
    return pack
  })
}

/**
 * Convert MCP configurations to MCPServerConfig
 */
export function normalizeMCPConfigs(
  mcpConfigs?: MCPConfigEntry[]
): MCPServerConfig[] {
  if (!mcpConfigs) return []

  const resolveEnv = (entry?: string[] | Record<string, string>): Record<string, string> | undefined => {
    if (!entry) return undefined

    if (Array.isArray(entry)) {
      const env: Record<string, string> = {}
      for (const key of entry) {
        const raw = key.trim()
        if (!raw) continue

        const eq = raw.indexOf('=')
        if (eq > 0) {
          const envKey = raw.slice(0, eq).trim()
          const envVal = raw.slice(eq + 1)
          if (envKey.length > 0) env[envKey] = envVal
          continue
        }

        const value = process.env[raw]
        if (typeof value === 'string') {
          env[raw] = value
        }
      }
      return Object.keys(env).length > 0 ? env : undefined
    }

    return Object.keys(entry).length > 0 ? entry : undefined
  }

  return mcpConfigs.map(config => {
    const env = resolveEnv(config.env)
    const serverConfig: MCPServerConfig = {
      id: config.name,
      name: config.name,
      transport: config.transport.type === 'stdio'
        ? {
            type: 'stdio',
            command: config.transport.command || 'npx',
            args: config.transport.args || [],
            cwd: config.transport.cwd,
            timeout: config.transport.timeout,
            startTimeout: config.transport.startTimeout,
            env
          }
        : {
            type: 'http',
            url: config.transport.url || '',
            headers: config.transport.headers,
            timeout: config.transport.timeout
          }
    }

    return serverConfig
  })
}

/**
 * Generate .env.example content
 */
export function generateEnvExample(
  envVars: Record<string, string>
): string {
  const lines = [
    '# Environment variables for Agent Foundry',
    '# Copy this file to .env and fill in the values',
    '',
    '# OpenAI API Key (required)',
    'OPENAI_API_KEY=sk-...',
    ''
  ]

  for (const [key, description] of Object.entries(envVars)) {
    if (description) {
      lines.push(`# ${description}`)
    }
    lines.push(`${key}=`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Validate configuration file
 */
export function validateConfig(config: AgentYAMLConfig): string[] {
  const errors: string[] = []

  if (!config.id) {
    errors.push('Missing required field: id')
  }

  if (config.id && !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(config.id)) {
    errors.push('Invalid id format: must start with letter, contain only letters, numbers, underscores, and hyphens')
  }

  if (config.packs) {
    for (const pack of config.packs) {
      const packName = typeof pack === 'string' ? pack : pack.name
      if (packName === 'python') {
        errors.push('Pack "python" is not supported in agent.yaml (requires a PythonBridge instance). Use createAgent({ packs: [packs.python(...)] }) in code.')
      } else if (!SUPPORTED_YAML_PACKS.includes(packName as typeof SUPPORTED_YAML_PACKS[number])) {
        errors.push(`Unknown pack: ${packName}`)
      }
    }
  }

  if (config.model) {
    if (config.model.provider !== undefined) {
      if (typeof config.model.provider === 'string') {
        // String provider ID — accept any registered provider (Tier 1 + Tier 2 + custom)
        if (config.model.provider.trim().length === 0) {
          errors.push('model.provider must be a non-empty string')
        }
      } else if (typeof config.model.provider === 'object' && config.model.provider !== null) {
        // Inline provider definition object
        const providerObj = config.model.provider as ProviderConfigEntry
        if (!providerObj.id || typeof providerObj.id !== 'string' || providerObj.id.trim().length === 0) {
          errors.push('model.provider.id is required and must be a non-empty string')
        }
        if (!providerObj.baseUrl || typeof providerObj.baseUrl !== 'string' || providerObj.baseUrl.trim().length === 0) {
          errors.push('model.provider.baseUrl is required and must be a non-empty string')
        }
        if (!providerObj.apiKeyEnv || typeof providerObj.apiKeyEnv !== 'string' || providerObj.apiKeyEnv.trim().length === 0) {
          errors.push('model.provider.apiKeyEnv is required and must be a non-empty string')
        }
        if (providerObj.apiProtocol !== undefined) {
          const validProtocols = ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-generative']
          if (!validProtocols.includes(providerObj.apiProtocol)) {
            errors.push(`model.provider.apiProtocol must be one of: ${validProtocols.join(', ')}`)
          }
        }
        if (providerObj.models) {
          if (!Array.isArray(providerObj.models)) {
            errors.push('model.provider.models must be an array')
          } else {
            for (let i = 0; i < providerObj.models.length; i++) {
              const m = providerObj.models[i]
              if (!m?.id || typeof m.id !== 'string') {
                errors.push(`model.provider.models[${i}].id is required and must be a string`)
              }
            }
          }
        }
      } else {
        errors.push('model.provider must be a string or an object with id, baseUrl, and apiKeyEnv')
      }
    }
    if (config.model.temperature !== undefined && (config.model.temperature < 0 || config.model.temperature > 2)) {
      errors.push('model.temperature must be between 0 and 2')
    }
    if (config.model.reasoningEffort !== undefined) {
      const validEfforts = ['low', 'medium', 'high', 'max']
      if (!validEfforts.includes(config.model.reasoningEffort)) {
        errors.push(`model.reasoningEffort must be one of: ${validEfforts.join(', ')}`)
      }
    }
    if (config.model.maxTokens !== undefined && (config.model.maxTokens < 1 || config.model.maxTokens > 1000000)) {
      errors.push('model.maxTokens must be between 1 and 1000000')
    }
  }

  if (config.maxSteps !== undefined && (config.maxSteps < 1 || config.maxSteps > 100)) {
    errors.push('maxSteps must be between 1 and 100')
  }

  if (config.runner) {
    if (config.runner.mode && config.runner.mode !== 'single' && config.runner.mode !== 'autonomous') {
      errors.push('runner.mode must be "single" or "autonomous"')
    }
    if (config.runner.maxTurns !== undefined && (config.runner.maxTurns < 1 || config.runner.maxTurns > 1000)) {
      errors.push('runner.maxTurns must be between 1 and 1000')
    }
    if (config.runner.stopCondition !== undefined && config.runner.stopCondition.trim().length === 0) {
      errors.push('runner.stopCondition cannot be empty')
    }
    if (config.runner.continuePrompt !== undefined && config.runner.continuePrompt.trim().length === 0) {
      errors.push('runner.continuePrompt cannot be empty')
    }
  }

  if (config.skills) {
    if (!Array.isArray(config.skills)) {
      errors.push('skills must be an array')
    } else {
      for (let i = 0; i < config.skills.length; i++) {
        const entry = config.skills[i]
        if (!entry || typeof entry !== 'object') {
          errors.push(`skills[${i}] must be an object with id, github, or url`)
          continue
        }
        const keys = ['id', 'github', 'url'].filter(k => !!(entry as Record<string, unknown>)[k])
        if (keys.length === 0) {
          errors.push(`skills[${i}] must have one of: id, github, or url`)
        } else if (keys.length > 1) {
          errors.push(`skills[${i}] must have exactly one of: id, github, or url (found: ${keys.join(', ')})`)
        }
        if (entry.github && typeof entry.github === 'string') {
          // Must be owner/repo or owner/repo/path
          if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\/.*)?$/.test(entry.github)) {
            errors.push(`skills[${i}].github must be in format "owner/repo" or "owner/repo/path"`)
          }
        }
        if (entry.url && typeof entry.url === 'string') {
          if (!entry.url.startsWith('http://') && !entry.url.startsWith('https://')) {
            errors.push(`skills[${i}].url must start with http:// or https://`)
          }
        }
      }
    }
  }

  return errors
}

/**
 * Resolve the provider ID from a model.provider config value.
 * Returns the string ID whether it's a string or inline object.
 */
export function resolveProviderIdFromConfig(
  provider: string | ProviderConfigEntry | undefined
): string | undefined {
  if (!provider) return undefined
  if (typeof provider === 'string') return provider
  return provider.id
}
