/**
 * safe - 安全核心工具包
 *
 * 特点：
 * - 无外部依赖
 * - 沙箱内运行
 * - 可审计
 * - 默认启用
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import { read, write, edit, glob, grep, ctxGet } from '../tools/index.js'
import { noSecretFiles } from '../policies/no-secret-files.js'
import { normalizePathsPolicies } from '../policies/normalize-paths.js'
import { autoLimitRead, autoLimitGrep, autoLimitGlob } from '../policies/auto-limit.js'

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
 */
export function safe(): Pack {
  return definePack({
    id: 'safe',
    description: '安全核心工具包：ctx-get, read, write, edit, glob, grep',

    tools: [
      ctxGet as any,
      read as any,
      write as any,
      edit as any,
      glob as any,
      grep as any
    ],

    policies: [
      // Guard: 禁止访问敏感文件
      ...noSecretFiles,
      // Mutate: 路径规范化
      ...normalizePathsPolicies,
      // Mutate: 自动限制输出大小
      autoLimitRead,
      autoLimitGrep,
      autoLimitGlob
    ],

    promptFragment: `
## 核心工具使用指南

### 上下文获取（推荐首选）
- **ctx-get**: 统一上下文入口，获取结构化信息
  - 可用源: repo.index, repo.search, repo.file 等
  - 降低心智负担，优先使用

### 文件操作
- **read**: 读取文件内容，支持分页
- **write**: 写入/创建文件
- **edit**: 编辑文件（替换指定内容）
- **glob**: 按模式匹配文件
- **grep**: 在文件中搜索内容

### 最佳实践
1. 优先使用 ctx-get 获取结构化信息
2. 使用 glob 找到文件后再用 read 读取
3. 使用 grep 搜索特定内容
4. 使用 edit 进行精确修改，避免整体重写
    `.trim()
  })
}

/**
 * 别名：safePack
 */
export const safePack = safe
