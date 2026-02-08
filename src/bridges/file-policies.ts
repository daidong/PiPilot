/**
 * File Access Policies
 *
 * Generates file access policies based on permission declarations
 */

import type { Policy, PolicyContext, GuardDecision } from '../types/policy.js'
import { defineGuardPolicy } from '../factories/define-policy.js'

/**
 * File policy configuration
 */
export interface FileAccessPolicyConfig {
  /** Provider ID (used as policy ID prefix) */
  providerId: string
  /** Allowed access paths */
  allowedPaths?: string[]
  /** Denied access paths */
  deniedPaths?: string[]
  /** Policy priority */
  priority?: number
}

/**
 * Create a file read policy
 */
export function createFileReadPolicy(config: FileAccessPolicyConfig): Policy {
  const { providerId, allowedPaths, deniedPaths, priority = 15 } = config

  return defineGuardPolicy({
    id: `${providerId}.file.read`,
    description: `File read access control for ${providerId}`,
    priority,
    match: (ctx: PolicyContext) => {
      // Match the read tool or file read operations
      return ctx.tool === 'read' || ctx.operation === 'readFile'
    },
    decide: (ctx: PolicyContext): GuardDecision => {
      const input = ctx.input as { path?: string } | undefined
      const filePath = input?.path

      if (!filePath) {
        return { action: 'allow' }
      }

      // Check if the path is in the denied list
      if (deniedPaths && matchesAnyPattern(filePath, deniedPaths)) {
        return {
          action: 'deny',
          reason: `[${providerId}] File read denied: ${filePath}`
        }
      }

      // If an allow list exists, check if the path is within allowed scope
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
 * Create a file write policy
 */
export function createFileWritePolicy(config: FileAccessPolicyConfig): Policy {
  const { providerId, allowedPaths, deniedPaths, priority = 15 } = config

  return defineGuardPolicy({
    id: `${providerId}.file.write`,
    description: `File write access control for ${providerId}`,
    priority,
    match: (ctx: PolicyContext) => {
      // Match the write/edit tools or file write operations
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

      // Check if the path is in the denied list
      if (deniedPaths && matchesAnyPattern(filePath, deniedPaths)) {
        return {
          action: 'deny',
          reason: `[${providerId}] File write denied: ${filePath}`
        }
      }

      // If an allow list exists, check if the path is within allowed scope
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
 * Check if a path matches any pattern
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
 * Normalize a path
 */
function normalizePath(filePath: string): string {
  // Replace backslashes
  let normalized = filePath.replace(/\\/g, '/')

  // Remove redundant slashes
  normalized = normalized.replace(/\/+/g, '/')

  return normalized
}

/**
 * Match a path pattern
 *
 * Supported patterns:
 * - Exact match: /path/to/file
 * - Directory match: /path/to/ (matches all files under the directory)
 * - Wildcard: *.txt (matches file extensions)
 * - Double star: ** (matches any depth)
 */
function matchPattern(filePath: string, pattern: string): boolean {
  const normalizedPattern = normalizePath(pattern)

  // Exact match
  if (filePath === normalizedPattern) {
    return true
  }

  // Directory match (ends with /)
  if (normalizedPattern.endsWith('/')) {
    return filePath.startsWith(normalizedPattern) ||
           filePath === normalizedPattern.slice(0, -1)
  }

  // Convert glob pattern to regular expression
  const regexPattern = globToRegex(normalizedPattern)
  return regexPattern.test(filePath)
}

/**
 * Convert a glob pattern to a regular expression
 */
function globToRegex(pattern: string): RegExp {
  let regex = pattern
    // Escape special characters
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // ** matches any path
    .replace(/\\\*\\\*/g, '.*')
    // * matches any character except /
    .replace(/\\\*/g, '[^/]*')
    // ? matches a single character
    .replace(/\\\?/g, '[^/]')

  // If the pattern doesn't start with /, allow matching at any position in the path
  if (!pattern.startsWith('/') && !pattern.startsWith('./')) {
    regex = '(^|/)' + regex
  }

  return new RegExp(regex + '$', 'i')
}

/**
 * Create file access policies from permission declarations
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

  // Read policy
  if (permissions.read) {
    policies.push(
      createFileReadPolicy({
        providerId,
        allowedPaths: permissions.read,
        priority
      })
    )
  }

  // Write policy
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
