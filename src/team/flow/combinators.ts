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
  RetrySpec,
  FallbackSpec,
  InvokeSpec,
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
// Sequential Combinator
// ============================================================================

/**
 * Execute steps in sequence
 *
 * @example
 * seq(
 *   step(planner).in(state.initial<Input>()).out(state.path('plan')),
 *   step(executor).in(state.path('plan')).out(state.path('result')),
 *   step(verifier).in(state.path('result'))
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
 *     step(researcher1).in(state.initial<Input>()),
 *     step(researcher2).in(state.initial<Input>()),
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
 *   step(reviewer).in(state.prev<Chapter>()),
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
 *     bugfix: step(bugfixer).in(state.prev()),
 *     feature: step(developer).in(state.prev()),
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
 *     step(critic).in(state.path('draft')).out(state.path('review')),
 *     step(reviser).in(state.path('review')).out(state.path('draft'))
 *   ),
 *   { type: 'field-eq', path: 'review.approved', value: true },
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
 *   step(publisher).in(state.prev()),  // on pass
 *   step(fixer).in(state.prev())       // on fail
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
 *     step(fastSearch).in(state.initial<Query>()),
 *     step(deepSearch).in(state.initial<Query>()),
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
 *   step(supervisor).in(state.initial<Task>()).toSpec(),
 *   par([
 *     step(worker1).in(state.prev()),
 *     step(worker2).in(state.prev()),
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
// Retry Combinator (RFC-005 Phase 3)
// ============================================================================

export interface RetryOptions {
  /** Maximum attempts including the first (default: 3) */
  maxAttempts?: number
  /** Backoff delay in ms between attempts */
  backoffMs?: number
  /** Exponential backoff multiplier (default: 2) */
  backoffMultiplier?: number
  /** Human-readable name */
  name?: string
  /** Tags for filtering */
  tags?: string[]
}

/**
 * Retry a flow step on failure with error feedback.
 *
 * On each failure, the error is classified and scoped feedback
 * is written to the step's state path `{stepId}._errorFeedback`.
 * On success, the feedback is cleaned up.
 *
 * @example
 * retry(
 *   step(executor).in(state.path('plan')).out(state.path('result')),
 *   { maxAttempts: 3 }
 * )
 */
export function retry(
  inner: FlowSpec,
  options?: RetryOptions
): RetrySpec {
  return {
    kind: 'retry',
    inner,
    maxAttempts: options?.maxAttempts ?? 3,
    backoffMs: options?.backoffMs,
    backoffMultiplier: options?.backoffMultiplier,
    name: options?.name,
    tags: options?.tags
  }
}

// ============================================================================
// Fallback Combinator (RFC-005 Phase 3)
// ============================================================================

export interface FallbackOptions {
  /** Human-readable name */
  name?: string
  /** Tags for filtering */
  tags?: string[]
}

/**
 * Try primary flow first; if it fails, execute fallback flow.
 *
 * @example
 * fallback(
 *   step(primaryAnalyzer).in(state.initial()).out(state.path('result')),
 *   step(simpleAnalyzer).in(state.initial()).out(state.path('result'))
 * )
 */
export function fallback(
  primary: FlowSpec,
  fallbackFlow: FlowSpec,
  options?: FallbackOptions
): FallbackSpec {
  return {
    kind: 'fallback',
    primary,
    fallback: fallbackFlow,
    name: options?.name,
    tags: options?.tags
  }
}

