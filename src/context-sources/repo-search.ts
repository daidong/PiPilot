/**
 * repo.search - 代码搜索上下文源
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { GrepMatch } from '../types/runtime.js'

export interface RepoSearchParams {
  pattern: string
  type?: string
  limit?: number
  ignoreCase?: boolean
}

export interface RepoSearchData {
  pattern: string
  matches: GrepMatch[]
  totalMatches: number
  truncated: boolean
}

/**
 * 格式化搜索结果
 */
function formatMatches(matches: GrepMatch[], limit: number): string {
  const lines: string[] = []
  const displayMatches = matches.slice(0, limit)

  for (const match of displayMatches) {
    lines.push(`${match.file}:${match.line}`)
    lines.push(`  ${match.text.trim()}`)
    lines.push('')
  }

  return lines.join('\n')
}

export const repoSearch: ContextSource<RepoSearchParams, RepoSearchData> = defineContextSource({
  id: 'repo.search',
  kind: 'search',
  description: 'Search code content by pattern (regex or keyword). Returns matching lines with file locations.',
  shortDescription: 'Search code by pattern',
  resourceTypes: ['grep'],
  params: [
    { name: 'pattern', type: 'string', required: true, description: 'Search pattern (regex supported)' },
    { name: 'type', type: 'string', required: false, description: 'File type filter (e.g., "ts", "js")' },
    { name: 'limit', type: 'number', required: false, description: 'Max results', default: 20 },
    { name: 'ignoreCase', type: 'boolean', required: false, description: 'Case insensitive search', default: false }
  ],
  examples: [
    { description: 'Find function definition', params: { pattern: 'function createAgent' }, resultSummary: 'Matching code locations' },
    { description: 'Search TypeScript files only', params: { pattern: 'interface', type: 'ts', limit: 10 }, resultSummary: 'Interface definitions' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 60 * 1000
  },
  render: {
    maxTokens: 2000,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<RepoSearchData>> => {
    const startTime = Date.now()

    if (!params?.pattern) {
      return createErrorResult('pattern is required', Date.now() - startTime)
    }

    const limit = params.limit ?? 20

    const result = await runtime.io.grep(params.pattern, {
      type: params.type,
      limit: limit + 1,
      ignoreCase: params.ignoreCase,
      caller: 'ctx.get:repo.search'
    })

    if (!result.success) {
      return createErrorResult(result.error ?? 'Search failed', Date.now() - startTime)
    }

    const matches = result.data!
    const truncated = matches.length > limit
    const finalMatches = truncated ? matches.slice(0, limit) : matches

    const rendered = [
      `# Search: "${params.pattern}"`,
      '',
      `Found ${finalMatches.length}${truncated ? '+' : ''} matches:`,
      '',
      formatMatches(finalMatches, 10),
      truncated ? `... (${matches.length - 10} more matches)` : '',
      '',
      `[Coverage: limit=${limit}, showing ${Math.min(finalMatches.length, 10)} of ${finalMatches.length}${truncated ? '+' : ''}]`
    ].join('\n')

    return createSuccessResult(
      {
        pattern: params.pattern,
        matches: finalMatches,
        totalMatches: matches.length,
        truncated
      },
      rendered,
      {
        provenance: {
          operations: [{ type: 'grep', target: params.pattern, traceId: result.traceId }],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete: !truncated,
          limitations: truncated ? [`limit=${limit}`] : undefined,
          suggestions: truncated ? ['Increase limit or refine pattern'] : undefined
        }
      }
    )
  }
})
