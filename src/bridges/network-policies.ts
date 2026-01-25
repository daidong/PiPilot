/**
 * Network Access Policies
 *
 * 根据权限声明生成网络访问策略
 */

import type { Policy, PolicyContext, GuardDecision } from '../types/policy.js'
import { defineGuardPolicy } from '../factories/define-policy.js'

/**
 * 网络策略配置
 */
export interface NetworkPolicyConfig {
  /** Provider ID（用于策略 ID 前缀） */
  providerId: string
  /** 允许访问的域名 */
  allowedDomains?: string[]
  /** 禁止访问的域名 */
  deniedDomains?: string[]
  /** 策略优先级 */
  priority?: number
}

/**
 * 创建网络访问策略
 */
export function createNetworkPolicy(config: NetworkPolicyConfig): Policy {
  const { providerId, allowedDomains, deniedDomains, priority = 15 } = config

  return defineGuardPolicy({
    id: `${providerId}.network`,
    description: `Network access control for ${providerId}`,
    priority,
    match: (ctx: PolicyContext) => {
      // 匹配 fetch 工具或网络请求操作
      return ctx.tool === 'fetch' || ctx.operation === 'fetch'
    },
    decide: (ctx: PolicyContext): GuardDecision => {
      const input = ctx.input as { url?: string } | undefined
      const url = input?.url

      if (!url) {
        return { action: 'allow' }
      }

      // 解析域名
      const domain = extractDomain(url)
      if (!domain) {
        return {
          action: 'deny',
          reason: `[${providerId}] Invalid URL: ${url}`
        }
      }

      // 检查是否在禁止列表中
      if (deniedDomains && matchesDomain(domain, deniedDomains)) {
        return {
          action: 'deny',
          reason: `[${providerId}] Network access denied: ${domain}`
        }
      }

      // 如果有允许列表，检查是否在允许范围内
      if (allowedDomains && allowedDomains.length > 0) {
        if (!matchesDomain(domain, allowedDomains)) {
          return {
            action: 'deny',
            reason: `[${providerId}] Network access not in allowed domains: ${domain}`
          }
        }
      }

      return { action: 'allow' }
    }
  })
}

/**
 * 从 URL 提取域名
 */
export function extractDomain(url: string): string | null {
  try {
    // 处理相对 URL
    if (url.startsWith('/')) {
      return null
    }

    // 添加协议前缀（如果没有）
    let fullUrl = url
    if (!url.includes('://')) {
      fullUrl = 'https://' + url
    }

    const parsed = new URL(fullUrl)
    return parsed.hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * 检查域名是否匹配任意模式
 */
export function matchesDomain(domain: string, patterns: string[]): boolean {
  const normalizedDomain = domain.toLowerCase()

  for (const pattern of patterns) {
    if (matchDomainPattern(normalizedDomain, pattern.toLowerCase())) {
      return true
    }
  }

  return false
}

/**
 * 匹配域名模式
 *
 * 支持的模式：
 * - 精确匹配: api.example.com
 * - 通配符: *.example.com (匹配子域名)
 * - 全局通配: * (匹配所有)
 */
function matchDomainPattern(domain: string, pattern: string): boolean {
  // 全局通配
  if (pattern === '*') {
    return true
  }

  // 精确匹配
  if (domain === pattern) {
    return true
  }

  // 通配符匹配 (*.example.com)
  if (pattern.startsWith('*.')) {
    const baseDomain = pattern.slice(2)
    // 匹配 example.com 本身
    if (domain === baseDomain) {
      return true
    }
    // 匹配子域名 sub.example.com
    if (domain.endsWith('.' + baseDomain)) {
      return true
    }
  }

  // 后缀匹配 (.example.com)
  if (pattern.startsWith('.')) {
    if (domain.endsWith(pattern)) {
      return true
    }
  }

  return false
}

/**
 * 从权限声明创建网络访问策略
 */
export function createNetworkAccessPolicies(
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
      createNetworkPolicy({
        providerId,
        deniedDomains: permissions.deny,
        priority
      })
    ]
  }

  // 如果有 allow 列表，创建允许策略
  if (permissions.allow && permissions.allow.length > 0) {
    return [
      createNetworkPolicy({
        providerId,
        allowedDomains: permissions.allow,
        deniedDomains: permissions.deny,
        priority
      })
    ]
  }

  return []
}
