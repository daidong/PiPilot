/**
 * repo.index - 目录结构上下文源
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { DirEntry } from '../types/runtime.js'

export interface RepoIndexParams {
  path?: string
  depth?: number
  includeHidden?: boolean
}

export interface RepoIndexData {
  root: string
  entries: DirEntry[]
  stats: {
    files: number
    directories: number
    totalSize: number
  }
}

/**
 * 格式化目录树
 */
function formatTree(entries: DirEntry[], depth: number = 0, maxDepth: number = 3): string {
  const lines: string[] = []
  const indent = '  '.repeat(depth)

  // 按目录优先、名称排序
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return a.name.localeCompare(b.name)
  })

  for (const entry of sorted) {
    const prefix = entry.isDirectory ? '📁 ' : '📄 '
    lines.push(`${indent}${prefix}${entry.name}`)

    // 如果是目录且有子项，展示提示
    if (entry.isDirectory && depth >= maxDepth) {
      lines.push(`${indent}  ...`)
    }
  }

  return lines.join('\n')
}

export const repoIndex: ContextSource<RepoIndexParams, RepoIndexData> = defineContextSource({
  id: 'repo.index',
  kind: 'index',
  description: 'Browse project directory structure. Returns file tree with statistics.',
  shortDescription: 'List project directory structure',
  resourceTypes: ['readdir'],
  params: [
    { name: 'path', type: 'string', required: false, description: 'Root path to browse', default: '.' },
    { name: 'depth', type: 'number', required: false, description: 'Max depth to traverse', default: 2 },
    { name: 'includeHidden', type: 'boolean', required: false, description: 'Include hidden files', default: false }
  ],
  examples: [
    { description: 'Browse project root', params: {}, resultSummary: 'Directory tree of project' },
    { description: 'Browse src folder', params: { path: 'src', depth: 3 }, resultSummary: 'Directory tree of src/' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 5 * 60 * 1000,
    invalidateOn: ['file:create', 'file:delete']
  },
  render: {
    maxTokens: 1000,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<RepoIndexData>> => {
    const startTime = Date.now()
    const path = params?.path ?? '.'
    const depth = params?.depth ?? 2

    const result = await runtime.io.readdir(path, {
      recursive: true,
      depth
    })

    if (!result.success) {
      return createErrorResult(result.error ?? 'Failed to read directory', Date.now() - startTime)
    }

    const entries = result.data!

    // 过滤隐藏文件（如果不包含）
    const filtered = params?.includeHidden
      ? entries
      : entries.filter(e => !e.name.startsWith('.') && !e.name.includes('/.'))

    // 统计
    const stats = {
      files: filtered.filter(e => e.isFile).length,
      directories: filtered.filter(e => e.isDirectory).length,
      totalSize: filtered.reduce((sum, e) => sum + (e.size ?? 0), 0)
    }

    // 渲染树形结构
    const rendered = [
      `# 项目结构: ${path}`,
      '',
      formatTree(filtered, 0, depth),
      '',
      `[Statistics: ${stats.files} files, ${stats.directories} directories]`,
      `[Coverage: depth=${depth}]`
    ].join('\n')

    return createSuccessResult(
      { root: path, entries: filtered, stats },
      rendered,
      {
        provenance: {
          operations: [{ type: 'readdir', target: path, traceId: result.traceId }],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete: depth <= 2,
          limitations: depth > 2 ? [`depth=${depth}`] : undefined
        }
      }
    )
  }
})
