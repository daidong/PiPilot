/**
 * ctx.route - Intelligent routing context source
 *
 * Recommends the best context source based on user intent.
 * Supports various intents (search, browse, read, lookup, etc.)
 * and suggests appropriate sources with confidence scores.
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult, ContextKind } from '../types/context.js'

/**
 * Supported intent types
 */
export type RouteIntent =
  | 'search'      // Find something by query
  | 'browse'      // Get an overview/index
  | 'read'        // Read specific content
  | 'lookup'      // Get specific item by key
  | 'explore'     // Understand structure
  | 'remember'    // Store information
  | 'recall'      // Retrieve stored info
  | 'auto'        // Auto-detect from query

export interface CtxRouteParams {
  /** Intent type (required) */
  intent: RouteIntent
  /** Query or description of what you're looking for */
  query?: string
  /** Preferred namespace (e.g., 'docs', 'repo') */
  namespace?: string
  /** Resource type hint (e.g., 'code', 'docs', 'memory') */
  resourceType?: string
}

export interface RouteRecommendation {
  source: string
  confidence: number
  reason: string
  suggestedParams: Record<string, unknown>
  example: string
}

export interface CtxRouteData {
  intent: RouteIntent
  query?: string
  recommendations: RouteRecommendation[]
  workflow?: string[]
}

/**
 * Intent to kind mapping
 */
const INTENT_KIND_MAP: Record<RouteIntent, ContextKind[]> = {
  search: ['search'],
  browse: ['index'],
  read: ['open', 'get'],
  lookup: ['get', 'open'],
  explore: ['index', 'search'],
  remember: ['get'],  // Memory tools handle writing
  recall: ['get', 'search'],
  auto: ['search', 'index', 'open', 'get']
}

/**
 * Keywords that suggest specific intents
 */
const INTENT_KEYWORDS: Record<string, RouteIntent> = {
  // Search intent
  'find': 'search',
  'search': 'search',
  'look for': 'search',
  'where': 'search',
  'which': 'search',
  'query': 'search',

  // Browse intent
  'list': 'browse',
  'show': 'browse',
  'overview': 'browse',
  'all': 'browse',
  'index': 'browse',
  'catalog': 'browse',

  // Read intent
  'read': 'read',
  'open': 'read',
  'view': 'read',
  'content': 'read',
  'details': 'read',

  // Lookup intent
  'get': 'lookup',
  'fetch': 'lookup',
  'retrieve': 'lookup',
  'specific': 'lookup',

  // Explore intent
  'explore': 'explore',
  'understand': 'explore',
  'structure': 'explore',
  'how': 'explore',

  // Remember intent
  'remember': 'remember',
  'store': 'remember',
  'save': 'remember',
  'add': 'remember',

  // Recall intent
  'recall': 'recall',
  'what did': 'recall',
  'previous': 'recall',
  'history': 'recall'
}

/**
 * Namespace hints from keywords
 */
const NAMESPACE_HINTS: Record<string, string[]> = {
  'code': ['repo'],
  'file': ['repo'],
  'function': ['repo'],
  'class': ['repo'],
  'symbol': ['repo'],
  'document': ['docs'],
  'doc': ['docs'],
  'guide': ['docs'],
  'api': ['docs', 'repo'],
  'memory': ['memory'],
  'fact': ['facts'],
  'decision': ['decisions'],
  'session': ['session'],
  'conversation': ['session'],
  'git': ['repo']
}

/**
 * Detect intent from query
 */
function detectIntent(query: string): RouteIntent {
  const lowerQuery = query.toLowerCase()

  for (const [keyword, intent] of Object.entries(INTENT_KEYWORDS)) {
    if (lowerQuery.includes(keyword)) {
      return intent
    }
  }

  // Default heuristics
  if (lowerQuery.includes('?')) return 'search'
  if (lowerQuery.startsWith('what') || lowerQuery.startsWith('how')) return 'explore'

  return 'search' // Default to search
}

/**
 * Detect namespace hints from query
 */
function detectNamespaceHints(query: string): string[] {
  const lowerQuery = query.toLowerCase()
  const hints: Set<string> = new Set()

  for (const [keyword, namespaces] of Object.entries(NAMESPACE_HINTS)) {
    if (lowerQuery.includes(keyword)) {
      for (const ns of namespaces) {
        hints.add(ns)
      }
    }
  }

  return Array.from(hints)
}

/**
 * Score a source for a given intent and query
 */
