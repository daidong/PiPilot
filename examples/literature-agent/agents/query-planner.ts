/**
 * Query Planner Agent
 *
 * Takes a user's research question and creates an optimized search strategy
 * with multiple query variations for comprehensive coverage.
 */

import type { Paper } from '../types.js'

export interface QueryPlan {
  originalRequest: string
  searchQueries: string[]
  searchStrategy: {
    focusAreas: string[]
    suggestedSources: string[]
    timeRange?: { start: number; end: number }
  }
  expectedTopics: string[]
}

export interface QueryPlannerAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
}

/**
 * Create a Query Planner Agent
 *
 * This is a mock implementation that demonstrates the agent's role.
 * In production, this would use an LLM to generate optimized queries.
 */
export function createQueryPlannerAgent(): QueryPlannerAgent {
  return {
    id: 'query-planner',

    async run(input: string): Promise<{ success: boolean; output: string }> {
      console.log('  [QueryPlanner] Analyzing research request...')

      // Parse input (could be initial request or JSON)
      let request: string
      try {
        const parsed = JSON.parse(input)
        request = parsed.userRequest || parsed.request || input
      } catch {
        request = input
      }

      // Extract key terms (simplified - would use LLM in production)
      const terms = request.toLowerCase()
      const queries: string[] = []
      const focusAreas: string[] = []

      // Generate query variations based on common patterns
      if (terms.includes('retrieval') || terms.includes('rag')) {
        queries.push('retrieval augmented generation LLM')
        queries.push('RAG language model knowledge')
        queries.push('dense retrieval neural information')
        focusAreas.push('Retrieval techniques', 'LLM integration')
      } else if (terms.includes('attention') || terms.includes('transformer')) {
        queries.push('transformer attention mechanism')
        queries.push('self-attention neural network')
        queries.push('multi-head attention deep learning')
        focusAreas.push('Attention mechanisms', 'Transformer architecture')
      } else if (terms.includes('agent') || terms.includes('autonomous')) {
        queries.push('autonomous AI agents planning')
        queries.push('LLM agent tool use')
        queries.push('multi-agent system coordination')
        focusAreas.push('Agent architectures', 'Tool use', 'Planning')
      } else {
        // Generic expansion
        const words = request.split(/\s+/).filter(w => w.length > 3)
        queries.push(words.slice(0, 4).join(' '))
        queries.push(words.slice(0, 3).join(' ') + ' survey')
        queries.push(words.slice(0, 3).join(' ') + ' recent advances')
        focusAreas.push('General overview', 'Recent developments')
      }

      // Detect time range hints
      let timeRange: { start: number; end: number } | undefined
      const yearMatch = request.match(/(\d{4})\s*[-–]\s*(\d{4})/)
      if (yearMatch) {
        timeRange = { start: parseInt(yearMatch[1]), end: parseInt(yearMatch[2]) }
      } else if (terms.includes('recent') || terms.includes('latest')) {
        timeRange = { start: 2023, end: 2024 }
      }

      const plan: QueryPlan = {
        originalRequest: request,
        searchQueries: queries.slice(0, 3), // Max 3 queries
        searchStrategy: {
          focusAreas,
          suggestedSources: ['semantic_scholar', 'arxiv', 'openalex'],
          timeRange
        },
        expectedTopics: focusAreas
      }

      console.log('  [QueryPlanner] Generated plan:', JSON.stringify({
        queries: plan.searchQueries,
        focusAreas: plan.searchStrategy.focusAreas
      }))

      return { success: true, output: JSON.stringify(plan) }
    },

    async destroy() {
      // Cleanup if needed
    }
  }
}
