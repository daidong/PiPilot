/**
 * Permission-Policy Bridge
 *
 * 将 Provider manifest 中的权限声明转换为实际执行的 Policy
 */

import type { Policy } from '../types/policy.js'
import type { ProviderPermissions, ProviderBudgets } from '../types/provider.js'
import { createFileAccessPolicies } from './file-policies.js'
import { createNetworkAccessPolicies } from './network-policies.js'
import { createExecAccessPolicies } from './exec-policies.js'
import { createBudgetPolicies } from './budget-policies.js'

/**
 * 策略生成选项
 */
export interface PolicyGenerationOptions {
  /** Provider ID（用于策略 ID 前缀） */
  providerId: string
  /** 策略优先级基数 */
  basePriority?: number
  /** 是否生成审计策略 */
  generateAudit?: boolean
}

/**
 * 从权限声明生成策略
 */
export function generatePoliciesFromPermissions(
  permissions: ProviderPermissions,
  options: PolicyGenerationOptions
): Policy[] {
  const { providerId, basePriority = 15 } = options
  const policies: Policy[] = []

  // 文件访问策略
  if (permissions.file) {
    policies.push(
      ...createFileAccessPolicies(providerId, permissions.file, basePriority)
    )
  }

  // 网络访问策略
  if (permissions.network) {
    policies.push(
      ...createNetworkAccessPolicies(providerId, permissions.network, basePriority)
    )
  }

  // 命令执行策略
  if (permissions.exec) {
    policies.push(
      ...createExecAccessPolicies(providerId, permissions.exec, basePriority)
    )
  }

  return policies
}

/**
 * 从预算声明生成策略
 */
export function generatePoliciesFromBudgets(
  budgets: ProviderBudgets,
  options: PolicyGenerationOptions
): Policy[] {
  const { providerId, basePriority = 50 } = options

  return createBudgetPolicies(providerId, budgets, basePriority)
}

/**
 * 综合生成所有策略
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
 * 权限策略桥接器类
 *
 * 提供静态方法生成各类策略
 */
export class PermissionPolicyBridge {
  /**
   * 生成文件访问策略
   */
  static fileAccessPolicies(
    permissions: ProviderPermissions['file'],
    providerId: string,
    priority?: number
  ): Policy[] {
    return createFileAccessPolicies(providerId, permissions, priority)
  }

  /**
   * 生成网络访问策略
   */
  static networkAccessPolicies(
    permissions: ProviderPermissions['network'],
    providerId: string,
    priority?: number
  ): Policy[] {
    return createNetworkAccessPolicies(providerId, permissions, priority)
  }

  /**
   * 生成命令执行策略
   */
  static execAccessPolicies(
    permissions: ProviderPermissions['exec'],
    providerId: string,
    priority?: number
  ): Policy[] {
    return createExecAccessPolicies(providerId, permissions, priority)
  }

  /**
   * 生成预算限制策略
   */
  static budgetPolicies(
    budgets: ProviderBudgets,
    providerId: string,
    priority?: number
  ): Policy[] {
    return createBudgetPolicies(providerId, budgets, priority)
  }

  /**
   * 从完整的权限和预算声明生成策略
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
 * 验证权限声明是否有效
 */
export function validatePermissions(
  permissions: ProviderPermissions
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // 验证文件权限
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

  // 验证网络权限
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

  // 验证执行权限
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
 * 验证预算声明是否有效
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
