/**
 * edit - 编辑文件工具
 *
 * 特性：
 * - 使用 readFileForEdit 绕过 autoLimitRead（避免截断）
 * - 唯一性检测（防止意外替换多处）
 * - 一致的输出结构（count/truncated/error）
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface EditInput {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export interface EditOutput {
  /** 编辑的文件路径 */
  path: string
  /** 替换的次数 */
  replacements: number
  /** 文件总字节数（编辑后） */
  bytes: number
}

export const edit: Tool<EditInput, EditOutput> = defineTool({
  name: 'edit',
  description: `编辑文件内容。将 old_string 替换为 new_string。

特性：
- 精确匹配：old_string 必须完全匹配
- 唯一性检测：默认要求 old_string 只出现一次
- 如需替换多处，设置 replace_all=true

注意：为确保编辑准确，old_string 应包含足够的上下文使其唯一。`,
  parameters: {
    path: {
      type: 'string',
      description: '文件路径（相对于项目根目录）',
      required: true
    },
    old_string: {
      type: 'string',
      description: '要替换的原始内容（需完全匹配）',
      required: true
    },
    new_string: {
      type: 'string',
      description: '替换后的新内容',
      required: true
    },
    replace_all: {
      type: 'boolean',
      description: '是否替换所有匹配项，默认只替换第一个',
      required: false,
      default: false
    }
  },
  execute: async (input, { runtime }) => {
    // 使用 readFileForEdit 读取完整文件（绕过 autoLimitRead 策略）
    // 这确保编辑操作不会因为文件被截断而失败
    let content: string

    if (runtime.io.readFileForEdit) {
      const readResult = await runtime.io.readFileForEdit(input.path)
      if (!readResult.success) {
        return { success: false, error: readResult.error }
      }
      content = readResult.data!
    } else {
      // 降级：使用普通读取（可能被截断）
      const readResult = await runtime.io.readFile(input.path)
      if (!readResult.success) {
        return { success: false, error: readResult.error }
      }
      content = readResult.data!

      // 检查是否被截断
      if (readResult.meta?.truncated) {
        return {
          success: false,
          error: `File too large for edit and was truncated. Consider using smaller edits or splitting the file.`
        }
      }
    }

    // 检查 old_string 是否存在
    if (!content.includes(input.old_string)) {
      return {
        success: false,
        error: `old_string not found in file: ${input.path}`
      }
    }

    // 检查唯一性（如果不是 replace_all）
    const occurrences = content.split(input.old_string).length - 1
    if (!input.replace_all && occurrences > 1) {
      return {
        success: false,
        error: `old_string appears ${occurrences} times. Use replace_all=true or provide more context to make it unique.`
      }
    }

    // 执行替换
    let newContent: string
    let replacements: number

    if (input.replace_all) {
      replacements = occurrences
      newContent = content.split(input.old_string).join(input.new_string)
    } else {
      replacements = 1
      newContent = content.replace(input.old_string, input.new_string)
    }

    // 写入文件
    const writeResult = await runtime.io.writeFile(input.path, newContent)

    if (!writeResult.success) {
      return { success: false, error: writeResult.error }
    }

    return {
      success: true,
      data: {
        path: input.path,
        replacements,
        bytes: newContent.length
      }
    }
  }
})
