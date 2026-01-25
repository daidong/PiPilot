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
  InputRef,
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
  invoke,
  seq,
  par,
  map,
  choose,
  loop,
  gate,
  race,
  supervise,
  join,
  input,
  transfer,
  until,
  pred
} from './combinators.js'

export type {
  InvokeOptions,
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
