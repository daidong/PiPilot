/**
 * python - Python 桥接包
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import type { Tool } from '../types/tool.js'
import { PythonBridge } from '../python/bridge.js'
import { createPythonToolFactory } from '../python/define-python-tool.js'

/**
 * Python Pack 配置
 */
export interface PythonPackConfig {
  /** Python Bridge 实例 */
  bridge: PythonBridge
  /** 工具配置 */
  tools: Array<{
    /** 方法名 */
    method: string
    /** 工具名称 */
    name: string
    /** 工具描述 */
    description: string
    /** 参数定义 */
    parameters?: Record<string, {
      type: string
      description?: string
      required?: boolean
    }>
  }>
}

/**
 * 创建 Python Pack
 */
export function python(config: PythonPackConfig): Pack {
  const factory = createPythonToolFactory(config.bridge)

  const tools: Tool[] = config.tools.map(toolConfig => {
    const parameters: Record<string, {
      type: 'string' | 'number' | 'boolean' | 'object' | 'array'
      description?: string
      required?: boolean
    }> = {}

    if (toolConfig.parameters) {
      for (const [key, value] of Object.entries(toolConfig.parameters)) {
        parameters[key] = {
          type: value.type as 'string' | 'number' | 'boolean' | 'object' | 'array',
          description: value.description,
          required: value.required
        }
      }
    }

    return factory.create({
      name: toolConfig.name,
      description: toolConfig.description,
      method: toolConfig.method,
      parameters
    })
  })

  return definePack({
    id: 'python',
    description: `Python 桥接包：${tools.map(t => t.name).join(', ')}`,
    tools,

    onInit: async () => {
      if (!config.bridge.isReady()) {
        await config.bridge.start()
      }
    },

    onDestroy: async () => {
      await config.bridge.stop()
    },

    promptFragment: `
## Python 工具

以下工具由 Python 提供：

${tools.map(t => `- **${t.name}**: ${t.description}`).join('\n')}

这些工具通过 Python Bridge 执行，可能需要额外的依赖。
    `.trim()
  })
}
