/**
 * Reducer Registry - Deterministic Join Functions
 *
 * Reducers combine parallel execution results into a single output.
 * All reducers MUST be:
 * 1. Deterministic: same inputs + args => same output
 * 2. Pure: no side effects, no IO
 * 3. Sorted: inputs are sorted by stable key before applying
 */

import { createHash } from 'node:crypto'

// ============================================================================
// Types
// ============================================================================

/**
 * Context provided to reducer functions
 */
export interface ReducerContext {
  /** Flow node ID */
  nodeId: string
  /** Team run ID */
  runId: string
  /** Trace recorder */
  trace: {
    record: (event: ReducerTraceEvent) => void
  }
}

/**
 * Trace event for reducer operations
 */
export interface ReducerTraceEvent {
  type: 'reducer.apply'
  runId: string
  nodeId: string
  reducerId: string
  ts: number
  args?: Record<string, unknown>
  inputDigests: string[]
  outputDigest: string
}

/**
 * Reducer specification
 */
export interface ReducerSpec {
  /** Unique reducer ID */
  id: string
  /** Human-readable description */
  description: string
  /** Must always be true - enforces determinism contract */
  deterministic: true
  /** Apply function - MUST be pure */
  apply: (inputs: unknown[], args: Record<string, unknown> | undefined, ctx: ReducerContext) => unknown
  /** Optional: custom sort key for inputs */
  sortKey?: (input: unknown) => string
  /** Optional: custom digest function */
  digest?: (value: unknown) => string
  /** Optional: fallback reducer if this one fails */
  fallbackReducerId?: string
}

// ============================================================================
// Reducer Registry
// ============================================================================

/**
 * Registry for reducers
 */
export class ReducerRegistry {
  private reducers = new Map<string, ReducerSpec>()

  /**
   * Register a reducer
   */
  register(reducer: ReducerSpec): void {
    if (this.reducers.has(reducer.id)) {
      throw new Error(`Reducer already registered: ${reducer.id}`)
    }
    this.reducers.set(reducer.id, reducer)
  }

  /**
   * Get a reducer by ID
   */
  get(id: string): ReducerSpec | undefined {
    return this.reducers.get(id)
  }

  /**
   * Check if reducer exists
   */
  has(id: string): boolean {
    return this.reducers.has(id)
  }

  /**
   * List all reducer IDs
   */
  list(): string[] {
    return Array.from(this.reducers.keys())
  }

  /**
   * Apply a reducer with full tracing
   */
  apply(
    reducerId: string,
    inputs: unknown[],
    args: Record<string, unknown> | undefined,
    ctx: ReducerContext
  ): unknown {
    const reducer = this.reducers.get(reducerId)
    if (!reducer) {
      throw new Error(`Reducer not found: ${reducerId}`)
    }

    // Sort inputs by stable key for determinism
    const sortKey = reducer.sortKey ?? defaultSortKey
    const sortedInputs = [...inputs].sort((a, b) => {
      const keyA = sortKey(a)
      const keyB = sortKey(b)
      return keyA.localeCompare(keyB)
    })

    // Calculate input digests
    const digestFn = reducer.digest ?? defaultDigest
    const inputDigests = sortedInputs.map(input => digestFn(input))

    // Apply reducer
    const output = reducer.apply(sortedInputs, args, ctx)

    // Calculate output digest
    const outputDigest = digestFn(output)

    // Record trace event
    ctx.trace.record({
      type: 'reducer.apply',
      runId: ctx.runId,
      nodeId: ctx.nodeId,
      reducerId,
      ts: Date.now(),
      args,
      inputDigests,
      outputDigest
    })

    return output
  }
}

// ============================================================================
// Default Functions
// ============================================================================

/**
 * Default sort key: JSON stable stringify
 */
function defaultSortKey(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort())
}

/**
 * Default digest: SHA256 of JSON
 */
function defaultDigest(value: unknown): string {
  const json = JSON.stringify(value, Object.keys(value as object).sort())
  return createHash('sha256').update(json).digest('hex').slice(0, 16)
}

// ============================================================================
// Built-in Reducers
// ============================================================================

/**
 * Concatenate arrays from all inputs
 */
