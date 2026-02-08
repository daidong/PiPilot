/**
 * defineContextSource - Context source definition factory
 */

import type {
  ContextSource,
  ContextSourceConfig,
  ContextResult,
  ContextKind,
  Provenance,
  Coverage,
  KindEcho,
  NextStep
} from '../types/context.js'
import type { Runtime } from '../types/runtime.js'
import { classifyError } from '../core/errors.js'
import { RetryBudget, DEFAULT_BUDGET_CONFIG, getStrategy, computeBackoff } from '../core/retry.js'

/**
 * Extract namespace from source ID
 * e.g., 'docs.index' -> 'docs'
 */
function extractNamespace(id: string): string {
  const dotIndex = id.indexOf('.')
  if (dotIndex === -1) {
    throw new Error(`Invalid source ID format: ${id}. Expected 'namespace.name' (e.g., 'docs.index')`)
  }
  return id.substring(0, dotIndex)
}

/**
 * Generate short description from full description
 * Takes first sentence or first 80 characters
 */
function generateShortDescription(description: string): string {
  // Find first sentence
  const firstSentence = description.split(/[.!?]/)[0] ?? description
  if (firstSentence.length <= 80) {
    return firstSentence.trim()
  }
  // Truncate at 80 chars with ellipsis
  return firstSentence.substring(0, 77).trim() + '...'
}

/**
 * Validate source ID format
 */
function validateSourceId(id: string): void {
  const pattern = /^[a-z]+\.[a-z][a-z0-9-]*$/
  if (!pattern.test(id)) {
    throw new Error(
      `Invalid source ID format: ${id}. ` +
      `Expected lowercase 'namespace.name' format (e.g., 'docs.index', 'session.trace')`
    )
  }
}

/**
 * Define a context source
 */
export function defineContextSource<TParams = unknown, TData = unknown>(
  config: ContextSourceConfig<TParams, TData>
): ContextSource<TParams, TData> {
  // Validate required fields
  if (!config.id) {
    throw new Error('Context source id is required')
  }

  validateSourceId(config.id)

  if (!config.kind) {
    throw new Error(`Context source kind is required for ${config.id}. Must be one of: index, search, open, get`)
  }

  const validKinds: ContextKind[] = ['index', 'search', 'open', 'get']
  if (!validKinds.includes(config.kind)) {
    throw new Error(`Invalid kind "${config.kind}" for ${config.id}. Must be one of: ${validKinds.join(', ')}`)
  }

  if (!config.description) {
    throw new Error('Context source description is required')
  }

  if (!config.fetch) {
    throw new Error('Context source fetch function is required')
  }

  if (!config.costTier) {
    throw new Error('Context source costTier is required')
  }

  // Extract namespace from id
  const namespace = extractNamespace(config.id)

  // Generate shortDescription if not provided
  const shortDescription = config.shortDescription ?? generateShortDescription(config.description)

  return {
    id: config.id,
    namespace,
    kind: config.kind,
    description: config.description,
    shortDescription,
    resourceTypes: config.resourceTypes ?? [],
    params: config.params,
    examples: config.examples,
    fetch: config.fetch,
    cache: config.cache,
    costTier: config.costTier,
    render: config.render
  }
}

/**
 * Options for createSuccessResult
 */
export interface SuccessResultOptions {
  provenance?: Partial<Provenance>
  coverage?: Partial<Coverage>
  kindEcho?: KindEcho
  next?: NextStep[]
}

/**
 * Create a successful ContextResult
 */
export function createSuccessResult<T>(
  data: T,
  rendered: string,
  options?: SuccessResultOptions
): ContextResult<T> {
  return {
    success: true,
    data,
    rendered,
    provenance: {
      operations: options?.provenance?.operations ?? [],
      durationMs: options?.provenance?.durationMs ?? 0,
      cached: options?.provenance?.cached ?? false
    },
    coverage: {
      complete: options?.coverage?.complete ?? true,
      limitations: options?.coverage?.limitations,
      suggestions: options?.coverage?.suggestions
    },
    kindEcho: options?.kindEcho,
    next: options?.next
  }
}

/**
 * Options for createErrorResult
 */
export interface ErrorResultOptions {
  durationMs?: number
  kindEcho?: KindEcho
  suggestions?: string[]
}

/**
 * Create a failed ContextResult
 */