function scoreSource(
  source: ContextSource,
  intent: RouteIntent,
  query: string | undefined,
  preferredNamespace: string | undefined,
  namespaceHints: string[]
): { score: number; reason: string } {
  let score = 0
  const reasons: string[] = []

  // Kind match
  const preferredKinds = INTENT_KIND_MAP[intent] ?? INTENT_KIND_MAP.auto
  if (preferredKinds.includes(source.kind)) {
    score += 40
    reasons.push(`${source.kind} matches ${intent} intent`)
  }

  // Namespace preference
  if (preferredNamespace && source.namespace === preferredNamespace) {
    score += 30
    reasons.push(`matches preferred namespace`)
  }

  // Namespace hints from query
  if (namespaceHints.includes(source.namespace)) {
    score += 20
    reasons.push(`namespace relevant to query`)
  }

  // Cost tier preference (prefer cheaper)
  if (source.costTier === 'cheap') {
    score += 10
    reasons.push(`cost-effective`)
  } else if (source.costTier === 'medium') {
    score += 5
  }

  // Query keyword match in description
  if (query) {
    const lowerDesc = source.description.toLowerCase()
    const queryWords = query.toLowerCase().split(/\s+/)
    const matchCount = queryWords.filter(w => w.length > 2 && lowerDesc.includes(w)).length
    if (matchCount > 0) {
      score += matchCount * 5
      reasons.push(`description matches query`)
    }
  }

  return {
    score,
    reason: reasons.join(', ') || 'general match'
  }
}

/**
 * Generate suggested params for a source based on query
 */
function generateSuggestedParams(
  source: ContextSource,
  query: string | undefined
): Record<string, unknown> {
  const params: Record<string, unknown> = {}

  if (!source.params) return params

  // Find query-like params
  const queryParams = source.params.filter(p =>
    ['query', 'q', 'search', 'keyword', 'pattern'].includes(p.name.toLowerCase())
  )

  if (queryParams.length > 0 && query) {
    params[queryParams[0]!.name] = query
  }

  // Add defaults for required params without values
  for (const p of source.params) {
    if (p.required && !(p.name in params)) {
      if (p.default !== undefined) {
        params[p.name] = p.default
      } else if (p.type === 'string') {
        params[p.name] = `<${p.name}>`
      } else if (p.type === 'number') {
        params[p.name] = 10
      } else if (p.type === 'boolean') {
        params[p.name] = true
      }
    }
  }

  return params
}

/**
 * Generate example call
 */
function generateExample(source: ContextSource, params: Record<string, unknown>): string {
  if (Object.keys(params).length === 0) {
    return `ctx.get("${source.id}")`
  }
  return `ctx.get("${source.id}", ${JSON.stringify(params)})`
}

/**
 * Generate workflow suggestion
 */
function generateWorkflow(
  intent: RouteIntent,
  recommendations: RouteRecommendation[]
): string[] {
  const workflow: string[] = []

  switch (intent) {
    case 'search':
      workflow.push('1. Use the recommended search source to find candidates')
      if (recommendations.some(r => r.source.includes('.open'))) {
        workflow.push('2. Use the open source to read top results')
      }
      workflow.push('3. Check coverage.complete - if false, refine query or increase limit')
      break

    case 'browse':
      workflow.push('1. Use the index source to get an overview')
      workflow.push('2. If needed, use search to find specific items')
      workflow.push('3. Use open to read details of interesting items')
      break

    case 'read':
      workflow.push('1. If you know the path, use open directly')
      workflow.push('2. Otherwise, search first to find the right resource')
      workflow.push('3. Check coverage - use startLine/offset to continue reading')
      break

    case 'explore':
      workflow.push('1. Start with ctx.catalog to see available sources')
      workflow.push('2. Use index sources to understand structure')
      workflow.push('3. Use search to find specific areas of interest')
      break

    case 'remember':
      workflow.push('1. Use tools (not context sources) to store information')
      workflow.push('2. For facts: use fact-remember tool')
      workflow.push('3. For memory: use memory-set tool')
      break

    case 'recall':
      workflow.push('1. Check session.recent for recent context')
      workflow.push('2. Use facts.list or memory.get for stored information')
      workflow.push('3. Use session.search if you need older conversation history')
      break

    default:
      workflow.push('1. Start with the top recommendation')
      workflow.push('2. If results are insufficient, try alternatives')
      workflow.push('3. Use ctx.describe for detailed source documentation')
  }

  return workflow
}