export const concatReducer: ReducerSpec = {
  id: 'concat',
  description: 'Concatenate arrays from all inputs',
  deterministic: true,
  apply: (inputs) => (inputs as unknown[][]).flat()
}

/**
 * Merge objects (later inputs override earlier)
 */
export const mergeReducer: ReducerSpec = {
  id: 'merge',
  description: 'Merge objects, later inputs override earlier',
  deterministic: true,
  apply: (inputs) => Object.assign({}, ...(inputs as Record<string, unknown>[]))
}

/**
 * Deep merge objects
 */
export const deepMergeReducer: ReducerSpec = {
  id: 'deepMerge',
  description: 'Deep merge objects recursively',
  deterministic: true,
  apply: (inputs) => {
    const result: Record<string, unknown> = {}
    for (const input of inputs as Record<string, unknown>[]) {
      deepMergeInto(result, input)
    }
    return result
  }
}

function deepMergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const sourceVal = source[key]
    const targetVal = target[key]
    if (
      typeof sourceVal === 'object' &&
      sourceVal !== null &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === 'object' &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      deepMergeInto(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>)
    } else {
      target[key] = sourceVal
    }
  }
}

/**
 * Return first input
 */
export const firstReducer: ReducerSpec = {
  id: 'first',
  description: 'Return the first input',
  deterministic: true,
  apply: (inputs) => inputs[0]
}

/**
 * Return last input
 */
export const lastReducer: ReducerSpec = {
  id: 'last',
  description: 'Return the last input',
  deterministic: true,
  apply: (inputs) => inputs[inputs.length - 1]
}

/**
 * Collect all inputs into array
 */
export const collectReducer: ReducerSpec = {
  id: 'collect',
  description: 'Collect all inputs into an array',
  deterministic: true,
  apply: (inputs) => inputs
}

/**
 * Majority vote (for discrete values)
 */
export const voteReducer: ReducerSpec = {
  id: 'vote',
  description: 'Majority vote among inputs',
  deterministic: true,
  apply: (inputs) => {
    const counts = new Map<string, { value: unknown; count: number }>()
    for (const input of inputs) {
      const key = JSON.stringify(input)
      const existing = counts.get(key)
      if (existing) {
        existing.count++
      } else {
        counts.set(key, { value: input, count: 1 })
      }
    }

    let maxCount = 0
    let winner: unknown = inputs[0]
    for (const { value, count } of counts.values()) {
      if (count > maxCount) {
        maxCount = count
        winner = value
      }
    }
    return winner
  }
}

/**
 * Sum numbers
 */
export const sumReducer: ReducerSpec = {
  id: 'sum',
  description: 'Sum all numeric inputs',
  deterministic: true,
  apply: (inputs) => (inputs as number[]).reduce((a, b) => a + b, 0)
}

/**
 * Average numbers
 */
export const avgReducer: ReducerSpec = {
  id: 'avg',
  description: 'Average all numeric inputs',
  deterministic: true,
  apply: (inputs) => {
    const nums = inputs as number[]
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
  }
}

/**
 * Max number
 */
export const maxReducer: ReducerSpec = {
  id: 'max',
  description: 'Maximum of all numeric inputs',
  deterministic: true,
  apply: (inputs) => Math.max(...(inputs as number[]))
}

/**
 * Min number
 */
export const minReducer: ReducerSpec = {
  id: 'min',
  description: 'Minimum of all numeric inputs',
  deterministic: true,
  apply: (inputs) => Math.min(...(inputs as number[]))
}

// ============================================================================
// Create Default Registry
// ============================================================================

/**
 * Create a registry with built-in reducers
 */
export function createReducerRegistry(): ReducerRegistry {
  const registry = new ReducerRegistry()

  // Register built-in reducers
  registry.register(concatReducer)
  registry.register(mergeReducer)
  registry.register(deepMergeReducer)
  registry.register(firstReducer)
  registry.register(lastReducer)
  registry.register(collectReducer)
  registry.register(voteReducer)
  registry.register(sumReducer)
  registry.register(avgReducer)
  registry.register(maxReducer)
  registry.register(minReducer)

  return registry
}
