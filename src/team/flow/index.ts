/**
 * Flow Module Exports
 */

// AST Types
export type {
  FlowSpec,
  FlowNodeId,
  BaseSpec,
  InvokeSpec,
  SeqSpec,
  ParSpec,
  MapSpec,
  ChooseSpec,
  LoopSpec,
  GateSpec,
  RaceSpec,
  SuperviseSpec,
  BranchSpec,
  NoopSpec,
  SelectSpec,
  InputRef,
  MappedInputRef,
  StateRef,
  ItemsRef,
  TransferSpec,
  JoinSpec,
  RouterSpec,
  RuleRouterSpec,
  LLMRouterSpec,
  RuleClause,
  PredicateSpec,
  UntilSpec,
  WinnerSpec,
  GateRuleSpec
} from './ast.js'

// Combinators
export {
  seq,
  par,
  map,
  choose,
  loop,
  gate,
  race,
  supervise,
  join,
  transfer
} from './combinators.js'

// Business-Semantic Until Conditions (preferred)
export {
  until,
  evaluateBusinessUntil,
  isBusinessUntilSpec,
  isFieldUntilSpec,
  isValidatorUntilSpec
} from './until.js'

export type {
  BusinessUntilSpec,
  ExtendedBusinessUntilSpec,
  FieldEqUntilSpec,
  FieldNeqUntilSpec,
  FieldTruthyUntilSpec,
  FieldFalsyUntilSpec,
  FieldCompareUntilSpec,
  ValidatorUntilSpec,
  MaxIterationsUntilSpec,
  NoProgressUntilSpec,
  BudgetExceededUntilSpec,
  AllUntilSpec,
  AnyUntilSpec,
  FieldConditionBuilder,
  UntilEvaluationContext
} from './until.js'

export type {
  ParOptions,
  MapOptions,
  ChooseOptions,
  LoopOptions,
  GateOptions,
  RaceOptions,
  SuperviseOptions
} from './combinators.js'

// Reducers
export {
  ReducerRegistry,
  createReducerRegistry,
  concatReducer,
  mergeReducer,
  deepMergeReducer,
  firstReducer,
  lastReducer,
  collectReducer,
  voteReducer,
  sumReducer,
  avgReducer,
  maxReducer,
  minReducer
} from './reducers.js'

export type {
  ReducerSpec,
  ReducerContext,
  ReducerTraceEvent
} from './reducers.js'

// Executor
export {
  executeFlow
} from './executor.js'

export type {
  ExecutionContext,
  ExecutionResult,
  AgentInvoker,
  TraceRecorder,
  FlowTraceEvent
} from './executor.js'

// Handoff
export {
  isHandoffResult,
  createHandoff,
  parseHandoff,
  executeHandoffChain
} from './handoff.js'

export type {
  HandoffSpec,
  HandoffResult,
  AgentResult,
  HandoffTraceEvent,
  HandoffChainConfig,
  HandoffChainState
} from './handoff.js'

// Edge Combinators (contract-first input transformation)
export {
  mapInput,
  composeMapInput,
  branch,
  noop,
  namedNoop,
  select,
  isMappedInputRef,
  isBranchSpec,
  isNoopSpec,
  isSelectSpec,
  resolveMappedInput,
  passthrough as passthroughTransform,
  pick,
  omit,
  merge as mergeTransform
} from './edges.js'

// Note: edges.ts exports typed versions with generics for API use
// ast.ts exports runtime versions without generics for FlowSpec
export type {
  MappedInputRef as TypedMappedInputRef,
  BranchSpec as TypedBranchSpec,
  NoopSpec as TypedNoopSpec,
  SelectSpec as TypedSelectSpec
} from './edges.js'

// Step Builder (fluent API for flow definition)
export {
  step,
  isTypedInvokeSpec,
  hasSchemaInfo,
  passthrough as passthroughStep,
  pipeline as pipelineSteps
} from './step.js'

export type {
  StepAgent,
  TypedAgent,
  StepInput,
  TypedInvokeSpec,
  StepBuilderWithAgent,
  StepBuilderWithInput
} from './step.js'
