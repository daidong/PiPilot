/**
 * ToolRegistry - 工具注册表
 */

import type { Tool, ToolContext, ToolResult, ParameterSchema, ParameterDefinition } from '../types/tool.js'
import type { PolicyEngine } from './policy-engine.js'
import type { TraceCollector } from './trace-collector.js'
import type { Runtime } from '../types/runtime.js'

/**
 * 工具调用信息
 */
export interface ToolCallInfo {
  tool: string
  input: unknown
  output?: ToolResult
  error?: string
  durationMs: number
}

/**
 * 工具注册表配置
 */
export interface ToolRegistryConfig {
  policyEngine: PolicyEngine
  trace: TraceCollector
  runtime: Runtime
}

/**
 * 参数校验错误
 */
export interface ValidationError {
  param: string
  message: string
}

/**
 * 参数校验结果
 */
export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  normalized: Record<string, unknown>
}

/**
 * 校验单个参数值
 */
function validateValue(
  value: unknown,
  def: ParameterDefinition,
  path: string
): ValidationError[] {
  const errors: ValidationError[] = []

  // 类型检查
  const actualType = Array.isArray(value) ? 'array' : typeof value

  if (def.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ param: path, message: `Expected array, got ${actualType}` })
      return errors
    }

    // 校验数组元素
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

    // 校验对象属性
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

  // enum 检查
  if (def.enum && !errors.length) {
    if (!def.enum.includes(value)) {
      errors.push({ param: path, message: `Value must be one of: ${def.enum.join(', ')}` })
    }
  }

  return errors
}

/**
 * 校验工具输入参数
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

    // 检查必填参数
    if (value === undefined || value === null) {
      if (paramDef.required !== false) {
        errors.push({ param: paramName, message: 'Required parameter missing' })
        continue
      }
      // 应用默认值
      if (paramDef.default !== undefined) {
        normalized[paramName] = paramDef.default
      }
      continue
    }

    // 校验参数类型和约束
    const paramErrors = validateValue(value, paramDef, paramName)
    errors.push(...paramErrors)

    if (paramErrors.length === 0) {
      normalized[paramName] = value
    }
  }

  // 保留未定义在 schema 中的参数（向前兼容）
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
 * 工具注册表
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>()
  private config: ToolRegistryConfig | null = null

  /**
   * 设置配置
   */
  configure(config: ToolRegistryConfig): void {
    this.config = config
  }

  /**
   * 注册工具
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  /**
   * 批量注册工具
   */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  /**
   * 取消注册工具
   */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  /**
   * 获取工具
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * 获取所有工具
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  /**
   * 获取所有工具名称
   */
  getNames(): string[] {
    return Array.from(this.tools.keys())
  }

  /**
   * 获取工具数量
   */
  get size(): number {
    return this.tools.size
  }

  /**
   * 调用工具
   */
  async call(
    name: string,
    input: unknown,
    context?: Partial<ToolContext>
  ): Promise<ToolResult> {
    if (!this.config) {
      throw new Error('ToolRegistry not configured')
    }

    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, error: `Unknown tool: ${name}` }
    }

    // ========== 参数校验 ==========
    const validation = validateInput(input, tool.parameters)
    if (!validation.valid) {
      const errorMessages = validation.errors
        .map(e => `${e.param}: ${e.message}`)
        .join('; ')

      this.config.trace.record({
        type: 'tool.validation_error',
        data: { tool: name, errors: validation.errors }
      })

      return {
        success: false,
        error: `Parameter validation failed: ${errorMessages}`
      }
    }

    // 使用规范化后的输入（包含默认值）
    const normalizedInput = validation.normalized

    // 构建策略上下文
    const policyContext = {
      tool: name,
      input: normalizedInput,
      agentId: this.config.runtime.agentId,
      sessionId: this.config.runtime.sessionId,
      step: this.config.runtime.step
    }

    // 执行前检查（Guard + Mutate）
    const beforeResult = await this.config.policyEngine.evaluateBefore(policyContext)

    if (!beforeResult.allowed) {
      const result: ToolResult = { success: false, error: beforeResult.reason }

      this.config.trace.record({
        type: 'tool.result',
        data: { tool: name, success: false, error: beforeResult.reason }
      })

      return result
    }

    // 使用可能被 mutate 的输入
    const mutatedInput = beforeResult.input ?? normalizedInput

    // 记录工具调用
    const spanId = this.config.trace.startSpan('tool.call', { tool: name, input: mutatedInput })

    // 构建工具上下文
    const toolContext: ToolContext = {
      runtime: this.config.runtime,
      sessionId: context?.sessionId ?? this.config.runtime.sessionId,
      step: context?.step ?? this.config.runtime.step,
      agentId: context?.agentId ?? this.config.runtime.agentId
    }

    let result: ToolResult

    try {
      result = await tool.execute(mutatedInput, toolContext)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      result = { success: false, error: errorMessage }
    }

    // 结束 span
    this.config.trace.endSpan(spanId, {
      success: result.success,
      error: result.error
    })

    // 执行后观察（Observe）
    await this.config.policyEngine.evaluateAfter({
      ...policyContext,
      input: mutatedInput,
      result
    })

    return result
  }

  /**
   * 校验输入参数（不执行工具）
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
   * 生成工具描述（给 LLM 用）
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
   * 生成工具 schema（用于 LLM function calling）
   */
  generateToolSchemas(): Array<{
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required: string[]
    }
  }> {
    const schemas = []

    for (const tool of this.tools.values()) {
      const properties: Record<string, unknown> = {}
      const required: string[] = []

      for (const [name, def] of Object.entries(tool.parameters)) {
        properties[name] = {
          type: def.type,
          description: def.description,
          ...(def.enum ? { enum: def.enum } : {}),
          ...(def.default !== undefined ? { default: def.default } : {})
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
   * 清空注册表
   */
  clear(): void {
    this.tools.clear()
  }
}

// 导出校验函数供测试使用
export { validateInput, validateValue }
