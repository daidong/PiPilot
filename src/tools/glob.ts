/**
 * glob - 文件匹配工具
 *
 * 特性：
 * - 硬限制 maxResults
 * - 自动合并默认 ignore 模式
 * - 一致的输出结构（count/truncated/error）
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface GlobInput {
  pattern: string
  cwd?: string
  ignore?: string[]
}

export interface GlobOutput {
  /** 匹配的文件列表 */
  files: string[]
  /** 匹配数量 */
  count: number
  /** 是否被截断 */
  truncated: boolean
  /** 总匹配数（截断前） */
  total?: number
}

export const glob: Tool<GlobInput, GlobOutput> = defineTool({
  name: 'glob',
  description: `使用 glob 模式匹配文件。例如 "**/*.ts" 匹配所有 TypeScript 文件。

默认忽略：
- node_modules, .git, dist, build, coverage 等

安全限制：
- 有最大结果数限制
- 路径必须在项目目录内`,
  parameters: {
    pattern: {
      type: 'string',
      description: 'Glob 匹配模式（如 **/*.ts）',
      required: true
    },
    cwd: {
      type: 'string',
      description: '搜索的起始目录（相对于项目根目录）',
      required: false
    },
    ignore: {
      type: 'array',
      description: '额外要忽略的模式（会与默认忽略模式合并）',
      required: false,
      items: { type: 'string' }
    }
  },
  execute: async (input, { runtime }) => {
    const result = await runtime.io.glob(input.pattern, {
      cwd: input.cwd,
      ignore: input.ignore
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    const files = result.data!
    const meta = result.meta ?? {}

    return {
      success: true,
      data: {
        files,
        count: files.length,
        truncated: meta.truncated ?? false,
        total: meta.total
      }
    }
  }
})
