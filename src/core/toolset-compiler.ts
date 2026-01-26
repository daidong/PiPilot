/**
 * ToolsetCompiler - Compiles tools into LLM-ready schemas with token tracking
 *
 * Responsibilities:
 * - Convert tool definitions to LLM schemas
 * - Track token costs per tool and total
 * - Support tool filtering for degradation (minimal mode)
 * - Provide bounded tool index for prompt
 */

import type { Tool, ParameterDefinition } from '../types/tool.js'
import { countTokens } from '../utils/tokenizer.js'

/**
 * Tool schema for LLM
 */
export interface LLMToolSchema {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
}

/**
 * Compiled tool with token cost
 */
export interface CompiledTool {
  name: string
  schema: LLMToolSchema
  tokens: number
  priority: number
}

/**
 * Tool filter options
 */
export interface ToolFilterOptions {
  /** Only include these tools */
  include?: string[]
  /** Exclude these tools */
  exclude?: string[]
  /** Maximum total tokens for tools */
  maxTokens?: number
  /** Priority tools to always include */
  priorityTools?: string[]
  /** Minimum number of tools to keep */
  minTools?: number
}

/**
 * Compiled toolset result
 */
export interface CompiledToolset {
  /** Tool schemas for LLM */
  schemas: LLMToolSchema[]
  /** Total tokens */
  totalTokens: number
  /** Token breakdown by tool */
  tokensByTool: Map<string, number>
  /** Tools that were included */
  includedTools: string[]
  /** Tools that were excluded due to budget */
  excludedTools: string[]
  /** Whether toolset was reduced */
  wasReduced: boolean
}

/**
 * Default tool priorities (higher = more important)
 */
const DEFAULT_PRIORITIES: Record<string, number> = {
  'ctx-get': 100,
  'read': 90,
  'write': 85,
  'edit': 85,
  'glob': 80,
  'grep': 80,
  'bash': 75,
  'fetch': 70,
  'llm-call': 60,
  'memory-get': 50,
  'memory-put': 50
}

/**
 * ToolsetCompiler - Manages tool compilation and degradation
 */
export class ToolsetCompiler {
  private tools = new Map<string, Tool>()
  private compiledCache = new Map<string, CompiledTool>()
  private priorityTools: Set<string>

