/**
 * Network Access Policies
 *
 * Generates network access policies based on permission declarations
 */

import type { Policy, PolicyContext, GuardDecision } from '../types/policy.js'
import { defineGuardPolicy } from '../factories/define-policy.js'

/**
 * Network policy configuration
 */
export interface NetworkPolicyConfig {
  /** Provider ID (used as policy ID prefix) */
  providerId: string
  /** Allowed domains */
  allowedDomains?: string[]
  /** Denied domains */
  deniedDomains?: string[]
  /** Policy priority */
  priority?: number
}

/**
 * Create a network access policy
 */
export function createNetworkPolicy(config: NetworkPolicyConfig): Policy {
  const { providerId, allowedDomains, deniedDomains, priority = 15 } = config

  return defineGuardPolicy({
    id: `${providerId}.network`,
    description: `Network access control for ${providerId}`,
    priority,
    match: (ctx: PolicyContext) => {
      // Match the fetch tool or network request operations
      return ctx.tool === 'fetch' || ctx.operation === 'fetch'
    },
    decide: (ctx: PolicyContext): GuardDecision => {
      const input = ctx.input as { url?: string } | undefined
      const url = input?.url

      if (!url) {
        return { action: 'allow' }
      }

      // Parse domain
      const domain = extractDomain(url)
      if (!domain) {
        return {
          action: 'deny',
          reason: `[${providerId}] Invalid URL: ${url}`
        }
      }

      // Check if the domain is in the denied list
      if (deniedDomains && matchesDomain(domain, deniedDomains)) {
        return {
          action: 'deny',
          reason: `[${providerId}] Network access denied: ${domain}`
        }
      }

      // If an allow list exists, check if the domain is within allowed scope
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
 * Extract domain from URL
 */
export function extractDomain(url: string): string | null {
  try {
    // Handle relative URLs
    if (url.startsWith('/')) {
      return null
    }

    // Add protocol prefix (if missing)
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
 * Check if a domain matches any pattern
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
 * Match a domain pattern
 *
 * Supported patterns:
 * - Exact match: api.example.com
 * - Wildcard: *.example.com (matches subdomains)
 * - Global wildcard: * (matches all)
 */
function matchDomainPattern(domain: string, pattern: string): boolean {
  // Global wildcard
  if (pattern === '*') {
    return true
  }

  // Exact match
  if (domain === pattern) {
    return true
  }

  // Wildcard match (*.example.com)
  if (pattern.startsWith('*.')) {
    const baseDomain = pattern.slice(2)
    // Match example.com itself
    if (domain === baseDomain) {
      return true
    }
    // Match subdomains like sub.example.com
    if (domain.endsWith('.' + baseDomain)) {
      return true
    }
  }

  // Suffix match (.example.com)
  if (pattern.startsWith('.')) {
    if (domain.endsWith(pattern)) {
      return true
    }
  }

  return false
}

/**
 * Create network access policies from permission declarations
 */
export function createNetworkAccessPolicies(
  providerId: string,
  permissions: { allow?: string[]; deny?: string[] } | undefined,
  priority?: number
): Policy[] {
  if (!permissions) {
    return []
  }

  // If there is only a deny list, create a deny policy
  if (permissions.deny && permissions.deny.length > 0 && !permissions.allow) {
    return [
      createNetworkPolicy({
        providerId,
        deniedDomains: permissions.deny,
        priority
      })
    ]
  }

  // If there is an allow list, create an allow policy
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
