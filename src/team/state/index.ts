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

// Typed Blackboard (contract-first state management)
export {
  TypedBlackboard,
  createTypedBlackboard,
  createStatePaths,
  state,
  isTypedStateRef,
  isTypedInitialRef,
  isTypedPrevRef,
  isTypedConstRef,
  isTypedInputRef
} from './typed-blackboard.js'

export type {
  StateSchemaDefinition,
  InferStateType,
  TypedStateRef,
  TypedInitialRef,
  TypedPrevRef,
  TypedConstRef,
  TypedInputRef,
  TypedBlackboardConfig
} from './typed-blackboard.js'
