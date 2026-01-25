/**
 * Literature Research Agent
 *
 * An agent specialized for academic literature research with a structured workflow:
 *
 * 1. Query Expansion - Use llm-expand to optimize queries for academic search
 * 2. Multi-Source Search - Parallel search across Semantic Scholar, arXiv, OpenAlex
 * 3. Relevance Filtering - Use llm-filter to score and filter results
 * 4. Summary Generation - Present findings with suggestions
 *
 * Session Limits:
 * - Max 3 unique queries (prevents API abuse)
 * - Max 24 papers per session (prevents token explosion)
 * - Each query searched only once (no duplicates)
 */

import {
  defineAgent,
  packs,
  type AgentConfig,
  type AgentRunResult,
  type TraceEvent
} from '../../dist/index.js'

import { literaturePack } from './pack.js'
import { LITERATURE_DEFAULTS } from './types.js'

// Re-export types
export type { Paper, SearchResult, MultiSearchResult, LiteratureConfig } from './types.js'
export { literaturePack } from './pack.js'

/**
 * Extended agent config with literature options
 */
export interface LiteratureAgentConfig extends AgentConfig {
  /** Enable verbose trace output */
  enableTraceOutput?: boolean
  /** Semantic Scholar API key (optional) */
  semanticScholarApiKey?: string
}

/**
 * Literature Research Agent Definition
 */
export const literatureAgentDefinition = defineAgent({
  id: 'literature-researcher',
  name: 'Literature Research Agent',

  identity: `You are an expert academic literature research assistant.
Your job is to help users find and understand academic papers efficiently.

## Your Workflow (ALWAYS follow this sequence)

### Step 1: Query Expansion
When a user asks about a topic, FIRST use \`llm-expand\` to generate optimized search queries:
\`\`\`
llm-expand({
  text: "user's query",
  style: "search",
  domain: "academic",
  numVariations: 3
})
\`\`\`
This generates 2-3 academic search query variations with technical terminology.

### Step 2: Multi-Source Search
Use \`literature_multi_search\` with the expanded queries:
\`\`\`
literature_multi_search({
  queries: [...variations from step 1],
  sources: ["semanticScholar", "arxiv", "openAlex"],
  maxResultsPerSource: 8
})
\`\`\`
This searches Semantic Scholar, arXiv, and OpenAlex in parallel.

### Step 3: Relevance Filtering
Convert papers to filter format and use \`llm-filter\`:
\`\`\`
llm-filter({
  items: papers.map(p => ({
    id: p.id,
    title: p.title,
    description: p.abstract
  })),
  query: "original user query",
  maxItems: 10,
  minScore: 5
})
\`\`\`
This scores each paper 0-10 and keeps only relevant ones.

### Step 4: Present Results
Summarize the findings:
- List papers with title, authors, year, brief description
- Highlight citation counts for influential papers
- Suggest related topics for further exploration

## Available Tools
- \`llm-expand\`: Expand queries for academic search (style: "search", domain: "academic")
- \`literature_multi_search\`: Search multiple academic databases in parallel
- \`llm-filter\`: Filter and score items by relevance to a query

## Example
User: "Find papers about attention in neural networks"

1. llm-expand → ["transformer attention mechanism", "self-attention deep learning", "attention neural network architecture"]
2. literature_multi_search → ~24 papers from 3 sources
3. llm-filter → Top 8-10 most relevant papers with scores
4. Present with summaries and suggestions`,

  constraints: [
    `Maximum ${LITERATURE_DEFAULTS.maxQueriesPerSession} unique search queries per session`,
    `Maximum ${LITERATURE_DEFAULTS.maxPapersPerSession} papers per session`,
    'Each query is searched only once (no duplicates)',
    'ALWAYS use llm-expand before searching',
    'ALWAYS use llm-filter after searching',
    'Map papers to {id, title, description} format for llm-filter',
    'Present papers with: Title, Authors, Year, Citation count, Brief description',
    'Suggest related topics after presenting results',
    'Acknowledge limitations (e.g., rate limits, missing abstracts)'
  ],

  packs: [
    packs.compute(),                    // llm-call, llm-expand, llm-filter
    packs.network({ allowHttp: true }), // fetch (with HTTP for arXiv)
    literaturePack                      // literature_multi_search + session state
  ],

  model: {
    default: 'gpt-4o',
    maxTokens: 16384
  },

  maxSteps: 25
})

