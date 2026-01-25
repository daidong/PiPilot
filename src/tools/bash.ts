/**
 * bash - 执行命令工具
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
  description: '执行 bash 命令。用于运行系统命令、构建脚本等。',
  parameters: {
    command: {
      type: 'string',
      description: '要执行的命令',
      required: true
    },
    cwd: {
      type: 'string',
      description: '工作目录（相对于项目根目录）',
      required: false
    },
    timeout: {
      type: 'number',
      description: '超时时间（毫秒），默认 60000',
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
