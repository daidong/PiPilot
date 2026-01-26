/**
 * ctx.describe - Meta context source that provides full documentation for a source
 *
 * Returns complete documentation including:
 * - Full description
 * - Parameter schema with types and defaults
 * - Examples with explanations
 * - Common errors and fixes
 * - Related sources and workflow suggestions
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult, ParamSchema, ContextSourceExample } from '../types/context.js'

export interface CtxDescribeParams {
  /** Source ID to describe (required) */
  id: string
}

export interface CtxDescribeData {
  id: string
  namespace: string
  kind: string
  description: string
  params: ParamSchema[]
  examples: ContextSourceExample[]
  commonErrors: { error: string; fix: string }[]
  workflow: string
  relatedSources: string[]
}

/**
 * Generate common errors based on params
 */
function generateCommonErrors(source: ContextSource): { error: string; fix: string }[] {
  const errors: { error: string; fix: string }[] = []

  if (source.params) {
    // Required field errors
    const required = source.params.filter(p => p.required)
    for (const p of required) {
      errors.push({
        error: `Missing required field "${p.name}"`,
        fix: `Add ${p.name} parameter: { "${p.name}": <${p.type}> }`
      })
    }

    // Type errors
    for (const p of source.params.slice(0, 3)) {
      if (p.enum) {
        errors.push({
          error: `Invalid value for "${p.name}"`,
          fix: `Use one of: ${p.enum.map(e => JSON.stringify(e)).join(', ')}`
        })
      }
    }
  }

  // Generic errors
  errors.push({
    error: 'Source not found',
    fix: 'Check spelling. Use ctx.get("ctx.catalog") to list available sources.'
  })

  return errors.slice(0, 5) // Limit to 5 errors
}

/**
 * Generate workflow suggestion based on kind
 */
function generateWorkflow(source: ContextSource, allSources: ContextSource[]): string {
  const ns = source.namespace
  const sameNs = allSources.filter(s => s.namespace === ns && s.id !== source.id)

  const indexSource = sameNs.find(s => s.kind === 'index')
  const searchSource = sameNs.find(s => s.kind === 'search')
  const openSource = sameNs.find(s => s.kind === 'open')

  const steps: string[] = []

  switch (source.kind) {
    case 'index':
      steps.push(`1. Use ${source.id} to get an overview`)
      if (searchSource) {
        steps.push(`2. Use ${searchSource.id} to find specific items`)
      }
      if (openSource) {
        steps.push(`3. Use ${openSource.id} to read details`)
      }
      break

    case 'search':
      if (indexSource) {
        steps.push(`1. (Optional) Use ${indexSource.id} first to understand structure`)
      }
      steps.push(`${indexSource ? '2' : '1'}. Use ${source.id} to find candidates`)
      if (openSource) {
        steps.push(`${indexSource ? '3' : '2'}. Use ${openSource.id} on top results`)
      }
      steps.push('Check coverage.complete - if false, refine query or increase k')
      break

    case 'open':
      if (searchSource) {
        steps.push(`1. First use ${searchSource.id} to find relevant items`)
      }
      steps.push(`${searchSource ? '2' : '1'}. Use ${source.id} to read content`)
      steps.push('Check coverage.complete - if false, use offset/range to read more')
      break

    case 'get':
      steps.push(`1. Use ${source.id} with exact namespace and key`)
      steps.push('If key unknown, use search to find it first')
      break
  }

  return steps.join('\n')
}

/**
 * Find related sources in the same namespace
 */
function findRelatedSources(source: ContextSource, allSources: ContextSource[]): string[] {
  return allSources
    .filter(s => s.namespace === source.namespace && s.id !== source.id)
    .map(s => s.id)
    .slice(0, 5)
}

