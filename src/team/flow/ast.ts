/**
 * FlowSpec AST - Serializable, Replayable Flow Definitions
 *
 * This AST defines the structure of multi-agent collaboration flows.
 * All types are designed to be JSON-serializable for replay and debugging.
 */

// ============================================================================
// Core Types
// ============================================================================

export type FlowNodeId = string

/**
 * Union type for all flow specifications
 * Phase 1: invoke, seq
 * Phase 2: par, map
 * Phase 3: choose, loop, gate, branch, noop, select
 * Phase 4: race, supervise
 */
export type FlowSpec =
  | InvokeSpec
  | SeqSpec
  | ParSpec
  | MapSpec
  | ChooseSpec
  | LoopSpec
  | GateSpec
  | RaceSpec
  | SuperviseSpec
  | BranchSpec
  | NoopSpec
  | SelectSpec

/**
 * Base specification shared by all flow nodes
 */
export interface BaseSpec {
  /** Node kind discriminator */
  kind: string
  /** Optional unique ID for trace/debug */
  id?: FlowNodeId
  /** Optional human-readable name */
  name?: string
  /** Optional tags for filtering/grouping */
  tags?: string[]
}

// ============================================================================
// Reference Types (for inputs, state, items)
// ============================================================================

/**
 * Reference to input data
 */
export type InputRef =
  | { ref: 'initial' }                    // Initial team input
  | { ref: 'state'; path: string }        // Read from shared state
  | { ref: 'prev' }                       // Output from previous step
  | { ref: 'const'; value: unknown }      // Constant value
  | MappedInputRef                        // Transformed input

/**
 * Mapped input reference with transform function
 */
export interface MappedInputRef {
  ref: 'mapped'
  /** Source input reference */
  source: Exclude<InputRef, MappedInputRef>
  /** Transform function (stored for runtime execution) */
  transform: (input: unknown) => unknown
}

/**
 * Reference to a state location for writing
 */
export type StateRef = { path: string }

/**
 * Reference to a list of items (for map)
 */
export type ItemsRef =
  | { ref: 'state'; path: string }
  | { ref: 'const'; value: unknown[] }

// ============================================================================
// Transfer Specification
// ============================================================================

/**
 * Context transfer mode between agents
 */
export type TransferSpec =
  | { mode: 'minimal' }                                           // Only essential context
  | { mode: 'scoped'; allowNamespaces: string[]; maxBytes?: number }  // Scoped by namespace
  | { mode: 'full' }                                              // Full context (use with caution)

// ============================================================================
// Flow Node Specifications
// ============================================================================

/**
 * Invoke a single agent
 */
export interface InvokeSpec extends BaseSpec {
  kind: 'invoke'
  /** Agent ID to invoke */
  agent: string
  /** Input reference */
  input: InputRef
  /** Context transfer mode */
  transfer?: TransferSpec
  /** Write output to state */
  outputAs?: StateRef
}

/**
 * Sequential execution
 */
export interface SeqSpec extends BaseSpec {
  kind: 'seq'
  /** Steps to execute in order */
  steps: FlowSpec[]
}

/**
 * Parallel execution with join
 */
export interface ParSpec extends BaseSpec {
  kind: 'par'
  /** Branches to execute in parallel */
  branches: FlowSpec[]
  /** How to join results */
  join: JoinSpec
}

/**
 * Map over items with parallel execution
 */
export interface MapSpec extends BaseSpec {
  kind: 'map'
  /** Items to map over */
  items: ItemsRef
  /** Worker flow for each item */
  worker: FlowSpec
  /** How to join results */
  join: JoinSpec
  /** Max concurrent executions */
  concurrency?: number
}

/**
 * Conditional branching
 */
export interface ChooseSpec extends BaseSpec {
  kind: 'choose'
  /** Router to determine branch */
  router: RouterSpec
  /** Named branches */
  branches: Record<string, FlowSpec>
  /** Default branch if no match */
  defaultBranch?: string
}

/**
 * Loop until condition met
 */
export interface LoopSpec extends BaseSpec {
  kind: 'loop'
  /** Body to execute each iteration */
  body: FlowSpec
  /** Stop condition */
  until: UntilSpec
  /** Maximum iterations (required for safety) */
  maxIters: number
}

/**
 * Gate for validation/approval
 */
export interface GateSpec extends BaseSpec {
  kind: 'gate'
  /** Gate rule to evaluate */
  gate: GateRuleSpec
  /** Flow if gate passes */
  onPass: FlowSpec
  /** Flow if gate fails */
  onFail: FlowSpec
}

/**
 * Race multiple flows, first success wins
 */
export interface RaceSpec extends BaseSpec {
  kind: 'race'
  /** Flows to race */
  contenders: FlowSpec[]
  /** How to determine winner */
  winner: WinnerSpec
}

/**
 * Supervisor-managed execution
 */
