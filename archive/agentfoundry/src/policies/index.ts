/**
 * Policies - Built-in policy exports
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
 * All built-in Guard policies
 */
export const builtinGuardPolicies: Policy[] = [
  noDestructive,
  ...noSecretFiles
]

/**
 * All built-in Mutate policies
 */
export const builtinMutatePolicies: Policy[] = [
  ...autoLimitPolicies,
  ...normalizePathsPolicies
]

/**
 * All built-in Observe policies
 */
export const builtinObservePolicies: Policy[] = [
  ...auditPolicies
]

/**
 * All built-in policies
 */
export const builtinPolicies: Policy[] = [
  ...builtinGuardPolicies,
  ...builtinMutatePolicies,
  ...builtinObservePolicies
]

/**
 * Default security policies (recommended to enable)
 */
export const defaultSecurityPolicies: Policy[] = [
  noDestructive,
  ...noSecretFiles
]

/**
 * Get a policy by ID
 */
export function getBuiltinPolicy(id: string): Policy | undefined {
  return builtinPolicies.find(p => p.id === id)
}
