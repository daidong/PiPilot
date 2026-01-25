/**
 * Policies - 内置策略导出
 */

export { noDestructive, requireApprovalForDestructive } from './no-destructive.js'
export {
  noSecretFilesRead,
  noSecretFilesWrite,
  noSecretSearch,
  noSecretFiles
} from './no-secret-files.js'
export {
  autoLimitSql,
  autoLimitGrep,
  autoLimitGlob,
  autoLimitRead,
  autoLimitPolicies
} from './auto-limit.js'
export {
  normalizeReadPaths,
  normalizeWritePaths,
  normalizeGlobPaths,
  normalizePathsPolicies
} from './normalize-paths.js'
export {
  auditAllCalls,
  auditFileWrites,
  auditCommandExecution,
  alertOnErrors,
  alertOnDenied,
  auditPolicies
} from './audit-all.js'

import type { Policy } from '../types/policy.js'
import { noDestructive } from './no-destructive.js'
import { noSecretFiles } from './no-secret-files.js'
import { autoLimitPolicies } from './auto-limit.js'
import { normalizePathsPolicies } from './normalize-paths.js'
import { auditPolicies } from './audit-all.js'

/**
 * 所有内置 Guard 策略
 */
export const builtinGuardPolicies: Policy[] = [
  noDestructive,
  ...noSecretFiles
]

/**
 * 所有内置 Mutate 策略
 */
export const builtinMutatePolicies: Policy[] = [
  ...autoLimitPolicies,
  ...normalizePathsPolicies
]

/**
 * 所有内置 Observe 策略
 */
export const builtinObservePolicies: Policy[] = [
  ...auditPolicies
]

/**
 * 所有内置策略
 */
export const builtinPolicies: Policy[] = [
  ...builtinGuardPolicies,
  ...builtinMutatePolicies,
  ...builtinObservePolicies
]

/**
 * 默认安全策略（推荐启用）
 */
export const defaultSecurityPolicies: Policy[] = [
  noDestructive,
  ...noSecretFiles
]

/**
 * 获取策略 by ID
 */
export function getBuiltinPolicy(id: string): Policy | undefined {
  return builtinPolicies.find(p => p.id === id)
}
