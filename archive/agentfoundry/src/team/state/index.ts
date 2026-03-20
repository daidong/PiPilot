/**
 * State Module Exports
 */

export {
  Blackboard,
  createBlackboard,
  getNestedPath
} from './blackboard.js'

export type {
  BlackboardConfig,
  StateEntry,
  StateTraceEvent,
  StateTraceContext
} from './blackboard.js'

// Namespaced Context (multi-agent isolation)
export {
  NamespacedContext,
  NamespaceAccessor,
  createNamespacedContext,
  AccessDeniedError
} from './namespaced-context.js'

export type {
  Namespace,
  NamespacedContextConfig,
  WriteOptions,
  NamespacedEntry
} from './namespaced-context.js'

// Context Permissions
export {
  ContextPermissions,
  createContextPermissions,
  WILDCARD_AGENT
} from './context-permissions.js'

export type {
  Permission,
  PermissionCheckResult
} from './context-permissions.js'

// Conflict Resolver
export {
  ConflictResolver,
  createConflictResolver,
  createLastWriteWinsResolver,
  createMergeResolver,
  createRejectResolver,
  createCustomResolver,
  WriteConflictError
} from './conflict-resolver.js'

export type {
  ConflictStrategy,
  ConflictMeta,
  CustomResolverFn,
  ConflictResolverConfig,
  ConflictResolutionResult
} from './conflict-resolver.js'

// Isolated Blackboard (Blackboard-compatible wrapper for NamespacedContext)
export {
  IsolatedBlackboard,
  createIsolatedBlackboard,
  isIsolatedBlackboard,
  SYSTEM_AGENT
} from './isolated-blackboard.js'

export type {
  IsolatedBlackboardConfig,
  IsolatedState
} from './isolated-blackboard.js'
