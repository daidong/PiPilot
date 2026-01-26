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
export { sessionMessages } from './session-messages.js'
export { sessionSearch } from './session-search.js'
export { sessionThread } from './session-thread.js'

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

// Type exports
export type { SessionTraceParams, SessionTraceData, TraceEntry } from './session-trace.js'
export type { SessionMessagesParams, SessionMessagesData } from './session-messages.js'
export type { SessionSearchParams, SessionSearchData } from './session-search.js'
export type { SessionThreadParams, SessionThreadData } from './session-thread.js'
export type { CtxCatalogParams, CtxCatalogData, CatalogEntry } from './ctx-catalog.js'
export type { CtxDescribeParams, CtxDescribeData } from './ctx-describe.js'
export type { MemoryGetParams, MemoryGetData } from './memory-get.js'
export type { MemorySearchParams, MemorySearchData } from './memory-search.js'
export type { MemoryListParams, MemoryListData } from './memory-list.js'
export type { DocsIndexParams, DocsIndexData } from './docs-index.js'
export type { DocsSearchParams, DocsSearchData } from './docs-search.js'
export type { DocsOpenParams, DocsOpenData } from './docs-open.js'

import type { ContextSource } from '../types/context.js'
import { sessionTrace } from './session-trace.js'
import { sessionMessages } from './session-messages.js'
import { sessionSearch } from './session-search.js'
import { sessionThread } from './session-thread.js'
import { ctxCatalog } from './ctx-catalog.js'
import { ctxDescribe } from './ctx-describe.js'
import { memoryGet } from './memory-get.js'
import { memorySearch } from './memory-search.js'
import { memoryList } from './memory-list.js'
import { docsIndex } from './docs-index.js'
import { docsSearch } from './docs-search.js'
import { docsOpen } from './docs-open.js'

/**
 * Session namespace context sources
 */
export const sessionContextSources: ContextSource<any, any>[] = [
  sessionTrace,
  sessionMessages,
  sessionSearch,
  sessionThread
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
 * All builtin context sources
 */
export const builtinContextSources: ContextSource<any, any>[] = [
  ...sessionContextSources,
  ...metaContextSources,
  ...memoryContextSources,
  ...docsContextSources
]

/**
 * Get builtin context source by ID
 */
export function getBuiltinContextSource(id: string): ContextSource | undefined {
  return builtinContextSources.find(s => s.id === id)
}
