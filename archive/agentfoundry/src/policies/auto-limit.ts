/**
 * auto-limit - Auto-limiting policies
 */

import { defineMutatePolicy } from '../factories/define-policy.js'

/**
 * Automatically add LIMIT to SQL queries
 */
export const autoLimitSql = defineMutatePolicy({
  id: 'auto-limit-sql',
  description: 'Automatically add LIMIT clause to SQL queries',
  priority: 50,
  match: (ctx) => {
    // Match tools that execute SQL
    const input = ctx.input as { sql?: string }
    return !!input?.sql
  },
  transforms: (ctx) => {
    const input = ctx.input as { sql?: string }
    const sql = input.sql ?? ''

    // Check if LIMIT already exists
    if (/LIMIT\s+\d+/i.test(sql)) {
      return []
    }

    // Only add to SELECT statements
    if (!/^\s*SELECT/i.test(sql)) {
      return []
    }

    return [{
      op: 'append',
      path: 'sql',
      value: ' LIMIT 100'
    }]
  }
})

/**
 * Automatically limit grep result count
 */
export const autoLimitGrep = defineMutatePolicy({
  id: 'auto-limit-grep',
  description: 'Automatically limit the number of grep search results',
  priority: 50,
  match: (ctx) => {
    return ctx.tool === 'grep' || ctx.operation === 'grep'
  },
  transforms: (ctx) => {
    const input = ctx.input as { limit?: number }

    // If limit is not set or is too large
    if (input.limit === undefined || input.limit > 200) {
      return [{
        op: 'set',
        path: 'limit',
        value: 100
      }]
    }

    return []
  }
})

/**
 * Automatically limit glob result count
 */
export const autoLimitGlob = defineMutatePolicy({
  id: 'auto-limit-glob',
  description: 'Automatically limit the number of glob match results',
  priority: 50,
  match: (ctx) => {
    return ctx.tool === 'glob' || ctx.operation === 'glob'
  },
  transforms: () => {
    // Add common ignore patterns
    return [{
      op: 'set',
      path: 'ignore',
      value: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/coverage/**']
    }]
  }
})

/**
 * Automatically limit file read line count
 */
export const autoLimitRead = defineMutatePolicy({
  id: 'auto-limit-read',
  description: 'Automatically limit the number of lines read from a file',
  priority: 50,
  match: (ctx) => {
    return ctx.tool === 'read' || ctx.operation === 'readFile'
  },
  transforms: (ctx) => {
    const input = ctx.input as { limit?: number }

    // If limit is not set or is too large
    if (input.limit === undefined || input.limit > 2000) {
      return [{
        op: 'set',
        path: 'limit',
        value: 2000
      }]
    }

    return []
  }
})

/**
 * All auto-limiting policies
 */
export const autoLimitPolicies = [
  autoLimitSql,
  autoLimitGrep,
  autoLimitGlob,
  autoLimitRead
]