export interface SuperviseSpec extends BaseSpec {
  kind: 'supervise'
  /** Supervisor agent */
  supervisor: InvokeSpec
  /** Workers to manage */
  workers: FlowSpec
  /** Execution strategy */
  strategy: 'sequential' | 'parallel' | 'dynamic'
  /** How to join results */
  join: JoinSpec
}

/**
 * Binary conditional branching
 * A simpler alternative to ChooseSpec for two-way decisions
 */
export interface BranchSpec extends BaseSpec {
  kind: 'branch'
  /** Condition function to evaluate */
  condition: (state: unknown) => boolean
  /** Flow to execute if condition is true */
  then: FlowSpec
  /** Flow to execute if condition is false */
  else: FlowSpec
}

/**
 * No-operation step
 * Used in conditional branches to skip execution
 */
export interface NoopSpec extends BaseSpec {
  kind: 'noop'
}

/**
 * Multi-way conditional branching based on selector
 * Maps a selector value to one of many branches
 */
export interface SelectSpec extends BaseSpec {
  kind: 'select'
  /** Function to determine which branch to take */
  selector: (state: unknown) => string
  /** Named branches keyed by selector return value */
  branches: Record<string, FlowSpec>
  /** Default branch if selector returns unknown key */
  default?: FlowSpec
}

// ============================================================================
// Join Specification
// ============================================================================

/**
 * Specification for joining parallel results
 */
export interface JoinSpec {
  /** Reducer ID (must be registered) */
  reducerId: string
  /** Arguments for reducer */
  args?: Record<string, unknown>
  /** Write joined output to state */
  outputAs?: StateRef
}

// ============================================================================
// Router Specification
// ============================================================================

/**
 * Router determines which branch to take
 */
export type RouterSpec =
  | RuleRouterSpec
  | LLMRouterSpec

/**
 * Rule-based router
 */
export interface RuleRouterSpec {
  type: 'rule'
  rules: RuleClause[]
}

/**
 * LLM-based router (decisions must be traced)
 */
export interface LLMRouterSpec {
  type: 'llm'
  /** Agent to use for routing */
  agent: string
  /** Prompt input */
  promptRef: InputRef
  /** Key in output that contains the route */
  outputKey: string
}

/**
 * Single routing rule
 */
export interface RuleClause {
  when: PredicateSpec
  route: string
}

// ============================================================================
// Predicate Specification
// ============================================================================

/**
 * Predicate for conditions
 */
export type PredicateSpec =
  | { op: 'eq'; path: string; value: unknown }
  | { op: 'neq'; path: string; value: unknown }
  | { op: 'gt'; path: string; value: number }
  | { op: 'gte'; path: string; value: number }
  | { op: 'lt'; path: string; value: number }
  | { op: 'lte'; path: string; value: number }
  | { op: 'contains'; path: string; value: string }
  | { op: 'regex'; path: string; pattern: string }
  | { op: 'exists'; path: string }
  | { op: 'empty'; path: string }
  | { op: 'and'; clauses: PredicateSpec[] }
  | { op: 'or'; clauses: PredicateSpec[] }
  | { op: 'not'; clause: PredicateSpec }

// ============================================================================
// Until Specification (Loop termination)
// ============================================================================

/**
 * Condition for loop termination
 *
 * Includes both legacy framework conditions and new business-semantic conditions.
 * Business-semantic conditions (field-*, validator, max-iterations) are preferred
 * as they express intent more clearly.
 */
export type UntilSpec =
  // Legacy conditions (for backward compatibility)
  | { type: 'predicate'; predicate: PredicateSpec }
  | { type: 'noCriticalIssues'; path: string }
  | { type: 'noProgress'; windowSize?: number }
  | { type: 'budgetExceeded' }
  // Business-semantic conditions (preferred)
  | { type: 'field-eq'; path: string; value: unknown }
  | { type: 'field-neq'; path: string; value: unknown }
  | { type: 'field-truthy'; path: string }
  | { type: 'field-falsy'; path: string }
  | { type: 'field-compare'; path: string; comparator: 'gt' | 'gte' | 'lt' | 'lte'; value: number }
  | { type: 'validator'; path: string; schema: import('zod').ZodSchema; check: (value: unknown) => boolean }
  | { type: 'max-iterations'; count: number }
  | { type: 'no-progress'; windowSize?: number }
  | { type: 'budget-exceeded' }
  | { type: 'all'; conditions: UntilSpec[] }
  | { type: 'any'; conditions: UntilSpec[] }

// ============================================================================
// Winner Specification (Race)
// ============================================================================

/**
 * How to determine race winner
 */
export type WinnerSpec =
  | { type: 'firstSuccess' }
  | { type: 'firstComplete' }
  | { type: 'highestScore'; path: string }

// ============================================================================
// Gate Rule Specification
// ============================================================================

/**
 * Gate rule for validation/approval
 */
export type GateRuleSpec =
  | { type: 'validator'; validatorId: string; input: InputRef }
  | { type: 'policy'; policyId: string }
  | { type: 'human'; message: string; timeoutSec?: number }
  | { type: 'predicate'; predicate: PredicateSpec }
