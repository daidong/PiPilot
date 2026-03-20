/**
 * Permission-Policy Bridges Module
 *
 * Converts permission and budget declarations from Provider manifests into executable Policies
 */

// Core bridge
export {
  generatePoliciesFromPermissions,
  generatePoliciesFromBudgets,
  generateProviderPolicies,
  PermissionPolicyBridge,
  validatePermissions,
  validateBudgets,
  type PolicyGenerationOptions
} from './permission-policy-bridge.js'

// File policies
export {
  createFileReadPolicy,
  createFileWritePolicy,
  createFileAccessPolicies,
  type FileAccessPolicyConfig
} from './file-policies.js'

// Network policies
export {
  createNetworkPolicy,
  createNetworkAccessPolicies,
  extractDomain,
  matchesDomain,
  type NetworkPolicyConfig
} from './network-policies.js'

// Exec policies
export {
  createExecPolicy,
  createExecAccessPolicies,
  type ExecPolicyConfig
} from './exec-policies.js'

// Budget policies
export {
  createTimeoutPolicy,
  createOutputLimitPolicy,
  createRequestLimitPolicy,
  createBudgetPolicies,
  resetRequestCounter,
  resetAllRequestCounters,
  type TimeoutPolicyConfig,
  type OutputLimitPolicyConfig,
  type RequestLimitPolicyConfig
} from './budget-policies.js'
