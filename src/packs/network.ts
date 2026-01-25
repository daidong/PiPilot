/**
 * network - 网络能力包
 *
 * 特点：
 * - 需要显式启用
 * - 支持 domain allowlist/denylist
 * - 支持响应大小限制
 * - SSRF 防护
 */

import { definePack } from '../factories/define-pack.js'
import { defineGuardPolicy, defineMutatePolicy, defineAuditPolicy } from '../factories/define-policy.js'
import type { Pack } from '../types/pack.js'
import type { Policy } from '../types/policy.js'
import { fetchTool } from '../tools/index.js'

/**
 * Network Pack 配置选项
 */
export interface NetworkPackOptions {
  /**
   * 允许访问的域名（allowlist 模式）
   * 如果设置，只能访问这些域名
   */
  allowDomains?: string[]

  /**
   * 禁止访问的域名（denylist 模式）
   * 默认包含内网地址
   */
  denyDomains?: string[]

  /**
   * 禁止访问的 IP 范围（SSRF 防护）
   * 默认禁止内网 IP
   */
  denyIpRanges?: string[]

  /**
   * 最大响应大小（字节）
   * 默认 10MB
   */
  maxResponseSize?: number

  /**
   * 请求超时时间（毫秒）
   * 默认 30000
   */
  timeout?: number

  /**
   * 允许的 HTTP 方法
   * 默认 ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
   */
  allowMethods?: string[]

  /**
   * 是否允许非 HTTPS 请求
   * 默认 false（只允许 HTTPS）
   */
  allowHttp?: boolean
}

/**
 * 默认禁止的内网 IP 范围（保留供未来 IP 级别 SSRF 防护使用）
 */
export const DEFAULT_DENY_IP_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '::1',
  'fc00::/7',
  'fe80::/10'
]

/**
 * 默认禁止的域名
 */
const DEFAULT_DENY_DOMAINS = [
  'localhost',
  '*.local',
  '*.internal',
  'metadata.google.internal',
  '169.254.169.254'  // AWS metadata
]

/**
 * 检查域名是否匹配模式
 */
function matchDomain(domain: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)
    return domain.endsWith(suffix) || domain === pattern.slice(2)
  }
  return domain === pattern
}

/**
 * 从 URL 提取域名
 */
function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.hostname
  } catch {
    return null
  }
}

/**
 * 创建域名 allowlist 策略
 */
