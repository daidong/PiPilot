/**
 * MCP Tool Adapter
 *
 * 将 MCP 工具转换为 AgentFoundry 工具格式
 */

import type {
  Tool,
  ToolResult,
  ParameterSchema,
  ParameterDefinition
} from '../types/tool.js'
import type {
  MCPToolDefinition,
  MCPToolResult,
  MCPPropertySchema,
  MCPContent
} from './types.js'
import type { MCPClient } from './client.js'

/**
 * 适配器选项
 */
export interface ToolAdapterOptions {
  /** 工具名前缀（避免冲突） */
  prefix?: string
  /** 超时时间（毫秒） */
  timeout?: number
  /** 是否在描述中添加来源信息 */
  includeSource?: boolean
  /** 来源名称 */
  sourceName?: string
}

/**
 * 将 MCP 工具转换为 AgentFoundry 工具
 */
export function adaptMCPTool(
  mcpTool: MCPToolDefinition,
  client: MCPClient,
  options: ToolAdapterOptions = {}
): Tool {
  const { prefix = '', timeout, includeSource = true, sourceName } = options

  // Use underscore instead of dot for OpenAI compatibility (pattern: ^[a-zA-Z0-9_-]+$)
  const toolName = prefix ? `${prefix}_${mcpTool.name}` : mcpTool.name

  let description = mcpTool.description ?? `MCP tool: ${mcpTool.name}`
  if (includeSource && sourceName) {
    description = `[${sourceName}] ${description}`
  }

  return {
    name: toolName,
    description,
    parameters: convertJsonSchemaToParameters(mcpTool.inputSchema),
    execute: async (input): Promise<ToolResult<MCPToolResultData>> => {
      try {
        // 设置超时
        const timeoutPromise = timeout
          ? new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Tool execution timeout')), timeout)
            )
          : null

        const executePromise = client.callTool(mcpTool.name, input)

        const result = timeoutPromise
          ? await Promise.race([executePromise, timeoutPromise])
          : await executePromise

        // 转换 MCP 结果为 AgentFoundry 格式
        return convertMCPResult(result)
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }
}

/**
 * MCP 工具结果数据
 */
export interface MCPToolResultData {
  /** 文本内容 */
  text?: string
  /** 所有内容块 */
  contents: MCPContent[]
}

/**
 * 将 MCP JSON Schema 转换为 AgentFoundry ParameterSchema
 */
export function convertJsonSchemaToParameters(
  schema: MCPToolDefinition['inputSchema']
): ParameterSchema {
  const parameters: ParameterSchema = {}

  if (!schema.properties) {
    return parameters
  }

  const required = new Set(schema.required ?? [])

  for (const [name, prop] of Object.entries(schema.properties)) {
    parameters[name] = convertPropertySchema(prop as MCPPropertySchema, required.has(name))
  }

  return parameters
}

/**
 * 转换属性 Schema
 */
function convertPropertySchema(
  prop: MCPPropertySchema,
  isRequired: boolean
): ParameterDefinition {
  const definition: ParameterDefinition = {
    type: mapSchemaType(prop.type),
    description: prop.description,
    required: isRequired
  }

  if (prop.default !== undefined) {
    definition.default = prop.default
  }

  if (prop.enum) {
    definition.enum = prop.enum
  }

  // 处理数组类型
  if (prop.type === 'array' && prop.items) {
    definition.items = convertPropertySchema(prop.items, false)
  }

  // 处理对象类型
  if (prop.type === 'object' && prop.properties) {
    definition.properties = {}
    const objRequired = new Set(prop.required ?? [])

    for (const [name, subProp] of Object.entries(prop.properties)) {
      definition.properties[name] = convertPropertySchema(
        subProp as MCPPropertySchema,
        objRequired.has(name)
      )
    }
  }

  return definition
}

/**
 * 映射 Schema 类型
 */
function mapSchemaType(
  type: MCPPropertySchema['type']
): ParameterDefinition['type'] {
  switch (type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'array':
      return 'array'
    case 'object':
      return 'object'
    default:
      return 'string'
  }
}

/**
 * 转换 MCP 结果
 */
function convertMCPResult(result: MCPToolResult): ToolResult<MCPToolResultData> {
  // 提取文本内容
  const textContents = result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)

  const text = textContents.join('\n')

  return {
    success: !result.isError,
    data: {
      text: text || undefined,
      contents: result.content
    },
    error: result.isError ? text : undefined
  }
}

/**
 * 批量转换 MCP 工具
 */
export function adaptMCPTools(
  tools: MCPToolDefinition[],
  client: MCPClient,
  options: ToolAdapterOptions = {}
): Tool[] {
  return tools.map((tool) => adaptMCPTool(tool, client, options))
}

/**
 * 验证工具输入是否符合 Schema
 */
export function validateToolInput(
  input: unknown,
  schema: MCPToolDefinition['inputSchema']
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: ['Input must be an object'] }
  }

  const inputObj = input as Record<string, unknown>

  // 检查必需字段
  if (schema.required) {
    for (const field of schema.required) {
      if (!(field in inputObj)) {
        errors.push(`Missing required field: ${field}`)
      }
    }
  }

  // 检查字段类型
  if (schema.properties) {
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (name in inputObj) {
        const value = inputObj[name]
        const propSchema = prop as MCPPropertySchema
        const typeError = validateType(value, propSchema)
        if (typeError) {
          errors.push(`Field '${name}': ${typeError}`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * 验证值类型
 */
function validateType(value: unknown, schema: MCPPropertySchema): string | null {
  const actualType = Array.isArray(value) ? 'array' : typeof value

  switch (schema.type) {
    case 'string':
      if (actualType !== 'string') {
        return `expected string, got ${actualType}`
      }
      break
    case 'number':
    case 'integer':
      if (actualType !== 'number') {
        return `expected number, got ${actualType}`
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        return 'expected integer'
      }
      break
    case 'boolean':
      if (actualType !== 'boolean') {
        return `expected boolean, got ${actualType}`
      }
      break
    case 'array':
      if (!Array.isArray(value)) {
        return `expected array, got ${actualType}`
      }
      break
    case 'object':
      if (actualType !== 'object' || Array.isArray(value)) {
        return `expected object, got ${actualType}`
      }
      break
  }

  // 检查枚举
  if (schema.enum && !schema.enum.includes(value)) {
    return `value must be one of: ${schema.enum.join(', ')}`
  }

  return null
}
