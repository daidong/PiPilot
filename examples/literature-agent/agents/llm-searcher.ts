/**
 * LLM-Powered Searcher Agent
 *
 * Uses a real LLM with access to the literature_multi_search tool
 * to perform actual academic database searches.
 */

import { defineAgent, packs } from '../../../src/index.js'
import type { AgentInstance } from '../../../src/types/agent.js'
import { literaturePack } from '../pack.js'

export interface SearcherConfig {
  apiKey: string
  projectPath?: string
  model?: string
}

export interface LLMSearcherAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
}

const SEARCHER_IDENTITY = `You are a Literature Search Specialist who executes academic database searches.

Your task is to use the literature_multi_search tool to find relevant papers.

## Your Workflow

1. Parse the input to get search queries
2. Call literature_multi_search with the queries
3. Return the results in JSON format

## Output Format

After searching, output a JSON object:
\`\`\`json
{
  "papers": [...],
  "totalFound": number,
  "sourcesSearched": ["semantic_scholar", "arxiv", "openalex"],
  "sourcesSucceeded": [...],
  "sourcesFailed": [...],
  "queriesUsed": [...]
}
\`\`\`

## Tool Usage

Use literature_multi_search like this:
- Pass the queries array from the input
- Use all three sources: semantic_scholar, arxiv, openalex
- Set maxPerSource to 8 for good coverage

## Handling Feedback

If the input contains "additionalQueries" (from reviewer feedback), search with those queries to expand results.

IMPORTANT: Always use the literature_multi_search tool - do not make up results!`

const SEARCHER_CONSTRAINTS = [
  'ALWAYS use literature_multi_search tool for searching',
  'Never fabricate or make up paper results',
  'Search all available sources (semantic_scholar, arxiv, openalex)',
  'Return results in the specified JSON format',
  'Handle API errors gracefully'
]

/**
 * Create an LLM-powered Searcher Agent
 */
export function createLLMSearcherAgent(config: SearcherConfig): LLMSearcherAgent {
  const { apiKey, projectPath = process.cwd(), model = 'gpt-4o-mini' } = config

  // Define the agent with literature pack for the search tool
  const agentDef = defineAgent({
    id: 'searcher-llm',
    name: 'Literature Searcher Agent',
    identity: SEARCHER_IDENTITY,
    constraints: SEARCHER_CONSTRAINTS,
    packs: [
      packs.safe(),
      packs.network({ allowHttp: true }), // Required for arXiv HTTP
      literaturePack
    ],
    model: { default: model, maxTokens: 4096 },
    maxSteps: 10 // More steps to handle tool calls
  })

  let agentInstance: AgentInstance | null = null

  const getAgent = () => {
    if (!agentInstance) {
      agentInstance = agentDef({ apiKey, projectPath })
    }
    return agentInstance
  }

  return {
    id: 'searcher',

    async run(input: string): Promise<{ success: boolean; output: string }> {
      console.log('  [Searcher-LLM] Processing search request with LLM...')

      const agent = getAgent()

      // Parse the input
      let searchInput: { searchQueries?: string[]; additionalQueries?: string[]; queries?: string[] }
      try {
        searchInput = JSON.parse(input)
      } catch {
        return { success: false, output: JSON.stringify({ error: 'Invalid input format' }) }
      }

      // Get queries from various possible input formats
      const queries = searchInput.searchQueries || searchInput.additionalQueries || searchInput.queries || []

      if (queries.length === 0) {
        return { success: false, output: JSON.stringify({ error: 'No queries provided' }) }
      }

      console.log('  [Searcher-LLM] Queries:', queries.join(', '))

      const prompt = `Search for academic papers using these queries:
${queries.map((q, i) => `${i + 1}. "${q}"`).join('\n')}

Use the literature_multi_search tool to search semantic_scholar, arxiv, and openalex.

After getting results, output the search results as a JSON object with papers, totalFound, sourcesSearched, etc.`

      try {
        const result = await agent.run(prompt)

        if (!result.success) {
          return { success: false, output: JSON.stringify({ error: result.error }) }
        }

        // Extract JSON from output
        let jsonOutput = result.output
        const jsonMatch = jsonOutput.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (jsonMatch) {
          jsonOutput = jsonMatch[1].trim()
        }

        // Try to parse as JSON
        try {
          const parsed = JSON.parse(jsonOutput)
          console.log('  [Searcher-LLM] Found', parsed.papers?.length || 0, 'papers')
          return { success: true, output: JSON.stringify(parsed) }
        } catch {
          // Try to find JSON in output
          const jsonStart = jsonOutput.indexOf('{')
          const jsonEnd = jsonOutput.lastIndexOf('}')
          if (jsonStart !== -1 && jsonEnd !== -1) {
            const extracted = jsonOutput.slice(jsonStart, jsonEnd + 1)
            try {
              const parsed = JSON.parse(extracted)
              console.log('  [Searcher-LLM] Found', parsed.papers?.length || 0, 'papers')
              return { success: true, output: JSON.stringify(parsed) }
            } catch {
              // Return raw output if can't parse
              return { success: true, output: result.output }
            }
          }
          return { success: true, output: result.output }
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
