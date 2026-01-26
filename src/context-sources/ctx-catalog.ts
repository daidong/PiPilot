/**
 * ctx.catalog - Meta context source that lists available sources
 *
 * Returns a short listing of registered context sources, grouped by namespace.
 * Use ctx.describe for full documentation of a specific source.
 */

import { defineContextSource, createSuccessResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult, ContextKind, CostTier } from '../types/context.js'

export interface CtxCatalogParams {
  /** Filter by namespace (e.g., 'repo', 'docs') */
  namespace?: string
  /** Filter by kind (e.g., 'search', 'index') */
  kind?: ContextKind
}

export interface CatalogEntry {
  id: string
  namespace: string
  kind: ContextKind
  oneLiner: string
  minParams: string[]
  example: string
  costTier: CostTier
}

export interface CtxCatalogData {
  sources: CatalogEntry[]
  namespaces: string[]
  total: number
}

/**
 * Extract minimum required params from a source
 */
function getMinParams(source: ContextSource): string[] {
  if (!source.params) return []
  return source.params
    .filter(p => p.required)
    .map(p => p.name)
}

/**
 * Generate a minimal example call
 */
function generateExample(source: ContextSource): string {
  if (source.examples && source.examples.length > 0) {
    const ex = source.examples[0]!
    const paramsStr = Object.keys(ex.params).length > 0
      ? JSON.stringify(ex.params)
      : ''
    return paramsStr
      ? `ctx.get("${source.id}", ${paramsStr})`
      : `ctx.get("${source.id}")`
  }

  // Generate from required params
  const requiredParams = source.params?.filter(p => p.required) ?? []
  if (requiredParams.length === 0) {
    return `ctx.get("${source.id}")`
  }

  const exampleParams: Record<string, string> = {}
  for (const p of requiredParams) {
    exampleParams[p.name] = `<${p.type}>`
  }
  return `ctx.get("${source.id}", ${JSON.stringify(exampleParams)})`
}

export const ctxCatalog: ContextSource<CtxCatalogParams, CtxCatalogData> = defineContextSource({
  id: 'ctx.catalog',
  kind: 'index',
  description: 'List available context sources. Returns short listing grouped by namespace. Use ctx.describe for full documentation.',
  shortDescription: 'List available context sources',
  resourceTypes: [],
  params: [
    { name: 'namespace', type: 'string', required: false, description: 'Filter by namespace (e.g., "session", "docs", "memory")' },
    { name: 'kind', type: 'string', required: false, description: 'Filter by kind', enum: ['index', 'search', 'open', 'get'] }
  ],
  examples: [
    { description: 'List all sources', params: {}, resultSummary: 'All available sources' },
    { description: 'List session sources', params: { namespace: 'session' }, resultSummary: 'session.* sources only' },
    { description: 'List search sources', params: { kind: 'search' }, resultSummary: 'All search-type sources' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 10 * 60 * 1000 // 10 minutes
  },
  render: {
    maxTokens: 800,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<CtxCatalogData>> => {
    const startTime = Date.now()

    // Get all sources from context manager
    const allSources = runtime.contextManager.getAllSources()

    // Filter sources
    let filteredSources = allSources

    if (params?.namespace) {
      filteredSources = filteredSources.filter(s => s.namespace === params.namespace)
    }

    if (params?.kind) {
      filteredSources = filteredSources.filter(s => s.kind === params.kind)
    }

    // Exclude ctx.catalog and ctx.describe from listing (meta sources)
    // Actually keep them - they're useful for the model to know about

    // Build catalog entries
    const entries: CatalogEntry[] = filteredSources.map(source => ({
      id: source.id,
      namespace: source.namespace,
      kind: source.kind,
      oneLiner: source.shortDescription,
      minParams: getMinParams(source),
      example: generateExample(source),
      costTier: source.costTier
    }))

    // Sort by namespace, then by kind priority (index, search, open, get)
    const kindOrder: Record<ContextKind, number> = { index: 0, search: 1, open: 2, get: 3 }
    entries.sort((a, b) => {
      const nsCompare = a.namespace.localeCompare(b.namespace)
      if (nsCompare !== 0) return nsCompare
      return (kindOrder[a.kind] ?? 99) - (kindOrder[b.kind] ?? 99)
    })

    // Get unique namespaces
    const namespaces = [...new Set(entries.map(e => e.namespace))].sort()

    // Render output
    const lines: string[] = ['# Available Context Sources', '']

    if (params?.namespace) {
      lines.push(`Filtered by namespace: **${params.namespace}**`)
      lines.push('')
    }
    if (params?.kind) {
      lines.push(`Filtered by kind: **${params.kind}**`)
      lines.push('')
    }

    // Group by namespace
    const byNamespace = new Map<string, CatalogEntry[]>()
    for (const entry of entries) {
      const list = byNamespace.get(entry.namespace) ?? []
      list.push(entry)
      byNamespace.set(entry.namespace, list)
    }

    for (const [ns, sources] of byNamespace) {
      lines.push(`## ${ns}.*`)
      lines.push('')
      lines.push('| Source | Kind | Purpose | Cost |')
      lines.push('|--------|------|---------|------|')
      for (const s of sources) {
        lines.push(`| ${s.id} | ${s.kind} | ${s.oneLiner} | ${s.costTier} |`)
      }
      lines.push('')

      // Quick examples
      lines.push('**Examples:**')
      for (const s of sources.slice(0, 3)) {
        lines.push(`- ${s.example}`)
      }
      lines.push('')
    }

    // Help section
    lines.push('## Help')
    lines.push('- Use `ctx.get("ctx.describe", { id: "source.id" })` for full documentation')
    lines.push('')
    lines.push(`[${entries.length} sources in ${namespaces.length} namespaces]`)

    return createSuccessResult(
      {
        sources: entries,
        namespaces,
        total: entries.length
      },
      lines.join('\n'),
      {
        provenance: {
          operations: [],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete: true
        },
        kindEcho: {
          source: 'ctx.catalog',
          kind: 'index',
          paramsUsed: (params ?? {}) as Record<string, unknown>
        }
      }
    )
  }
})
