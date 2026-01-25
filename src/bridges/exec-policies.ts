/**
 * Exec Access Policies
 *
 * 根据权限声明生成命令执行策略
 */

import type { Policy, PolicyContext, GuardDecision } from '../types/policy.js'
import { defineGuardPolicy } from '../factories/define-policy.js'

/**
 * 执行策略配置
 */
export interface ExecPolicyConfig {
  /** Provider ID（用于策略 ID 前缀） */
  providerId: string
  /** 允许执行的命令模式 */
  allowedCommands?: string[]
  /** 禁止执行的命令模式 */
  deniedCommands?: string[]
  /** 策略优先级 */
  priority?: number
}

/**
 * 创建命令执行策略
 */
export function createExecPolicy(config: ExecPolicyConfig): Policy {
  const { providerId, allowedCommands, deniedCommands, priority = 15 } = config

  return defineGuardPolicy({
    id: `${providerId}.exec`,
    description: `Command execution control for ${providerId}`,
    priority,
    match: (ctx: PolicyContext) => {
      // 匹配 bash 工具或命令执行操作
      return ctx.tool === 'bash' || ctx.operation === 'exec'
    },
    decide: (ctx: PolicyContext): GuardDecision => {
      const input = ctx.input as { command?: string } | undefined
      const command = input?.command

      if (!command) {
        return { action: 'allow' }
      }

      // 提取命令名称
      const commandName = extractCommandName(command)

      // 检查是否在禁止列表中
      if (deniedCommands && matchesCommand(command, commandName, deniedCommands)) {
        return {
          action: 'deny',
          reason: `[${providerId}] Command execution denied: ${commandName}`
        }
      }

      // 如果有允许列表，检查是否在允许范围内
      if (allowedCommands && allowedCommands.length > 0) {
        if (!matchesCommand(command, commandName, allowedCommands)) {
          return {
            action: 'deny',
            reason: `[${providerId}] Command not in allowed list: ${commandName}`
          }
        }
      }

      return { action: 'allow' }
    }
  })
}

/**
 * 提取命令名称
 */
function extractCommandName(command: string): string {
  // 移除前导空白和环境变量设置
  let cmd = command.trim()

  // 处理 env VAR=value command 格式
  while (cmd.match(/^\w+=\S*\s+/)) {
    cmd = cmd.replace(/^\w+=\S*\s+/, '')
  }

  // 处理 sudo、time 等前缀
  const prefixes = ['sudo', 'time', 'nice', 'nohup', 'env']
  for (const prefix of prefixes) {
    if (cmd.startsWith(prefix + ' ')) {
      cmd = cmd.slice(prefix.length + 1).trim()
    }
  }

  // 提取第一个命令
  const parts = cmd.split(/\s+/)
  const firstPart = parts[0] ?? ''

  // 移除路径，只保留命令名
  const cmdName = firstPart.split('/').pop() ?? firstPart

  return cmdName
}

/**
 * 检查命令是否匹配任意模式
 */
function matchesCommand(
  fullCommand: string,
  commandName: string,
  patterns: string[]
): boolean {
  for (const pattern of patterns) {
    if (matchCommandPattern(fullCommand, commandName, pattern)) {
      return true
    }
  }

  return false
}

/**
 * 匹配命令模式
 *
 * 支持的模式：
 * - 精确匹配: npm
 * - 正则匹配: /rm\s+-rf/ (以 / 包围)
 * - 通配符: npm* (匹配 npm, npx 等)
 * - 全局通配: * (匹配所有)
 */
function matchCommandPattern(
  fullCommand: string,
  commandName: string,
  pattern: string
): boolean {
  // 全局通配
  if (pattern === '*') {
    return true
  }

  // 正则匹配
  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      const regex = new RegExp(pattern.slice(1, -1), 'i')
      return regex.test(fullCommand)
    } catch {
      return false
    }
  }

  // 通配符匹配
  if (pattern.includes('*')) {
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    const regex = new RegExp('^' + regexPattern + '$', 'i')
    return regex.test(commandName)
  }

  // 精确匹配
  return commandName.toLowerCase() === pattern.toLowerCase()
}

/**
 * 从权限声明创建执行策略
 */
export function createExecAccessPolicies(
  providerId: string,
  permissions: { allow?: string[]; deny?: string[] } | undefined,
  priority?: number
): Policy[] {
  if (!permissions) {
    return []
  }

  // 如果只有 deny 列表，创建拒绝策略
  if (permissions.deny && permissions.deny.length > 0 && !permissions.allow) {
    return [
      createExecPolicy({
        providerId,
        deniedCommands: permissions.deny,
        priority
      })
    ]
  }

  // 如果有 allow 列表，创建允许策略
  if (permissions.allow && permissions.allow.length > 0) {
    return [
      createExecPolicy({
        providerId,
        allowedCommands: permissions.allow,
        deniedCommands: permissions.deny,
        priority
      })
    ]
  }

  return []
}
