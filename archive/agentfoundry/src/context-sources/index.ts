/**
 * Context Sources - Built-in context source exports
 *
 * Simplified structure:
 * - session.*: Conversation messages and operation trace
 * - memory.*: Key-value storage operations
 * - docs.*: Document library
 * - ctx.*: Meta sources (catalog, describe)
 */

// Session namespace
export { sessionTrace } from './session-trace.js'

// Meta namespace (ctx.*)
export { ctxCatalog } from './ctx-catalog.js'
export { ctxDescribe } from './ctx-describe.js'

// Memory namespace (KV storage)
export { memoryGet } from './memory-get.js'
export { memorySearch } from './memory-search.js'
export { memoryList } from './memory-list.js'

// Docs namespace
export { docsIndex } from './docs-index.js'
export { docsSearch } from './docs-search.js'
export { docsOpen } from './docs-open.js'

// Todo namespace
export { todoList } from './todo-list.js'
export { todoGet } from './todo-get.js'

// Skill namespace
export { skillLoad } from './skill-load.js'

// Type exports
export type { SessionTraceParams, SessionTraceData, TraceEntry } from './session-trace.js'
export type { CtxCatalogParams, CtxCatalogData, CatalogEntry } from './ctx-catalog.js'
export type { CtxDescribeParams, CtxDescribeData } from './ctx-describe.js'
export type { MemoryGetParams, MemoryGetData } from './memory-get.js'
export type { MemorySearchParams, MemorySearchData } from './memory-search.js'
export type { MemoryListParams, MemoryListData } from './memory-list.js'
export type { DocsIndexParams, DocsIndexData } from './docs-index.js'
export type { DocsSearchParams, DocsSearchData } from './docs-search.js'
export type { DocsOpenParams, DocsOpenData } from './docs-open.js'
export type { TodoListParams, TodoListData } from './todo-list.js'
export type { TodoGetParams, TodoGetData } from './todo-get.js'
export type { SkillLoadParams, SkillLoadData } from './skill-load.js'

import type { ContextSource } from '../types/context.js'
import { sessionTrace } from './session-trace.js'
import { ctxCatalog } from './ctx-catalog.js'
import { ctxDescribe } from './ctx-describe.js'
import { memoryGet } from './memory-get.js'
import { memorySearch } from './memory-search.js'
import { memoryList } from './memory-list.js'
import { docsIndex } from './docs-index.js'
import { docsSearch } from './docs-search.js'
import { docsOpen } from './docs-open.js'
import { todoList } from './todo-list.js'
import { todoGet } from './todo-get.js'
import { skillLoad } from './skill-load.js'

/**
 * Session namespace context sources
 */
export const sessionContextSources: ContextSource<any, any>[] = [
  sessionTrace
]

/**
 * Meta namespace context sources (ctx.*)
 * These provide discovery capabilities
 */
export const metaContextSources: ContextSource<any, any>[] = [
  ctxCatalog,
  ctxDescribe
]

/**
 * Memory namespace context sources (memory.*)
 * For KV memory storage operations
 */
export const memoryContextSources: ContextSource<any, any>[] = [
  memoryGet,
  memorySearch,
  memoryList
]

/**
 * Docs namespace context sources
 * For document library management
 */
export const docsContextSources: ContextSource<any, any>[] = [
  docsIndex,
  docsSearch,
  docsOpen
]

/**
 * Todo namespace context sources
 * For task tracking operations
 */
export const todoContextSources: ContextSource<any, any>[] = [
  todoList,
  todoGet
]

/**
 * Skill namespace context sources
 */
export const skillContextSources: ContextSource<any, any>[] = [
  skillLoad
]

/**
 * All builtin context sources
 */
export const builtinContextSources: ContextSource<any, any>[] = [
  ...sessionContextSources,
  ...metaContextSources,
  ...memoryContextSources,
  ...docsContextSources,
  ...todoContextSources,
  ...skillContextSources
]

/**
 * Get builtin context source by ID
 */
export function getBuiltinContextSource(id: string): ContextSource | undefined {
  return builtinContextSources.find(s => s.id === id)
}