export const ctxDescribe: ContextSource<CtxDescribeParams, CtxDescribeData> = defineContextSource({
  id: 'ctx.describe',
  kind: 'get',
  description: 'Get full documentation for a context source. Returns schema, examples, common errors, and workflow.',
  shortDescription: 'Get full source documentation',
  resourceTypes: [],
  params: [
    { name: 'id', type: 'string', required: true, description: 'Source ID to describe (e.g., "docs.search")' }
  ],
  examples: [
    { description: 'Describe docs.search', params: { id: 'docs.search' }, resultSummary: 'Full documentation for docs.search' },
    { description: 'Describe docs.open', params: { id: 'docs.open' }, resultSummary: 'Full documentation for docs.open' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 10 * 60 * 1000 // 10 minutes
  },
  render: {
    maxTokens: 1500,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<CtxDescribeData>> => {
    const startTime = Date.now()

    // Validate required param
    if (!params?.id) {
      return createErrorResult('Missing required field "id"', {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Provide source ID: ctx.get("ctx.describe", { id: "docs.search" })',
          'Use ctx.get("ctx.catalog") to list available sources'
        ]
      })
    }

    // Get the source
    const source = runtime.contextManager.getSource(params.id)

    if (!source) {
      // Try to find similar sources
      const similar = runtime.contextManager.findSimilarSources(params.id, 3)

      let errorMsg = `Source "${params.id}" not found.`
      if (similar.length > 0) {
        errorMsg += ` Did you mean: ${similar.join(', ')}?`
      }

      return createErrorResult(errorMsg, {
        durationMs: Date.now() - startTime,
        suggestions: similar.length > 0
          ? [`Try: ctx.get("ctx.describe", { id: "${similar[0]}" })`]
          : ['Use ctx.get("ctx.catalog") to list available sources']
      })
    }

    // Get all sources for context
    const allSources = runtime.contextManager.getAllSources()

    // Build documentation
    const commonErrors = generateCommonErrors(source)
    const workflow = generateWorkflow(source, allSources)
    const relatedSources = findRelatedSources(source, allSources)

    // Render output
    const lines: string[] = [
      `# ${source.id}`,
      '',
      source.description,
      '',
      `**Kind:** ${source.kind}`,
      `**Namespace:** ${source.namespace}`,
      `**Cost:** ${source.costTier}`,
      ''
    ]

    // Parameters section
    lines.push('## Parameters')
    lines.push('')

    if (source.params && source.params.length > 0) {
      lines.push('| Name | Type | Required | Default | Description |')
      lines.push('|------|------|----------|---------|-------------|')
      for (const p of source.params) {
        const required = p.required ? '✓' : ''
        const defaultVal = p.default !== undefined ? JSON.stringify(p.default) : '-'
        let desc = p.description
        if (p.enum) {
          desc += ` (${p.enum.map(e => JSON.stringify(e)).join(' | ')})`
        }
        lines.push(`| ${p.name} | ${p.type} | ${required} | ${defaultVal} | ${desc} |`)
      }
    } else {
      lines.push('No parameters required.')
    }
    lines.push('')

    // Examples section
    lines.push('## Examples')
    lines.push('')

    if (source.examples && source.examples.length > 0) {
      for (let i = 0; i < source.examples.length; i++) {
        const ex = source.examples[i]!
        lines.push(`**${i + 1}. ${ex.description}:**`)
        lines.push('```json')
        lines.push(`ctx.get("${source.id}", ${JSON.stringify(ex.params, null, 2)})`)
        lines.push('```')
        if (ex.resultSummary) {
          lines.push(`→ ${ex.resultSummary}`)
        }
        lines.push('')
      }
    } else {
      lines.push('```json')
      lines.push(`ctx.get("${source.id}")`)
      lines.push('```')
      lines.push('')
    }

    // Common errors section
    lines.push('## Common Errors')
    lines.push('')
    lines.push('| Error | Fix |')
    lines.push('|-------|-----|')
    for (const err of commonErrors) {
      lines.push(`| ${err.error} | ${err.fix} |`)
    }
    lines.push('')

    // Workflow section
    lines.push('## Workflow')
    lines.push('')
    lines.push(workflow)
    lines.push('')

    // Related sources section
    if (relatedSources.length > 0) {
      lines.push('## Related')
      lines.push('')
      lines.push(relatedSources.join(', '))
      lines.push('')
    }

    return createSuccessResult(
      {
        id: source.id,
        namespace: source.namespace,
        kind: source.kind,
        description: source.description,
        params: source.params ?? [],
        examples: source.examples ?? [],
        commonErrors,
        workflow,
        relatedSources
      },
      lines.join('\n'),
      {
        provenance: {
          operations: [],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete: true
        },
        kindEcho: {
          source: 'ctx.describe',
          kind: 'get',
          paramsUsed: { id: params.id }
        }
      }
    )
  }
})
