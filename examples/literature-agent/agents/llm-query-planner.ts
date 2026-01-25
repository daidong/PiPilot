/**
 * LLM-Powered Query Planner Agent
 *
 * Uses direct LLM calls to analyze research requests and create
 * optimized search strategies with multiple query variations.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'

export interface QueryPlannerConfig {
  apiKey: string
  model?: string
}

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

export interface LLMQueryPlannerAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
}

const SYSTEM_PROMPT = `You are a Query Planning Specialist for academic literature research.

Your task is to analyze a user's research request and create an optimized search strategy.

You MUST respond with ONLY a valid JSON object (no markdown, no explanation) in this exact format:
{
  "originalRequest": "the user's original request",
  "searchQueries": ["query1", "query2", "query3"],
  "searchStrategy": {
    "focusAreas": ["area1", "area2"],
    "suggestedSources": ["semantic_scholar", "arxiv", "openalex"],
    "timeRange": { "start": 2020, "end": 2024 }
  },
  "expectedTopics": ["topic1", "topic2"]
}

Guidelines for Query Generation:
1. Generate 2-3 diverse search queries that cover different aspects
2. Use academic terminology and synonyms
3. Include both broad and specific queries
4. Consider technical terms, acronyms, and related concepts

IMPORTANT: Output ONLY the JSON object, nothing else.`

/**
 * Create an LLM-powered Query Planner Agent
 */
export function createLLMQueryPlannerAgent(config: QueryPlannerConfig): LLMQueryPlannerAgent {
  const { apiKey, model = 'gpt-4o-mini' } = config

  const openai = createOpenAI({ apiKey })

  return {
    id: 'query-planner',

    async run(input: string): Promise<{ success: boolean; output: string }> {
      console.log('  [QueryPlanner-LLM] Analyzing research request with LLM...')

      // Parse input to get the user request
      let userRequest: string
      try {
        const parsed = JSON.parse(input)
        userRequest = parsed.userRequest || parsed.request || input
      } catch {
        userRequest = input
      }

      try {
        const result = await generateText({
          model: openai(model),
          system: SYSTEM_PROMPT,
          prompt: `Analyze this research request and create a search strategy:\n\n"${userRequest}"`,
          maxTokens: 1024,
          temperature: 0.3
        })

        // Extract JSON from response
        let jsonOutput = result.text.trim()

        // Remove markdown code blocks if present
        const jsonMatch = jsonOutput.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (jsonMatch) {
          jsonOutput = jsonMatch[1].trim()
        }

        // Parse and validate
        const parsed = JSON.parse(jsonOutput) as QueryPlan
        console.log('  [QueryPlanner-LLM] Generated queries:', parsed.searchQueries?.join(', '))

        return { success: true, output: JSON.stringify(parsed) }
      } catch (error) {
        console.error('  [QueryPlanner-LLM] Error:', error)
        return {
          success: false,
          output: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' })
        }
      }
    },

    async destroy() {
      // No cleanup needed
    }
  }
}
