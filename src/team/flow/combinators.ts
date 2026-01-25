/**
 * Flow Combinators - Build FlowSpec using composable functions
 *
 * These combinators produce serializable FlowSpec AST nodes.
 * Users can compose them to build complex multi-agent workflows.
 */

import type {
  FlowSpec,
  SeqSpec,
  ParSpec,
  MapSpec,
  ChooseSpec,
  LoopSpec,
  GateSpec,
  RaceSpec,
  SuperviseSpec,
  InvokeSpec,
  InputRef,
  StateRef,
  ItemsRef,
  TransferSpec,
  JoinSpec,
  RouterSpec,
  UntilSpec,
  WinnerSpec,
  GateRuleSpec
} from './ast.js'

// ============================================================================
// Invoke Combinator
// ============================================================================

export interface InvokeOptions {
  /** Context transfer mode */
  transfer?: TransferSpec
  /** Write output to state path */
  outputAs?: StateRef
  /** Human-readable name */
  name?: string
  /** Tags for filtering */
  tags?: string[]
}

/**
 * Invoke a single agent
 *
 * @example
 * invoke('researcher', { ref: 'initial' })
 * invoke('drafter', { ref: 'state', path: 'outline' }, { outputAs: { path: 'draft' } })
 */
export function invoke(
  agent: string,
  input: InputRef,
  options?: InvokeOptions
): InvokeSpec {
  return {
    kind: 'invoke',
    agent,
    input,
    transfer: options?.transfer,
    outputAs: options?.outputAs,
    name: options?.name,
    tags: options?.tags
  }
}

// ============================================================================
// Sequential Combinator
// ============================================================================

/**
 * Execute steps in sequence
 *
 * @example
 * seq(
 *   invoke('planner', { ref: 'initial' }),
 *   invoke('executor', { ref: 'prev' }),
 *   invoke('verifier', { ref: 'prev' })
 * )
 */
export function seq(...steps: FlowSpec[]): SeqSpec {
  return {
    kind: 'seq',
    steps
  }
}

// ============================================================================
// Parallel Combinator
// ============================================================================

export interface ParOptions {
  /** Human-readable name */
  name?: string
  /** Tags for filtering */
  tags?: string[]
}

/**
 * Execute branches in parallel, join results
 *
 * @example
 * par(
 *   [
 *     invoke('researcher1', { ref: 'initial' }),
 *     invoke('researcher2', { ref: 'initial' }),
 *   ],
 *   { reducerId: 'merge', outputAs: { path: 'evidence' } }
 * )
 */
export function par(
  branches: FlowSpec[],
  join: JoinSpec,
  options?: ParOptions
): ParSpec {
  return {
    kind: 'par',
    branches,
    join,
    name: options?.name,
    tags: options?.tags
  }
}

// ============================================================================
// Map Combinator
// ============================================================================

export interface MapOptions {
  /** Max concurrent executions */
  concurrency?: number
  /** Human-readable name */
  name?: string
  /** Tags for filtering */
  tags?: string[]
}

/**
 * Map over items with parallel execution
 *
 * @example
 * map(
 *   { ref: 'state', path: 'chapters' },
 *   invoke('reviewer', { ref: 'prev' }),
 *   { reducerId: 'concat', outputAs: { path: 'reviews' } },
 *   { concurrency: 3 }
 * )
 */
export function map(
  items: ItemsRef,
  worker: FlowSpec,
  join: JoinSpec,
  options?: MapOptions
): MapSpec {
  return {
    kind: 'map',
    items,
    worker,
    join,
    concurrency: options?.concurrency,
    name: options?.name,
    tags: options?.tags
  }
}

// ============================================================================
// Choose Combinator
// ============================================================================

export interface ChooseOptions {
  /** Default branch if no rule matches */
  defaultBranch?: string
  /** Human-readable name */
  name?: string
  /** Tags for filtering */
  tags?: string[]
}

/**
 * Conditional branching based on router
 *
 * @example
 * choose(
 *   { type: 'rule', rules: [
 *     { when: { op: 'eq', path: 'type', value: 'bug' }, route: 'bugfix' },
 *     { when: { op: 'eq', path: 'type', value: 'feature' }, route: 'feature' },
 *   ]},
 *   {
 *     bugfix: invoke('bugfixer', { ref: 'prev' }),
 *     feature: invoke('developer', { ref: 'prev' }),
 *   },
 *   { defaultBranch: 'feature' }
 * )
 */
export function choose(
  router: RouterSpec,
  branches: Record<string, FlowSpec>,
  options?: ChooseOptions
): ChooseSpec {
  return {
    kind: 'choose',
    router,
    branches,
    defaultBranch: options?.defaultBranch,
    name: options?.name,
    tags: options?.tags
  }
}

// ============================================================================
// Loop Combinator
// ============================================================================

export interface LoopOptions {
  /** Human-readable name */
  name?: string
  /** Tags for filtering */
  tags?: string[]
}

/**
 * Loop until condition met
 *
 * @example
 * loop(
 *   seq(
 *     invoke('critic', { ref: 'state', path: 'draft' }),
 *     invoke('reviser', { ref: 'prev' })
 *   ),
 *   { type: 'noCriticalIssues', path: 'reviews' },
 *   { maxIters: 3 }
 * )
 */
export function loop(
  body: FlowSpec,
  until: UntilSpec,
  options: { maxIters: number } & LoopOptions
): LoopSpec {
  return {
    kind: 'loop',
    body,
    until,
    maxIters: options.maxIters,
    name: options?.name,
    tags: options?.tags
  }
}

// ============================================================================
// Gate Combinator
// ============================================================================

export interface GateOptions {
  /** Human-readable name */
  name?: string
  /** Tags for filtering */
  tags?: string[]
}

