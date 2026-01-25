/**
 * memory.get - Context source for retrieving a specific memory item
 *
 * Returns a single memory item by namespace and key.
 * Use memory.search for querying multiple items.
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { MemoryNamespace, MemoryItem } from '../types/memory.js'

export interface MemoryGetParams {
  /** Namespace of the item (user, project, session, or custom) */
  namespace: MemoryNamespace
  /** Key within namespace (e.g., "writing.style") */
  key: string
  /** Whether to include deprecated items (default: false) */
  includeDeprecated?: boolean
}

export interface MemoryGetData {
  item: MemoryItem | null
  found: boolean
  fullKey: string
}

export const memoryGet: ContextSource<MemoryGetParams, MemoryGetData> = defineContextSource({
  id: 'memory.get',
  kind: 'get',
  description: 'Get a specific memory item by namespace and key. Returns the stored value and metadata.',
  shortDescription: 'Get memory item by key',
  resourceTypes: ['memory'],
  params: [
    { name: 'namespace', type: 'string', required: true, description: 'Namespace (user, project, session, or custom)' },
    { name: 'key', type: 'string', required: true, description: 'Key within namespace (e.g., "writing.style")' },
    { name: 'includeDeprecated', type: 'boolean', required: false, default: false, description: 'Include deprecated items' }
  ],
  examples: [
    { description: 'Get user preference', params: { namespace: 'user', key: 'code.style' }, resultSummary: 'User code style preference' },
    { description: 'Get project config', params: { namespace: 'project', key: 'db.connection' }, resultSummary: 'Project database config' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 1 * 60 * 1000, // 1 minute
    invalidateOn: ['memory:write']
  },
  render: {
    maxTokens: 500,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<MemoryGetData>> => {
    const startTime = Date.now()

    // Validate required params
    if (!params?.namespace) {
      return createErrorResult('Missing required field "namespace"', {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Provide namespace: ctx.get("memory.get", { namespace: "user", key: "..." })',
          'Valid namespaces: user, project, session, or custom'
        ]
      })
    }

    if (!params?.key) {
      return createErrorResult('Missing required field "key"', {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Provide key: ctx.get("memory.get", { namespace: "...", key: "code.style" })',
          'Use ctx.get("memory.search") to find keys by query'
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

    const fullKey = `${params.namespace}:${params.key}`

    // Get the item
    const item = await memoryStorage.get(params.namespace, params.key)

    // Check if deprecated
    if (item && item.status === 'deprecated' && !params.includeDeprecated) {
      const lines: string[] = [
        `# Memory Item: ${fullKey}`,
        '',
        '**Status:** Deprecated',
        '',
        'This item is marked as deprecated. Use includeDeprecated: true to retrieve it.',
        '',
        `*Deprecation date: ${item.updatedAt}*`
      ]

      return createSuccessResult(
        { item: null, found: true, fullKey },
        lines.join('\n'),
        {
          provenance: {
            operations: [],
            durationMs: Date.now() - startTime
          },
          coverage: {
            complete: true,
            limitations: ['Item is deprecated']
          },
          kindEcho: {
            source: 'memory.get',
            kind: 'get',
            paramsUsed: { namespace: params.namespace, key: params.key }
          }
        }
      )
    }

    if (!item) {
      return createErrorResult(`Memory item not found: ${fullKey}`, {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Check the namespace and key spelling',
          'Use ctx.get("memory.search", { query: "..." }) to find items',
          'Use ctx.get("memory.list") to see available items'
        ]
      })
    }

    // Render output
    const lines: string[] = [
      `# Memory Item: ${fullKey}`,
      ''
    ]

    // Value section
    lines.push('## Value')
    lines.push('')
    if (item.valueText) {
      lines.push(item.valueText)
      lines.push('')
      lines.push('**Raw value:**')
    }
    lines.push('```json')
    lines.push(JSON.stringify(item.value, null, 2))
    lines.push('```')
    lines.push('')

    // Metadata section
    lines.push('## Metadata')
    lines.push('')
    lines.push(`- **Namespace:** ${item.namespace}`)
    lines.push(`- **Key:** ${item.key}`)
    lines.push(`- **Status:** ${item.status}`)
    lines.push(`- **Sensitivity:** ${item.sensitivity}`)
    if (item.tags.length > 0) {
      lines.push(`- **Tags:** ${item.tags.join(', ')}`)
    }
    lines.push(`- **Created:** ${item.createdAt}`)
    lines.push(`- **Updated:** ${item.updatedAt}`)
    if (item.ttlExpiresAt) {
      lines.push(`- **Expires:** ${item.ttlExpiresAt}`)
    }
    lines.push('')

    // Provenance section
    lines.push('## Provenance')
    lines.push('')
    lines.push(`- **Created by:** ${item.provenance.createdBy}`)
    if (item.provenance.sessionId) {
      lines.push(`- **Session:** ${item.provenance.sessionId}`)
    }
    lines.push(`- **Trace ID:** ${item.provenance.traceId}`)

    return createSuccessResult(
      { item, found: true, fullKey },
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
          source: 'memory.get',
          kind: 'get',
          paramsUsed: { namespace: params.namespace, key: params.key }
        }
      }
    )
  }
})
