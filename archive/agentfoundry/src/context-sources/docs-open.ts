/**
 * docs.open - Context source for reading document content
 *
 * Reads document content with optional chunk selection.
 * Supports line range and includes document outline.
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { DocOutlineEntry } from '../types/docs.js'
import { FileDocsIndexer } from '../core/docs-indexer.js'

export interface DocsOpenParams {
  /** Document path (required) */
  path: string
  /** Specific chunk ID to read */
  chunkId?: string
  /** Start line (default: 1) */
  startLine?: number
  /** Maximum lines to read (default: 150) */
  lineLimit?: number
  /** Include document outline (default: false) */
  includeOutline?: boolean
  /** Include document metadata (default: false) */
  includeMeta?: boolean
}

export interface DocsOpenData {
  path: string
  title: string
  content: string
  startLine: number
  endLine: number
  totalLines: number
  outline?: DocOutlineEntry[]
  metadata?: Record<string, unknown>
}

export const docsOpen: ContextSource<DocsOpenParams, DocsOpenData> = defineContextSource({
  id: 'docs.open',
  kind: 'open',
  description: 'Read document content. Supports reading by chunk or line range.',
  shortDescription: 'Read document content',
  resourceTypes: ['docs'],
  params: [
    { name: 'path', type: 'string', required: true, description: 'Document path' },
    { name: 'chunkId', type: 'string', required: false, description: 'Specific chunk to read' },
    { name: 'startLine', type: 'number', required: false, default: 1, description: 'Start line' },
    { name: 'lineLimit', type: 'number', required: false, default: 150, description: 'Max lines to read' },
    { name: 'includeOutline', type: 'boolean', required: false, default: false, description: 'Include outline' },
    { name: 'includeMeta', type: 'boolean', required: false, default: false, description: 'Include metadata' }
  ],
  examples: [
    { description: 'Read document', params: { path: 'docs/guide.md' }, resultSummary: 'First 150 lines of guide.md' },
    { description: 'Read specific chunk', params: { path: 'docs/api.md', chunkId: 'doc_xxx_chunk_002' }, resultSummary: 'Chunk content' },
    { description: 'Read with outline', params: { path: 'docs/guide.md', includeOutline: true }, resultSummary: 'Content with outline' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 60 * 1000, // 1 minute
    invalidateOn: ['file:write', 'docs:reindex']
  },
  render: {
    maxTokens: 3000,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<DocsOpenData>> => {
    const startTime = Date.now()

    // Validate required params
    if (!params?.path) {
      return createErrorResult('Missing required field "path"', {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Provide path: ctx.get("docs.open", { path: "docs/guide.md" })',
          'Use ctx.get("docs.index") to list available documents'
        ]
      })
    }

    // Get indexer
    const indexer = new FileDocsIndexer(runtime.projectPath)
    const doc = await indexer.getDocument(params.path)

    if (!doc) {
      // Try to read file directly even without index
      const content = await indexer.readContent(params.path, params.startLine ?? 1, params.lineLimit ?? 150)

      if (!content) {
        return createErrorResult(`Document not found: ${params.path}`, {
          durationMs: Date.now() - startTime,
          suggestions: [
            'Check the path spelling',
            'Use ctx.get("docs.index") to list available documents',
            'Run `agent-foundry index-docs` to rebuild index'
          ]
        })
      }

      // Return content without index metadata
      const lines = content.split('\n')
      return createSuccessResult(
        {
          path: params.path,
          title: params.path.split('/').pop() ?? params.path,
          content,
          startLine: params.startLine ?? 1,
          endLine: (params.startLine ?? 1) + lines.length - 1,
          totalLines: lines.length
        },
        `# ${params.path}\n\n\`\`\`\n${content}\n\`\`\``,
        {
          provenance: {
            operations: [],
            durationMs: Date.now() - startTime
          },
          coverage: {
            complete: false,
            limitations: ['Document not in index. Metadata unavailable.']
          },
          kindEcho: {
            source: 'docs.open',
            kind: 'open',
            paramsUsed: { path: params.path }
          }
        }
      )
    }

    // Determine line range
    let startLine = params.startLine ?? 1
    let lineLimit = params.lineLimit ?? 150

    // If chunkId specified, use chunk's line range
    if (params.chunkId) {
      const chunk = doc.chunks.find(c => c.id === params.chunkId)
      if (!chunk) {
        return createErrorResult(`Chunk not found: ${params.chunkId}`, {
          durationMs: Date.now() - startTime,
          suggestions: [
            `Available chunks: ${doc.chunks.map(c => c.id).join(', ')}`,
            'Use docs.search to find relevant chunks'
          ]
        })
      }
      startLine = chunk.startLine
      lineLimit = chunk.endLine - chunk.startLine + 1
    }

    // Read content
    const content = await indexer.readContent(params.path, startLine, lineLimit)

    if (content === null) {
      return createErrorResult(`Failed to read document: ${params.path}`, {
        durationMs: Date.now() - startTime
      })
    }

    const contentLines = content.split('\n')
    const endLine = startLine + contentLines.length - 1

    // Estimate total lines from chunks
    const totalLines = doc.chunks.length > 0
      ? Math.max(...doc.chunks.map(c => c.endLine))
      : contentLines.length

    // Build response
    const data: DocsOpenData = {
      path: params.path,
      title: doc.title,
      content,
      startLine,
      endLine,
      totalLines
    }

    if (params.includeOutline) {
      data.outline = doc.outline
    }

    if (params.includeMeta) {
      data.metadata = doc.metadata
    }

    // Render output
    const lines: string[] = [
      `# ${doc.title}`,
      '',
      `**Path:** ${params.path}`,
      `**Lines:** ${startLine} - ${endLine} of ${totalLines}`,
      ''
    ]

    if (params.includeOutline && doc.outline.length > 0) {
      lines.push('## Outline')
      lines.push('')
      for (const heading of doc.outline) {
        const indent = '  '.repeat(heading.level - 1)
        lines.push(`${indent}- ${heading.title} (line ${heading.line})`)
      }
      lines.push('')
    }

    if (params.includeMeta && Object.keys(doc.metadata).length > 0) {
      lines.push('## Metadata')
      lines.push('')
      for (const [key, value] of Object.entries(doc.metadata)) {
        lines.push(`- **${key}:** ${JSON.stringify(value)}`)
      }
      lines.push('')
    }

    lines.push('## Content')
    lines.push('')
    lines.push('```')
    lines.push(content)
    lines.push('```')

    const complete = endLine >= totalLines

    return createSuccessResult(
      data,
      lines.join('\n'),
      {
        provenance: {
          operations: [],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete,
          limitations: complete ? undefined : [
            `Showing lines ${startLine}-${endLine} of ${totalLines}.`,
            `Use startLine: ${endLine + 1} to continue reading.`
          ]
        },
        kindEcho: {
          source: 'docs.open',
          kind: 'open',
          paramsUsed: { path: params.path, chunkId: params.chunkId, startLine, lineLimit }
        },
        next: !complete ? [
          {
            source: 'docs.open',
            params: { path: params.path, startLine: endLine + 1, lineLimit },
            why: 'Continue reading',
            confidence: 0.9
          }
        ] : undefined
      }
    )
  }
})
