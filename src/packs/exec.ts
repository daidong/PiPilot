/**
 * exec - 执行能力包（高风险）
 *
 * 特点：
 * - 需要显式启用
 * - 强制策略约束
 * - 可配置 allowlist/denylist
 */

import { definePack } from '../factories/define-pack.js'
import { defineGuardPolicy, defineApprovalPolicy } from '../factories/define-policy.js'
import type { Pack } from '../types/pack.js'
import type { Policy } from '../types/policy.js'
import { bash } from '../tools/index.js'
import { noDestructive, requireApprovalForDestructive } from '../policies/no-destructive.js'
import { auditCommandExecution } from '../policies/audit-all.js'

/**
 * Exec Pack 配置选项
 */
export interface ExecPackOptions {
  /**
   * 允许执行的命令前缀（allowlist 模式）
   * 如果设置，只有匹配的命令才能执行
   */
  allowCommands?: string[]

  /**
   * 禁止执行的命令模式（denylist 模式）
   * 默认包含危险命令
   */
  denyPatterns?: RegExp[]

  /**
   * 是否需要用户审批
   * - 'none': 不需要审批
   * - 'dangerous': 危险命令需要审批（默认）
   * - 'all': 所有命令需要审批
   */
  approvalMode?: 'none' | 'dangerous' | 'all'

  /**
   * 执行超时时间（毫秒）
   * 默认 60000
   */
  timeout?: number

  /**
   * 允许的工作目录（cwd）
   * 如果设置，只能在这些目录下执行
   */
  allowedCwd?: string[]
}

/**
 * 创建 allowlist 策略
 */
function createAllowlistPolicy(allowCommands: string[]): Policy {
  return defineGuardPolicy({
    id: 'exec:allowlist',
    description: '只允许执行白名单中的命令',
    priority: 5,
    match: (ctx) => ctx.tool === 'bash',
    decide: (ctx) => {
      const command = (ctx.input as { command?: string })?.command ?? ''
      const allowed = allowCommands.some(prefix =>
        command.trim().startsWith(prefix)
      )
      if (!allowed) {
        return {
          action: 'deny',
          reason: `命令不在允许列表中: ${command.slice(0, 50)}...`
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * 创建 denylist 策略
 */
function createDenylistPolicy(denyPatterns: RegExp[]): Policy {
  return defineGuardPolicy({
    id: 'exec:denylist',
    description: '禁止执行黑名单中的命令',
    priority: 10,
    match: (ctx) => ctx.tool === 'bash',
    decide: (ctx) => {
      const command = (ctx.input as { command?: string })?.command ?? ''
      for (const pattern of denyPatterns) {
        if (pattern.test(command)) {
          return {
            action: 'deny',
            reason: `命令被禁止: ${command.slice(0, 50)}...`
          }
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * 创建全审批策略
 */
function createAllApprovalPolicy(): Policy {
  return defineApprovalPolicy({
    id: 'exec:approval-all',
    description: '所有 bash 命令需要审批',
    priority: 15,
    match: (ctx) => ctx.tool === 'bash',
    message: (ctx) => {
      const command = (ctx.input as { command?: string })?.command ?? ''
      return `确认执行命令: ${command}`
    },
    timeout: 60000
  })
}

/**
 * 创建 cwd 限制策略
 */
function createCwdPolicy(allowedCwd: string[]): Policy {
  return defineGuardPolicy({
    id: 'exec:cwd-restrict',
    description: '限制命令执行的工作目录',
    priority: 8,
    match: (ctx) => ctx.tool === 'bash',
    decide: (ctx) => {
      const cwd = (ctx.input as { cwd?: string })?.cwd
      if (cwd) {
        const allowed = allowedCwd.some(dir =>
          cwd.startsWith(dir) || cwd === dir
        )
        if (!allowed) {
          return {
            action: 'deny',
            reason: `工作目录不被允许: ${cwd}`
          }
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * Exec Pack - 执行能力包
 *
 * 包含工具：
 * - bash: 执行 shell 命令
 *
 * 默认策略：
 * - 禁止危险命令（rm -rf, DROP TABLE 等）
 * - 危险操作需要用户审批
 * - 审计所有命令执行
 */
export function exec(options: ExecPackOptions = {}): Pack {
  const {
    allowCommands,
    denyPatterns,
    approvalMode = 'dangerous',
    allowedCwd
  } = options

  const policies: Policy[] = []

  // Allowlist 策略（最高优先级）
  if (allowCommands && allowCommands.length > 0) {
    policies.push(createAllowlistPolicy(allowCommands))
  }

  // Denylist 策略
  if (denyPatterns && denyPatterns.length > 0) {
    policies.push(createDenylistPolicy(denyPatterns))
  } else {
    // 默认使用内置的危险命令阻止策略
    policies.push(noDestructive)
  }

  // CWD 限制策略
  if (allowedCwd && allowedCwd.length > 0) {
    policies.push(createCwdPolicy(allowedCwd))
  }

  // 审批策略
  if (approvalMode === 'all') {
    policies.push(createAllApprovalPolicy())
  } else if (approvalMode === 'dangerous') {
    policies.push(requireApprovalForDestructive)
  }

  // 审计策略
  policies.push(auditCommandExecution)

  return definePack({
    id: 'exec',
    description: '执行能力包：bash 命令执行（需显式启用）',

    tools: [bash as any],

    policies,

    promptFragment: `
## 命令执行能力

### bash 工具
执行 shell 命令，用于：
- 运行构建脚本
- 执行测试
- 安装依赖
- Git 操作

### 安全限制
${allowCommands ? `- 仅允许: ${allowCommands.join(', ')}` : '- 禁止危险命令（rm -rf, DROP TABLE 等）'}
${approvalMode !== 'none' ? `- ${approvalMode === 'all' ? '所有命令' : '危险命令'}需要用户审批` : ''}
${allowedCwd ? `- 仅允许在以下目录执行: ${allowedCwd.join(', ')}` : ''}

### 最佳实践
1. 使用绝对路径或明确的 cwd
2. 避免管道组合复杂命令
3. 设置合理的 timeout
    `.trim()
  })
}

/**
 * 别名：execPack
 */
export const execPack = exec

/**
 * 预设：严格模式（只允许安全命令）
 */
export function execStrict(): Pack {
  return exec({
    allowCommands: [
      'ls', 'cat', 'head', 'tail', 'wc',
      'git status', 'git log', 'git diff', 'git branch',
      'npm list', 'npm outdated',
      'node --version', 'npm --version',
      'pwd', 'echo', 'date'
    ],
    approvalMode: 'all'
  })
}

/**
 * 预设：开发模式（允许常见开发命令）
 */
export function execDev(): Pack {
  return exec({
    allowCommands: [
      'npm', 'npx', 'yarn', 'pnpm',
      'git', 'node', 'tsc', 'tsx',
      'ls', 'cat', 'head', 'tail', 'wc',
      'mkdir', 'cp', 'mv',
      'pwd', 'echo', 'date', 'which'
    ],
    denyPatterns: [
      /\brm\s+(-[rf]+\s+)?(\/|~)/,  // 禁止删除根目录或 home
      /\bsudo\b/,
      /\bchmod\s+777/,
      /\b(curl|wget)\s+.*\|\s*(sh|bash)/  // 禁止 curl | bash
    ],
    approvalMode: 'dangerous'
  })
}
