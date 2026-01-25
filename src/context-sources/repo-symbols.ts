/**
 * repo.symbols - 符号索引上下文源
 */

import { defineContextSource, createSuccessResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'

export interface RepoSymbolsParams {
  type?: 'function' | 'class' | 'interface' | 'type' | 'const' | 'all'
  pattern?: string
  limit?: number
}

export interface Symbol {
  name: string
  type: string
  file: string
  line: number
}

export interface RepoSymbolsData {
  symbols: Symbol[]
  count: number
}

/**
 * 符号匹配模式
 */
const SYMBOL_PATTERNS: Record<string, RegExp> = {
  function: /(?:function|const|let|var)\s+(\w+)\s*[=:]\s*(?:async\s*)?\(/,
  class: /class\s+(\w+)/,
  interface: /interface\s+(\w+)/,
  type: /type\s+(\w+)\s*=/,
  const: /(?:const|let|var)\s+(\w+)\s*[=:]/
}

export const repoSymbols: ContextSource<RepoSymbolsParams, RepoSymbolsData> = defineContextSource({
  id: 'repo.symbols',
  kind: 'index',
  description: 'Index code symbols (functions, classes, interfaces, types). Useful for understanding codebase structure.',
  shortDescription: 'List code symbols (functions, classes, etc)',
  resourceTypes: ['grep'],
  params: [
    { name: 'type', type: 'string', required: false, description: 'Symbol type filter', default: 'all', enum: ['function', 'class', 'interface', 'type', 'const', 'all'] },
    { name: 'pattern', type: 'string', required: false, description: 'Filter symbols by name pattern' },
    { name: 'limit', type: 'number', required: false, description: 'Max symbols to return', default: 50 }
  ],
  examples: [
    { description: 'Find all interfaces', params: { type: 'interface' }, resultSummary: 'List of interface definitions' },
    { description: 'Find symbols matching pattern', params: { pattern: 'Agent', limit: 20 }, resultSummary: 'Symbols containing "Agent"' }
  ],
  costTier: 'medium',
  cache: {
    ttlMs: 5 * 60 * 1000,
    invalidateOn: ['file:write', 'file:create', 'file:delete']
  },
  render: {
    maxTokens: 1500,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<RepoSymbolsData>> => {
    const startTime = Date.now()
    const symbolType = params?.type ?? 'all'
    const limit = params?.limit ?? 50
    const symbols: Symbol[] = []
    const operations: { type: string; target: string; traceId: string }[] = []

    // 确定要搜索的符号类型
    const typesToSearch = symbolType === 'all'
      ? Object.keys(SYMBOL_PATTERNS)
      : [symbolType]

    for (const type of typesToSearch) {
      const pattern = SYMBOL_PATTERNS[type]
      if (!pattern) continue

      // 构建搜索模式
      const searchPattern = pattern.source

      const result = await runtime.io.grep(searchPattern, {
        type: 'ts',
        limit: limit * 2,
        caller: 'ctx.get:repo.symbols'
      })

      if (result.success && result.data) {
        operations.push({ type: 'grep', target: type, traceId: result.traceId })

        for (const match of result.data) {
          // 从匹配中提取符号名
          const fullPattern = new RegExp(pattern)
          const nameMatch = fullPattern.exec(match.text)

          if (nameMatch && nameMatch[1]) {
            // 如果有 pattern 过滤
            if (params?.pattern && !nameMatch[1].includes(params.pattern)) {
              continue
            }

            symbols.push({
              name: nameMatch[1],
              type,
              file: match.file,
              line: match.line
            })
          }
        }
      }
    }

    // 去重并限制数量
    const uniqueSymbols = Array.from(
      new Map(symbols.map(s => [`${s.file}:${s.name}`, s])).values()
    ).slice(0, limit)

    // 渲染
    const rendered = [
      `# Symbols${params?.pattern ? ` matching "${params.pattern}"` : ''}`,
      '',
      ...uniqueSymbols.slice(0, 30).map(s =>
        `- **${s.name}** (${s.type}) - ${s.file}:${s.line}`
      ),
      uniqueSymbols.length > 30 ? `\n... (${uniqueSymbols.length - 30} more)` : '',
      '',
      `[Coverage: ${uniqueSymbols.length} symbols found]`
    ].join('\n')

    return createSuccessResult(
      { symbols: uniqueSymbols, count: uniqueSymbols.length },
      rendered,
      {
        provenance: {
          operations,
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete: uniqueSymbols.length < limit,
          limitations: uniqueSymbols.length >= limit ? [`limit=${limit}`] : undefined
        }
      }
    )
  }
})