export function createErrorResult<T = never>(
  error: string,
  options?: ErrorResultOptions | number
): ContextResult<T> {
  // Support legacy call signature: createErrorResult(error, durationMs)
  const opts: ErrorResultOptions = typeof options === 'number'
    ? { durationMs: options }
    : options ?? {}

  return {
    success: false,
    error,
    rendered: `Error: ${error}`,
    provenance: {
      operations: [],
      durationMs: opts.durationMs ?? 0,
      cached: false
    },
    coverage: {
      complete: false,
      suggestions: opts.suggestions
    },
    kindEcho: opts.kindEcho
  }
}

/**
 * Create a context source with timeout
 */
export function withContextTimeout<TParams, TData>(
  source: ContextSource<TParams, TData>,
  timeoutMs: number
): ContextSource<TParams, TData> {
  return {
    ...source,
    fetch: async (params: TParams, runtime: Runtime): Promise<ContextResult<TData>> => {
      const timeoutPromise = new Promise<ContextResult<TData>>((resolve) => {
        setTimeout(() => {
          resolve(createErrorResult(`Context source ${source.id} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })

      return Promise.race([source.fetch(params, runtime), timeoutPromise])
    }
  }
}

/**
 * Create a context source wrapper with retry support.
 *
 * Uses the structured error system (RFC-005):
 * - Classifies errors to determine retry strategy
 * - Uses RetryBudget to prevent infinite loops
 * - Uses per-category backoff strategies
 *
 * Backwards compatible: accepts (source, maxRetries, delayMs) signature.
 */
export function withContextRetry<TParams, TData>(
  source: ContextSource<TParams, TData>,
  maxRetries: number = 3,
  delayMs: number = 1000
): ContextSource<TParams, TData> {
  return {
    ...source,
    fetch: async (params: TParams, runtime: Runtime): Promise<ContextResult<TData>> => {
      let lastResult: ContextResult<TData> | undefined
      const budget = new RetryBudget(DEFAULT_BUDGET_CONFIG)

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        lastResult = await source.fetch(params, runtime)

        if (lastResult.success) {
          return lastResult
        }

        // Classify the error and check retry budget
        if (attempt < maxRetries) {
          const agentError = classifyError(lastResult.error || 'Context fetch failed')
          agentError.attempt = attempt + 1
          if (!budget.canRetry(agentError.category, agentError.recoverability)) {
            break
          }
          budget.record(agentError.category)

          // Use strategy-appropriate backoff via computeBackoff
          const strategy = getStrategy(agentError.category)
          const backoffDelay = strategy.backoff
            ? computeBackoff(strategy.backoff, attempt)
            : (strategy.backoffMs
              ? strategy.backoffMs * Math.pow(strategy.backoffMultiplier || 2, attempt)
              : delayMs * (attempt + 1))
          await new Promise(resolve => setTimeout(resolve, backoffDelay))
        }
      }

      return lastResult ?? createErrorResult(`Failed after ${maxRetries + 1} attempts`)
    }
  }
}

/**
 * Create a context source with default value
 */
export function withContextDefault<TParams, TData>(
  source: ContextSource<TParams, TData>,
  defaultResult: ContextResult<TData>
): ContextSource<TParams, TData> {
  return {
    ...source,
    fetch: async (params: TParams, runtime: Runtime): Promise<ContextResult<TData>> => {
      try {
        const result = await source.fetch(params, runtime)
        return result.success ? result : defaultResult
      } catch {
        return defaultResult
      }
    }
  }
}

/**
 * Compose multiple context source enhancers
 */
export function composeContextSource<TParams, TData>(
  source: ContextSource<TParams, TData>,
  ...enhancers: Array<(s: ContextSource<TParams, TData>) => ContextSource<TParams, TData>>
): ContextSource<TParams, TData> {
  return enhancers.reduce((s, enhancer) => enhancer(s), source)
}

/**
 * Helper to create KindEcho
 */
export function createKindEcho(
  source: ContextSource,
  params: Record<string, unknown>
): KindEcho {
  return {
    source: source.id,
    kind: source.kind,
    paramsUsed: params
  }
}

/**
 * Helper to create NextStep
 */
export function createNextStep(
  source: string,
  params: Record<string, unknown>,
  why: string,
  confidence?: number
): NextStep {
  return { source, params, why, confidence }
}