export const ctxRoute: ContextSource<CtxRouteParams, CtxRouteData> = defineContextSource({
  id: 'ctx.route',
  kind: 'get',
  description: 'Get routing recommendations for context sources. Suggests the best source based on your intent and query.',
  shortDescription: 'Get routing recommendations',
  resourceTypes: [],
  params: [
    {
      name: 'intent',
      type: 'string',
      required: true,
      description: 'What you want to do',
      enum: ['search', 'browse', 'read', 'lookup', 'explore', 'remember', 'recall', 'auto']
    },
    { name: 'query', type: 'string', required: false, description: 'Query or description of what you need' },
    { name: 'namespace', type: 'string', required: false, description: 'Preferred namespace (e.g., "docs", "repo")' },
    { name: 'resourceType', type: 'string', required: false, description: 'Resource type hint (e.g., "code", "docs")' }
  ],
  examples: [
    {
      description: 'Find code',
      params: { intent: 'search', query: 'authentication function' },
      resultSummary: 'Recommends repo.search with query'
    },
    {
      description: 'Browse documents',
      params: { intent: 'browse', namespace: 'docs' },
      resultSummary: 'Recommends docs.index'
    },
    {
      description: 'Auto-detect intent',
      params: { intent: 'auto', query: 'find all API endpoints' },
      resultSummary: 'Detects search intent, recommends repo.search'
    }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 5 * 60 * 1000 // 5 minutes
  },
  render: {
    maxTokens: 1000,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<CtxRouteData>> => {
    const startTime = Date.now()

    // Validate required param
    if (!params?.intent) {
      return createErrorResult('Missing required field "intent"', {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Provide intent: ctx.get("ctx.route", { intent: "search", query: "..." })',
          'Valid intents: search, browse, read, lookup, explore, remember, recall, auto'
        ]
      })
    }

    // Get all sources
    const allSources = runtime.contextManager.getAllSources()

    // Determine effective intent
    let effectiveIntent = params.intent
    if (effectiveIntent === 'auto' && params.query) {
      effectiveIntent = detectIntent(params.query)
    }

    // Get namespace hints from query
    const namespaceHints = params.query ? detectNamespaceHints(params.query) : []

    // Score and rank sources
    const scored = allSources
      .filter(s => !s.id.startsWith('ctx.')) // Exclude meta sources from recommendations
      .map(source => {
        const { score, reason } = scoreSource(
          source,
          effectiveIntent,
          params.query,
          params.namespace,
          namespaceHints
        )
        return { source, score, reason }
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)

    // Build recommendations
    const recommendations: RouteRecommendation[] = scored.map(item => {
      const suggestedParams = generateSuggestedParams(item.source, params.query)
      return {
        source: item.source.id,
        confidence: Math.min(item.score / 100, 1),
        reason: item.reason,
        suggestedParams,
        example: generateExample(item.source, suggestedParams)
      }
    })

    // Generate workflow
    const workflow = generateWorkflow(effectiveIntent, recommendations)

    // Render output
    const lines: string[] = [
      '# Routing Recommendations',
      '',
      `**Intent:** ${effectiveIntent}${params.intent === 'auto' ? ' (auto-detected)' : ''}`,
    ]

    if (params.query) {
      lines.push(`**Query:** "${params.query}"`)
    }
    if (params.namespace) {
      lines.push(`**Namespace:** ${params.namespace}`)
    }
    lines.push('')

    if (recommendations.length === 0) {
      lines.push('*No matching sources found.*')
      lines.push('')
      lines.push('**Suggestions:**')
      lines.push('- Use ctx.get("ctx.catalog") to see all available sources')
      lines.push('- Try a different intent or remove namespace filter')
    } else {
      lines.push('## Recommendations')
      lines.push('')

      for (let i = 0; i < recommendations.length; i++) {
        const r = recommendations[i]!
        const confidencePercent = Math.round(r.confidence * 100)
        lines.push(`### ${i + 1}. ${r.source} (${confidencePercent}% match)`)
        lines.push('')
        lines.push(`**Why:** ${r.reason}`)
        lines.push('')
        lines.push('```')
        lines.push(r.example)
        lines.push('```')
        lines.push('')
      }

      lines.push('## Suggested Workflow')
      lines.push('')
      for (const step of workflow) {
        lines.push(step)
      }
      lines.push('')
    }

    lines.push('## Help')
    lines.push('- Use `ctx.get("ctx.describe", { id: "..." })` for full documentation')
    lines.push('- Use `ctx.get("ctx.catalog")` to see all sources')

    return createSuccessResult(
      {
        intent: effectiveIntent,
        query: params.query,
        recommendations,
        workflow
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
          source: 'ctx.route',
          kind: 'get',
          paramsUsed: {
            intent: params.intent,
            query: params.query,
            namespace: params.namespace
          }
        },
        next: recommendations.length > 0 ? [
          {
            source: recommendations[0]!.source,
            params: recommendations[0]!.suggestedParams,
            why: 'Top recommendation',
            confidence: recommendations[0]!.confidence
          }
        ] : undefined
      }
    )
  }
})
