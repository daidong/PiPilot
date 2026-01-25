/**
 * facts.list - Context source for retrieving learned facts
 *
 * Facts are learned preferences, constraints, and knowledge that persist
 * across sessions. They can be confirmed (by user) or inferred (by model).
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { FactConfidence } from '../types/session.js'

export interface FactsListParams {
  /** Filter by topics */
  topics?: string[]
  /** Search query in fact content */
  query?: string
  /** Filter by confidence level (default: all) */
  confidence?: FactConfidence | 'all'
  /** Maximum facts to return (default: 20) */
  limit?: number
}

export interface FactsListData {
  facts: {
    id: string
    content: string
    topics: string[]
    confidence: FactConfidence
    createdAt: string
    provenance: {
      sessionId?: string
      timestamp: string
    }
  }[]
  totalFacts: number
  filters: {
    topics?: string[]
    query?: string
    confidence?: FactConfidence | 'all'
  }
}

export const factsList: ContextSource<FactsListParams, FactsListData> = defineContextSource({
  id: 'facts.list',
  kind: 'index',
  description: 'List learned facts (preferences, constraints, knowledge). Facts persist across sessions.',
  shortDescription: 'List learned facts',
  resourceTypes: ['memory'],
  params: [
    { name: 'topics', type: 'array', required: false, description: 'Filter by topics' },
    { name: 'query', type: 'string', required: false, description: 'Search query in content' },
    { name: 'confidence', type: 'string', required: false, default: 'all', description: 'Filter by confidence', enum: ['confirmed', 'inferred', 'all'] },
    { name: 'limit', type: 'number', required: false, default: 20, description: 'Max facts to return' }
  ],
  examples: [
    { description: 'List all facts', params: {}, resultSummary: 'All learned facts' },
    { description: 'List confirmed preferences', params: { topics: ['preference'], confidence: 'confirmed' }, resultSummary: 'Confirmed preferences' },
    { description: 'Search for coding style', params: { query: 'coding style' }, resultSummary: 'Facts about coding style' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 5 * 60 * 1000, // 5 minutes
    invalidateOn: ['facts:update']
  },
  render: {
    maxTokens: 1000,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<FactsListData>> => {
    const startTime = Date.now()

    const factsStore = runtime.factsDecisionsStore
    if (!factsStore) {
      return createErrorResult('Facts store not available. Make sure session-memory pack is loaded.', {
        durationMs: Date.now() - startTime
      })
    }

    const limit = params?.limit ?? 20

    // Get facts with filters
    const facts = await factsStore.getFacts({
      topics: params?.topics,
      query: params?.query,
      confidence: params?.confidence,
      limit
    })

    // Transform to output format
    const outputFacts = facts.map(f => ({
      id: f.id,
      content: f.content,
      topics: f.topics,
      confidence: f.confidence,
      createdAt: f.createdAt,
      provenance: {
        sessionId: f.provenance.sessionId,
        timestamp: f.provenance.timestamp
      }
    }))

    // Get total count (without limit)
    const allFacts = await factsStore.getFacts({
      topics: params?.topics,
      query: params?.query,
      confidence: params?.confidence
    })

    // Render output
    const lines: string[] = [
      '# Learned Facts',
      '',
      `**Total:** ${allFacts.length} facts`,
      `**Showing:** ${outputFacts.length}`,
      ''
    ]

    if (params?.topics?.length || params?.query || params?.confidence) {
      lines.push('**Filters:**')
      if (params?.topics?.length) {
        lines.push(`- Topics: ${params.topics.join(', ')}`)
      }
      if (params?.query) {
        lines.push(`- Query: "${params.query}"`)
      }
      if (params?.confidence && params.confidence !== 'all') {
        lines.push(`- Confidence: ${params.confidence}`)
      }
      lines.push('')
    }

    if (outputFacts.length === 0) {
      lines.push('*No facts found.*')
      lines.push('')
      lines.push('**Suggestions:**')
      lines.push('- Use `memory-remember` tool to add new facts')
      lines.push('- Try removing filters to see all facts')
    } else {
      // Group by confidence
      const confirmed = outputFacts.filter(f => f.confidence === 'confirmed')
      const inferred = outputFacts.filter(f => f.confidence === 'inferred')

      if (confirmed.length > 0) {
        lines.push('## Confirmed Facts')
        lines.push('')
        for (const fact of confirmed) {
          lines.push(`- **${fact.id}**: ${fact.content}`)
          if (fact.topics.length > 0) {
            lines.push(`  - Topics: ${fact.topics.join(', ')}`)
          }
        }
        lines.push('')
      }

      if (inferred.length > 0) {
        lines.push('## Inferred Facts')
        lines.push('')
        for (const fact of inferred) {
          lines.push(`- **${fact.id}**: ${fact.content}`)
          if (fact.topics.length > 0) {
            lines.push(`  - Topics: ${fact.topics.join(', ')}`)
          }
        }
        lines.push('')
      }
    }

    const complete = outputFacts.length >= allFacts.length

    return createSuccessResult(
      {
        facts: outputFacts,
        totalFacts: allFacts.length,
        filters: {
          topics: params?.topics,
          query: params?.query,
          confidence: params?.confidence
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
          limitations: complete ? undefined : [`Showing ${outputFacts.length} of ${allFacts.length}. Increase limit to see more.`]
        },
        kindEcho: {
          source: 'facts.list',
          kind: 'index',
          paramsUsed: { topics: params?.topics, query: params?.query, confidence: params?.confidence, limit }
        }
      }
    )
  }
})
