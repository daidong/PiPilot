/**
 * bash - Command execution tool
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface BashInput {
  command: string
  cwd?: string
  timeout?: number
}

export interface BashOutput {
  stdout: string
  stderr: string
  exitCode: number
}

export const bash: Tool<BashInput, BashOutput> = defineTool({
  name: 'bash',
  description: 'Execute bash commands. Used to run system commands, build scripts, etc.',
  parameters: {
    command: {
      type: 'string',
      description: 'Command to execute',
      required: true
    },
    cwd: {
      type: 'string',
      description: 'Working directory (relative to project root)',
      required: false
    },
    timeout: {
      type: 'number',
      description: 'Timeout in milliseconds, defaults to 60000',
      required: false,
      default: 60000
    }
  },
  execute: async (input, { runtime }) => {
    const result = await runtime.io.exec(input.command, {
      cwd: input.cwd,
      timeout: input.timeout
    })

    if (!result.success && !result.data) {
      return { success: false, error: result.error }
    }

    const output = result.data!

    return {
      success: output.exitCode === 0,
      data: output,
      error: output.exitCode !== 0 ? `Command exited with code ${output.exitCode}` : undefined
    }
  }
})
