/**
 * ToolRegistry - Tool Registry
 */

import type { Tool, ToolContext, ToolResult, ParameterSchema, ParameterDefinition } from '../types/tool.js'
import type { PolicyEngine } from './policy-engine.js'
import type { TraceCollector } from './trace-collector.js'
import type { Runtime } from '../types/runtime.js'
import { createValidationError } from './errors.js'
import { toolValidationFeedback, policyDenialFeedback, formatFeedbackAsToolResult } from './feedback.js'
import type { FeedbackContext, ToolSchemaSummary } from './feedback.js'
import { tryCatch } from '../utils/result.js'

/**
 * Tool call information
 */
export interface ToolCallInfo {
  tool: string
  input: unknown
  output?: ToolResult
  error?: string
  durationMs: number
}

/**
 * Tool registry configuration
 */
export interface ToolRegistryConfig {
  policyEngine: PolicyEngine
  trace: TraceCollector
  runtime: Runtime
}

/**
 * Parameter validation error
 */
export interface ValidationError {
  param: string
  message: string
}

/**
 * Parameter validation result
 */
export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  normalized: Record<string, unknown>
}

/**
 * Validate a single parameter value
 */
function validateValue(
  value: unknown,
  def: ParameterDefinition,
  path: string
): ValidationError[] {
  const errors: ValidationError[] = []

  // Type check
  const actualType = Array.isArray(value) ? 'array' : typeof value

  if (def.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ param: path, message: `Expected array, got ${actualType}` })
      return errors
    }

    // Validate array elements
    if (def.items) {
      for (let i = 0; i < value.length; i++) {
        errors.push(...validateValue(value[i], def.items, `${path}[${i}]`))
      }
    }
  } else if (def.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push({ param: path, message: `Expected object, got ${actualType}` })
      return errors
    }

    // Validate object properties
    if (def.properties) {
      const obj = value as Record<string, unknown>
      for (const [propName, propDef] of Object.entries(def.properties)) {
        const propValue = obj[propName]
        if (propValue === undefined) {
          if (propDef.required !== false) {
            errors.push({ param: `${path}.${propName}`, message: 'Required property missing' })
          }
        } else {
          errors.push(...validateValue(propValue, propDef, `${path}.${propName}`))
        }
      }
    }
  } else if (def.type === 'string') {
    if (typeof value !== 'string') {
      errors.push({ param: path, message: `Expected string, got ${actualType}` })
    }
  } else if (def.type === 'number') {
    if (typeof value !== 'number' || isNaN(value)) {
      errors.push({ param: path, message: `Expected number, got ${actualType}` })
    }
  } else if (def.type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push({ param: path, message: `Expected boolean, got ${actualType}` })
    }
  }

  // Enum check
  if (def.enum && !errors.length) {
    if (!def.enum.includes(value)) {
      errors.push({ param: path, message: `Value must be one of: ${def.enum.join(', ')}` })
    }
  }

  return errors
}

/**
 * Validate tool input parameters
 */
