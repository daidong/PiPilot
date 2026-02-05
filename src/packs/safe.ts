/**
 * safe - 安全核心工具包
 *
 * 特点：
 * - 无外部依赖
 * - 沙箱内运行
 * - 可审计
 * - 默认启用
 *
 * Migration to Skills:
 * - Set useSkills: true to use lazy-loaded skills instead of promptFragment
 * - Skills reduce initial token usage by ~60% (50 vs 120 tokens)
 * - Skills load automatically when ctx-get tool is first used
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import { read, write, edit, glob, grep, ctxGet } from '../tools/index.js'
import { noSecretFiles } from '../policies/no-secret-files.js'
import { normalizePathsPolicies } from '../policies/normalize-paths.js'
import { autoLimitRead, autoLimitGrep, autoLimitGlob } from '../policies/auto-limit.js'
import { contextRetrievalSkill } from '../skills/builtin/index.js'

/**
 * Safe Pack options
 */
export interface SafePackOptions {
  /**
   * Use Skills instead of promptFragment for token optimization
   * When true, uses lazy-loaded contextRetrievalSkill instead of inline promptFragment
   * @default true
   */
  useSkills?: boolean
}

/**
 * Safe Pack - 安全核心工具包
 *
 * 包含工具：
 * - ctx-get: 统一上下文入口
 * - read: 读取文件
 * - write: 写入文件
 * - edit: 编辑文件
 * - glob: 文件匹配
 * - grep: 内容搜索
 *
 * 不包含：
 * - bash: 执行能力（移至 execPack）
 * - fetch: 网络能力（移至 networkPack）
 * - llm_call: LLM 调用（移至 computePack）
 *
 * @param options - Configuration options
 * @param options.useSkills - Use lazy-loaded skill instead of promptFragment (default: true)
 */
export function safe(options: SafePackOptions = {}): Pack {
  const { useSkills = true } = options

  const tools = [
    ctxGet as any,
    read as any,
    write as any,
    edit as any,
    glob as any,
    grep as any
  ]

  const policies = [
    // Guard: 禁止访问敏感文件
    ...noSecretFiles,
    // Mutate: 路径规范化
    ...normalizePathsPolicies,
    // Mutate: 自动限制输出大小
    autoLimitRead,
    autoLimitGrep,
    autoLimitGlob
  ]

  // Skills-based approach: lazy loading for token optimization
  if (useSkills) {
    return definePack({
      id: 'safe',
      description: '安全核心工具包：ctx-get, read, write, edit, glob, grep',
      tools,
      policies,
      skills: [contextRetrievalSkill],
      skillLoadingConfig: {
        lazy: ['context-retrieval-skill'] // Loads when ctx-get tool is first used
      }
    })
  }

  // Legacy promptFragment approach (for backward compatibility)
  return definePack({
    id: 'safe',
    description: '安全核心工具包：ctx-get, read, write, edit, glob, grep',
    tools,
    policies,
    promptFragment: `
## Core Tools Guide

### Context Retrieval
- **ctx-get**: Unified context entry point for structured information
  - Available sources depend on registered packs (session.*, memory.*, docs.*, etc.)
  - Source IDs are listed in the ctx-get tool description

### File Operations
- **read**: Read file content with pagination
- **write**: Write/create files
- **edit**: Edit files (replace specific content)
- **glob**: Match files by pattern
- **grep**: Search content in files

### Best Practices
1. Use glob to find files, then read to view content
2. Use grep to search for specific patterns
3. Use edit for precise modifications, avoid full rewrites
4. Use ctx-get for session history, memory, and documentation
    `.trim()
  })
}

/**
 * 别名：safePack
 */
export const safePack = safe
