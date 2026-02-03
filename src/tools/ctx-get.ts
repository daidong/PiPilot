/**
 * ctx-get - Context retrieval tool
 *
 * Features:
 * - Unified context access via ctx.get(source, params)
 * - Budget feedback: token consumption, cost tier, truncation
 * - Coverage info: completeness, limitations, suggestions
 * - Discovery via meta sources: ctx.catalog, ctx.describe
 * - Dynamic source catalog embedded in schema for better LLM guidance
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import type { ContextSource, ContextResult, CostTier, KindEcho, NextStep } from '../types/context.js'
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
 * Source info for schema generation
 */
export interface SourceInfo {
  id: string
  shortDescription: string
  requiredParams?: string[]
  optionalParams?: string[]
}

/**
 * Estimate token count (simple implementation)
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~3 chars per token (conservative for mixed content)
  return Math.ceil(text.length / 3)
}

/**
 * Extract source info from ContextSource
 */
function extractSourceInfo(source: ContextSource): SourceInfo {
  const requiredParams: string[] = []
  const optionalParams: string[] = []

  if (source.params) {
    for (const param of source.params) {
      if (param.required) {
        requiredParams.push(param.name)
      } else {
        optionalParams.push(param.name)
      }
    }
  }

  return {
    id: source.id,
    shortDescription: source.shortDescription,
    requiredParams: requiredParams.length > 0 ? requiredParams : undefined,
    optionalParams: optionalParams.length > 0 ? optionalParams : undefined
  }
}

/**
 * Generate source catalog description for schema
 */
function generateSourceCatalog(sources: SourceInfo[]): string {
  if (sources.length === 0) {
    return 'No context sources registered'
  }

  const lines: string[] = ['Available sources:']

  for (const source of sources) {
    let line = `- ${source.id}: ${source.shortDescription}`
    if (source.requiredParams && source.requiredParams.length > 0) {
      line += ` (requires: ${source.requiredParams.join(', ')})`
    }
    lines.push(line)
  }

  return lines.join('\n')
}

/**
 * Generate dynamic description based on registered sources
 */
function generateDescription(namespaces: string[], sourceIds: string[]): string {
  const nsListStr = namespaces.length > 0
    ? namespaces.map(ns => `${ns}.*`).join(', ')
    : 'repo.*, session.*'

  const hasCatalog = sourceIds.includes('ctx.catalog')
  const hasDescribe = sourceIds.includes('ctx.describe')
  const discoveryParts: string[] = []
  if (hasCatalog) discoveryParts.push('ctx.catalog (list sources)')
  if (hasDescribe) discoveryParts.push('ctx.describe (source docs)')

  const discoveryStr = discoveryParts.length > 0
    ? ` Discovery: ${discoveryParts.join(', ')}.`
    : ''

  return `Get context from registered sources. Namespaces: ${nsListStr}.${discoveryStr} Workflow: index → search → open.`
}

/**
 * Options for creating ctx-get tool
 */
export interface CreateCtxGetOptions {
  /** Context sources to embed in schema */
  sources?: ContextSource[]
  /** Maximum sources to list in description (default: 15) */
  maxSourcesInDescription?: number
}

/**
 * Create ctx-get tool with embedded source catalog
 *
 * This factory allows creating a ctx-get tool with source information
 * embedded in the schema, helping LLM know available sources and
 * their required parameters upfront.
 *
 * @example
 * ```typescript
 * const ctxGet = createCtxGetTool({
 *   sources: contextManager.getAllSources()
 * })
 * ```
 */
export function createCtxGetTool(options: CreateCtxGetOptions = {}): Tool<CtxGetInput, CtxGetOutput> {
  const { sources = [], maxSourcesInDescription = 15 } = options

  // Extract source info
  const sourceInfos = sources.map(extractSourceInfo)

  // Generate enum values if we have sources
  const sourceEnum = sourceInfos.length > 0
    ? sourceInfos.map(s => s.id)
    : undefined

  // Generate description with embedded catalog
  const sourceIds = sourceInfos.map(s => s.id)
  const namespaces = [...new Set(sourceIds.map(id => id.split('.')[0]!))]
  const baseDescription = generateDescription(namespaces, sourceIds)

  // Add source catalog to description (limited to maxSourcesInDescription)
  const catalogSources = sourceInfos.slice(0, maxSourcesInDescription)
  const sourceCatalog = generateSourceCatalog(catalogSources)
  const hasMore = sourceInfos.length > maxSourcesInDescription

  const hasCatalog = sourceIds.includes('ctx.catalog')
  const truncationHint = hasMore && hasCatalog
    ? `\n\nUse ctx.get("ctx.catalog") for full list.`
    : ''
  const fullDescription = hasMore
    ? `${baseDescription}\n\n## Source Catalog (${catalogSources.length} of ${sourceInfos.length})\n${sourceCatalog}${truncationHint}`
    : `${baseDescription}\n\n## Source Catalog\n${sourceCatalog}`

  return defineTool({
    name: 'ctx-get',
    description: fullDescription,
    activity: {
      formatCall: (a) => {
        const key = (a.source as string) || (a.key as string) || (a.query as string) || ''
        return { label: key ? `Recall: ${key.slice(0, 40)}` : 'Recall memory', icon: 'memory' }
      },
      formatResult: (r, a) => {
        const key = (a?.source as string) || (a?.key as string) || (a?.query as string) || ''
        const data = (r.data as any)
        const value = data?.value || data?.content || data?.rendered
        const keyPart = key ? `"${key.slice(0, 25)}"` : 'memory'
        return { label: value ? `Recalled ${keyPart}` : `${keyPart}: not found`, icon: 'memory' }
      }
    },
    parameters: {
      source: {
        type: 'string',
        description: 'Context source ID. ' + (sourceEnum
          ? `Available: ${sourceEnum.slice(0, 10).join(', ')}${sourceEnum.length > 10 ? ` (+${sourceEnum.length - 10} more)` : ''}`
          : 'No context sources registered'),
        required: true,
        ...(sourceEnum ? { enum: sourceEnum } : {})
      },
      params: {
        type: 'object',
        description: 'Parameters for the source. Check source description for required params.',
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
}

/**
 * Default ctx-get tool (static, no embedded catalog)
 *
 * For better LLM guidance, use createCtxGetTool() with sources.
 */
export const ctxGet: Tool<CtxGetInput, CtxGetOutput> = createCtxGetTool()
