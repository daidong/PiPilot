/**
 * llm-filter - LLM smart filtering tool
 *
 * Uses LLM to score and filter lists by relevance for:
 * - Search result filtering
 * - Content relevance ranking
 * - Quality screening
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface LLMFilterInput {
  /** List of items to filter */
  items: Array<{
    id: string
    title: string
    description?: string
    [key: string]: unknown
  }>
  /** Filter query/criteria */
  query: string
  /** Max items to return, defaults to 10 */
  maxItems?: number
  /** Minimum relevance score 0-10, defaults to 5 */
  minScore?: number
  /** Scoring criteria description */
  criteria?: string
}

export interface LLMFilterOutput {
  /** Filtered items (with scores) */
  items: Array<{
    id: string
    title: string
    description?: string
    relevanceScore: number
    [key: string]: unknown
  }>
  /** Count before filtering */
  totalBefore: number
  /** Count after filtering */
  totalAfter: number
  /** Count of filtered-out items */
  filteredOut: number
}

export const llmFilter: Tool<LLMFilterInput, LLMFilterOutput> = defineTool({
  name: 'llm-filter',
  description: `Filter items by relevance using LLM. Scores each item 0-10 and returns relevant ones. Items need 'id' and 'title'; 'description' optional.`,

  parameters: {
    items: {
      type: 'array',
      description: 'Items to filter (each with id, title, and optional description)',
      required: true,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' }
        }
      }
    },
    query: {
      type: 'string',
      description: 'Query or criteria to filter by',
      required: true
    },
    maxItems: {
      type: 'number',
      description: 'Maximum items to return (default: 10)',
      required: false,
      default: 10
    },
    minScore: {
      type: 'number',
      description: 'Minimum relevance score 0-10 (default: 5)',
      required: false,
      default: 5
    },
    criteria: {
      type: 'string',
      description: 'Additional scoring criteria or guidelines',
      required: false
    }
  },
  activity: {
    formatCall: (a) => {
      const query = (a.query as string) || ''
      const items = (a.items as unknown[]) || []
      return { label: `Filter ${items.length} items: ${query.slice(0, 30)}`, icon: 'default' }
    },
    formatResult: (r) => {
      const filtered = (r.data as any)?.filtered as unknown[] || (r.data as any)?.items as unknown[] || []
      return { label: `Filtered: ${filtered.length} items`, icon: 'default' }
    }
  },

  execute: async (input, { runtime }) => {
    const { items, query, maxItems = 10, minScore = 5, criteria } = input

    if (items.length === 0) {
      return {
        success: true,
        data: {
          items: [],
          totalBefore: 0,
          totalAfter: 0,
          filteredOut: 0
        }
      }
    }

    // If few items, skip LLM and return all with default score
    if (items.length <= maxItems) {
      const scoredItems = items.map(item => ({ ...item, relevanceScore: 7 }))
      return {
        success: true,
        data: {
          items: scoredItems,
          totalBefore: items.length,
          totalAfter: items.length,
          filteredOut: 0
        }
      }
    }

    // Prepare items for LLM (truncate descriptions to save tokens)
    const itemsForLLM = items.map((item, i) => ({
      index: i,
      title: item.title,
      description: (item.description || '').slice(0, 200)
    }))

    const systemPrompt = `You are an expert at evaluating content relevance.
Score each item's relevance to the query on a scale of 0-10:
- 10: Directly addresses the query
- 7-9: Highly relevant, closely related
- 5-6: Moderately relevant
- 3-4: Tangentially related
- 0-2: Not relevant

${criteria ? `Additional criteria: ${criteria}` : ''}

Output JSON only.`

    const userPrompt = `Query: "${query}"

Items to evaluate:
${itemsForLLM.map(item => `[${item.index}] "${item.title}"${item.description ? `\n    ${item.description}...` : ''}`).join('\n\n')}

Return JSON with relevance scores:
{
  "scores": [
    {"index": 0, "score": 8},
    {"index": 1, "score": 5},
    ...
  ]
}`

    try {
      const result = await runtime.toolRegistry.call('llm-call', {
        prompt: userPrompt,
        systemPrompt,
        maxTokens: 1000,
        jsonMode: true
      }, {
        runtime,
        sessionId: runtime.sessionId,
        step: runtime.step,
        agentId: runtime.agentId
      })

      if (!result.success) {
        // Fallback: return items sorted by original order, limited to maxItems
        const fallbackItems = items
          .slice(0, maxItems)
          .map(item => ({ ...item, relevanceScore: 6 }))

        return {
          success: true,
          data: {
            items: fallbackItems,
            totalBefore: items.length,
            totalAfter: fallbackItems.length,
            filteredOut: items.length - fallbackItems.length
          }
        }
      }

      const llmResult = result.data as { text: string }

      // Parse scores
      let parsed: { scores?: Array<{ index: number; score: number }> }
      try {
        parsed = JSON.parse(llmResult.text)
      } catch {
        const jsonMatch = llmResult.text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
        if (jsonMatch && jsonMatch[1]) {
          parsed = JSON.parse(jsonMatch[1])
        } else {
          throw new Error('Failed to parse LLM response')
        }
      }

      // Apply scores and filter
      type ScoredItem = {
        id: string
        title: string
        description?: string
        relevanceScore: number
        [key: string]: unknown
      }
      const scoredItems: ScoredItem[] = []
      const scores = parsed.scores || []

      for (const { index, score } of scores) {
        if (index >= 0 && index < items.length && score >= minScore) {
          const item = items[index]!
          scoredItems.push({
            ...item,
            id: item.id,
            title: item.title,
            relevanceScore: score
          })
        }
      }

      // Sort by relevance score and limit
      scoredItems.sort((a, b) => b.relevanceScore - a.relevanceScore)
      const finalItems = scoredItems.slice(0, maxItems)

      return {
        success: true,
        data: {
          items: finalItems,
          totalBefore: items.length,
          totalAfter: finalItems.length,
          filteredOut: items.length - finalItems.length
        }
      }
    } catch (error) {
      // Fallback on error
      const fallbackItems = items
        .slice(0, maxItems)
        .map(item => ({ ...item, relevanceScore: 6 }))

      return {
        success: true,
        data: {
          items: fallbackItems,
          totalBefore: items.length,
          totalAfter: fallbackItems.length,
          filteredOut: items.length - fallbackItems.length
        }
      }
    }
  }
})
