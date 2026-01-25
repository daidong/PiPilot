/**
 * no-destructive - 禁止危险命令策略
 */

import { defineGuardPolicy } from '../factories/define-policy.js'

/**
 * 危险命令模式
 */
const DESTRUCTIVE_PATTERNS = [
  // 删除操作
  /\brm\s+(-[rf]+\s+)?[\/\w]/,
  /\brmdir\b/,
  /\bdel\b/,
  /\brd\b/,

  // 数据库操作
  /\bDROP\s+(TABLE|DATABASE|INDEX|VIEW)/i,
  /\bTRUNCATE\s+TABLE/i,
  /\bDELETE\s+FROM\s+\w+\s*$/i, // DELETE without WHERE

  // 系统操作
  /\bformat\b/i,
  /\bmkfs\b/,
  /\bdd\s+if=/,

  // Git 危险操作
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[fd]/,

  // 权限操作
  /\bchmod\s+777/,
  /\bchown\s+-R/
]

/**
 * 禁止危险命令策略
 */
export const noDestructive = defineGuardPolicy({
  id: 'no-destructive',
  description: '禁止执行危险的破坏性命令',
  priority: 10,
  match: (ctx) => {
    return ctx.tool === 'bash' || ctx.operation === 'exec'
  },
  decide: (ctx) => {
    const command = (ctx.input as { command?: string })?.command ??
                    (ctx.params as { command?: string })?.command ?? ''

    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(command)) {
        return {
          action: 'deny',
          reason: `危险命令被阻止: ${command.slice(0, 50)}...`
        }
      }
    }

    return { action: 'allow' }
  }
})

/**
 * 需要审批的危险操作（比 noDestructive 宽松）
 */
export const requireApprovalForDestructive = defineGuardPolicy({
  id: 'require-approval-destructive',
  description: '危险命令需要用户审批',
  priority: 20,
  match: (ctx) => {
    return ctx.tool === 'bash' || ctx.operation === 'exec'
  },
  decide: (ctx) => {
    const command = (ctx.input as { command?: string })?.command ??
                    (ctx.params as { command?: string })?.command ?? ''

    // 需要审批的命令模式
    const needsApproval = [
      /\brm\b/,
      /\bgit\s+push/,
      /\bnpm\s+publish/,
      /\bsudo\b/
    ]

    for (const pattern of needsApproval) {
      if (pattern.test(command)) {
        return {
          action: 'require_approval',
          message: `执行此命令需要确认: ${command}`,
          timeout: 30000
        }
      }
    }

    return { action: 'allow' }
  }
})
