/**
 * read - 读取文件工具
 *
 * 特性：
 * - 流式处理大文件
 * - 硬限制 maxBytes/maxLines
 * - 一致的输出结构（count/truncated/error）
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface ReadInput {
  path: string
  encoding?: BufferEncoding
  offset?: number
  limit?: number
}

export interface ReadOutput {
  /** 文件内容 */
  content: string
  /** 总行数（可能是实际行数或截断前的估计） */
  lines: number
  /** 是否被截断 */
  truncated: boolean
  /** 读取的字节数 */
  bytes: number
}

export const read: Tool<ReadInput, ReadOutput> = defineTool({
  name: 'read',
  description: `读取文件内容。可以指定编码、偏移量和行数限制。

安全限制：
- 路径必须在项目目录内
- 有最大字节和行数限制
- 大文件会自动截断

输出说明：
- truncated=true 表示内容被截断，需要使用 offset/limit 分页读取`,
  parameters: {
    path: {
      type: 'string',
      description: '文件路径（相对于项目根目录）',
      required: true
    },
    encoding: {
      type: 'string',
      description: '文件编码，默认 utf-8',
      required: false,
      default: 'utf-8'
    },
    offset: {
      type: 'number',
      description: '起始行号（从 0 开始）',
      required: false
    },
    limit: {
      type: 'number',
      description: '读取的最大行数（受系统硬限制）',
      required: false
    }
  },
  execute: async (input, { runtime }) => {
    const result = await runtime.io.readFile(input.path, {
      encoding: input.encoding,
      offset: input.offset,
      limit: input.limit
    })

    if (!result.success) {
      return {
        success: false,
        error: result.error
      }
    }

    const content = result.data!
    const meta = result.meta ?? {}

    return {
      success: true,
      data: {
        content,
        lines: meta.lines ?? content.split('\n').length,
        truncated: meta.truncated ?? false,
        bytes: meta.bytes ?? content.length
      }
    }
  }
})
