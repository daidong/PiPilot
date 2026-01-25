/**
 * grep - 内容搜索工具
 *
 * 特性：
 * - 非 shell 执行（spawn + 参数数组，防止命令注入）
 * - 源头限量（使用 -m 参数）
 * - 默认排除 node_modules/.git/dist 等
 * - 一致的输出结构（count/truncated/error）
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import type { GrepMatch } from '../types/runtime.js'

export interface GrepInput {
  pattern: string
  cwd?: string
  type?: string
  limit?: number
  ignoreCase?: boolean
}

export interface GrepOutput {
  /** 匹配结果 */
  matches: GrepMatch[]
  /** 匹配数量 */
  count: number
  /** 是否被截断 */
  truncated: boolean
}

export const grep: Tool<GrepInput, GrepOutput> = defineTool({
  name: 'grep',
  description: `在文件中搜索内容。支持正则表达式。

默认排除：
- node_modules, .git, dist, build, coverage 等

安全特性：
- 非 shell 执行（防止命令注入）
- 有最大结果数限制
- 路径必须在项目目录内

输出说明：
- truncated=true 表示结果被截断，建议缩小搜索范围或使用 type 过滤`,
  parameters: {
    pattern: {
      type: 'string',
      description: '搜索模式（支持正则表达式）',
      required: true
    },
    cwd: {
      type: 'string',
      description: '搜索的起始目录（相对于项目根目录）',
      required: false
    },
    type: {
      type: 'string',
      description: '文件类型过滤（如 ts, js, py）',
      required: false
    },
    limit: {
      type: 'number',
      description: '最大结果数（默认 100，受系统硬限制）',
      required: false,
      default: 100
    },
    ignoreCase: {
      type: 'boolean',
      description: '是否忽略大小写',
      required: false,
      default: false
    }
  },
  execute: async (input, { runtime }) => {
    const limit = input.limit ?? 100

    const result = await runtime.io.grep(input.pattern, {
      cwd: input.cwd,
      type: input.type,
      limit,
      ignoreCase: input.ignoreCase
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    const matches = result.data!
    const meta = result.meta ?? {}

    return {
      success: true,
      data: {
        matches,
        count: matches.length,
        truncated: meta.truncated ?? false
      }
    }
  }
})
