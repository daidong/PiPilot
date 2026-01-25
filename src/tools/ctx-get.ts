/**
 * ctx-get - Context retrieval tool
 *
 * Features:
 * - Unified context access via ctx.get(source, params)
 * - Budget feedback: token consumption, cost tier, truncation
 * - Coverage info: completeness, limitations, suggestions
 * - Discovery via meta sources: ctx.catalog, ctx.describe
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import type { ContextResult, CostTier, KindEcho, NextStep } from '../types/context.js'
import { coerceObjectValues } from '../utils/schema-coercion.js'

export interface CtxGetInput {
  source: string
  /** Parameters for the context source */
  params?: Record<string, unknown>
}

export interface CtxGetOutput {
  /** Context source ID */
  source: string
  /** Rendered text (for model consumption) */
  rendered: string
  /** Structured data (for programmatic use) */
  data?: unknown
  /** Budget feedback */
  budget: {
    /** Estimated token count */
    estimatedTokens: number
    /** Cost tier */
    costTier: CostTier
    /** Whether content was truncated */
    truncated: boolean
    /** Whether result was from cache */
    cached: boolean
    /** Execution time in milliseconds */
    durationMs: number
  }
  /** Coverage information */
  coverage: {
    complete: boolean
    limitations?: string[]
    suggestions?: string[]
  }
  /** Echo of what was called */
  kindEcho?: KindEcho
  /** Suggested next steps */
  next?: NextStep[]
}

/**
 * Estimate token count (simple implementation)
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~3 chars per token (conservative for mixed content)
  return Math.ceil(text.length / 3)
}

/**
 * Generate dynamic description based on registered sources
 */
function generateDescription(namespaces: string[]): string {
  const nsListStr = namespaces.length > 0
    ? namespaces.map(ns => `${ns}.*`).join(', ')
    : 'repo.*, session.*'

  return `Get context information from registered sources.

## Available Namespaces
${nsListStr}

## Discovery Sources
- ctx.catalog: List all available sources
- ctx.describe: Get full documentation for a source

## Quick Pattern
1. Unsure which source? Use ctx.get("ctx.catalog")
2. Need params? Use ctx.get("ctx.describe", { id: "source.id" })
3. Standard workflow: index → search → open

## Output
- budget: Token consumption and cost info
- coverage: Completeness and suggestions for next steps
- kindEcho: Confirms what was called
- next: Suggested follow-up actions`
}

export const ctxGet: Tool<CtxGetInput, CtxGetOutput> = defineTool({
  name: 'ctx-get',
  description: generateDescription([]),  // Static fallback, runtime will have actual namespaces
  parameters: {
    source: {
      type: 'string',
      description: 'Context source ID (e.g., repo.index, docs.search, ctx.catalog)',
      required: true
    },
    params: {
      type: 'object',
      description: 'Parameters for the source (shape depends on source kind)',
      required: false
    }
  },
  execute: async (input, { runtime }) => {
    // Coerce string values to their intended types
    // This is needed because OpenAI Responses API requires additionalProperties: { type: 'string' }
    // See: src/utils/schema-coercion.ts for details
    const params = coerceObjectValues(input.params)

    // Get source info for cost tier
    const sourceInfo = runtime.contextManager.getSource?.(input.source)
    const costTier: CostTier = sourceInfo?.costTier ?? 'medium'

    // Execute context fetch
    const result: ContextResult = await runtime.contextManager.get(input.source, params)

    // Handle errors - return rendered error for actionable feedback
    if (!result.success) {
      // Even on error, we include rendered content for the model to understand what went wrong
      // The ContextManager now provides helpful error messages with suggestions
      return {
        success: false,
        error: result.error ?? `Failed to get context from source: ${input.source}`
      }
    }

    const rendered = result.rendered ?? ''
    const estimatedTokens = estimateTokens(rendered)

    const output: CtxGetOutput = {
      source: input.source,
      rendered,
      data: result.data,
      budget: {
        estimatedTokens,
        costTier,
        truncated: !result.coverage.complete,
        cached: result.provenance.cached,
        durationMs: result.provenance.durationMs
      },
      coverage: result.coverage,
      kindEcho: result.kindEcho,
      next: result.next
    }

    return {
      success: true,
      data: output
    }
  }
})
