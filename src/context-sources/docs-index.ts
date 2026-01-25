/**
 * docs.index - Context source for document library overview
 *
 * Returns a list of indexed documents without reading content.
 * Use docs.search to find relevant documents, docs.open to read content.
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { DocType } from '../types/docs.js'
import { FileDocsIndexer } from '../core/docs-indexer.js'

export interface DocsIndexParams {
  /** Filter by document type */
  type?: DocType | 'all'
  /** Filter by category (from metadata) */
  category?: string
  /** Filter by tags (from metadata) */
  tags?: string[]
  /** Sort by: modified, title, size */
  sortBy?: 'modified' | 'title' | 'size'
  /** Offset for pagination */
  offset?: number
  /** Maximum documents to return (default: 50) */
  limit?: number
}

export interface DocsIndexData {
  documents: {
    id: string
    path: string
    title: string
    type: DocType
    size: number
    modifiedAt: string
    chunkCount: number
    tags?: string[]
  }[]
  total: number
  stats: {
    totalDocuments: number
    totalChunks: number
    byType: Record<string, number>
  }
}

export const docsIndex: ContextSource<DocsIndexParams, DocsIndexData> = defineContextSource({
  id: 'docs.index',
  kind: 'index',
  description: 'List indexed documents. Returns document metadata without content. Use docs.search to find relevant documents.',
  shortDescription: 'List indexed documents',
  resourceTypes: ['docs'],
  params: [
    { name: 'type', type: 'string', required: false, default: 'all', description: 'Filter by type', enum: ['markdown', 'txt', 'pdf', 'all'] },
    { name: 'category', type: 'string', required: false, description: 'Filter by category' },
    { name: 'tags', type: 'array', required: false, description: 'Filter by tags' },
    { name: 'sortBy', type: 'string', required: false, default: 'modified', description: 'Sort by', enum: ['modified', 'title', 'size'] },
    { name: 'limit', type: 'number', required: false, default: 50, description: 'Max documents to return' },
    { name: 'offset', type: 'number', required: false, default: 0, description: 'Offset for pagination' }
  ],
  examples: [
    { description: 'List all documents', params: {}, resultSummary: 'All indexed documents' },
    { description: 'List markdown files', params: { type: 'markdown' }, resultSummary: 'Markdown documents only' },
    { description: 'List by category', params: { category: 'api' }, resultSummary: 'Documents in API category' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 10 * 60 * 1000, // 10 minutes
    invalidateOn: ['docs:reindex']
  },
  render: {
    maxTokens: 800,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<DocsIndexData>> => {
    const startTime = Date.now()

    // Get indexer
    const indexer = new FileDocsIndexer(runtime.projectPath)
    const index = await indexer.load()

    if (!index) {
      return createErrorResult('No document index found. Run `agent-foundry index-docs` first.', {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Build index: npx agent-foundry index-docs --paths docs',
          'Check if .agent-foundry/docs_index.json exists'
        ]
      })
    }

    let documents = [...index.documents]

    // Filter by type
    if (params?.type && params.type !== 'all') {
      documents = documents.filter(d => d.type === params.type)
    }

    // Filter by category
    if (params?.category) {
      documents = documents.filter(d => d.metadata.category === params.category)
    }

    // Filter by tags
    if (params?.tags && params.tags.length > 0) {
      documents = documents.filter(d => {
        const docTags = d.metadata.tags as string[] | undefined
        return docTags && params.tags!.some(t => docTags.includes(t))
      })
    }

    // Sort
    const sortBy = params?.sortBy ?? 'modified'
    switch (sortBy) {
      case 'modified':
        documents.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
        break
      case 'title':
        documents.sort((a, b) => a.title.localeCompare(b.title))
        break
      case 'size':
        documents.sort((a, b) => b.size - a.size)
        break
    }

    const total = documents.length

    // Pagination
    const offset = params?.offset ?? 0
    const limit = params?.limit ?? 50
    documents = documents.slice(offset, offset + limit)

    // Transform to output format
    const outputDocs = documents.map(d => ({
      id: d.id,
      path: d.path,
      title: d.title,
      type: d.type,
      size: d.size,
      modifiedAt: d.modifiedAt,
      chunkCount: d.chunks.length,
      tags: d.metadata.tags as string[] | undefined
    }))

    // Render output
    const lines: string[] = [
      '# Document Library',
      '',
      `**Total:** ${total} documents`,
      `**Showing:** ${offset + 1} - ${offset + outputDocs.length}`,
      ''
    ]

    if (params?.type || params?.category || params?.tags) {
      lines.push('**Filters:**')
      if (params?.type && params.type !== 'all') {
        lines.push(`- Type: ${params.type}`)
      }
      if (params?.category) {
        lines.push(`- Category: ${params.category}`)
      }
      if (params?.tags?.length) {
        lines.push(`- Tags: ${params.tags.join(', ')}`)
      }
      lines.push('')
    }

    if (outputDocs.length === 0) {
      lines.push('*No documents found.*')
    } else {
      // Group by type
      const byType = new Map<string, typeof outputDocs>()
      for (const doc of outputDocs) {
        const list = byType.get(doc.type) ?? []
        list.push(doc)
        byType.set(doc.type, list)
      }

      for (const [type, docs] of byType) {
        lines.push(`## ${type.toUpperCase()} (${docs.length})`)
        lines.push('')
        lines.push('| Title | Path | Size | Modified |')
        lines.push('|-------|------|------|----------|')

        for (const doc of docs) {
          const sizeKb = Math.round(doc.size / 1024)
          const modified = new Date(doc.modifiedAt).toLocaleDateString()
          lines.push(`| ${doc.title} | ${doc.path} | ${sizeKb}KB | ${modified} |`)
        }
        lines.push('')
      }
    }

    // Stats
    lines.push('## Stats')
    lines.push('')
    lines.push(`- Documents: ${index.stats.totalDocuments}`)
    lines.push(`- Chunks: ${index.stats.totalChunks}`)
    lines.push(`- Types: ${Object.entries(index.stats.byType).map(([t, c]) => `${t}(${c})`).join(', ')}`)

    const complete = offset + outputDocs.length >= total

    return createSuccessResult(
      {
        documents: outputDocs,
        total,
        stats: {
          totalDocuments: index.stats.totalDocuments,
          totalChunks: index.stats.totalChunks,
          byType: index.stats.byType
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
          limitations: complete ? undefined : [`Showing ${outputDocs.length} of ${total}. Use offset/limit to paginate.`]
        },
        kindEcho: {
          source: 'docs.index',
          kind: 'index',
          paramsUsed: { type: params?.type, sortBy, limit, offset }
        },
        next: outputDocs.length > 0 ? [
          {
            source: 'docs.search',
            params: { query: '' },
            why: 'Search for specific content',
            confidence: 0.7
          },
          {
            source: 'docs.open',
            params: { path: outputDocs[0]!.path },
            why: 'Read first document',
            confidence: 0.5
          }
        ] : undefined
      }
    )
  }
})
