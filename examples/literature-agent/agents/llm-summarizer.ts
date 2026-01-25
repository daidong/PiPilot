/**
 * LLM-Powered Summarizer Agent
 *
 * Uses a real LLM to synthesize research findings into
 * a comprehensive, well-organized summary.
 */

import { defineAgent, packs } from '../../../src/index.js'
import type { AgentInstance } from '../../../src/types/agent.js'

export interface SummarizerConfig {
  apiKey: string
  projectPath?: string
  model?: string
}

export interface LLMSummarizerAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
}

const SUMMARIZER_IDENTITY = `You are a Research Synthesis Specialist who creates comprehensive literature review summaries.

Your task is to take reviewed academic papers and create an insightful, well-organized research summary.

## Output Format

You MUST output a JSON object in this format:
\`\`\`json
{
  "title": "Literature Review: [Topic]",
  "overview": "A 2-3 sentence executive summary of findings",
  "papers": [
    {
      "title": "Paper Title",
      "authors": "Author1, Author2 et al.",
      "year": 2023,
      "venue": "Conference/Journal",
      "citations": 100,
      "summary": "Key contribution in 1-2 sentences",
      "url": "paper url"
    }
  ],
  "themes": [
    {
      "name": "Theme Name",
      "papers": ["Paper 1", "Paper 2"],
      "insight": "Key insight about this theme"
    }
  ],
  "keyFindings": [
    "Finding 1",
    "Finding 2"
  ],
  "researchGaps": [
    "Gap 1",
    "Gap 2"
  ],
  "limitations": [
    "Limitation of this review"
  ],
  "suggestedFollowUp": [
    "Suggestion 1",
    "Suggestion 2"
  ]
}
\`\`\`

## Guidelines

1. **Overview**: Capture the main thrust of the research area in 2-3 sentences
2. **Papers**: List top 5-10 most relevant papers, sorted by importance
3. **Themes**: Group papers into 2-4 thematic categories
4. **Key Findings**: Extract 3-5 main takeaways from the literature
5. **Research Gaps**: Identify 2-3 areas needing more research
6. **Limitations**: Note any limitations of this literature review

## Quality Standards

- Be objective and balanced
- Highlight seminal/highly-cited works
- Note emerging trends vs. established methods
- Provide actionable insights for researchers

IMPORTANT: Output ONLY the JSON object.`

const SUMMARIZER_CONSTRAINTS = [
  'Output ONLY valid JSON',
  'Include 5-10 most relevant papers',
  'Group into 2-4 clear themes',
  'Extract actionable key findings',
  'Be objective and scholarly in tone',
  'Cite specific papers when making claims'
]

/**
 * Create an LLM-powered Summarizer Agent
 */
export function createLLMSummarizerAgent(config: SummarizerConfig): LLMSummarizerAgent {
  const { apiKey, projectPath = process.cwd(), model = 'gpt-4o-mini' } = config

  const agentDef = defineAgent({
    id: 'summarizer-llm',
    name: 'Research Summarizer Agent',
    identity: SUMMARIZER_IDENTITY,
    constraints: SUMMARIZER_CONSTRAINTS,
    packs: [packs.safe()],
    model: { default: model, maxTokens: 4096 },
    maxSteps: 3
  })

  let agentInstance: AgentInstance | null = null

  const getAgent = () => {
    if (!agentInstance) {
      agentInstance = agentDef({ apiKey, projectPath })
    }
    return agentInstance
  }

  return {
    id: 'summarizer',

    async run(input: string): Promise<{ success: boolean; output: string }> {
      console.log('  [Summarizer-LLM] Creating research synthesis with LLM...')

      const agent = getAgent()

      // Parse input (review results)
      let reviewData: {
        relevantPapers?: Array<{
          id?: string
          title?: string
          authors?: string[] | string
          year?: number
          abstract?: string
          venue?: string
          citationCount?: number
          url?: string
          relevanceScore?: number
          relevanceReason?: string
        }>
        coverage?: {
          coveredTopics?: string[]
          missingTopics?: string[]
        }
      }

      try {
        reviewData = JSON.parse(input)
      } catch {
        return { success: false, output: JSON.stringify({ error: 'Invalid input format' }) }
      }

      const papers = reviewData.relevantPapers || []
      const coverage = reviewData.coverage || {}

      console.log(`  [Summarizer-LLM] Synthesizing ${papers.length} papers...`)

      // Build paper details for the LLM
      const paperDetails = papers.map((p, i) => `
Paper ${i + 1}:
- Title: ${p.title || 'Unknown'}
- Authors: ${Array.isArray(p.authors) ? p.authors.slice(0, 3).join(', ') : p.authors || 'Unknown'}
- Year: ${p.year || 'N/A'}
- Venue: ${p.venue || 'N/A'}
- Citations: ${p.citationCount || 'N/A'}
- URL: ${p.url || 'N/A'}
- Relevance Score: ${p.relevanceScore || 'N/A'}/10
- Relevance Reason: ${p.relevanceReason || 'N/A'}
- Abstract: ${(p.abstract || '').slice(0, 400)}
`).join('\n')

      const prompt = `Create a comprehensive literature review summary from these papers.

${papers.length > 0 ? `Papers (${papers.length} total):
${paperDetails}` : 'No papers provided.'}

Coverage Analysis:
- Covered Topics: ${coverage.coveredTopics?.join(', ') || 'Not specified'}
- Missing Topics: ${coverage.missingTopics?.join(', ') || 'None identified'}

Create a well-organized research summary with:
1. Executive overview
2. Top papers with brief summaries
3. Thematic groupings
4. Key findings
5. Research gaps
6. Suggested follow-up

Output ONLY the JSON summary object.`

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

        try {
          const parsed = JSON.parse(jsonOutput)
          console.log(`  [Summarizer-LLM] Summary created: ${parsed.papers?.length || 0} papers, ${parsed.themes?.length || 0} themes`)
          return { success: true, output: JSON.stringify(parsed) }
        } catch {
          const jsonStart = jsonOutput.indexOf('{')
          const jsonEnd = jsonOutput.lastIndexOf('}')
          if (jsonStart !== -1 && jsonEnd !== -1) {
            const extracted = jsonOutput.slice(jsonStart, jsonEnd + 1)
            try {
              const parsed = JSON.parse(extracted)
              console.log(`  [Summarizer-LLM] Summary created: ${parsed.papers?.length || 0} papers, ${parsed.themes?.length || 0} themes`)
              return { success: true, output: JSON.stringify(parsed) }
            } catch {
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
