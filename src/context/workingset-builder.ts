/**
 * WorkingSet Builder - RFC-009
 *
 * Assembles WorkingSet Cards per request from multiple signals.
 * WorkingSet is runtime-only and never persisted.
 *
 * Sources (in priority order):
 * 1. Explicit: @mention or UI "Add to Working Set"
 * 2. Continuity: recently used entities in this session
 * 3. Retrieval: relevance search over titles, tags, summaryCards
 * 4. Index: low-cost index lines for "potentially useful" items
 */

import type {
  WorkingSetItem,
  WorkingSetPlan,
  EntityShape,
  EntityIndex,
  WorkingSetResolvedEntity
} from '../types/memory-entity.js'
import type { ContextPhase, ContextFragment, AssemblyContext } from '../types/context-pipeline.js'
import { PHASE_PRIORITIES, DEFAULT_BUDGETS } from './pipeline.js'
import { ShapeDegrader } from './shape-degrader.js'
import { countTokens } from '../utils/tokenizer.js'

export type { EntityIndex, WorkingSetResolvedEntity } from '../types/memory-entity.js'

// ============ Configuration ============

/**
 * Configuration for WorkingSet Builder
 */
export interface WorkingSetBuilderConfig {
  /**
   * Maximum number of items in WorkingSet
   * Default: 30
   */
  maxItems?: number

  /**
   * Token budget for WorkingSet
   * Default: 8000
   */
  tokenBudget?: number

  /**
   * Continuity window in turns
   * Default: 6
   */
  continuityTurns?: number

  /**
   * Continuity window in minutes
   * Default: 30
   */
  continuityMinutes?: number

  /**
   * Default shape for WorkingSet items
   * Default: 'card'
   */
  defaultShape?: EntityShape

  /**
   * Enable retrieval source
   * Default: true
   */
  enableRetrieval?: boolean

  /**
   * Maximum retrieval results
   * Default: 10
   */
  maxRetrievalResults?: number

  /**
   * Minimum relevance score for retrieval (0-1)
   * Default: 0.3
   */
  minRelevanceScore?: number
}

const DEFAULT_CONFIG: Required<WorkingSetBuilderConfig> = {
  maxItems: 30,
  tokenBudget: 8000,
  continuityTurns: 6,
  continuityMinutes: 30,
  defaultShape: 'card',
  enableRetrieval: true,
  maxRetrievalResults: 10,
  minRelevanceScore: 0.3
}

// ============ Continuity Tracking ============

/**
 * Entry in continuity tracker
 */
export interface ContinuityEntry {
  entityId: string
  lastUsedAt: Date
  lastUsedTurn: number
  useCount: number
  useType: 'mention' | 'tool-access' | 'update'
}

/**
 * Continuity tracker for tracking recently used entities
 */
export class ContinuityTracker {
  private entries: Map<string, ContinuityEntry> = new Map()
  private currentTurn: number = 0

  /**
   * Record entity usage
   */
  recordUsage(entityId: string, useType: ContinuityEntry['useType']): void {
    const existing = this.entries.get(entityId)
    if (existing) {
      existing.lastUsedAt = new Date()
      existing.lastUsedTurn = this.currentTurn
      existing.useCount++
      existing.useType = useType
    } else {
      this.entries.set(entityId, {
        entityId,
        lastUsedAt: new Date(),
        lastUsedTurn: this.currentTurn,
        useCount: 1,
        useType
      })
    }
  }

  /**
   * Advance turn counter
   */
  advanceTurn(): void {
    this.currentTurn++
  }

  /**
   * Get current turn
   */
  getCurrentTurn(): number {
    return this.currentTurn
  }

  /**
   * Get recent entities within window
   */
  getRecentEntities(
    maxTurnsAgo: number,
    maxMinutesAgo: number
  ): ContinuityEntry[] {
    const now = new Date()
    const minTurn = this.currentTurn - maxTurnsAgo
    const minTime = new Date(now.getTime() - maxMinutesAgo * 60 * 1000)

    return Array.from(this.entries.values())
      .filter(entry =>
        entry.lastUsedTurn >= minTurn ||
        entry.lastUsedAt >= minTime
      )
      .sort((a, b) => {
        // Sort by turn first, then by time
        if (a.lastUsedTurn !== b.lastUsedTurn) {
          return b.lastUsedTurn - a.lastUsedTurn
        }
        return b.lastUsedAt.getTime() - a.lastUsedAt.getTime()
      })
  }

