/**
 * normalize-paths - 路径规范化策略
 */

import { defineMutatePolicy } from '../factories/define-policy.js'

/**
 * 规范化路径
 */
function normalizePath(path: string): string {
  // 替换反斜杠
  let normalized = path.replace(/\\/g, '/')

  // 移除多余的斜杠
  normalized = normalized.replace(/\/+/g, '/')

  // 处理 . 和 ..
  const parts = normalized.split('/')
  const result: string[] = []

  for (const part of parts) {
    if (part === '.') {
      continue
    }
    if (part === '..') {
      result.pop()
      continue
    }
    if (part) {
      result.push(part)
    }
  }

  // 保留开头的斜杠
  const prefix = normalized.startsWith('/') ? '/' : ''

  return prefix + result.join('/')
}

/**
 * 规范化读取路径
 */
export const normalizeReadPaths = defineMutatePolicy({
  id: 'normalize-read-paths',
  description: '规范化读取操作的文件路径',
  priority: 90,
  match: (ctx) => {
    return ctx.tool === 'read' || ctx.operation === 'readFile'
  },
  transforms: (ctx) => {
    const input = ctx.input as { path?: string }
    if (!input?.path) {
      return []
    }

    const normalized = normalizePath(input.path)
    if (normalized === input.path) {
      return []
    }

    return [{
      op: 'normalize_path',
      path: 'path'
    }]
  }
})

/**
 * 规范化写入路径
 */
export const normalizeWritePaths = defineMutatePolicy({
  id: 'normalize-write-paths',
  description: '规范化写入操作的文件路径',
  priority: 90,
  match: (ctx) => {
    return ctx.tool === 'write' || ctx.tool === 'edit' || ctx.operation === 'writeFile'
  },
  transforms: (ctx) => {
    const input = ctx.input as { path?: string }
    if (!input?.path) {
      return []
    }

    const normalized = normalizePath(input.path)
    if (normalized === input.path) {
      return []
    }

    return [{
      op: 'normalize_path',
      path: 'path'
    }]
  }
})

/**
 * 规范化 glob 路径
 */
export const normalizeGlobPaths = defineMutatePolicy({
  id: 'normalize-glob-paths',
  description: '规范化 glob 操作的路径',
  priority: 90,
  match: (ctx) => {
    return ctx.tool === 'glob' || ctx.operation === 'glob'
  },
  transforms: (ctx) => {
    const input = ctx.input as { cwd?: string }
    if (!input?.cwd) {
      return []
    }

    const normalized = normalizePath(input.cwd)
    if (normalized === input.cwd) {
      return []
    }

    return [{
      op: 'normalize_path',
      path: 'cwd'
    }]
  }
})

/**
 * 所有路径规范化策略
 */
export const normalizePathsPolicies = [
  normalizeReadPaths,
  normalizeWritePaths,
  normalizeGlobPaths
]
