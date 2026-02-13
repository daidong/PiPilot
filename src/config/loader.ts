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
    provider?: string
    maxTokens?: number
    temperature?: number
    reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  }

  /** Runner configuration (used by CLI run command) */
  runner?: RunnerConfigEntry

  /** Maximum number of steps */
  maxSteps?: number

  /** Custom configuration */
  custom?: Record<string, unknown>
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
      const validProviders = ['openai', 'anthropic', 'deepseek', 'google']
      if (!validProviders.includes(config.model.provider)) {
        errors.push(`model.provider must be one of: ${validProviders.join(', ')}`)
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

  return errors
}
