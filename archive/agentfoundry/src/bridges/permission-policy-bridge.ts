/**
 * Permission-Policy Bridge
 *
 * Converts permission declarations from Provider manifests into executable Policies
 */

import type { Policy } from '../types/policy.js'
import type { ProviderPermissions, ProviderBudgets } from '../types/provider.js'
import { createFileAccessPolicies } from './file-policies.js'
import { createNetworkAccessPolicies } from './network-policies.js'
import { createExecAccessPolicies } from './exec-policies.js'
import { createBudgetPolicies } from './budget-policies.js'

/**
 * Policy generation options
 */
export interface PolicyGenerationOptions {
  /** Provider ID (used as policy ID prefix) */
  providerId: string
  /** Base priority for policies */
  basePriority?: number
  /** Whether to generate audit policies */
  generateAudit?: boolean
}

/**
 * Generate policies from permission declarations
 */
export function generatePoliciesFromPermissions(
  permissions: ProviderPermissions,
  options: PolicyGenerationOptions
): Policy[] {
  const { providerId, basePriority = 15 } = options
  const policies: Policy[] = []

  // File access policies
  if (permissions.file) {
    policies.push(
      ...createFileAccessPolicies(providerId, permissions.file, basePriority)
    )
  }

  // Network access policies
  if (permissions.network) {
    policies.push(
      ...createNetworkAccessPolicies(providerId, permissions.network, basePriority)
    )
  }

  // Command execution policies
  if (permissions.exec) {
    policies.push(
      ...createExecAccessPolicies(providerId, permissions.exec, basePriority)
    )
  }

  return policies
}

/**
 * Generate policies from budget declarations
 */
export function generatePoliciesFromBudgets(
  budgets: ProviderBudgets,
  options: PolicyGenerationOptions
): Policy[] {
  const { providerId, basePriority = 50 } = options

  return createBudgetPolicies(providerId, budgets, basePriority)
}

/**
 * Generate all policies comprehensively
 */
export function generateProviderPolicies(
  permissions: ProviderPermissions | undefined,
  budgets: ProviderBudgets | undefined,
  options: PolicyGenerationOptions
): Policy[] {
  const policies: Policy[] = []

  if (permissions) {
    policies.push(...generatePoliciesFromPermissions(permissions, options))
  }

  if (budgets) {
    policies.push(...generatePoliciesFromBudgets(budgets, options))
  }

  return policies
}

/**
 * Permission-Policy bridge class
 *
 * Provides static methods to generate various policies
 */
export class PermissionPolicyBridge {
  /**
   * Generate file access policies
   */
  static fileAccessPolicies(
    permissions: ProviderPermissions['file'],
    providerId: string,
    priority?: number
  ): Policy[] {
    return createFileAccessPolicies(providerId, permissions, priority)
  }

  /**
   * Generate network access policies
   */
  static networkAccessPolicies(
    permissions: ProviderPermissions['network'],
    providerId: string,
    priority?: number
  ): Policy[] {
    return createNetworkAccessPolicies(providerId, permissions, priority)
  }

  /**
   * Generate command execution policies
   */
  static execAccessPolicies(
    permissions: ProviderPermissions['exec'],
    providerId: string,
    priority?: number
  ): Policy[] {
    return createExecAccessPolicies(providerId, permissions, priority)
  }

  /**
   * Generate budget limit policies
   */
  static budgetPolicies(
    budgets: ProviderBudgets,
    providerId: string,
    priority?: number
  ): Policy[] {
    return createBudgetPolicies(providerId, budgets, priority)
  }

  /**
   * Generate policies from complete permission and budget declarations
   */
  static fromManifest(
    permissions: ProviderPermissions | undefined,
    budgets: ProviderBudgets | undefined,
    providerId: string
  ): Policy[] {
    return generateProviderPolicies(permissions, budgets, { providerId })
  }
}

/**
 * Validate whether permission declarations are valid
 */
export function validatePermissions(
  permissions: ProviderPermissions
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // Validate file permissions
  if (permissions.file) {
    if (permissions.file.read) {
      for (const path of permissions.file.read) {
        if (typeof path !== 'string' || path.length === 0) {
          errors.push(`Invalid file.read path: ${path}`)
        }
      }
    }
    if (permissions.file.write) {
      for (const path of permissions.file.write) {
        if (typeof path !== 'string' || path.length === 0) {
          errors.push(`Invalid file.write path: ${path}`)
        }
      }
    }
  }

  // Validate network permissions
  if (permissions.network) {
    if (permissions.network.allow) {
      for (const domain of permissions.network.allow) {
        if (typeof domain !== 'string' || domain.length === 0) {
          errors.push(`Invalid network.allow domain: ${domain}`)
        }
      }
    }
    if (permissions.network.deny) {
      for (const domain of permissions.network.deny) {
        if (typeof domain !== 'string' || domain.length === 0) {
          errors.push(`Invalid network.deny domain: ${domain}`)
        }
      }
    }
  }

  // Validate exec permissions
  if (permissions.exec) {
    if (permissions.exec.allow) {
      for (const cmd of permissions.exec.allow) {
        if (typeof cmd !== 'string' || cmd.length === 0) {
          errors.push(`Invalid exec.allow command: ${cmd}`)
        }
      }
    }
    if (permissions.exec.deny) {
      for (const cmd of permissions.exec.deny) {
        if (typeof cmd !== 'string' || cmd.length === 0) {
          errors.push(`Invalid exec.deny command: ${cmd}`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Validate whether budget declarations are valid
 */
export function validateBudgets(
  budgets: ProviderBudgets
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (budgets.timeoutMs !== undefined) {
    if (typeof budgets.timeoutMs !== 'number' || budgets.timeoutMs <= 0) {
      errors.push(`Invalid timeoutMs: ${budgets.timeoutMs}`)
    }
  }

  if (budgets.maxOutputBytes !== undefined) {
    if (typeof budgets.maxOutputBytes !== 'number' || budgets.maxOutputBytes <= 0) {
      errors.push(`Invalid maxOutputBytes: ${budgets.maxOutputBytes}`)
    }
  }

  if (budgets.maxRequests !== undefined) {
    if (typeof budgets.maxRequests !== 'number' || budgets.maxRequests <= 0) {
      errors.push(`Invalid maxRequests: ${budgets.maxRequests}`)
    }
  }

  return { valid: errors.length === 0, errors }
}
