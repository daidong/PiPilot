/**
 * defineTool - 工具定义工厂
 */

import type { Tool, ToolConfig, ToolContext, ToolResult } from '../types/tool.js'

/**
 * 定义工具
 */
export function defineTool<TInput = unknown, TOutput = unknown>(
  config: ToolConfig<TInput, TOutput>
): Tool<TInput, TOutput> {
  // 验证配置
  if (!config.name) {
    throw new Error('Tool name is required')
  }

  if (!config.description) {
    throw new Error('Tool description is required')
  }

  if (!config.execute) {
    throw new Error('Tool execute function is required')
  }

  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: config.execute
  }
}

/**
 * 创建工具包装器，添加错误处理
 */
export function withErrorHandling<TInput, TOutput>(
  tool: Tool<TInput, TOutput>
): Tool<TInput, TOutput> {
  return {
    ...tool,
    execute: async (input: TInput, context: ToolContext): Promise<ToolResult<TOutput>> => {
      try {
        return await tool.execute(input, context)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          error: `Tool execution failed: ${errorMessage}`
        }
      }
    }
  }
}

/**
 * 创建工具包装器，添加超时
 */
export function withTimeout<TInput, TOutput>(
  tool: Tool<TInput, TOutput>,
  timeoutMs: number
): Tool<TInput, TOutput> {
  return {
    ...tool,
    execute: async (input: TInput, context: ToolContext): Promise<ToolResult<TOutput>> => {
      const timeoutPromise = new Promise<ToolResult<TOutput>>((_, reject) => {
        setTimeout(() => reject(new Error(`Tool ${tool.name} timed out after ${timeoutMs}ms`)), timeoutMs)
      })

      try {
        return await Promise.race([tool.execute(input, context), timeoutPromise])
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          error: errorMessage
        }
      }
    }
  }
}

/**
 * 创建工具包装器，添加重试
 */
export function withRetry<TInput, TOutput>(
  tool: Tool<TInput, TOutput>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Tool<TInput, TOutput> {
  return {
    ...tool,
    execute: async (input: TInput, context: ToolContext): Promise<ToolResult<TOutput>> => {
      let lastError: string | undefined

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await tool.execute(input, context)
          if (result.success) {
            return result
          }
          lastError = result.error
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
        }

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)))
        }
      }

      return {
        success: false,
        error: `Failed after ${maxRetries + 1} attempts: ${lastError}`
      }
    }
  }
}

/**
 * 组合多个工具增强器
 */
export function composeTool<TInput, TOutput>(
  tool: Tool<TInput, TOutput>,
  ...enhancers: Array<(t: Tool<TInput, TOutput>) => Tool<TInput, TOutput>>
): Tool<TInput, TOutput> {
  return enhancers.reduce((t, enhancer) => enhancer(t), tool)
}
