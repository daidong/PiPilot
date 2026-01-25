/**
 * LLM-Powered Query Planner Agent
 *
 * Uses a real LLM to analyze research requests and create
 * optimized search strategies with multiple query variations.
 */

import { defineAgent, packs } from '../../../src/index.js'
import type { AgentInstance } from '../../../src/types/agent.js'

export interface QueryPlannerConfig {
  apiKey: string
  projectPath?: string
  model?: string
}

export interface LLMQueryPlannerAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
}

const QUERY_PLANNER_IDENTITY = `You are a Query Planning Specialist for academic literature research.

Your task is to analyze a user's research request and create an optimized search strategy.

## Your Output Format

You MUST respond with a valid JSON object in this exact format:
\`\`\`json
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
\`\`\`

## Guidelines for Query Generation

1. Generate 2-3 diverse search queries that cover different aspects of the topic
2. Use academic terminology and synonyms
3. Include both broad and specific queries
4. Consider:
   - Technical terms vs. common terms
   - Acronyms and full names (e.g., "RAG" and "retrieval augmented generation")
   - Related concepts and methodologies

## Examples

For "papers about attention mechanisms in transformers":
- "transformer self-attention mechanism architecture"
- "multi-head attention deep learning"
- "attention neural network survey"

For "recent advances in code generation with LLMs":
- "large language model code generation"
- "neural program synthesis LLM"
- "code completion deep learning 2023"

IMPORTANT: Only output the JSON object, no other text.`

const QUERY_PLANNER_CONSTRAINTS = [
  'Output ONLY valid JSON, no markdown or explanations',
  'Generate exactly 2-3 search queries',
  'Queries should be 3-6 words each',
  'Include academic/technical terminology',
  'Detect time preferences from the request (e.g., "recent" → 2023-2024)'
]

/**
 * Create an LLM-powered Query Planner Agent
 */
export function createLLMQueryPlannerAgent(config: QueryPlannerConfig): LLMQueryPlannerAgent {
  const { apiKey, projectPath = process.cwd(), model = 'gpt-4o-mini' } = config

  // Define the agent
  const agentDef = defineAgent({
    id: 'query-planner-llm',
    name: 'Query Planner Agent',
    identity: QUERY_PLANNER_IDENTITY,
    constraints: QUERY_PLANNER_CONSTRAINTS,
    packs: [packs.safe()], // Only needs basic capabilities
    model: { default: model, maxTokens: 1024 },
    maxSteps: 3
  })

  // Create the agent instance
  let agentInstance: AgentInstance | null = null

  const getAgent = () => {
    if (!agentInstance) {
      agentInstance = agentDef({ apiKey, projectPath })
    }
    return agentInstance
  }

  return {
    id: 'query-planner',

    async run(input: string): Promise<{ success: boolean; output: string }> {
      console.log('  [QueryPlanner-LLM] Analyzing research request with LLM...')

      const agent = getAgent()

      // Parse input to get the user request
      let userRequest: string
      try {
        const parsed = JSON.parse(input)
        userRequest = parsed.userRequest || parsed.request || input
      } catch {
        userRequest = input
      }

      const prompt = `Analyze this research request and create a search strategy:

"${userRequest}"

Remember: Output ONLY the JSON object with searchQueries, searchStrategy, and expectedTopics.`

      try {
        const result = await agent.run(prompt)

        if (!result.success) {
          return { success: false, output: JSON.stringify({ error: result.error }) }
        }

        // Extract JSON from output (handle markdown code blocks)
        let jsonOutput = result.output
        const jsonMatch = jsonOutput.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (jsonMatch) {
          jsonOutput = jsonMatch[1].trim()
        }

        // Validate it's valid JSON
        try {
          const parsed = JSON.parse(jsonOutput)
          console.log('  [QueryPlanner-LLM] Generated queries:', parsed.searchQueries?.join(', '))
          return { success: true, output: JSON.stringify(parsed) }
        } catch {
          // Try to extract JSON from the output
          const jsonStart = jsonOutput.indexOf('{')
          const jsonEnd = jsonOutput.lastIndexOf('}')
          if (jsonStart !== -1 && jsonEnd !== -1) {
            const extracted = jsonOutput.slice(jsonStart, jsonEnd + 1)
            const parsed = JSON.parse(extracted)
            console.log('  [QueryPlanner-LLM] Generated queries:', parsed.searchQueries?.join(', '))
            return { success: true, output: JSON.stringify(parsed) }
          }
          return { success: false, output: JSON.stringify({ error: 'Failed to parse LLM output as JSON', raw: jsonOutput }) }
        }
      } catch (error) {
        return {
          success: false,
          output: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' })
        }
      }
    },

    async destroy() {
      if (agentInstance) {
        await agentInstance.destroy()
        agentInstance = null
      }
    }
  }
}
