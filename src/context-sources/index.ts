/**
 * Context Sources - 内置上下文源导出
 */

// Repo namespace
export { repoIndex } from './repo-index.js'
export { repoSearch } from './repo-search.js'
export { repoSymbols } from './repo-symbols.js'
export { repoFile } from './repo-file.js'
export { repoGit } from './repo-git.js'

// Session namespace
export { sessionHistory } from './session-history.js'
export { sessionRecent } from './session-recent.js'
export { sessionSearch } from './session-search.js'
export { sessionThread } from './session-thread.js'

// Meta namespace (ctx.*)
export { ctxCatalog } from './ctx-catalog.js'
export { ctxDescribe } from './ctx-describe.js'
export { ctxRoute } from './ctx-route.js'

// Memory namespace (KV storage)
export { memoryGet } from './memory-get.js'
export { memorySearch } from './memory-search.js'
export { memoryList } from './memory-list.js'

// Facts and Decisions namespace
export { factsList } from './facts-list.js'
export { decisionsList } from './decisions-list.js'

// Docs namespace
export { docsIndex } from './docs-index.js'
export { docsSearch } from './docs-search.js'
export { docsOpen } from './docs-open.js'

// Type exports
export type { RepoIndexParams, RepoIndexData } from './repo-index.js'
export type { RepoSearchParams, RepoSearchData } from './repo-search.js'
export type { RepoSymbolsParams, RepoSymbolsData, Symbol } from './repo-symbols.js'
export type { RepoFileParams, RepoFileData } from './repo-file.js'
export type { RepoGitParams, RepoGitData, GitStatus, GitLog } from './repo-git.js'
export type { SessionHistoryParams, SessionHistoryData, HistoryEntry } from './session-history.js'
export type { SessionRecentParams, SessionRecentData } from './session-recent.js'
export type { SessionSearchParams, SessionSearchData } from './session-search.js'
export type { SessionThreadParams, SessionThreadData } from './session-thread.js'
export type { CtxCatalogParams, CtxCatalogData, CatalogEntry } from './ctx-catalog.js'
export type { CtxDescribeParams, CtxDescribeData } from './ctx-describe.js'
export type { CtxRouteParams, CtxRouteData, RouteIntent, RouteRecommendation } from './ctx-route.js'
export type { MemoryGetParams, MemoryGetData } from './memory-get.js'
export type { MemorySearchParams, MemorySearchData } from './memory-search.js'
export type { MemoryListParams, MemoryListData } from './memory-list.js'
export type { FactsListParams, FactsListData } from './facts-list.js'
export type { DecisionsListParams, DecisionsListData } from './decisions-list.js'
export type { DocsIndexParams, DocsIndexData } from './docs-index.js'
export type { DocsSearchParams, DocsSearchData } from './docs-search.js'
export type { DocsOpenParams, DocsOpenData } from './docs-open.js'

import type { ContextSource } from '../types/context.js'
import { repoIndex } from './repo-index.js'
import { repoSearch } from './repo-search.js'
import { repoSymbols } from './repo-symbols.js'
import { repoFile } from './repo-file.js'
import { repoGit } from './repo-git.js'
import { sessionHistory } from './session-history.js'
import { sessionRecent } from './session-recent.js'
import { sessionSearch } from './session-search.js'
import { sessionThread } from './session-thread.js'
import { ctxCatalog } from './ctx-catalog.js'
import { ctxDescribe } from './ctx-describe.js'
import { ctxRoute } from './ctx-route.js'
import { memoryGet } from './memory-get.js'
import { memorySearch } from './memory-search.js'
import { memoryList } from './memory-list.js'
import { factsList } from './facts-list.js'
import { decisionsList } from './decisions-list.js'
import { docsIndex } from './docs-index.js'
import { docsSearch } from './docs-search.js'
import { docsOpen } from './docs-open.js'

/**
 * Repo namespace context sources
 */
export const repoContextSources: ContextSource<any, any>[] = [
  repoIndex,
  repoSearch,
  repoSymbols,
  repoFile,
  repoGit
]

/**
 * Session namespace context sources
 */
export const sessionContextSources: ContextSource<any, any>[] = [
  sessionHistory,
  sessionRecent,
  sessionSearch,
  sessionThread
]

/**
 * Meta namespace context sources (ctx.*)
 * These provide discovery and routing capabilities
 */
export const metaContextSources: ContextSource<any, any>[] = [
  ctxCatalog,
  ctxDescribe,
  ctxRoute
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
 * Facts and Decisions context sources
 * For long-term facts and decision tracking
 */
export const factsDecisionsContextSources: ContextSource<any, any>[] = [
  factsList,
  decisionsList
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
  ...repoContextSources,
  ...sessionContextSources,
  ...metaContextSources,
  ...memoryContextSources,
  ...factsDecisionsContextSources,
  ...docsContextSources
]

/**
 * Get builtin context source by ID
 */
export function getBuiltinContextSource(id: string): ContextSource | undefined {
  return builtinContextSources.find(s => s.id === id)
}
