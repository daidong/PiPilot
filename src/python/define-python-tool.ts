/**
 * definePythonTool - Python tool definition
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool, ParameterSchema } from '../types/tool.js'
import { PythonBridge } from './bridge.js'
import { buildFeedback, formatFeedbackAsToolResult } from '../core/feedback.js'

/**
 * Python tool configuration
 */
export interface PythonToolConfig {
  /** Tool name */
  name: string
  /** Tool description */
  description: string
  /** Python script path */
  script: string
  /** Method name (service mode) */
  method?: string
  /** Parameter definitions */
  parameters: ParameterSchema
  /** Python interpreter */
  python?: string
  /** Working directory */
  cwd?: string
}

/**
 * Define a Python tool (script mode)
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
   * Create multiple tools
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
 * Create a tool factory from a Python Bridge
 */
export function createPythonToolFactory(bridge: PythonBridge): PythonToolFactory {
  return new PythonToolFactory(bridge)
}