  /**
   * Calculate decay score for an entry (0-1)
   * Higher score = more recent
   */
  calculateDecayScore(entry: ContinuityEntry): number {
    const turnDecay = Math.exp(-0.3 * (this.currentTurn - entry.lastUsedTurn))
    const useBonus = Math.min(entry.useCount * 0.1, 0.3)
    return Math.min(turnDecay + useBonus, 1)
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.entries.clear()
    this.currentTurn = 0
  }
}

// ============ Retrieval ============

/**
 * Search entities by query
 */
export function searchEntities(
  query: string,
  entities: EntityIndex[],
  maxResults: number = 10,
  minScore: number = 0.3
): Array<{ entity: EntityIndex; score: number }> {
  if (!query.trim()) {
    return []
  }

  const queryTerms = tokenize(query)
  const results: Array<{ entity: EntityIndex; score: number }> = []

  for (const entity of entities) {
    // Skip Project Cards (they're handled separately)
    if (entity.projectCard) {
      continue
    }

    const score = calculateRelevanceScore(queryTerms, entity)
    if (score >= minScore) {
      results.push({ entity, score })
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score)

  return results.slice(0, maxResults)
}

/**
 * Tokenize text into lowercase terms
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter(term => term.length > 2)
}

/**
 * Calculate relevance score for an entity
 */
function calculateRelevanceScore(queryTerms: string[], entity: EntityIndex): number {
  const titleTerms = tokenize(entity.title)
  const tagTerms = entity.tags.map(t => t.toLowerCase())
  const summaryTerms = tokenize(entity.summaryCard)

  let score = 0
  let matchedTerms = 0

  for (const queryTerm of queryTerms) {
    // Title match (highest weight)
    if (titleTerms.some(t => t.includes(queryTerm) || queryTerm.includes(t))) {
      score += 0.4
      matchedTerms++
    }

    // Tag match (high weight)
    if (tagTerms.some(t => t.includes(queryTerm) || queryTerm.includes(t))) {
      score += 0.3
      matchedTerms++
    }

    // Summary match (moderate weight)
    if (summaryTerms.some(t => t.includes(queryTerm))) {
      score += 0.2
      matchedTerms++
    }
  }

  // Normalize by query length
  if (queryTerms.length > 0) {
    score = score / queryTerms.length
  }

  // Bonus for matching multiple terms
  if (matchedTerms > 1) {
    score *= (1 + matchedTerms * 0.1)
  }

  return Math.min(score, 1)
}

// ============ WorkingSet Builder ============

/**
 * Input for building WorkingSet
 */
export interface WorkingSetBuildInput {
  /** Explicit entity IDs (from @mentions or UI selection) */
  explicitIds?: string[]

  /** Current user query (for retrieval) */
  query?: string

  /** All available entities for retrieval */
  availableEntities?: EntityIndex[]

  /** Continuity tracker for recent usage */
  continuityTracker?: ContinuityTracker
}

/**
 * Build WorkingSet from multiple sources
 */
export async function buildWorkingSet(
  input: WorkingSetBuildInput,
  config: WorkingSetBuilderConfig = {}
): Promise<WorkingSetPlan> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const items: WorkingSetItem[] = []
  const seenIds = new Set<string>()

  // 1. Explicit source (highest priority)
  if (input.explicitIds) {
    for (const entityId of input.explicitIds) {
      if (!seenIds.has(entityId)) {
        seenIds.add(entityId)
        items.push({
          entityId,
          source: 'explicit',
          requestedShape: cfg.defaultShape,
          relevanceScore: 1.0,
          reason: 'Explicitly selected or mentioned'
        })
      }
    }
  }

  // 2. Continuity source
  if (input.continuityTracker) {
    const recentEntries = input.continuityTracker.getRecentEntities(
      cfg.continuityTurns,
      cfg.continuityMinutes
    )

    for (const entry of recentEntries) {
      if (!seenIds.has(entry.entityId) && items.length < cfg.maxItems) {
        seenIds.add(entry.entityId)
        const decayScore = input.continuityTracker.calculateDecayScore(entry)
        items.push({
          entityId: entry.entityId,
          source: 'continuity',
          requestedShape: cfg.defaultShape,
          relevanceScore: decayScore * 0.8, // Continuity max 0.8
          reason: `Recently used (${entry.useType}, turn ${entry.lastUsedTurn})`
        })
      }
    }
  }

  // 3. Retrieval source
  if (cfg.enableRetrieval && input.query && input.availableEntities) {
    const searchResults = searchEntities(
      input.query,
      input.availableEntities,
      cfg.maxRetrievalResults,
      cfg.minRelevanceScore
    )

    for (const result of searchResults) {
      if (!seenIds.has(result.entity.id) && items.length < cfg.maxItems) {
        seenIds.add(result.entity.id)
        items.push({
          entityId: result.entity.id,
          source: 'retrieval',
          requestedShape: cfg.defaultShape,
          relevanceScore: result.score * 0.7, // Retrieval max 0.7
          reason: `Matched query: "${input.query.slice(0, 50)}..."`
        })
      }
    }
  }

  // 4. Index hints (remaining budget for potentially useful items)
  // This would include items that might be relevant but weren't strongly matched
  // For now, we'll just add remaining high-value items as index lines
  if (input.availableEntities && items.length < cfg.maxItems) {
    // Sort by some heuristic (e.g., recency, tag overlap)
    const remaining = input.availableEntities
      .filter(e => !seenIds.has(e.id) && !e.projectCard)
      .slice(0, Math.min(5, cfg.maxItems - items.length))

    for (const entity of remaining) {
      seenIds.add(entity.id)
      items.push({
        entityId: entity.id,
        source: 'index',
        requestedShape: 'index-line', // Minimal shape for index hints
        relevanceScore: 0.2,
        reason: 'Index hint (available for ctx-expand)'
      })
    }
  }

  // Calculate estimated tokens
  let estimatedTokens = 0
  for (const item of items) {
    // Rough estimate based on shape
    switch (item.requestedShape) {
      case 'full':
        estimatedTokens += 500 // Estimate
        break
      case 'excerpt':
        estimatedTokens += 200
        break
      case 'card':
        estimatedTokens += 100
        break
      case 'index-line':
        estimatedTokens += 20
        break
    }
  }

  return {
    items,
    estimatedTokens,
    createdAt: new Date().toISOString()
  }
}

