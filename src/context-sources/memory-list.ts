/**
 * memory.list - Context source for listing memory items
 *
 * Lists memory items with optional filtering by namespace, tags, and status.
 * Use for browsing available memory without a specific search query.
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { MemoryNamespace, MemoryItem, MemoryStatus } from '../types/memory.js'

export interface MemoryListParams {
  /** Filter by namespace */
  namespace?: MemoryNamespace
  /** Filter by tags */
  tags?: string[]
  /** Filter by status (default: active) */
  status?: MemoryStatus | 'all'
  /** Maximum number of results (default: 50) */
  limit?: number
  /** Offset for pagination (default: 0) */
  offset?: number
}

export interface MemoryListData {
  items: MemoryItem[]
  total: number
  offset: number
  limit: number
  filters: {
    namespace?: MemoryNamespace
    tags?: string[]
    status?: MemoryStatus | 'all'
  }
}

export const memoryList: ContextSource<MemoryListParams, MemoryListData> = defineContextSource({
  id: 'memory.list',
  kind: 'index',
  description: 'List memory items with optional filtering. Use for browsing available memory.',
  shortDescription: 'List memory items',
  resourceTypes: ['memory'],
  params: [
    { name: 'namespace', type: 'string', required: false, description: 'Filter by namespace' },
    { name: 'tags', type: 'array', required: false, description: 'Filter by tags' },
    { name: 'status', type: 'string', required: false, default: 'active', description: 'Filter by status: active, deprecated, all', enum: ['active', 'deprecated', 'all'] },
    { name: 'limit', type: 'number', required: false, default: 50, description: 'Max items to return' },
    { name: 'offset', type: 'number', required: false, default: 0, description: 'Offset for pagination' }
  ],
  examples: [
    { description: 'List all active items', params: {}, resultSummary: 'All active memory items' },
    { description: 'List user preferences', params: { namespace: 'user' }, resultSummary: 'User namespace items' },
    { description: 'List items with tag', params: { tags: ['config'] }, resultSummary: 'Items tagged with config' },
    { description: 'List deprecated items', params: { status: 'deprecated' }, resultSummary: 'Deprecated items' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 1 * 60 * 1000, // 1 minute
    invalidateOn: ['memory:write']
  },
  render: {
    maxTokens: 1000,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<MemoryListData>> => {
    const startTime = Date.now()

    // Get memory storage
    const memoryStorage = runtime.memoryStorage
    if (!memoryStorage) {
      return createErrorResult('Memory storage not available. Make sure kv-memory pack is loaded.', {
        durationMs: Date.now() - startTime
      })
    }

    // Execute list
    const limit = params?.limit ?? 50
    const offset = params?.offset ?? 0
    const { items, total } = await memoryStorage.list({
      namespace: params?.namespace,
      tags: params?.tags,
      status: params?.status ?? 'active',
      limit,
      offset
    })

    const filters = {
      namespace: params?.namespace,
      tags: params?.tags,
      status: params?.status
    }

    // Render output
    const lines: string[] = [
      `# Memory Items`,
      '',
      `**Total:** ${total} items`,
      `**Showing:** ${offset + 1} - ${offset + items.length}`,
      ''
    ]

    if (params?.namespace || params?.tags?.length || params?.status) {
      lines.push('**Filters:**')
      if (params?.namespace) {
        lines.push(`- Namespace: ${params.namespace}`)
      }
      if (params?.tags?.length) {
        lines.push(`- Tags: ${params.tags.join(', ')}`)
      }
      if (params?.status) {
        lines.push(`- Status: ${params.status}`)
      }
      lines.push('')
    }

    if (items.length === 0) {
      lines.push('*No items found.*')
      lines.push('')
      if (offset > 0) {
        lines.push('**Suggestion:** Try offset: 0 to see items from the beginning.')
      } else {
        lines.push('**Suggestions:**')
        lines.push('- Use memory-put tool to store new items')
        lines.push('- Check filter settings')
      }
    } else {
      // Group by namespace
      const byNamespace = new Map<string, MemoryItem[]>()
      for (const item of items) {
        const ns = item.namespace
        const list = byNamespace.get(ns) ?? []
        list.push(item)
        byNamespace.set(ns, list)
      }

      for (const [ns, nsItems] of byNamespace) {
        lines.push(`## ${ns}`)
        lines.push('')
        lines.push('| Key | Value Preview | Status | Tags |')
        lines.push('|-----|---------------|--------|------|')

        for (const item of nsItems) {
          // Truncate value preview
          let valuePreview = item.valueText ?? JSON.stringify(item.value)
          if (valuePreview.length > 40) {
            valuePreview = valuePreview.substring(0, 37) + '...'
          }
          valuePreview = valuePreview.replace(/\|/g, '\\|').replace(/\n/g, ' ')

          const tags = item.tags.slice(0, 3).join(', ')
          const status = item.status === 'deprecated' ? '~~active~~' : 'active'

          lines.push(`| ${item.key} | ${valuePreview} | ${status} | ${tags} |`)
        }
        lines.push('')
      }

      // Pagination info
      if (total > offset + items.length) {
        lines.push('---')
        lines.push('')
        lines.push(`*More items available. Use offset: ${offset + limit} to see next page.*`)
      }
    }

    // Get stats
    const stats = await memoryStorage.getStats()
    lines.push('')
    lines.push('## Stats')
    lines.push('')
    lines.push(`- **Total items:** ${stats.totalItems}`)
    const nsNames = Object.keys(stats.byNamespace)
    if (nsNames.length > 0) {
      lines.push(`- **Namespaces:** ${nsNames.map(ns => `${ns}(${stats.byNamespace[ns]})`).join(', ')}`)
    }

    const complete = offset + items.length >= total

    return createSuccessResult(
      {
        items,
        total,
        offset,
        limit,
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
          limitations: complete ? undefined : [`Showing ${items.length} of ${total} items. Use offset/limit to paginate.`]
        },
        kindEcho: {
          source: 'memory.list',
          kind: 'index',
          paramsUsed: { ...filters, limit, offset }
        },
        next: items.length > 0 ? [
          {
            source: 'memory.get',
            params: { namespace: items[0]!.namespace, key: items[0]!.key },
            why: 'Get details of first item',
            confidence: 0.6
          },
          {
            source: 'memory.search',
            params: { query: '' },
            why: 'Search for specific items',
            confidence: 0.5
          }
        ] : undefined
      }
    )
  }
})
