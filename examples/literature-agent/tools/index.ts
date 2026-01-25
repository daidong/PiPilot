/**
 * Literature Agent Tools
 *
 * Only exports domain-specific tools.
 * Query expansion and relevance filtering use framework tools:
 * - llm-expand: Query expansion (style: 'search', domain: 'academic')
 * - llm-filter: Relevance filtering with scoring
 */

export { multiSearch, type MultiSearchInput, type MultiSearchOutput } from './multi-search.js'
