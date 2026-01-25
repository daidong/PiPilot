/**
 * Literature Pack
 *
 * Minimal pack that only provides:
 * - literature_multi_search: Domain-specific multi-source search
 * - Session state initialization
 *
 * LLM tools (llm-expand, llm-filter) are provided by packs.compute()
 * Network tools (fetch) are provided by packs.network()
 */

import { definePack, network } from '../../dist/index.js'
import type { Runtime } from '../../dist/index.js'

import { multiSearch } from './tools/multi-search.js'
import { LITERATURE_STATE_KEYS, LITERATURE_DEFAULTS } from './types.js'

/**
 * Literature Pack - Minimal domain-specific pack
 *
 * Only provides the multi-search tool and session state.
 * Use with packs.compute() and packs.network({ allowHttp: true })
 */
export const literaturePack = definePack({
  id: 'literature',
  description: `Literature multi-search tool for academic databases (Semantic Scholar, arXiv, OpenAlex)`,

  tools: [
    multiSearch as any
  ],

  // HTTP support for arXiv
  policies: network({ allowHttp: true }).policies,

  promptFragment: `
## literature_multi_search Tool

Search multiple academic databases in parallel:
- Semantic Scholar, arXiv, OpenAlex
- Pass array of queries (use llm-expand first)
- Returns deduplicated papers with metadata

Session limits: ${LITERATURE_DEFAULTS.maxQueriesPerSession} queries, ${LITERATURE_DEFAULTS.maxPapersPerSession} papers
  `.trim(),

  onInit: async (runtime: Runtime) => {
    // Initialize session state for rate limiting
    runtime.sessionState.set(LITERATURE_STATE_KEYS.QUERY_COUNT, 0)
    runtime.sessionState.set(LITERATURE_STATE_KEYS.SEARCHED_QUERIES, new Set<string>())
    runtime.sessionState.set(LITERATURE_STATE_KEYS.SEARCH_HISTORY, [])
    runtime.sessionState.set(LITERATURE_STATE_KEYS.PAPER_CACHE, [])

    console.log('[literature] Registered tools:', runtime.toolRegistry.getAll().map(t => t.name).join(', '))
  }
})