function createDomainAllowlistPolicy(allowDomains: string[]): Policy {
  return defineGuardPolicy({
    id: 'network:domain-allowlist',
    description: '只允许访问白名单中的域名',
    priority: 5,
    match: (ctx) => ctx.tool === 'fetch',
    decide: (ctx) => {
      const url = (ctx.input as { url?: string })?.url ?? ''
      const domain = extractDomain(url)

      if (!domain) {
        return { action: 'deny', reason: `无效的 URL: ${url}` }
      }

      const allowed = allowDomains.some(pattern => matchDomain(domain, pattern))
      if (!allowed) {
        return {
          action: 'deny',
          reason: `域名不在允许列表中: ${domain}`
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * 创建域名 denylist 策略
 */
function createDomainDenylistPolicy(denyDomains: string[]): Policy {
  return defineGuardPolicy({
    id: 'network:domain-denylist',
    description: '禁止访问黑名单中的域名',
    priority: 10,
    match: (ctx) => ctx.tool === 'fetch',
    decide: (ctx) => {
      const url = (ctx.input as { url?: string })?.url ?? ''
      const domain = extractDomain(url)

      if (!domain) {
        return { action: 'deny', reason: `无效的 URL: ${url}` }
      }

      const denied = denyDomains.some(pattern => matchDomain(domain, pattern))
      if (denied) {
        return {
          action: 'deny',
          reason: `域名被禁止访问: ${domain}`
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * 创建 HTTPS 强制策略
 */
function createHttpsOnlyPolicy(): Policy {
  return defineGuardPolicy({
    id: 'network:https-only',
    description: '只允许 HTTPS 请求',
    priority: 8,
    match: (ctx) => ctx.tool === 'fetch',
    decide: (ctx) => {
      const url = (ctx.input as { url?: string })?.url ?? ''
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:') {
          return {
            action: 'deny',
            reason: `只允许 HTTPS 请求: ${url}`
          }
        }
      } catch {
        return { action: 'deny', reason: `无效的 URL: ${url}` }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * 创建 HTTP 方法限制策略
 */
function createMethodPolicy(allowMethods: string[]): Policy {
  return defineGuardPolicy({
    id: 'network:method-restrict',
    description: '限制允许的 HTTP 方法',
    priority: 12,
    match: (ctx) => ctx.tool === 'fetch',
    decide: (ctx) => {
      const method = ((ctx.input as { method?: string })?.method ?? 'GET').toUpperCase()
      if (!allowMethods.includes(method)) {
        return {
          action: 'deny',
          reason: `HTTP 方法不被允许: ${method}`
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * 创建超时限制策略（Mutate）
 */
function createTimeoutPolicy(timeout: number): Policy {
  return defineMutatePolicy({
    id: 'network:timeout-limit',
    description: '强制设置请求超时',
    priority: 50,
    match: (ctx) => ctx.tool === 'fetch',
    transforms: [
      { op: 'clamp', path: 'timeout', max: timeout }
    ]
  })
}

/**
 * 创建网络审计策略
 */
const networkAuditPolicy = defineAuditPolicy({
  id: 'network:audit',
  description: '审计所有网络请求',
  priority: 100,
  match: (ctx) => ctx.tool === 'fetch',
  record: (ctx) => {
    const input = ctx.input as { url?: string; method?: string }
    return {
      tool: ctx.tool,
      url: input.url,
      method: input.method ?? 'GET',
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      step: ctx.step,
      timestamp: new Date().toISOString()
    }
  }
})

/**
 * Network Pack - 网络能力包
 *
 * 包含工具：
 * - fetch: HTTP 请求
 *
 * 默认策略：
 * - 禁止访问内网地址（SSRF 防护）
 * - 只允许 HTTPS（可配置）
 * - 审计所有网络请求
 */
export function network(options: NetworkPackOptions = {}): Pack {
  const {
    allowDomains,
    denyDomains = DEFAULT_DENY_DOMAINS,
    maxResponseSize = 10 * 1024 * 1024,  // 10MB
    timeout = 30000,
    allowMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
    allowHttp = false
  } = options

  const policies: Policy[] = []

  // Domain allowlist 策略
  if (allowDomains && allowDomains.length > 0) {
    policies.push(createDomainAllowlistPolicy(allowDomains))
  }

  // Domain denylist 策略
  if (denyDomains && denyDomains.length > 0) {
    policies.push(createDomainDenylistPolicy(denyDomains))
  }

  // HTTPS 强制策略
  if (!allowHttp) {
    policies.push(createHttpsOnlyPolicy())
  }

  // HTTP 方法限制策略
  policies.push(createMethodPolicy(allowMethods))

  // Timeout 限制策略
  policies.push(createTimeoutPolicy(timeout))

  // 审计策略
  policies.push(networkAuditPolicy)

  return definePack({
    id: 'network',
    description: '网络能力包：HTTP 请求（需显式启用）',

    tools: [fetchTool as any],

    policies,

    promptFragment: `
## 网络请求能力

### fetch 工具
发送 HTTP 请求，用于：
- 调用外部 API
- 获取远程数据
- Webhook 调用

### 安全限制
${allowDomains ? `- 仅允许访问: ${allowDomains.join(', ')}` : '- 禁止访问内网地址'}
${!allowHttp ? '- 仅允许 HTTPS 请求' : ''}
- 允许方法: ${allowMethods.join(', ')}
- 超时限制: ${timeout}ms
- 响应大小限制: ${Math.round(maxResponseSize / 1024 / 1024)}MB

### 最佳实践
1. 使用完整的 URL（包含协议）
2. 设置适当的 Content-Type
3. 处理超时和错误情况
    `.trim()
  })
}

/**
 * 别名：networkPack
 */
export const networkPack = network

/**
 * 预设：严格模式（需要显式指定允许的域名）
 */
export function networkStrict(allowDomains: string[]): Pack {
  return network({
    allowDomains,
    allowHttp: false,
    allowMethods: ['GET', 'POST'],
    timeout: 10000
  })
}

/**
 * 预设：API 模式（常见 API 场景）
 */
export function networkApi(): Pack {
  return network({
    denyDomains: [
      ...DEFAULT_DENY_DOMAINS,
      '*.gov',
      '*.mil'
    ],
    allowHttp: false,
    timeout: 30000
  })
}

/**
 * 预设：GitHub API
 */
export function networkGitHub(): Pack {
  return network({
    allowDomains: [
      'api.github.com',
      'raw.githubusercontent.com',
      'github.com'
    ],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    timeout: 30000
  })
}
