/**
 * repo.file - 读取文件上下文源
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'

export interface RepoFileParams {
  path: string
  offset?: number
  limit?: number
}

export interface RepoFileData {
  path: string
  content: string
  lines: number
  truncated: boolean
}

/**
 * 添加行号
 */
function addLineNumbers(content: string, startLine: number = 1): string {
  const lines = content.split('\n')
  const maxLineNum = startLine + lines.length - 1
  const padding = String(maxLineNum).length

  return lines
    .map((line, i) => `${String(startLine + i).padStart(padding)}| ${line}`)
    .join('\n')
}

export const repoFile: ContextSource<RepoFileParams, RepoFileData> = defineContextSource({
  id: 'repo.file',
  kind: 'open',
  description: 'Read file content with line numbers. Supports pagination via offset/limit.',
  shortDescription: 'Read file content',
  resourceTypes: ['readFile'],
  params: [
    { name: 'path', type: 'string', required: true, description: 'File path to read' },
    { name: 'offset', type: 'number', required: false, description: 'Starting line (0-based)', default: 0 },
    { name: 'limit', type: 'number', required: false, description: 'Max lines to read', default: 200 }
  ],
  examples: [
    { description: 'Read entire file', params: { path: 'src/index.ts' }, resultSummary: 'File content with line numbers' },
    { description: 'Read specific lines', params: { path: 'src/index.ts', offset: 100, limit: 50 }, resultSummary: 'Lines 101-150' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 60 * 1000,
    invalidateOn: ['file:write']
  },
  render: {
    maxTokens: 3000,
    truncateStrategy: 'middle'
  },

  fetch: async (params, runtime): Promise<ContextResult<RepoFileData>> => {
    const startTime = Date.now()

    if (!params?.path) {
      return createErrorResult('path is required', Date.now() - startTime)
    }

    const limit = params.limit ?? 200
    const offset = params.offset ?? 0

    const result = await runtime.io.readFile(params.path, {
      offset,
      limit: limit + 1
    })

    if (!result.success) {
      return createErrorResult(result.error ?? 'Failed to read file', Date.now() - startTime)
    }

    const content = result.data!
    const lines = content.split('\n')
    const truncated = lines.length > limit
    const finalContent = truncated ? lines.slice(0, limit).join('\n') : content
    const lineCount = truncated ? limit : lines.length

    // 推断语言
    const ext = params.path.split('.').pop() ?? ''
    const langMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'tsx',
      js: 'javascript',
      jsx: 'jsx',
      py: 'python',
      rs: 'rust',
      go: 'go',
      java: 'java',
      md: 'markdown',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml'
    }
    const language = langMap[ext] ?? ext

    const rendered = [
      `# ${params.path}`,
      '',
      '```' + language,
      addLineNumbers(finalContent, offset + 1),
      '```',
      '',
      truncated ? `[Truncated: showing lines ${offset + 1}-${offset + limit} of ${lines.length}+]` : '',
      `[Coverage: ${lineCount} lines${truncated ? ', use offset to see more' : ''}]`
    ].join('\n')

    return createSuccessResult(
      {
        path: params.path,
        content: finalContent,
        lines: lineCount,
        truncated
      },
      rendered,
      {
        provenance: {
          operations: [{ type: 'readFile', target: params.path, traceId: result.traceId }],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete: !truncated,
          limitations: truncated ? [`limit=${limit}`, `offset=${offset}`] : undefined,
          suggestions: truncated ? ['Use offset parameter to read more'] : undefined
        }
      }
    )
  }
})
