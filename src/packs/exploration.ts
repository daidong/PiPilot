/**
 * exploration - 探索指南包
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import { defineGuardPolicy, defineApprovalPolicy } from '../factories/define-policy.js'

/**
 * 探索前先了解结构策略
 */
const exploreBeforeModify = defineApprovalPolicy({
  id: 'explore-before-modify',
  description: '修改前建议先了解项目结构',
  priority: 50,
  match: (ctx) => {
    // 检查会话状态是否已探索
    const hasExplored = ctx.sessionId && (ctx as unknown as { sessionState?: { get: (k: string) => boolean } })
      .sessionState?.get?.('hasExplored')

    return ['edit', 'write'].includes(ctx.tool) && !hasExplored
  },
  message: '建议先用 ctx.get("repo.index") 了解项目结构。确定要直接修改吗？'
})

/**
 * 禁止用 bash 做探索策略
 */
const noBashExplore = defineGuardPolicy({
  id: 'no-bash-explore',
  description: '禁止使用 bash 进行代码探索',
  priority: 30,
  match: (ctx) => {
    if (ctx.tool !== 'bash') return false

    const cmd = (ctx.input as { command?: string })?.command ?? ''
    return /\b(ls|find|tree|grep|rg|cat|head|tail)\b/.test(cmd)
  },
  decide: (ctx) => {
    const cmd = (ctx.input as { command?: string })?.command ?? ''

    // 构建替代建议
    let suggestion = ''
    if (/\bls\b/.test(cmd) || /\btree\b/.test(cmd) || /\bfind\b/.test(cmd)) {
      suggestion = 'ctx.get("repo.index")'
    } else if (/\bgrep\b|\brg\b/.test(cmd)) {
      suggestion = 'ctx.get("repo.search", { pattern: "..." })'
    } else if (/\bcat\b|\bhead\b|\btail\b/.test(cmd)) {
      suggestion = 'ctx.get("repo.file", { path: "..." })'
    }

    return {
      action: 'deny',
      reason: `请使用 ${suggestion || 'ctx.get'} 而不是 bash 命令`
    }
  }
})

/**
 * 探索指南 Pack
 */
export function exploration(): Pack {
  return definePack({
    id: 'exploration',
    description: '代码探索指南和策略',

    policies: [
      exploreBeforeModify,
      noBashExplore
    ],

    promptFragment: `
## 代码探索指南

### 优先使用 ctx.get
在探索代码时，优先使用 ctx.get 而不是原始工具：

| 需求 | 使用 ctx.get | 不要用 |
|------|------------|--------|
| 查看项目结构 | ctx.get("repo.index") | ls, tree, find |
| 搜索代码 | ctx.get("repo.search", {...}) | grep, rg |
| 读取文件 | ctx.get("repo.file", {...}) | read (低层) |
| Git 状态 | ctx.get("repo.git") | git status |

### ctx.get 的优势
1. **结构化输出** - 返回格式化的、易读的内容
2. **预算控制** - 自动限制结果数量
3. **覆盖度说明** - 告诉你是否看到了完整结果
4. **缓存** - 重复请求会使用缓存

### 探索流程
1. 先用 \`ctx.get("repo.index")\` 了解项目结构
2. 用 \`ctx.get("repo.search", {...})\` 找到相关代码
3. 用 \`ctx.get("repo.file", {...})\` 阅读具体实现
4. 理解后再进行修改

### 注意 coverage 信息
如果返回结果显示 "not complete"，根据 suggestions 决定是否需要进一步探索。
    `.trim()
  })
}