/**
 * Create a Literature Research Agent
 */
export function createLiteratureAgent(config: LiteratureAgentConfig) {
  const {
    enableTraceOutput = true,
    semanticScholarApiKey,
    ...baseConfig
  } = config

  return literatureAgentDefinition(baseConfig)
}

// =============================================================================
// Trace Utilities
// =============================================================================

/**
 * Print trace summary from AgentRunResult
 */
export function printTraceSummary(result: AgentRunResult): void {
  const events = result.trace

  console.log('\n' + '='.repeat(60))
  console.log('TRACE SUMMARY')
  console.log('='.repeat(60))
  console.log(`Success: ${result.success}`)
  console.log(`Total Events: ${events.length}`)
  console.log(`Total Duration: ${result.durationMs}ms`)
  console.log(`Steps: ${result.steps}`)

  // Count by type
  const byType: Record<string, number> = {}
  for (const event of events) {
    byType[event.type] = (byType[event.type] ?? 0) + 1
  }

  console.log('\nEvents by Type:')
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`)
  }

  // Show tool calls with timing
  const toolCalls = events.filter(e => e.type === 'tool.call')
  if (toolCalls.length > 0) {
    console.log('\nTool Calls:')
    for (const call of toolCalls) {
      const tool = call.data.tool as string
      const duration = call.durationMs ?? 0
      console.log(`  [Step ${call.step}] ${tool} (${duration}ms)`)
    }
  }

  // Show LLM calls
  const llmCalls = events.filter(e => e.type === 'llm.request' || e.type === 'llm.response')
  if (llmCalls.length > 0) {
    console.log('\nLLM Calls: ' + (llmCalls.length / 2))
  }

  // Show policy events
  const policyEvents = events.filter(e => e.type.startsWith('policy.'))
  if (policyEvents.length > 0) {
    console.log('\nPolicy Events:')
    const policyTypes: Record<string, number> = {}
    for (const pe of policyEvents) {
      policyTypes[pe.type] = (policyTypes[pe.type] ?? 0) + 1
    }
    for (const [type, count] of Object.entries(policyTypes)) {
      console.log(`  ${type}: ${count}`)
    }
  }
}

/**
 * Export trace to JSON file
 */
export async function exportTrace(events: TraceEvent[], filePath: string): Promise<void> {
  const fs = await import('node:fs/promises')
  await fs.writeFile(filePath, JSON.stringify(events, null, 2), 'utf-8')
  console.log(`\nTrace exported to: ${filePath}`)
}

/**
 * Print detailed trace (for debugging)
 */
export function printDetailedTrace(events: TraceEvent[]): void {
  console.log('\n' + '='.repeat(60))
  console.log('DETAILED TRACE')
  console.log('='.repeat(60))

  for (const event of events) {
    console.log(`\n[${event.type}] Step ${event.step}`)
    console.log(`  ID: ${event.id}`)
    console.log(`  Duration: ${event.durationMs ?? 0}ms`)
    console.log(`  Timestamp: ${new Date(event.timestamp).toISOString()}`)
    if (Object.keys(event.data).length > 0) {
      // Truncate large data
      const dataStr = JSON.stringify(event.data)
      const truncated = dataStr.length > 500 ? dataStr.slice(0, 500) + '...' : dataStr
      console.log(`  Data: ${truncated}`)
    }
  }
}

// =============================================================================
// Main (Example Usage)
// =============================================================================

async function main() {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    console.error('Please set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable')
    process.exit(1)
  }

  console.log('Creating Literature Research Agent...\n')
  console.log('Workflow: llm-expand → literature_multi_search → llm-filter → Summary\n')

  const agent = createLiteratureAgent({
    apiKey,
    projectPath: process.cwd(),
    enableTraceOutput: true,
    semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY,

    onStream: (text) => process.stdout.write(text),

    onToolCall: (tool, input) => {
      console.log(`\n[Tool] ${tool}`)
      if (tool === 'fetch') {
        const url = (input as { url?: string })?.url
        if (url) {
          const displayUrl = url.length > 80 ? url.slice(0, 80) + '...' : url
          console.log(`  → ${displayUrl}`)
        }
      } else if (tool === 'llm-expand') {
        const text = (input as { text?: string })?.text
        console.log(`  → Expanding: "${text}"`)
      } else if (tool === 'literature_multi_search') {
        const queries = (input as { queries?: string[] })?.queries
        console.log(`  → Searching ${queries?.length || 0} queries`)
      } else if (tool === 'llm-filter') {
        const count = (input as { items?: unknown[] })?.items?.length
        console.log(`  → Filtering ${count || 0} items`)
      }
    },

    onToolResult: (tool, result) => {
      const r = result as { success: boolean; error?: string; data?: unknown }
      if (r.success) {
        if (tool === 'literature_multi_search') {
          const data = r.data as { papers?: unknown[]; sourcesSucceeded?: string[] }
          console.log(`[Result] Found ${data?.papers?.length || 0} papers from ${data?.sourcesSucceeded?.join(', ')}`)
        } else if (tool === 'llm-filter') {
          const data = r.data as { totalAfter?: number; filteredOut?: number }
          console.log(`[Result] Kept ${data?.totalAfter || 0} items (filtered ${data?.filteredOut || 0})`)
        } else if (tool === 'llm-expand') {
          const data = r.data as { variations?: string[] }
          console.log(`[Result] Generated ${data?.variations?.length || 0} query variants`)
        } else {
          console.log(`[Result] ${tool}: success`)
        }
      } else {
        console.log(`[Result] ${tool}: FAILED - ${r.error}`)
      }
    }
  })

  // Debug: Check registered tools
  console.log('Registered tools:', agent.id)

  try {
    console.log('=' .repeat(60))
    console.log('Running literature search...\n')

    const result = await agent.run(`
      Find recent papers about "retrieval augmented generation" (RAG) for large language models.
      Focus on papers from 2023-2024 that discuss:
      1. Techniques for improving retrieval quality
      2. Integration with LLMs
      3. Evaluation methods

      Please follow the workflow: expand query, search, filter, then present the top papers.
    `)

    console.log('\n' + '='.repeat(60))
    console.log('\n=== Research Complete ===')
    console.log(`Success: ${result.success}`)
    console.log(`Steps: ${result.steps}`)
    console.log(`Duration: ${result.durationMs}ms`)

    if (!result.success) {
      console.error(`Error: ${result.error}`)
    }

    // Print the agent's output (search results and summary)
    if (result.output) {
      console.log('\n' + '='.repeat(60))
      console.log('AGENT OUTPUT')
      console.log('='.repeat(60))
      console.log(result.output)
    }

    // Print trace summary
    printTraceSummary(result)

    // Export trace
    const traceFile = `./literature-agent-trace-${Date.now()}.json`
    await exportTrace(result.trace, traceFile)

    // Uncomment for detailed debugging:
    // printDetailedTrace(result.trace)

  } finally {
    await agent.destroy()
    console.log('\nAgent destroyed.')
  }
}

// Run if executed directly
const isMainModule = process.argv[1]?.includes('literature-agent')
if (isMainModule) {
  main().catch(console.error)
}

export default createLiteratureAgent