/**
 * Gate for validation/approval before proceeding
 *
 * @example
 * gate(
 *   { type: 'validator', validatorId: 'qualityCheck', input: { ref: 'prev' } },
 *   invoke('publisher', { ref: 'prev' }),  // on pass
 *   invoke('fixer', { ref: 'prev' })       // on fail
 * )
 */
export function gate(
  gateRule: GateRuleSpec,
  onPass: FlowSpec,
  onFail: FlowSpec,
  options?: GateOptions
): GateSpec {
  return {
    kind: 'gate',
    gate: gateRule,
    onPass,
    onFail,
    name: options?.name,
    tags: options?.tags
  }
}

// ============================================================================
// Race Combinator
// ============================================================================

export interface RaceOptions {
  /** Human-readable name */
  name?: string
  /** Tags for filtering */
  tags?: string[]
}

/**
 * Race multiple flows, winner determined by strategy
 *
 * @example
 * race(
 *   [
 *     invoke('fastSearch', { ref: 'initial' }),
 *     invoke('deepSearch', { ref: 'initial' }),
 *   ],
 *   { type: 'firstSuccess' }
 * )
 */
export function race(
  contenders: FlowSpec[],
  winner: WinnerSpec,
  options?: RaceOptions
): RaceSpec {
  return {
    kind: 'race',
    contenders,
    winner,
    name: options?.name,
    tags: options?.tags
  }
}

// ============================================================================
// Supervise Combinator
// ============================================================================

export interface SuperviseOptions {
  /** Human-readable name */
  name?: string
  /** Tags for filtering */
  tags?: string[]
}

/**
 * Supervisor-managed execution
 *
 * @example
 * supervise(
 *   invoke('supervisor', { ref: 'initial' }),
 *   par([
 *     invoke('worker1', { ref: 'prev' }),
 *     invoke('worker2', { ref: 'prev' }),
 *   ], { reducerId: 'merge' }),
 *   { reducerId: 'supervisorMerge' },
 *   'parallel'
 * )
 */
export function supervise(
  supervisor: InvokeSpec,
  workers: FlowSpec,
  join: JoinSpec,
  strategy: 'sequential' | 'parallel' | 'dynamic',
  options?: SuperviseOptions
): SuperviseSpec {
  return {
    kind: 'supervise',
    supervisor,
    workers,
    strategy,
    join,
    name: options?.name,
    tags: options?.tags
  }
}

// ============================================================================
// Helper: Join Spec Builder
// ============================================================================

/**
 * Create a JoinSpec with common defaults
 */
export function join(
  reducerId: string,
  options?: { args?: Record<string, unknown>; outputAs?: StateRef }
): JoinSpec {
  return {
    reducerId,
    args: options?.args,
    outputAs: options?.outputAs
  }
}

// ============================================================================
// Helper: Input Reference Builders
// ============================================================================

export const input = {
  /** Reference to initial team input */
  initial: (): InputRef => ({ ref: 'initial' }),

  /** Reference to previous step output */
  prev: (): InputRef => ({ ref: 'prev' }),

  /** Reference to state at path */
  state: (path: string): InputRef => ({ ref: 'state', path }),

  /** Constant value */
  const: (value: unknown): InputRef => ({ ref: 'const', value })
}

// ============================================================================
// Helper: Transfer Mode Builders
// ============================================================================

export const transfer = {
  /** Minimal context transfer */
  minimal: (): TransferSpec => ({ mode: 'minimal' }),

  /** Scoped context transfer */
  scoped: (allowNamespaces: string[], maxBytes?: number): TransferSpec => ({
    mode: 'scoped',
    allowNamespaces,
    maxBytes
  }),

  /** Full context transfer (use with caution) */
  full: (): TransferSpec => ({ mode: 'full' })
}

// ============================================================================
// Helper: Until Condition Builders
// ============================================================================

export const until = {
  /** Stop when predicate is true */
  predicate: (predicate: import('./ast.js').PredicateSpec): UntilSpec => ({
    type: 'predicate',
    predicate
  }),

  /** Stop when no critical issues remain */
  noCriticalIssues: (path: string): UntilSpec => ({
    type: 'noCriticalIssues',
    path
  }),

  /** Stop when no progress made */
  noProgress: (windowSize?: number): UntilSpec => ({
    type: 'noProgress',
    windowSize
  }),

  /** Stop when budget exceeded */
  budgetExceeded: (): UntilSpec => ({
    type: 'budgetExceeded'
  })
}

// ============================================================================
// Helper: Predicate Builders
// ============================================================================

export const pred = {
  eq: (path: string, value: unknown) => ({ op: 'eq' as const, path, value }),
  neq: (path: string, value: unknown) => ({ op: 'neq' as const, path, value }),
  gt: (path: string, value: number) => ({ op: 'gt' as const, path, value }),
  gte: (path: string, value: number) => ({ op: 'gte' as const, path, value }),
  lt: (path: string, value: number) => ({ op: 'lt' as const, path, value }),
  lte: (path: string, value: number) => ({ op: 'lte' as const, path, value }),
  contains: (path: string, value: string) => ({ op: 'contains' as const, path, value }),
  regex: (path: string, pattern: string) => ({ op: 'regex' as const, path, pattern }),
  exists: (path: string) => ({ op: 'exists' as const, path }),
  empty: (path: string) => ({ op: 'empty' as const, path }),
  and: (...clauses: import('./ast.js').PredicateSpec[]) => ({ op: 'and' as const, clauses }),
  or: (...clauses: import('./ast.js').PredicateSpec[]) => ({ op: 'or' as const, clauses }),
  not: (clause: import('./ast.js').PredicateSpec) => ({ op: 'not' as const, clause })
}