// ============ WorkingSet Phase ============

/**
 * Configuration for WorkingSet phase
 */
export interface WorkingSetPhaseConfig extends WorkingSetBuilderConfig {
  /** Entity index provider */
  getEntityIndex?: (ctx: AssemblyContext) => Promise<EntityIndex[]>
  /** Entity resolver (id -> resolved content) */
  resolveEntity?: (id: string, ctx: AssemblyContext) => Promise<WorkingSetResolvedEntity | null>
  /** Explicit WorkingSet IDs */
  getExplicitIds?: (ctx: AssemblyContext) => string[]
  /** Query used for retrieval */
  getQuery?: (ctx: AssemblyContext) => string | undefined
  /** Custom header text */
  header?: string
}

/**
 * Create a context phase for WorkingSet
 */
export function createWorkingSetPhase(config: WorkingSetPhaseConfig = {}): ContextPhase & {
  recordUsage: (entityId: string, useType: ContinuityEntry['useType']) => void
  advanceTurn: () => void
  getContinuityTracker: () => ContinuityTracker
  clearContinuity: () => void
} {
  const continuityTracker = new ContinuityTracker()
  const degrader = new ShapeDegrader()

  return {
    id: 'workingset',
    priority: PHASE_PRIORITIES.workingset,
    budget: DEFAULT_BUDGETS.workingset,

    async assemble(ctx: AssemblyContext): Promise<ContextFragment[]> {
      const { runtime } = ctx
      const fragments: ContextFragment[] = []

      const indexProvider = config.getEntityIndex
        ?? ((runtime as any).entityIndexProvider as WorkingSetPhaseConfig['getEntityIndex'] | undefined)
      if (!indexProvider) {
        return fragments
      }

      const availableEntities = await indexProvider(ctx)
      if (!availableEntities || availableEntities.length === 0) {
        return fragments
      }

      const workingSetState = runtime.sessionState.get<{
        explicitIds?: string[]
        query?: string
      }>('workingSet')

      const explicitIds = config.getExplicitIds
        ? config.getExplicitIds(ctx)
        : (workingSetState?.explicitIds ?? [])

      const query = config.getQuery
        ? config.getQuery(ctx)
        : (workingSetState?.query ?? runtime.sessionState.get<string>('latestUserMessage'))

      continuityTracker.advanceTurn()

      const plan = await buildWorkingSet({
        explicitIds,
        query,
        availableEntities,
        continuityTracker
      }, config)

      if (plan.items.length === 0) {
        return fragments
      }

      const resolver = config.resolveEntity
        ?? ((runtime as any).entityResolver as WorkingSetPhaseConfig['resolveEntity'] | undefined)

      const resolvedItems: Array<{ item: WorkingSetItem; entity: WorkingSetResolvedEntity }> = []
      for (const item of plan.items) {
        let entity: WorkingSetResolvedEntity | null = null
        if (resolver) {
          entity = await resolver(item.entityId, ctx)
        }
        if (!entity) {
          const fallback = availableEntities.find(e => e.id === item.entityId)
          if (fallback) {
            entity = buildFallbackResolvedEntity(fallback)
          }
        }
        if (entity) {
          resolvedItems.push({ item, entity })
        }
      }

      if (resolvedItems.length === 0) {
        return fragments
      }

      // Store runtime WorkingSet snapshot for UI/debugging (no content payloads)
      runtime.sessionState.set('workingSetRuntime', {
        createdAt: new Date().toISOString(),
        query,
        explicitIds,
        items: resolvedItems.map(({ item, entity }) => ({
          id: entity.id,
          title: entity.title,
          type: entity.type,
          projectCard: entity.projectCard,
          source: item.source,
          reason: item.reason,
          score: item.relevanceScore,
          requestedShape: item.requestedShape
        }))
      })

      const headerContent = config.header ?? '## Working Set'
      const headerTokens = countTokens(headerContent)
      const allocated = ctx.allocatedBudget ?? ctx.remainingBudget
      const contentBudget = Math.max(0, allocated - headerTokens)

      const degradableItems = resolvedItems.map(({ item, entity }) => ({
        id: entity.id,
        currentShape: item.requestedShape,
        content: {
          full: entity.content.full,
          excerpt: entity.content.excerpt,
          card: entity.content.card ?? entity.summaryCard ?? entity.content.full,
          indexLine: entity.content.indexLine ?? `- ${entity.title} [id:${entity.id}]`
        },
        priority: entity.priority ?? Math.round(item.relevanceScore * 100) ?? 50,
        isProjectCard: false
      }))

      const degraded = degrader.degradeItems(degradableItems, contentBudget)
      const kept = degraded.filter(r => !r.dropped && r.content)

      if (kept.length === 0) {
        return fragments
      }

      fragments.push({
        source: 'workingset:header',
        content: headerContent,
        tokens: headerTokens,
        metadata: { itemCount: kept.length }
      })

      for (const result of kept) {
        const sourceItem = resolvedItems.find(i => i.entity.id === result.id)
        const itemMeta = sourceItem?.item
        fragments.push({
          source: `workingset:${result.id}`,
          content: result.content,
          tokens: result.tokens,
          metadata: {
            shape: result.degradedShape,
            reason: result.reason,
            source: itemMeta?.source,
            score: itemMeta?.relevanceScore,
            requestedShape: itemMeta?.requestedShape
          }
        })

        if (itemMeta) {
          continuityTracker.recordUsage(
            result.id,
            itemMeta.source === 'explicit' ? 'mention'
              : itemMeta.source === 'continuity' ? 'update'
                : 'tool-access'
          )
        }
      }

      return fragments
    },

    enabled(ctx: AssemblyContext): boolean {
      const indexProvider = config.getEntityIndex
        ?? ((ctx.runtime as any).entityIndexProvider as WorkingSetPhaseConfig['getEntityIndex'] | undefined)
      return typeof indexProvider === 'function'
    },

    /**
     * Record entity usage (call from tools)
     */
    recordUsage(entityId: string, useType: ContinuityEntry['useType']): void {
      continuityTracker.recordUsage(entityId, useType)
    },

    /**
     * Advance turn (call after each user message)
     */
    advanceTurn(): void {
      continuityTracker.advanceTurn()
    },

    /**
     * Get continuity tracker (for external access)
     */
    getContinuityTracker(): ContinuityTracker {
      return continuityTracker
    },

    /**
     * Clear continuity (e.g., on session end)
     */
    clearContinuity(): void {
      continuityTracker.clear()
    }
  }
}

function buildFallbackResolvedEntity(entity: EntityIndex): WorkingSetResolvedEntity {
  const summary = entity.summaryCard?.trim() || entity.title
  const cardContent = `### ${entity.title}\n\n${summary}`
  return {
    id: entity.id,
    title: entity.title,
    tags: entity.tags ?? [],
    summaryCard: entity.summaryCard,
    projectCard: entity.projectCard,
    type: entity.type,
    content: {
      full: cardContent,
      card: cardContent,
      indexLine: `- ${entity.title} [id:${entity.id}]`
    }
  }
}
