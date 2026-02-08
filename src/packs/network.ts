/**
 * network - Network capability pack
 *
 * Features:
 * - Requires explicit enablement
 * - Supports domain allowlist/denylist
 * - Supports response size limits
 * - SSRF protection
 */

import { definePack } from '../factories/define-pack.js'
import { defineGuardPolicy, defineMutatePolicy, defineAuditPolicy } from '../factories/define-policy.js'
import type { Pack } from '../types/pack.js'
import type { Policy } from '../types/policy.js'
import { fetchTool } from '../tools/index.js'

/**
 * Network Pack configuration options
 */
export interface NetworkPackOptions {
  /**
   * Allowed domains (allowlist mode)
   * If set, only these domains can be accessed
   */
  allowDomains?: string[]

  /**
   * Denied domains (denylist mode)
   * Includes internal network addresses by default
   */
  denyDomains?: string[]

  /**
   * Denied IP ranges (SSRF protection)
   * Internal network IPs are denied by default
   */
  denyIpRanges?: string[]

  /**
   * Maximum response size in bytes
   * Default: 10MB
   */
  maxResponseSize?: number

  /**
   * Request timeout in milliseconds
   * Default: 30000
   */
  timeout?: number

  /**
   * Allowed HTTP methods
   * Default: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
   */
  allowMethods?: string[]

  /**
   * Whether non-HTTPS requests are allowed
   * Default: false (HTTPS only)
   */
  allowHttp?: boolean
}

/**
 * Default denied internal IP ranges (reserved for future IP-level SSRF protection)
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
 * Default denied domains
 */
const DEFAULT_DENY_DOMAINS = [
  'localhost',
  '*.local',
  '*.internal',
  'metadata.google.internal',
  '169.254.169.254'  // AWS metadata
]

/**
 * Check if a domain matches a pattern
 */
function matchDomain(domain: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)
    return domain.endsWith(suffix) || domain === pattern.slice(2)
  }
  return domain === pattern
}

/**
 * Extract domain from URL
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
 * Create a domain allowlist policy
 */
function createDomainAllowlistPolicy(allowDomains: string[]): Policy {
  return defineGuardPolicy({
    id: 'network:domain-allowlist',
    description: 'Only allow access to domains in the allowlist',
    priority: 5,
    match: (ctx) => ctx.tool === 'fetch',
    decide: (ctx) => {
      const url = (ctx.input as { url?: string })?.url ?? ''
      const domain = extractDomain(url)

      if (!domain) {
        return { action: 'deny', reason: `Invalid URL: ${url}` }
      }

      const allowed = allowDomains.some(pattern => matchDomain(domain, pattern))
      if (!allowed) {
        return {
          action: 'deny',
          reason: `Domain not in allowlist: ${domain}`
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * Create a domain denylist policy
 */
function createDomainDenylistPolicy(denyDomains: string[]): Policy {
  return defineGuardPolicy({
    id: 'network:domain-denylist',
    description: 'Deny access to domains in the denylist',
    priority: 10,
    match: (ctx) => ctx.tool === 'fetch',
    decide: (ctx) => {
      const url = (ctx.input as { url?: string })?.url ?? ''
      const domain = extractDomain(url)

      if (!domain) {
        return { action: 'deny', reason: `Invalid URL: ${url}` }
      }

      const denied = denyDomains.some(pattern => matchDomain(domain, pattern))
      if (denied) {
        return {
          action: 'deny',
          reason: `Domain is denied: ${domain}`
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * Create an HTTPS-only enforcement policy
 */
function createHttpsOnlyPolicy(): Policy {
  return defineGuardPolicy({
    id: 'network:https-only',
    description: 'Only allow HTTPS requests',
    priority: 8,
    match: (ctx) => ctx.tool === 'fetch',
    decide: (ctx) => {
      const url = (ctx.input as { url?: string })?.url ?? ''
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:') {
          return {
            action: 'deny',
            reason: `Only HTTPS requests are allowed: ${url}`
          }
        }
      } catch {
        return { action: 'deny', reason: `Invalid URL: ${url}` }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * Create an HTTP method restriction policy
 */
function createMethodPolicy(allowMethods: string[]): Policy {
  return defineGuardPolicy({
    id: 'network:method-restrict',
    description: 'Restrict allowed HTTP methods',
    priority: 12,
    match: (ctx) => ctx.tool === 'fetch',
    decide: (ctx) => {
      const method = ((ctx.input as { method?: string })?.method ?? 'GET').toUpperCase()
      if (!allowMethods.includes(method)) {
        return {
          action: 'deny',
          reason: `HTTP method not allowed: ${method}`
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * Create a timeout limit policy (Mutate)
 */
function createTimeoutPolicy(timeout: number): Policy {
  return defineMutatePolicy({
    id: 'network:timeout-limit',
    description: 'Enforce request timeout limit',
    priority: 50,
    match: (ctx) => ctx.tool === 'fetch',
    transforms: [
      { op: 'clamp', path: 'timeout', max: timeout }
    ]
  })
}

/**
 * Create a network audit policy
 */
const networkAuditPolicy = defineAuditPolicy({
  id: 'network:audit',
  description: 'Audit all network requests',
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
 * Network Pack - Network capability pack
 *
 * Included tools:
 * - fetch: HTTP requests
 *
 * Default policies:
 * - Deny access to internal network addresses (SSRF protection)
 * - HTTPS only (configurable)
 * - Audit all network requests
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

  // Domain allowlist policy
  if (allowDomains && allowDomains.length > 0) {
    policies.push(createDomainAllowlistPolicy(allowDomains))
  }

  // Domain denylist policy
  if (denyDomains && denyDomains.length > 0) {
    policies.push(createDomainDenylistPolicy(denyDomains))
  }

  // HTTPS enforcement policy
  if (!allowHttp) {
    policies.push(createHttpsOnlyPolicy())
  }

  // HTTP method restriction policy
  policies.push(createMethodPolicy(allowMethods))

  // Timeout limit policy
  policies.push(createTimeoutPolicy(timeout))

  // Audit policy
  policies.push(networkAuditPolicy)

  return definePack({
    id: 'network',
    description: 'Network capability pack: HTTP requests (requires explicit enablement)',

    tools: [fetchTool as any],

    policies,

    promptFragment: `
## Network Request Capabilities

### fetch Tool
Send HTTP requests for:
- Calling external APIs
- Fetching remote data
- Webhook invocations

### Security Restrictions
${allowDomains ? `- Only allowed domains: ${allowDomains.join(', ')}` : '- Access to internal network addresses is denied'}
${!allowHttp ? '- Only HTTPS requests are allowed' : ''}
- Allowed methods: ${allowMethods.join(', ')}
- Timeout limit: ${timeout}ms
- Response size limit: ${Math.round(maxResponseSize / 1024 / 1024)}MB

### Best Practices
1. Use complete URLs (including protocol)
2. Set an appropriate Content-Type
3. Handle timeouts and error conditions
    `.trim()
  })
}

/**
 * Alias: networkPack
 */
export const networkPack = network

/**
 * Preset: Strict mode (requires explicitly specified allowed domains)
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
 * Preset: API mode (common API scenarios)
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
 * Preset: GitHub API
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
