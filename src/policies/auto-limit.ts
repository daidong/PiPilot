/**
 * auto-limit - 自动限制策略
 */

import { defineMutatePolicy } from '../factories/define-policy.js'

/**
 * 自动为 SQL 查询添加 LIMIT
 */
export const autoLimitSql = defineMutatePolicy({
  id: 'auto-limit-sql',
  description: '自动为 SQL 查询添加 LIMIT 限制',
  priority: 50,
  match: (ctx) => {
    // 匹配执行 SQL 的工具
    const input = ctx.input as { sql?: string }
    return !!input?.sql
  },
  transforms: (ctx) => {
    const input = ctx.input as { sql?: string }
    const sql = input.sql ?? ''

    // 检查是否已有 LIMIT
    if (/LIMIT\s+\d+/i.test(sql)) {
      return []
    }

    // 只对 SELECT 语句添加
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
 * 自动限制 grep 结果数量
 */
export const autoLimitGrep = defineMutatePolicy({
  id: 'auto-limit-grep',
  description: '自动限制 grep 搜索结果数量',
  priority: 50,
  match: (ctx) => {
    return ctx.tool === 'grep' || ctx.operation === 'grep'
  },
  transforms: (ctx) => {
    const input = ctx.input as { limit?: number }

    // 如果没有设置 limit 或 limit 过大
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
 * 自动限制 glob 结果数量
 */
export const autoLimitGlob = defineMutatePolicy({
  id: 'auto-limit-glob',
  description: '自动限制 glob 匹配结果数量',
  priority: 50,
  match: (ctx) => {
    return ctx.tool === 'glob' || ctx.operation === 'glob'
  },
  transforms: () => {
    // 添加常见的忽略模式
    return [{
      op: 'set',
      path: 'ignore',
      value: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/coverage/**']
    }]
  }
})

/**
 * 自动限制文件读取行数
 */
export const autoLimitRead = defineMutatePolicy({
  id: 'auto-limit-read',
  description: '自动限制读取文件的行数',
  priority: 50,
  match: (ctx) => {
    return ctx.tool === 'read' || ctx.operation === 'readFile'
  },
  transforms: (ctx) => {
    const input = ctx.input as { limit?: number }

    // 如果没有设置 limit 或 limit 过大
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
 * 所有自动限制策略
 */
export const autoLimitPolicies = [
  autoLimitSql,
  autoLimitGrep,
  autoLimitGlob,
  autoLimitRead
]