function validateInput(
  input: unknown,
  schema: ParameterSchema
): ValidationResult {
  const errors: ValidationError[] = []
  const normalized: Record<string, unknown> = {}

  if (typeof input !== 'object' || input === null) {
    return {
      valid: false,
      errors: [{ param: 'input', message: 'Input must be an object' }],
      normalized: {}
    }
  }

  const inputObj = input as Record<string, unknown>

  for (const [paramName, paramDef] of Object.entries(schema)) {
    const value = inputObj[paramName]

    // Check required parameters
    if (value === undefined || value === null) {
      if (paramDef.required !== false) {
        errors.push({ param: paramName, message: 'Required parameter missing' })
        continue
      }
      // Apply default value
      if (paramDef.default !== undefined) {
        normalized[paramName] = paramDef.default
      }
      continue
    }

    // Validate parameter type and constraints
    const paramErrors = validateValue(value, paramDef, paramName)
    errors.push(...paramErrors)

    if (paramErrors.length === 0) {
      normalized[paramName] = value
    }
  }

  // Preserve parameters not defined in the schema (forward compatibility)
  for (const [key, value] of Object.entries(inputObj)) {
    if (!(key in schema) && value !== undefined) {
      normalized[key] = value
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    normalized
  }
}

/**
 * Run a promise with a deadline. Cleans up the timer whether the promise
 * resolves or rejects, so there are no dangling timers.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`Tool "${toolName}" timed out after ${ms}ms`)),
      ms
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timerId)
  }
}

/**
 * Tool Registry
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>()
  private config: ToolRegistryConfig | null = null

  /**
   * Set configuration
   */
  configure(config: ToolRegistryConfig): void {
    this.config = config
  }

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Tool "${tool.name}" already registered, overriding with later definition`)
    }
    this.tools.set(tool.name, tool)
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
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  /**
   * Get a tool
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * Get all tools
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  /**
   * Get all tool names
   */
  getNames(): string[] {
    return Array.from(this.tools.keys())
  }

  /**
   * Get the number of tools
   */
  get size(): number {
    return this.tools.size
  }

  /**
   * Call a tool
   */
  async call(
    name: string,
    input: unknown,
    context?: Partial<ToolContext> & { signal?: AbortSignal }
  ): Promise<ToolResult> {
    if (!this.config) {
      throw new Error('ToolRegistry not configured')
    }

    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, error: `Unknown tool: ${name}` }
    }

    // ========== Parameter Validation ==========
    const validation = validateInput(input, tool.parameters)
    if (!validation.valid) {
      const agentError = createValidationError(name, validation.errors)

      // Build FeedbackContext with tool schema info
      const toolSchema: ToolSchemaSummary = {
        name,
        params: Object.entries(tool.parameters).map(([pName, pDef]) => ({
          name: pName,
          type: pDef.type,
          required: pDef.required !== false
        }))
      }
      const feedbackCtx: FeedbackContext = { originalInput: input, toolSchema }
      const feedback = toolValidationFeedback(name, validation.errors, feedbackCtx)

      this.config.trace.record({
        type: 'tool.validation_error',
        data: { tool: name, errors: validation.errors, agentError }
      })

      return {
        success: false,
        error: formatFeedbackAsToolResult(feedback)
      }
    }

    // Use normalized input (includes default values)
    const normalizedInput = validation.normalized

    // Build policy context
    const policyContext = {
      tool: name,
      input: normalizedInput,
      agentId: this.config.runtime.agentId,
      sessionId: this.config.runtime.sessionId,
      step: this.config.runtime.step
    }

    // Pre-execution check (Guard + Mutate) — wrapped so a buggy policy can't crash the loop
    const { policyEngine, trace: registryTrace } = this.config
    const beforeRes = await tryCatch(() => policyEngine.evaluateBefore(policyContext))
    if (!beforeRes.ok) {
      return { success: false, error: `Policy evaluation error: ${beforeRes.error.message}` }
    }
    const beforeResult = beforeRes.value

    if (!beforeResult.allowed) {
      const feedback = policyDenialFeedback(name, beforeResult.reason || 'Policy denied', beforeResult.policyId)
      const result: ToolResult = { success: false, error: formatFeedbackAsToolResult(feedback) }

      registryTrace.record({
        type: 'tool.result',
        data: { tool: name, success: false, error: beforeResult.reason, category: 'policy_denied' }
      })

      return result
    }

    // Use potentially mutated input
    const mutatedInput = beforeResult.input ?? normalizedInput

    // Record tool call
    const spanId = this.config.trace.startSpan('tool.call', { tool: name, input: mutatedInput })

    // Build tool context — apply per-tool IO override if the tool defines createIO
    let effectiveRuntime = this.config.runtime
    if (tool.createIO) {
      const customIO = await tool.createIO(this.config.runtime.io, this.config.runtime)
      effectiveRuntime = { ...this.config.runtime, io: customIO }
    }

    const toolContext: ToolContext = {
      runtime: effectiveRuntime,
      sessionId: context?.sessionId ?? this.config.runtime.sessionId,
      step: context?.step ?? this.config.runtime.step,
      agentId: context?.agentId ?? this.config.runtime.agentId,
      messages: context?.messages,
      signal: context?.signal
    }

    let result: ToolResult

    try {
      const executePromise = tool.execute(mutatedInput, toolContext)
      result = tool.timeout
        ? await withTimeout(executePromise, tool.timeout, tool.name)
        : await executePromise
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      result = { success: false, error: errorMessage }
    }

    // End span
    this.config.trace.endSpan(spanId, {
      success: result.success,
      error: result.error
    })

    // Post-execution observation (Observe) — fire-and-forget; a buggy observe policy
    // must not crash the tool call that already succeeded.
    await tryCatch(() => policyEngine.evaluateAfter({
      ...policyContext,
      input: mutatedInput,
      result
    }))

    return result
  }

  /**
   * Validate input parameters (without executing the tool)
   */
  validate(name: string, input: unknown): ValidationResult {
    const tool = this.tools.get(name)
    if (!tool) {
      return {
        valid: false,
        errors: [{ param: 'tool', message: `Unknown tool: ${name}` }],
        normalized: {}
      }
    }
    return validateInput(input, tool.parameters)
  }

  /**
   * Generate full tool descriptions for LLM system prompt
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
   * Generate compact tool descriptions (first line of description + params as inline list)
   */
  generateCompactToolDescriptions(): string {
    const descriptions: string[] = []

    for (const tool of this.tools.values()) {
      // Take only the first line of the description
      const firstLine = (tool.description.split('\n')[0] ?? '').trim()

      const params = Object.entries(tool.parameters)
        .map(([name, def]) => {
          const required = def.required !== false ? '' : '?'
          return `${name}${required}: ${def.type}`
        })
        .join(', ')

      descriptions.push(`### ${tool.name}\n${firstLine}\nParams: ${params}`)
    }

    return descriptions.join('\n\n')
  }

  /**
   * Generate tool schemas for LLM function calling.
   * Supports optional subset filtering and token budget limits.
   */
  generateToolSchemas(options?: {
    /** Only include these tool names */
    subset?: string[]
    /** Maximum total tokens for all schemas (not yet enforced, reserved for future) */
    maxTokens?: number
  }): Array<{
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required: string[]
    }
  }> {
    const schemas = []
    const subset = options?.subset ? new Set(options.subset) : null

    for (const tool of this.tools.values()) {
      // Skip tools not in subset (if subset specified)
      if (subset && !subset.has(tool.name)) continue

      const properties: Record<string, unknown> = {}
      const required: string[] = []

      for (const [name, def] of Object.entries(tool.parameters)) {
        properties[name] = {
          type: def.type,
          description: def.description,
          ...(def.enum ? { enum: def.enum } : {}),
          ...(def.default !== undefined ? { default: def.default } : {}),
          ...(def.properties ? { properties: def.properties } : {}),
          ...(def.items ? { items: def.items } : {})
        }

        if (def.required !== false) {
          required.push(name)
        }
      }

      schemas.push({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object' as const,
          properties,
          required
        }
      })
    }

    return schemas
  }

  /**
   * Validate that a tool call targets a tool in the current allowed subset.
   * Returns a structured error if the tool is not available.
   */
  validateSubset(toolName: string, allowedSubset: string[]): ToolResult | null {
    const subsetSet = new Set(allowedSubset)
    if (subsetSet.has(toolName)) {
      return null // Valid
    }
    return {
      success: false,
      error: `Tool "${toolName}" is not available this round. Available tools: ${allowedSubset.join(', ')}`
    }
  }

  /**
   * Clear the registry
   */
  clear(): void {
    this.tools.clear()
  }
}

// Export validation functions for testing
export { validateInput, validateValue }
