/**
 * memory.search - Context source for searching memory items
 *
 * Searches memory items by query using keyword matching.
 * Returns ranked results based on relevance score.
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { MemoryNamespace, MemorySensitivity, MemorySearchResult } from '../types/memory.js'

export interface MemorySearchParams {
  /** Search query (required) */
  query: string
  /** Filter by namespace */
  namespace?: MemoryNamespace
  /** Filter by tags */
  tags?: string[]
  /** Filter by sensitivity level (default: excludes 'sensitive') */
  sensitivity?: MemorySensitivity | 'all'
  /** Maximum number of results (default: 20) */
  limit?: number
  /** Include deprecated items (default: false) */
  includeDeprecated?: boolean
}

export interface MemorySearchData {
  results: MemorySearchResult[]
  total: number
  query: string
  filters: {
    namespace?: MemoryNamespace
    tags?: string[]
    sensitivity?: MemorySensitivity | 'all'
  }
}

export const memorySearch: ContextSource<MemorySearchParams, MemorySearchData> = defineContextSource({
  id: 'memory.search',
  kind: 'search',
  description: 'Search memory items by query. Returns ranked results with relevance scores.',
  shortDescription: 'Search memory items',
  resourceTypes: ['memory'],
  params: [
    { name: 'query', type: 'string', required: true, description: 'Search query' },
    { name: 'namespace', type: 'string', required: false, description: 'Filter by namespace' },
    { name: 'tags', type: 'array', required: false, description: 'Filter by tags' },
    { name: 'sensitivity', type: 'string', required: false, default: 'internal', description: 'Filter by sensitivity: public, internal, sensitive, all', enum: ['public', 'internal', 'sensitive', 'all'] },
    { name: 'limit', type: 'number', required: false, default: 20, description: 'Max results to return' },
    { name: 'includeDeprecated', type: 'boolean', required: false, default: false, description: 'Include deprecated items' }
  ],
  examples: [
    { description: 'Search for style preferences', params: { query: 'style preference' }, resultSummary: 'Memory items matching "style preference"' },
    { description: 'Search in user namespace', params: { query: 'config', namespace: 'user' }, resultSummary: 'User config items' },
    { description: 'Search by tag', params: { query: 'database', tags: ['config'] }, resultSummary: 'Database config items' }
  ],
  costTier: 'medium',
  cache: {
    ttlMs: 2 * 60 * 1000, // 2 minutes
    invalidateOn: ['memory:write']
  },
  render: {
    maxTokens: 1500,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<MemorySearchData>> => {
    const startTime = Date.now()

    // Validate required params
    if (!params?.query) {
      return createErrorResult('Missing required field "query"', {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Provide query: ctx.get("memory.search", { query: "your search" })',
          'Use ctx.get("memory.list") to list all items without search'
        ]
      })
    }

    // Get memory storage
    const memoryStorage = runtime.memoryStorage
    if (!memoryStorage) {
      return createErrorResult('Memory storage not available. Make sure kv-memory pack is loaded.', {
        durationMs: Date.now() - startTime
      })
    }

    // Execute search
    const results = await memoryStorage.search(params.query, {
      namespace: params.namespace,
      tags: params.tags,
      sensitivity: params.sensitivity,
      limit: params.limit ?? 20,
      includeDeprecated: params.includeDeprecated
    })

    const filters = {
      namespace: params.namespace,
      tags: params.tags,
      sensitivity: params.sensitivity
    }

    // Render output
    const lines: string[] = [
      `# Memory Search Results`,
      '',
      `**Query:** "${params.query}"`,
      `**Found:** ${results.length} items`,
      ''
    ]

    if (params.namespace || params.tags?.length || params.sensitivity) {
      lines.push('**Filters:**')
      if (params.namespace) {
        lines.push(`- Namespace: ${params.namespace}`)
      }
      if (params.tags?.length) {
        lines.push(`- Tags: ${params.tags.join(', ')}`)
      }
      if (params.sensitivity) {
        lines.push(`- Sensitivity: ${params.sensitivity}`)
      }
      lines.push('')
    }

    if (results.length === 0) {
      lines.push('*No matching items found.*')
      lines.push('')
      lines.push('**Suggestions:**')
      lines.push('- Try broader search terms')
      lines.push('- Check spelling')
      lines.push('- Use ctx.get("memory.list") to see available items')
    } else {
      // Results table
      lines.push('## Results')
      lines.push('')
      lines.push('| # | Key | Value Preview | Score | Tags |')
      lines.push('|---|-----|---------------|-------|------|')

      for (let i = 0; i < results.length; i++) {
        const r = results[i]!
        const item = r.item
        const fullKey = `${item.namespace}:${item.key}`

        // Truncate value preview
        let valuePreview = item.valueText ?? JSON.stringify(item.value)
        if (valuePreview.length > 50) {
          valuePreview = valuePreview.substring(0, 47) + '...'
        }
        valuePreview = valuePreview.replace(/\|/g, '\\|').replace(/\n/g, ' ')

        const tags = item.tags.slice(0, 3).join(', ')
        const scorePercent = Math.round(r.score * 100)

        lines.push(`| ${i + 1} | ${fullKey} | ${valuePreview} | ${scorePercent}% | ${tags} |`)
      }
      lines.push('')

      // Top result detail
      if (results.length > 0) {
        const top = results[0]!
        lines.push('## Top Result Detail')
        lines.push('')
        lines.push(`**Key:** ${top.item.namespace}:${top.item.key}`)
        lines.push('')
        if (top.item.valueText) {
          lines.push(top.item.valueText)
          lines.push('')
        }
        lines.push('```json')
        lines.push(JSON.stringify(top.item.value, null, 2))
        lines.push('```')
        lines.push('')
        lines.push(`**Matched keywords:** ${top.matchedKeywords.join(', ')}`)
      }
    }

    const complete = results.length < (params.limit ?? 20)

    return createSuccessResult(
      {
        results,
        total: results.length,
        query: params.query,
        filters
      },
      lines.join('\n'),
      {
        provenance: {
          operations: [],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete,
          limitations: complete ? undefined : [`Results limited to ${params.limit ?? 20}. Use limit param to get more.`]
        },
        kindEcho: {
          source: 'memory.search',
          kind: 'search',
          paramsUsed: { query: params.query, ...filters, limit: params.limit }
        },
        next: results.length > 0 ? [
          {
            source: 'memory.get',
            params: { namespace: results[0]!.item.namespace, key: results[0]!.item.key },
            why: 'Get full details of top result',
            confidence: 0.8
          }
        ] : undefined
      }
    )
  }
})
