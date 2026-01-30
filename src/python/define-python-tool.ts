/**
 * definePythonTool - Python 工具定义
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool, ParameterSchema } from '../types/tool.js'
import { PythonBridge } from './bridge.js'
import { buildFeedback, formatFeedbackAsToolResult } from '../core/feedback.js'

/**
 * Python 工具配置
 */
export interface PythonToolConfig {
  /** 工具名称 */
  name: string
  /** 工具描述 */
  description: string
  /** Python 脚本路径 */
  script: string
  /** 方法名（服务模式） */
  method?: string
  /** 参数定义 */
  parameters: ParameterSchema
  /** Python 解释器 */
  python?: string
  /** 工作目录 */
  cwd?: string
}

/**
 * 定义 Python 工具（脚本模式）
 */
export function definePythonTool<TInput = unknown, TOutput = unknown>(
  config: PythonToolConfig
): Tool<TInput, TOutput> {
  const bridge = new PythonBridge({
    script: config.script,
    mode: 'script',
    python: config.python,
    cwd: config.cwd
  })

  return defineTool<TInput, TOutput>({
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: async (input) => {
      const result = await bridge.call<TOutput>(config.method ?? 'main', input)

      if (!result.success) {
        // Use structured feedback if agentError is available (RFC-005)
        if (result.agentError) {
          const feedback = buildFeedback(result.agentError)
          return { success: false, error: formatFeedbackAsToolResult(feedback) }
        }
        return { success: false, error: result.error }
      }

      return { success: true, data: result.data }
    }
  })
}

/**
 * Python service tool factory
 */
export class PythonToolFactory {
  private bridge: PythonBridge

  constructor(bridge: PythonBridge) {
    this.bridge = bridge
  }

  /**
   * Create a tool
   */
  create<TInput = unknown, TOutput = unknown>(config: {
    name: string
    description: string
    method: string
    parameters: ParameterSchema
  }): Tool<TInput, TOutput> {
    const bridge = this.bridge

    return defineTool<TInput, TOutput>({
      name: config.name,
      description: config.description,
      parameters: config.parameters,
      execute: async (input) => {
        if (!bridge.isReady()) {
          return { success: false, error: 'Python bridge not ready' }
        }

        const result = await bridge.call<TOutput>(config.method, input)

        if (!result.success) {
          if (result.agentError) {
            const feedback = buildFeedback(result.agentError)
            return { success: false, error: formatFeedbackAsToolResult(feedback) }
          }
          return { success: false, error: result.error }
        }

        return { success: true, data: result.data }
      }
    })
  }

  /**
   * 创建多个工具
   */
  createAll(configs: Array<{
    name: string
    description: string
    method: string
    parameters: ParameterSchema
  }>): Tool[] {
    return configs.map(config => this.create(config))
  }
}

/**
 * 从 Python Bridge 创建工具工厂
 */
export function createPythonToolFactory(bridge: PythonBridge): PythonToolFactory {
  return new PythonToolFactory(bridge)
}
