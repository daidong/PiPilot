/**
 * LLM-Powered Summarizer Agent
 *
 * Uses direct LLM calls to synthesize research findings into
 * a comprehensive, well-organized summary.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'
import type { Paper } from '../types.js'

export interface SummarizerConfig {
  apiKey: string
  model?: string
}

export interface ResearchSummary {
  title: string
  overview: string
  papers: Array<{
    title: string
    authors: string
    year: number
    venue?: string
    citations?: number
    summary: string
    url: string
  }>
  themes: Array<{
    name: string
    papers: string[]
    insight: string
  }>
  keyFindings: string[]
  researchGaps: string[]
  limitations: string[]
  suggestedFollowUp: string[]
}

export interface LLMSummarizerAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
}

const SYSTEM_PROMPT = `You are a Research Synthesis Specialist who creates comprehensive literature review summaries.

Your task is to take reviewed academic papers and create an insightful, well-organized research summary.

You MUST respond with ONLY a valid JSON object (no markdown, no explanation) in this format:
{
  "title": "Literature Review: [Topic]",
  "overview": "A 2-3 sentence executive summary",
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
      "papers": ["Paper 1 title", "Paper 2 title"],
      "insight": "Key insight about this theme"
    }
  ],
  "keyFindings": ["Finding 1", "Finding 2"],
  "researchGaps": ["Gap 1", "Gap 2"],
  "limitations": ["Limitation of this review"],
  "suggestedFollowUp": ["Suggestion 1", "Suggestion 2"]
}

Guidelines:
1. Overview: Capture the main thrust of the research in 2-3 sentences
2. Papers: List top 5-10 most relevant papers, sorted by importance
3. Themes: Group papers into 2-4 thematic categories
4. Key Findings: Extract 3-5 main takeaways
5. Research Gaps: Identify 2-3 areas needing more research
6. Be objective and scholarly in tone

IMPORTANT: Output ONLY the JSON object, nothing else.`

/**
 * Create an LLM-powered Summarizer Agent
 */
export function createLLMSummarizerAgent(config: SummarizerConfig): LLMSummarizerAgent {
  const { apiKey, model = 'gpt-4o-mini' } = config

  const openai = createOpenAI({ apiKey })

  return {
    id: 'summarizer',

    async run(input: string): Promise<{ success: boolean; output: string }> {
      console.log('  [Summarizer-LLM] Creating research synthesis with LLM...')

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

      if (papers.length === 0) {
        // No papers to summarize
        const result: ResearchSummary = {
          title: 'Literature Review: No Results',
          overview: 'The search did not return any relevant papers.',
          papers: [],
          themes: [],
          keyFindings: ['No papers found matching the search criteria'],
          researchGaps: ['Unable to assess - no papers reviewed'],
          limitations: ['Search may need refinement'],
          suggestedFollowUp: ['Try different search terms', 'Expand date range']
        }
        return { success: true, output: JSON.stringify(result) }
      }

      // Build paper details for the LLM
      const paperDetails = papers.slice(0, 12).map((p, i) => `
Paper ${i + 1}:
- Title: ${p.title || 'Unknown'}
- Authors: ${Array.isArray(p.authors) ? p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' et al.' : '') : p.authors || 'Unknown'}
- Year: ${p.year || 'N/A'}
- Venue: ${p.venue || 'N/A'}
- Citations: ${p.citationCount || 'N/A'}
- Relevance Score: ${p.relevanceScore || 'N/A'}/10
- URL: ${p.url || 'N/A'}
- Abstract: ${(p.abstract || '').slice(0, 350)}
`).join('\n')

      const prompt = `Create a comprehensive literature review summary from these papers.

Papers (${papers.length} total):
${paperDetails}

Coverage Analysis:
- Covered Topics: ${coverage.coveredTopics?.join(', ') || 'Not specified'}
- Missing Topics: ${coverage.missingTopics?.join(', ') || 'None identified'}

Create a well-organized research summary with overview, top papers, themes, key findings, and research gaps.
Output ONLY the JSON summary object.`

      try {
        const result = await generateText({
          model: openai(model),
          system: SYSTEM_PROMPT,
          prompt,
          maxTokens: 4096,
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
        const parsed = JSON.parse(jsonOutput) as ResearchSummary
        console.log(`  [Summarizer-LLM] Summary created: ${parsed.papers?.length || 0} papers, ${parsed.themes?.length || 0} themes`)

        return { success: true, output: JSON.stringify(parsed) }
      } catch (error) {
        console.error('  [Summarizer-LLM] Error:', error)
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