  constructor(priorityTools: string[] = []) {
    this.priorityTools = new Set(priorityTools)
  }

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
    this.compiledCache.delete(tool.name) // Invalidate cache
  }

  /**
   * Register multiple tools
   */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): void {
    this.tools.delete(name)
    this.compiledCache.delete(name)
  }

  /**
   * Clear all tools
   */
  clear(): void {
    this.tools.clear()
    this.compiledCache.clear()
  }

  /**
   * Get tool count
   */
  get size(): number {
    return this.tools.size
  }

  /**
   * Set priority tools
   */
  setPriorityTools(tools: string[]): void {
    this.priorityTools = new Set(tools)
  }

  /**
   * Convert parameter definition to JSON schema property
   */
  private paramToJsonSchema(def: ParameterDefinition): Record<string, unknown> {
    const schema: Record<string, unknown> = {
      type: def.type,
      description: def.description
    }

    if (def.enum) {
      schema.enum = def.enum
    }

    if (def.default !== undefined) {
      schema.default = def.default
    }

    if (def.type === 'object' && def.properties) {
      const props: Record<string, unknown> = {}
      const required: string[] = []

      for (const [propName, propDef] of Object.entries(def.properties)) {
        props[propName] = this.paramToJsonSchema(propDef)
        if (propDef.required !== false) {
          required.push(propName)
        }
      }

      schema.properties = props
      if (required.length > 0) {
        schema.required = required
      }
    }

    if (def.type === 'array' && def.items) {
      schema.items = this.paramToJsonSchema(def.items)
    }

    return schema
  }

  /**
   * Compile a single tool to LLM schema
   */
  private compileTool(tool: Tool): CompiledTool {
    // Check cache
    const cached = this.compiledCache.get(tool.name)
    if (cached) {
      return cached
    }

    // Build schema
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
      properties[paramName] = this.paramToJsonSchema(paramDef)
      if (paramDef.required !== false) {
        required.push(paramName)
      }
    }

    const schema: LLMToolSchema = {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties,
        required
      }
    }

    // Count tokens
    const tokens = countTokens(JSON.stringify(schema))

    // Determine priority
    const priority = this.priorityTools.has(tool.name)
      ? 1000
      : (DEFAULT_PRIORITIES[tool.name] ?? 10)

    const compiled: CompiledTool = {
      name: tool.name,
      schema,
      tokens,
      priority
    }

    // Cache
    this.compiledCache.set(tool.name, compiled)

    return compiled
  }

  /**
   * Compile all tools with optional filtering
   */
  compile(options: ToolFilterOptions = {}): CompiledToolset {
    const {
      include,
      exclude,
      maxTokens,
      priorityTools = [],
      minTools = 3
    } = options

    // Combine priority tools with instance priority tools
    const combinedPriorityTools = new Set([...this.priorityTools, ...priorityTools])

    // Filter and compile tools
    let compiledTools: CompiledTool[] = []

    for (const tool of this.tools.values()) {
      // Include filter
      if (include && !include.includes(tool.name)) {
        continue
      }

      // Exclude filter
      if (exclude && exclude.includes(tool.name)) {
        continue
      }

      const compiled = this.compileTool(tool)

      // Boost priority for combined priority tools
      if (combinedPriorityTools.has(tool.name) && compiled.priority < 1000) {
        compiled.priority = 1000
      }

      compiledTools.push(compiled)
    }

    // Sort by priority (highest first)
    compiledTools.sort((a, b) => b.priority - a.priority)

    // Apply token budget if specified
    let wasReduced = false
    const excludedTools: string[] = []

    if (maxTokens !== undefined) {
      let totalTokens = 0
      const includedTools: CompiledTool[] = []

      for (const tool of compiledTools) {
        if (totalTokens + tool.tokens <= maxTokens || includedTools.length < minTools) {
          includedTools.push(tool)
          totalTokens += tool.tokens
        } else {
          excludedTools.push(tool.name)
          wasReduced = true
        }
      }

      compiledTools = includedTools
    }

    // Calculate totals
    const totalTokens = compiledTools.reduce((sum, t) => sum + t.tokens, 0)
    const tokensByTool = new Map<string, number>()
    for (const tool of compiledTools) {
      tokensByTool.set(tool.name, tool.tokens)
    }

    return {
      schemas: compiledTools.map(t => t.schema),
      totalTokens,
      tokensByTool,
      includedTools: compiledTools.map(t => t.name),
      excludedTools,
      wasReduced
    }
  }

  /**
   * Get token count for specific tools
   */
  getTokensForTools(toolNames: string[]): number {
    let total = 0
    for (const name of toolNames) {
      const tool = this.tools.get(name)
      if (tool) {
        const compiled = this.compileTool(tool)
        total += compiled.tokens
      }
    }
    return total
  }

  /**
   * Generate bounded tool index for prompt
   * Format: "tool1, tool2, tool3 (+5 more)"
   */
  generateToolIndex(maxDisplay: number = 10): string {
    const allTools = Array.from(this.tools.keys()).sort()

    if (allTools.length <= maxDisplay) {
      return allTools.join(', ')
    }

    const displayed = allTools.slice(0, maxDisplay)
    const remaining = allTools.length - maxDisplay

    return `${displayed.join(', ')} (+${remaining} more)`
  }

  /**
   * Generate full tool descriptions for prompt
   */
  generateToolDescriptions(): string {
    const descriptions: string[] = []

    for (const tool of this.tools.values()) {
      const params = Object.entries(tool.parameters)
        .map(([name, def]) => {
          const required = def.required !== false ? ' (required)' : ''
          return `  - ${name}: ${def.type}${required} - ${def.description ?? ''}`
        })
        .join('\n')

      descriptions.push(`### ${tool.name}\n${tool.description}\n\nParameters:\n${params}`)
    }

    return descriptions.join('\n\n')
  }

  /**
   * Get estimated total tokens for all tools
   */
  getTotalTokens(): number {
    let total = 0
    for (const tool of this.tools.values()) {
      total += this.compileTool(tool).tokens
    }
    return total
  }

  /**
   * Get tool by name
   */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /**
   * Check if tool exists
   */
  hasTool(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * Get all tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys())
  }

  /**
   * Get snapshot for debugging
   */
  snapshot(): {
    toolCount: number
    totalTokens: number
    tokensByTool: Record<string, number>
    priorityTools: string[]
  } {
    const tokensByTool: Record<string, number> = {}
    let totalTokens = 0

    for (const tool of this.tools.values()) {
      const compiled = this.compileTool(tool)
      tokensByTool[tool.name] = compiled.tokens
      totalTokens += compiled.tokens
    }

    return {
      toolCount: this.tools.size,
      totalTokens,
      tokensByTool,
      priorityTools: Array.from(this.priorityTools)
    }
  }
}
