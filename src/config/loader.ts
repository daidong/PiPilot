/**
 * Config Loader - 配置加载器
 *
 * 加载和解析 agent.yaml 配置文件
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'yaml'

import type { MCPServerConfig } from '../mcp/index.js'

/**
 * Agent YAML 配置结构
 */
export interface AgentYAMLConfig {
  /** Agent ID */
  id: string

  /** Agent 名称 */
  name?: string

  /** Agent 身份描述 */
  identity?: string

  /** 约束条件 */
  constraints?: string[]

  /** 使用的 Packs */
  packs?: Array<string | PackConfigEntry>

  /** MCP 服务器配置 */
  mcp?: MCPConfigEntry[]

  /** 模型配置 */
  model?: {
    default?: string
    maxTokens?: number
    temperature?: number
  }

  /** 最大步骤数 */
  maxSteps?: number

  /** 自定义配置 */
  custom?: Record<string, unknown>
}

/**
 * Pack 配置项
 */
export interface PackConfigEntry {
  name: string
  options?: Record<string, unknown>
}

/**
 * MCP 配置项
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
 * 默认配置文件名
 */
export const DEFAULT_CONFIG_FILENAMES = [
  'agent.yaml',
  'agent.yml',
  '.agent.yaml',
  '.agent.yml'
]

/**
 * 查找配置文件
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
 * 加载配置文件
 */
export function loadConfig(filepath: string): AgentYAMLConfig {
  const content = fs.readFileSync(filepath, 'utf-8')
  const config = yaml.parse(content) as AgentYAMLConfig

  // 验证必需字段
  if (!config.id) {
    throw new Error(`Config file ${filepath} missing required field: id`)
  }

  return config
}

/**
 * 尝试加载配置文件（如果存在）
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
 * 保存配置文件
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
 * 合并配置（参数覆盖文件配置）
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
    // 深度合并特定字段
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
 * 将 Pack 配置转换为 Pack 名称列表
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
 * 将 MCP 配置转换为 MCPServerConfig
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
 * 生成 .env.example 内容
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
 * 验证配置文件
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
      'safe', 'compute', 'network', 'exec', 'browser', 'git', 'exploration', 'python',
      'kv-memory', 'kvMemory', 'docs', 'discovery', 'session-history', 'sessionHistory'
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
