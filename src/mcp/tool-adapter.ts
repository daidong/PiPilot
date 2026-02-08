/**
 * MCP Tool Adapter
 *
 * Converts MCP tools to AgentFoundry tool format
 */

import { resolve as resolvePath, basename } from 'node:path'
import { existsSync } from 'node:fs'
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
 * Adapter options
 */
export interface ToolAdapterOptions {
  /** Tool name prefix (to avoid conflicts) */
  prefix?: string
  /** Timeout in milliseconds */
  timeout?: number
  /** Whether to include source information in the description */
  includeSource?: boolean
  /** Source name */
  sourceName?: string
}

/**
 * Convert an MCP tool to an AgentFoundry tool
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
    execute: async (rawInput): Promise<ToolResult<MCPToolResultData>> => {
      // Resolve file:// URIs: turn relative paths into absolute ones
      // so MCP servers (which run as child processes) can find the file.
      const normalized = normalizeFileUris(rawInput)

      // Strip optional params with invalid enum values or empty/null values
      // to prevent MCP validation errors from LLM-generated inputs
      const input = sanitizeInput(normalized, mcpTool.inputSchema)

      const maxRetries = 3

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          // Set up timeout
          const timeoutPromise = timeout
            ? new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Tool execution timeout')), timeout)
              )
            : null

          const executePromise = client.callTool(mcpTool.name, input)

          const result = timeoutPromise
            ? await Promise.race([executePromise, timeoutPromise])
            : await executePromise

          // Check for rate limit errors in the MCP response
          const resultObj = convertMCPResult(result)
          if (!resultObj.success && isRateLimitError(resultObj.error)) {
            if (attempt < maxRetries) {
              const delayMs = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s
              await sleep(delayMs)
              continue
            }
          }

          return resultObj
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          if (isRateLimitError(errMsg) && attempt < maxRetries) {
            const delayMs = 1000 * Math.pow(2, attempt)
            await sleep(delayMs)
            continue
          }
          return {
            success: false,
            error: errMsg
          }
        }
      }

      // Should not reach here, but just in case
      return { success: false, error: 'Max retries exceeded' }
    }
  }
}

/**
 * MCP tool result data
 */
export interface MCPToolResultData {
  /** Text content */
  text?: string
  /** All content blocks */
  contents: MCPContent[]
}

/**
 * Convert MCP JSON Schema to AgentFoundry ParameterSchema
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
 * Convert a property schema
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

  // Handle array type
  if (prop.type === 'array' && prop.items) {
    definition.items = convertPropertySchema(prop.items, false)
  }

  // Handle object type
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
 * Map schema types
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
 * Convert an MCP result
 */
function convertMCPResult(result: MCPToolResult): ToolResult<MCPToolResultData> {
  // Extract text content
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
 * Sanitize tool input: strip optional parameters that have invalid enum values
 * or are null/undefined/empty-string. This prevents MCP validation errors caused
 * by LLMs generating bad values for optional fields.
 */
function sanitizeInput(
  input: unknown,
  schema: MCPToolDefinition['inputSchema']
): unknown {
  if (typeof input !== 'object' || input === null || !schema.properties) return input

  const obj = input as Record<string, unknown>
  const required = new Set(schema.required ?? [])
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    const propSchema = schema.properties[key] as MCPPropertySchema | undefined

    // Keep unknown keys as-is (pass through)
    if (!propSchema) {
      result[key] = value
      continue
    }

    // Always keep required fields
    if (required.has(key)) {
      result[key] = value
      continue
    }

    // Drop optional fields that are null, undefined, or empty string
    if (value === null || value === undefined || value === '') {
      continue
    }

    // Drop optional fields with invalid enum values
    if (propSchema.enum && !propSchema.enum.includes(value)) {
      continue
    }

    result[key] = value
  }

  return result
}

/**
 * Normalize file:// URIs in tool input.
 *
 * MCP servers run as child processes and need absolute paths.
 * LLMs often pass relative paths like "file:///report.pdf" or just "report.pdf".
 * This resolves them against cwd so the server can find the file.
 */
function normalizeFileUris(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input

  const obj = input as Record<string, unknown>
  let changed = false
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.startsWith('file://')) {
      // Strip file:// prefix, then strip leading slashes to get the raw path
      const raw = value.slice('file://'.length)
      const filePath = raw.replace(/^\/+/, '') || raw

      // Resolve to absolute: try the path as-is first, then basename against cwd
      let absPath: string | null = null

      // If it's already absolute and exists, use it
      if (raw.startsWith('/') && existsSync(raw)) {
        absPath = raw
      }
      // Try resolving as relative to cwd
      if (!absPath) {
        const fromCwd = resolvePath(process.cwd(), filePath)
        if (existsSync(fromCwd)) {
          absPath = fromCwd
        }
      }
      // Try basename only against cwd
      if (!absPath) {
        const name = basename(filePath)
        const fromBasename = resolvePath(process.cwd(), name)
        if (existsSync(fromBasename)) {
          absPath = fromBasename
        }
      }

      if (absPath) {
        const normalized = `file://${absPath}`
        if (normalized !== value) {
          result[key] = normalized
          changed = true
          continue
        }
      }
    }
    result[key] = value
  }

  return changed ? result : input
}

/**
 * Check if an error message indicates a rate limit (HTTP 429).
 */
function isRateLimitError(msg: string | undefined): boolean {
  if (!msg) return false
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('RATE_LIMITED')
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Batch convert MCP tools
 */
export function adaptMCPTools(
  tools: MCPToolDefinition[],
  client: MCPClient,
  options: ToolAdapterOptions = {}
): Tool[] {
  return tools.map((tool) => adaptMCPTool(tool, client, options))
}

/**
 * Validate whether tool input conforms to the schema
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

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (!(field in inputObj)) {
        errors.push(`Missing required field: ${field}`)
      }
    }
  }

  // Check field types
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
 * Validate value type
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

  // Check enum values
  if (schema.enum && !schema.enum.includes(value)) {
    return `value must be one of: ${schema.enum.join(', ')}`
  }

  return null
}
