/**
 * python - Python bridge pack
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import type { Tool } from '../types/tool.js'
import { PythonBridge } from '../python/bridge.js'
import { createPythonToolFactory } from '../python/define-python-tool.js'

/**
 * Python Pack configuration
 */
export interface PythonPackConfig {
  /** Python Bridge instance */
  bridge: PythonBridge
  /** Tool configurations */
  tools: Array<{
    /** Method name */
    method: string
    /** Tool name */
    name: string
    /** Tool description */
    description: string
    /** Parameter definitions */
    parameters?: Record<string, {
      type: string
      description?: string
      required?: boolean
    }>
  }>
}

/**
 * Create a Python Pack
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
    description: `Python bridge pack: ${tools.map(t => t.name).join(', ')}`,
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
## Python Tools

The following tools are provided by Python:

${tools.map(t => `- **${t.name}**: ${t.description}`).join('\n')}

These tools are executed via the Python Bridge and may require additional dependencies.
    `.trim()
  })
}
