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
    maxTokens?: number
    temperature?: number
  }

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
 * MCP configuration entry
 */
export interface MCPConfigEntry {
  name: string
  package?: string
  transport: {
    type: 'stdio' | 'http'
    command?: string
    args?: string[]
    url?: string
  }
  env?: string[]
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

  return mcpConfigs.map(config => {
    const serverConfig: MCPServerConfig = {
      id: config.name,
      name: config.name,
      transport: config.transport.type === 'stdio'
        ? {
            type: 'stdio',
            command: config.transport.command || 'npx',
            args: config.transport.args || []
          }
        : {
            type: 'http',
            url: config.transport.url || ''
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
    const validPacks = [
      'safe', 'compute', 'network', 'exec', 'git', 'exploration', 'python',
      'kv-memory', 'kvMemory', 'docs', 'discovery', 'todo', 'web',
      'documents', 'sqlite', 'memory-search', 'memorySearch'
    ]
    for (const pack of config.packs) {
      const packName = typeof pack === 'string' ? pack : pack.name
      if (!validPacks.includes(packName)) {
        errors.push(`Unknown pack: ${packName}`)
      }
    }
  }

  if (config.maxSteps !== undefined && (config.maxSteps < 1 || config.maxSteps > 100)) {
    errors.push('maxSteps must be between 1 and 100')
  }

  return errors
}
