/**
 * session.search - Context source for searching conversation history
 *
 * Searches past messages by keyword query with recency bias.
 * Returns ranked results with snippets and matched keywords.
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { SessionSearchResult } from '../types/session.js'
import { FileMessageStore } from '../core/message-store.js'

export interface SessionSearchParams {
  /** Search query (required) */
  query: string
  /** Maximum results to return (default: 10) */
  k?: number
  /** Recency bias: how much to favor recent messages (default: medium) */
  recencyBias?: 'high' | 'medium' | 'low'
  /** Include tool messages (default: true) */
  includeTools?: boolean
  /** Scope: current session or all sessions (default: current) */
  sessionScope?: 'current' | 'all'
  /** Time range filter */
  timeRange?: {
    from?: string
    to?: string
  }
}

export interface SessionSearchData {
  results: {
    messageId: string
    sessionId: string
    role: string
    snippet: string
    score: number
    timestamp: string
    matchedKeywords: string[]
  }[]
  totalMatches: number
  query: string
}

export const sessionSearch: ContextSource<SessionSearchParams, SessionSearchData> = defineContextSource({
  id: 'session.search',
  kind: 'search',
  description: 'Search conversation history by keywords. Returns ranked results with relevance scores.',
  shortDescription: 'Search conversation history',
  resourceTypes: ['session'],
  params: [
    { name: 'query', type: 'string', required: true, description: 'Search query' },
    { name: 'k', type: 'number', required: false, default: 10, description: 'Max results to return' },
    { name: 'recencyBias', type: 'string', required: false, default: 'medium', description: 'Recency bias level', enum: ['high', 'medium', 'low'] },
    { name: 'includeTools', type: 'boolean', required: false, default: true, description: 'Include tool messages' },
    { name: 'sessionScope', type: 'string', required: false, default: 'current', description: 'Search scope', enum: ['current', 'all'] }
  ],
  examples: [
    { description: 'Search for TypeScript discussions', params: { query: 'typescript' }, resultSummary: 'Messages mentioning TypeScript' },
    { description: 'Find recent API mentions', params: { query: 'api endpoint', recencyBias: 'high' }, resultSummary: 'Recent API discussions' },
    { description: 'Search all sessions', params: { query: 'database', sessionScope: 'all' }, resultSummary: 'Database mentions across sessions' }
  ],
  costTier: 'medium',
  cache: {
    ttlMs: 60 * 1000, // 1 minute
    invalidateOn: ['session:message']
  },
  render: {
    maxTokens: 1500,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<SessionSearchData>> => {
    const startTime = Date.now()

    // Validate required params
    if (!params?.query) {
      return createErrorResult('Missing required field "query"', {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Provide query: ctx.get("session.search", { query: "your search" })',
          'Use ctx.get("session.messages") to see recent messages without search'
        ]
      })
    }

    const messageStore = runtime.messageStore as FileMessageStore | undefined
    if (!messageStore) {
      return createErrorResult('Message store not available. Make sure session-history pack is loaded.', {
        durationMs: Date.now() - startTime
      })
    }

    const k = params.k ?? 10
    const recencyBias = params.recencyBias ?? 'medium'
    const includeTools = params.includeTools ?? true
    const sessionScope = params.sessionScope ?? 'current'

    // Get sessions to search
    let sessionIds: string[] = []

    if (sessionScope === 'current') {
      const currentId = await messageStore.getCurrentSessionId()
      if (!currentId) {
        return createErrorResult('No active session.', {
          durationMs: Date.now() - startTime,
          suggestions: ['Start a new conversation to create a session']
        })
      }
      sessionIds = [currentId]
    } else {
      const sessions = await messageStore.listSessions()
      sessionIds = sessions.map(s => s.id)
    }

    // Search across sessions
    const allResults: SessionSearchResult[] = []

    for (const sessionId of sessionIds) {
      const results = await messageStore.searchWithOptions(sessionId, params.query, {
        limit: k * 2, // Get more to account for merging
        recencyBias,
        includeTools,
        timeRange: params.timeRange
      })
      allResults.push(...results)
    }

    // Sort by score and limit
    allResults.sort((a, b) => b.score - a.score)
    const topResults = allResults.slice(0, k)

    // Transform to output format
    const outputResults = topResults.map(r => ({
      messageId: r.message.id,
      sessionId: r.message.sessionId,
      role: r.message.role,
      snippet: r.snippet,
      score: Math.round(r.score * 100) / 100,
      timestamp: r.message.timestamp,
      matchedKeywords: r.matchedKeywords
    }))

    // Render output
    const lines: string[] = [
      '# Session Search Results',
      '',
      `**Query:** "${params.query}"`,
      `**Found:** ${topResults.length} matches`,
      ''
    ]

    if (topResults.length === 0) {
      lines.push('*No matching messages found.*')
      lines.push('')
      lines.push('**Suggestions:**')
      lines.push('- Try broader search terms')
      lines.push('- Check spelling')
      lines.push('- Use sessionScope: "all" to search all sessions')
    } else {
      lines.push('## Results')
      lines.push('')

      for (let i = 0; i < outputResults.length; i++) {
        const r = outputResults[i]!
        const roleIcon = getRoleIcon(r.role)
        const timestamp = new Date(r.timestamp).toLocaleString()
        const scorePercent = Math.round(r.score * 100)

        lines.push(`### ${i + 1}. ${roleIcon} ${r.role} (${scorePercent}% match)`)
        lines.push('')
        lines.push(`> ${r.snippet}`)
        lines.push('')
        lines.push(`- **Message ID:** ${r.messageId}`)
        lines.push(`- **Time:** ${timestamp}`)
        lines.push(`- **Keywords:** ${r.matchedKeywords.join(', ')}`)
        lines.push('')
      }
    }

    const complete = topResults.length < k

    return createSuccessResult(
      {
        results: outputResults,
        totalMatches: allResults.length,
        query: params.query
      },
      lines.join('\n'),
      {
        provenance: {
          operations: [],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete,
          limitations: complete ? undefined : [`Showing ${k} of ${allResults.length} matches. Increase k to see more.`]
        },
        kindEcho: {
          source: 'session.search',
          kind: 'search',
          paramsUsed: { query: params.query, k, recencyBias }
        },
        next: topResults.length > 0 ? [
          {
            source: 'session.thread',
            params: { anchorMessageId: topResults[0]!.message.id },
            why: 'Get context around top result',
            confidence: 0.8
          }
        ] : undefined
      }
    )
  }
})

function getRoleIcon(role: string): string {
  switch (role) {
    case 'user': return '👤'
    case 'assistant': return '🤖'
    case 'tool': return '🔧'
    case 'system': return '⚙️'
    default: return '📝'
  }
}
