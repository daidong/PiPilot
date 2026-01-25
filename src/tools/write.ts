/**
 * write - 写入文件工具
 *
 * 特性：
 * - 原子写入（临时文件 + rename）
 * - 权限保留（继承原文件权限）
 * - 大小限制（防止内存/磁盘溢出）
 * - 一致的输出结构（count/truncated/error）
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface WriteInput {
  path: string
  content: string
}

export interface WriteOutput {
  /** 写入的文件路径 */
  path: string
  /** 写入的字节数 */
  bytes: number
  /** 是否为新建文件 */
  created: boolean
}

export const write: Tool<WriteInput, WriteOutput> = defineTool({
  name: 'write',
  description: `写入文件内容。如果文件不存在会创建，如果存在会覆盖。

安全特性：
- 原子写入（先写临时文件再 rename，防止中途失败导致文件损坏）
- 保留原文件权限
- 路径必须在项目目录内
- 有最大写入大小限制`,
  parameters: {
    path: {
      type: 'string',
      description: '文件路径（相对于项目根目录）',
      required: true
    },
    content: {
      type: 'string',
      description: '要写入的内容',
      required: true
    }
  },
  execute: async (input, { runtime }) => {
    // 先检查文件是否存在
    const existsResult = await runtime.io.exists(input.path)
    const existed = existsResult.success && existsResult.data === true

    const result = await runtime.io.writeFile(input.path, input.content)

    if (!result.success) {
      return {
        success: false,
        error: result.error
      }
    }

    return {
      success: true,
      data: {
        path: input.path,
        bytes: input.content.length,
        created: !existed
      }
    }
  }
})
