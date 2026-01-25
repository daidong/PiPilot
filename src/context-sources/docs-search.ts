/**
 * docs.search - Context source for searching documents
 *
 * Searches document content by keyword query.
 * Returns ranked results with previews.
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { DocType, DocsSearchMode } from '../types/docs.js'
import { FileDocsIndexer } from '../core/docs-indexer.js'

export interface DocsSearchParams {
  /** Search query (required) */
  query: string
  /** Search mode (default: keyword) */
  mode?: DocsSearchMode
  /** Filter by document type */
  type?: DocType | 'all'
  /** Maximum results (default: 20) */
  limit?: number
  /** Include content preview (default: true) */
  includePreview?: boolean
}

export interface DocsSearchData {
  results: {
    docId: string
    path: string
    title: string
    type: DocType
    score: number
    matchedKeywords: string[]
    matchingChunks: string[]
    preview?: string
  }[]
  total: number
  query: string
}

export const docsSearch: ContextSource<DocsSearchParams, DocsSearchData> = defineContextSource({
  id: 'docs.search',
  kind: 'search',
  description: 'Search documents by keyword query. Returns ranked results with relevance scores.',
  shortDescription: 'Search documents',
  resourceTypes: ['docs'],
  params: [
    { name: 'query', type: 'string', required: true, description: 'Search query' },
    { name: 'mode', type: 'string', required: false, default: 'keyword', description: 'Search mode', enum: ['keyword', 'semantic', 'hybrid'] },
    { name: 'type', type: 'string', required: false, default: 'all', description: 'Filter by type' },
    { name: 'limit', type: 'number', required: false, default: 20, description: 'Max results' },
    { name: 'includePreview', type: 'boolean', required: false, default: true, description: 'Include content preview' }
  ],
  examples: [
    { description: 'Search for API docs', params: { query: 'API authentication' }, resultSummary: 'Documents about API auth' },
    { description: 'Search markdown only', params: { query: 'setup guide', type: 'markdown' }, resultSummary: 'Markdown setup guides' }
  ],
  costTier: 'medium',
  cache: {
    ttlMs: 2 * 60 * 1000, // 2 minutes
    invalidateOn: ['docs:reindex']
  },
  render: {
    maxTokens: 1500,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<DocsSearchData>> => {
    const startTime = Date.now()

    // Validate required params
    if (!params?.query) {
      return createErrorResult('Missing required field "query"', {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Provide query: ctx.get("docs.search", { query: "your search" })',
          'Use ctx.get("docs.index") to browse documents without search'
        ]
      })
    }

    // Get indexer
    const indexer = new FileDocsIndexer(runtime.projectPath)
    const index = await indexer.load()

    if (!index) {
      return createErrorResult('No document index found. Run `agent-foundry index-docs` first.', {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Build index: npx agent-foundry index-docs --paths docs'
        ]
      })
    }

    const limit = params.limit ?? 20
    const includePreview = params.includePreview ?? true

    // Search
    let results = await indexer.search(params.query, limit * 2)

    // Filter by type
    if (params.type && params.type !== 'all') {
      results = results.filter(r => r.document.type === params.type)
    }

    // Limit results
    results = results.slice(0, limit)

    // Build output with previews
    const outputResults: DocsSearchData['results'] = []

    for (const r of results) {
      let preview: string | undefined

      if (includePreview && r.matchingChunks && r.matchingChunks.length > 0) {
        // Read first matching chunk
        const chunkId = r.matchingChunks[0]!
        const chunk = r.document.chunks.find(c => c.id === chunkId)
        if (chunk) {
          const content = await indexer.readContent(r.document.path, chunk.startLine, 5)
          if (content) {
            preview = content.length > 200 ? content.substring(0, 197) + '...' : content
          }
        }
      }

      outputResults.push({
        docId: r.document.id,
        path: r.document.path,
        title: r.document.title,
        type: r.document.type,
        score: Math.round(r.score * 100) / 100,
        matchedKeywords: r.matchedKeywords,
        matchingChunks: r.matchingChunks ?? [],
        preview
      })
    }

    // Render output
    const lines: string[] = [
      '# Document Search Results',
      '',
      `**Query:** "${params.query}"`,
      `**Found:** ${outputResults.length} documents`,
      ''
    ]

    if (outputResults.length === 0) {
      lines.push('*No matching documents found.*')
      lines.push('')
      lines.push('**Suggestions:**')
      lines.push('- Try broader search terms')
      lines.push('- Check spelling')
      lines.push('- Use ctx.get("docs.index") to see available documents')
    } else {
      for (let i = 0; i < outputResults.length; i++) {
        const r = outputResults[i]!
        const scorePercent = Math.round(r.score * 100)

        lines.push(`## ${i + 1}. ${r.title} (${scorePercent}% match)`)
        lines.push('')
        lines.push(`**Path:** ${r.path}`)
        lines.push(`**Type:** ${r.type}`)
        lines.push(`**Keywords:** ${r.matchedKeywords.join(', ')}`)

        if (r.preview) {
          lines.push('')
          lines.push('**Preview:**')
          lines.push('```')
          lines.push(r.preview)
          lines.push('```')
        }
        lines.push('')
      }
    }

    const complete = outputResults.length < limit

    return createSuccessResult(
      {
        results: outputResults,
        total: outputResults.length,
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
          limitations: complete ? undefined : [`Results limited to ${limit}. Increase limit to see more.`]
        },
        kindEcho: {
          source: 'docs.search',
          kind: 'search',
          paramsUsed: { query: params.query, type: params.type, limit }
        },
        next: outputResults.length > 0 ? [
          {
            source: 'docs.open',
            params: { path: outputResults[0]!.path },
            why: 'Read top result',
            confidence: 0.9
          }
        ] : undefined
      }
    )
  }
})
