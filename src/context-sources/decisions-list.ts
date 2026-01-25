/**
 * decisions.list - Context source for retrieving decisions
 *
 * Decisions are commitments with lifecycle management:
 * - active: Currently valid
 * - deprecated: No longer valid (with reason)
 * - superseded: Replaced by another decision
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { DecisionStatus } from '../types/session.js'

export interface DecisionsListParams {
  /** Search query in decision content */
  query?: string
  /** Filter by status (default: active) */
  status?: DecisionStatus | 'all'
  /** Maximum decisions to return (default: 20) */
  limit?: number
}

export interface DecisionsListData {
  decisions: {
    id: string
    content: string
    status: DecisionStatus
    supersededBy?: string
    createdAt: string
    deprecatedAt?: string
    deprecationReason?: string
    provenance: {
      sessionId?: string
      timestamp: string
    }
  }[]
  totalDecisions: number
  filters: {
    query?: string
    status?: DecisionStatus | 'all'
  }
}

export const decisionsList: ContextSource<DecisionsListParams, DecisionsListData> = defineContextSource({
  id: 'decisions.list',
  kind: 'index',
  description: 'List decisions and commitments with status tracking. Decisions are never deleted, only deprecated.',
  shortDescription: 'List decisions',
  resourceTypes: ['memory'],
  params: [
    { name: 'query', type: 'string', required: false, description: 'Search query in content' },
    { name: 'status', type: 'string', required: false, default: 'active', description: 'Filter by status', enum: ['active', 'deprecated', 'superseded', 'all'] },
    { name: 'limit', type: 'number', required: false, default: 20, description: 'Max decisions to return' }
  ],
  examples: [
    { description: 'List active decisions', params: {}, resultSummary: 'Active decisions' },
    { description: 'List all decisions', params: { status: 'all' }, resultSummary: 'All decisions including deprecated' },
    { description: 'Search for database decisions', params: { query: 'database' }, resultSummary: 'Decisions about database' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 5 * 60 * 1000, // 5 minutes
    invalidateOn: ['decisions:update']
  },
  render: {
    maxTokens: 1000,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<DecisionsListData>> => {
    const startTime = Date.now()

    const decisionsStore = runtime.factsDecisionsStore
    if (!decisionsStore) {
      return createErrorResult('Decisions store not available. Make sure session-memory pack is loaded.', {
        durationMs: Date.now() - startTime
      })
    }

    const limit = params?.limit ?? 20
    const status = params?.status ?? 'active'

    // Get decisions with filters
    const decisions = await decisionsStore.getDecisions({
      query: params?.query,
      status,
      limit
    })

    // Transform to output format
    const outputDecisions = decisions.map(d => ({
      id: d.id,
      content: d.content,
      status: d.status,
      supersededBy: d.supersededBy,
      createdAt: d.createdAt,
      deprecatedAt: d.deprecatedAt,
      deprecationReason: d.deprecationReason,
      provenance: {
        sessionId: d.provenance.sessionId,
        timestamp: d.provenance.timestamp
      }
    }))

    // Get total count (without limit)
    const allDecisions = await decisionsStore.getDecisions({
      query: params?.query,
      status
    })

    // Render output
    const lines: string[] = [
      '# Decisions',
      '',
      `**Total:** ${allDecisions.length} decisions`,
      `**Showing:** ${outputDecisions.length}`,
      ''
    ]

    if (params?.query || (params?.status && params.status !== 'active')) {
      lines.push('**Filters:**')
      if (params?.query) {
        lines.push(`- Query: "${params.query}"`)
      }
      if (params?.status) {
        lines.push(`- Status: ${params.status}`)
      }
      lines.push('')
    }

    if (outputDecisions.length === 0) {
      lines.push('*No decisions found.*')
      lines.push('')
      lines.push('**Suggestions:**')
      lines.push('- Use `memory-remember` tool to add new decisions')
      lines.push('- Try status: "all" to see deprecated decisions')
    } else {
      // Group by status
      const active = outputDecisions.filter(d => d.status === 'active')
      const deprecated = outputDecisions.filter(d => d.status === 'deprecated')
      const superseded = outputDecisions.filter(d => d.status === 'superseded')

      if (active.length > 0) {
        lines.push('## Active Decisions')
        lines.push('')
        for (const dec of active) {
          lines.push(`- **${dec.id}**: ${dec.content}`)
          lines.push(`  - Created: ${new Date(dec.createdAt).toLocaleDateString()}`)
        }
        lines.push('')
      }

      if (deprecated.length > 0) {
        lines.push('## Deprecated Decisions')
        lines.push('')
        for (const dec of deprecated) {
          lines.push(`- ~~**${dec.id}**: ${dec.content}~~`)
          if (dec.deprecationReason) {
            lines.push(`  - Reason: ${dec.deprecationReason}`)
          }
          if (dec.deprecatedAt) {
            lines.push(`  - Deprecated: ${new Date(dec.deprecatedAt).toLocaleDateString()}`)
          }
        }
        lines.push('')
      }

      if (superseded.length > 0) {
        lines.push('## Superseded Decisions')
        lines.push('')
        for (const dec of superseded) {
          lines.push(`- ~~**${dec.id}**: ${dec.content}~~`)
          if (dec.supersededBy) {
            lines.push(`  - Superseded by: ${dec.supersededBy}`)
          }
          if (dec.deprecationReason) {
            lines.push(`  - Reason: ${dec.deprecationReason}`)
          }
        }
        lines.push('')
      }
    }

    const complete = outputDecisions.length >= allDecisions.length

    return createSuccessResult(
      {
        decisions: outputDecisions,
        totalDecisions: allDecisions.length,
        filters: {
          query: params?.query,
          status: params?.status
        }
      },
      lines.join('\n'),
      {
        provenance: {
          operations: [],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete,
          limitations: complete ? undefined : [`Showing ${outputDecisions.length} of ${allDecisions.length}. Increase limit to see more.`]
        },
        kindEcho: {
          source: 'decisions.list',
          kind: 'index',
          paramsUsed: { query: params?.query, status, limit }
        }
      }
    )
  }
})
