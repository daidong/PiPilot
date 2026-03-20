/**
 * normalize-paths - Path normalization policies
 */

import { defineMutatePolicy } from '../factories/define-policy.js'

/**
 * Normalize a path
 */
function normalizePath(path: string): string {
  // Replace backslashes
  let normalized = path.replace(/\\/g, '/')

  // Remove redundant slashes
  normalized = normalized.replace(/\/+/g, '/')

  // Handle . and ..
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

  // Preserve the leading slash
  const prefix = normalized.startsWith('/') ? '/' : ''

  return prefix + result.join('/')
}

/**
 * Normalize read paths
 */
export const normalizeReadPaths = defineMutatePolicy({
  id: 'normalize-read-paths',
  description: 'Normalize file paths for read operations',
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
 * Normalize write paths
 */
export const normalizeWritePaths = defineMutatePolicy({
  id: 'normalize-write-paths',
  description: 'Normalize file paths for write operations',
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
 * Normalize glob paths
 */
export const normalizeGlobPaths = defineMutatePolicy({
  id: 'normalize-glob-paths',
  description: 'Normalize paths for glob operations',
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
 * All path normalization policies
 */
export const normalizePathsPolicies = [
  normalizeReadPaths,
  normalizeWritePaths,
  normalizeGlobPaths
]
