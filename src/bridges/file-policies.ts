/**
 * File Access Policies
 *
 * 根据权限声明生成文件访问策略
 */

import type { Policy, PolicyContext, GuardDecision } from '../types/policy.js'
import { defineGuardPolicy } from '../factories/define-policy.js'

/**
 * 文件策略配置
 */
export interface FileAccessPolicyConfig {
  /** Provider ID（用于策略 ID 前缀） */
  providerId: string
  /** 允许访问的路径 */
  allowedPaths?: string[]
  /** 禁止访问的路径 */
  deniedPaths?: string[]
  /** 策略优先级 */
  priority?: number
}

/**
 * 创建文件读取策略
 */
export function createFileReadPolicy(config: FileAccessPolicyConfig): Policy {
  const { providerId, allowedPaths, deniedPaths, priority = 15 } = config

  return defineGuardPolicy({
    id: `${providerId}.file.read`,
    description: `File read access control for ${providerId}`,
    priority,
    match: (ctx: PolicyContext) => {
      // 匹配 read 工具或文件读取操作
      return ctx.tool === 'read' || ctx.operation === 'readFile'
    },
    decide: (ctx: PolicyContext): GuardDecision => {
      const input = ctx.input as { path?: string } | undefined
      const filePath = input?.path

      if (!filePath) {
        return { action: 'allow' }
      }

      // 检查是否在禁止列表中
      if (deniedPaths && matchesAnyPattern(filePath, deniedPaths)) {
        return {
          action: 'deny',
          reason: `[${providerId}] File read denied: ${filePath}`
        }
      }

      // 如果有允许列表，检查是否在允许范围内
      if (allowedPaths && allowedPaths.length > 0) {
        if (!matchesAnyPattern(filePath, allowedPaths)) {
          return {
            action: 'deny',
            reason: `[${providerId}] File read not in allowed paths: ${filePath}`
          }
        }
      }

      return { action: 'allow' }
    }
  })
}

/**
 * 创建文件写入策略
 */
export function createFileWritePolicy(config: FileAccessPolicyConfig): Policy {
  const { providerId, allowedPaths, deniedPaths, priority = 15 } = config

  return defineGuardPolicy({
    id: `${providerId}.file.write`,
    description: `File write access control for ${providerId}`,
    priority,
    match: (ctx: PolicyContext) => {
      // 匹配 write/edit 工具或文件写入操作
      return (
        ctx.tool === 'write' ||
        ctx.tool === 'edit' ||
        ctx.operation === 'writeFile'
      )
    },
    decide: (ctx: PolicyContext): GuardDecision => {
      const input = ctx.input as { path?: string; file_path?: string } | undefined
      const filePath = input?.path ?? input?.file_path

      if (!filePath) {
        return { action: 'allow' }
      }

      // 检查是否在禁止列表中
      if (deniedPaths && matchesAnyPattern(filePath, deniedPaths)) {
        return {
          action: 'deny',
          reason: `[${providerId}] File write denied: ${filePath}`
        }
      }

      // 如果有允许列表，检查是否在允许范围内
      if (allowedPaths && allowedPaths.length > 0) {
        if (!matchesAnyPattern(filePath, allowedPaths)) {
          return {
            action: 'deny',
            reason: `[${providerId}] File write not in allowed paths: ${filePath}`
          }
        }
      }

      return { action: 'allow' }
    }
  })
}

/**
 * 检查路径是否匹配任意模式
 */
function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  const normalizedPath = normalizePath(filePath)

  for (const pattern of patterns) {
    if (matchPattern(normalizedPath, pattern)) {
      return true
    }
  }

  return false
}

/**
 * 规范化路径
 */
function normalizePath(filePath: string): string {
  // 替换反斜杠
  let normalized = filePath.replace(/\\/g, '/')

  // 移除多余的斜杠
  normalized = normalized.replace(/\/+/g, '/')

  return normalized
}

/**
 * 匹配路径模式
 *
 * 支持的模式：
 * - 精确匹配: /path/to/file
 * - 目录匹配: /path/to/ (匹配目录下所有文件)
 * - 通配符: *.txt (匹配扩展名)
 * - 双星: ** (匹配任意深度)
 */
function matchPattern(filePath: string, pattern: string): boolean {
  const normalizedPattern = normalizePath(pattern)

  // 精确匹配
  if (filePath === normalizedPattern) {
    return true
  }

  // 目录匹配（以 / 结尾）
  if (normalizedPattern.endsWith('/')) {
    return filePath.startsWith(normalizedPattern) ||
           filePath === normalizedPattern.slice(0, -1)
  }

  // 转换 glob 模式为正则表达式
  const regexPattern = globToRegex(normalizedPattern)
  return regexPattern.test(filePath)
}

/**
 * 将 glob 模式转换为正则表达式
 */
function globToRegex(pattern: string): RegExp {
  let regex = pattern
    // 转义特殊字符
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // ** 匹配任意路径
    .replace(/\\\*\\\*/g, '.*')
    // * 匹配除 / 外的任意字符
    .replace(/\\\*/g, '[^/]*')
    // ? 匹配单个字符
    .replace(/\\\?/g, '[^/]')

  // 如果模式不以 / 开头，允许匹配路径中的任意位置
  if (!pattern.startsWith('/') && !pattern.startsWith('./')) {
    regex = '(^|/)' + regex
  }

  return new RegExp(regex + '$', 'i')
}

/**
 * 从权限声明创建文件访问策略
 */
export function createFileAccessPolicies(
  providerId: string,
  permissions: { read?: string[]; write?: string[] } | undefined,
  priority?: number
): Policy[] {
  const policies: Policy[] = []

  if (!permissions) {
    return policies
  }

  // 读取策略
  if (permissions.read) {
    policies.push(
      createFileReadPolicy({
        providerId,
        allowedPaths: permissions.read,
        priority
      })
    )
  }

  // 写入策略
  if (permissions.write) {
    policies.push(
      createFileWritePolicy({
        providerId,
        allowedPaths: permissions.write,
        priority
      })
    )
  }

  return policies
}
