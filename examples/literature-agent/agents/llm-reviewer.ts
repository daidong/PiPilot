/**
 * LLM-Powered Reviewer Agent
 *
 * Uses a real LLM to evaluate search results, score relevance,
 * identify coverage gaps, and suggest refinements.
 */

import { defineAgent, packs } from '../../../src/index.js'
import type { AgentInstance } from '../../../src/types/agent.js'

export interface ReviewerConfig {
  apiKey: string
  projectPath?: string
  model?: string
}

export interface LLMReviewerAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
}

const REVIEWER_IDENTITY = `You are a Research Quality Reviewer who evaluates academic paper search results.

Your task is to:
1. Assess the relevance of each paper to the original research request
2. Analyze topic coverage and identify gaps
3. Decide if results are sufficient or need refinement
4. Suggest additional search queries if needed

## Output Format

You MUST output a JSON object in this exact format:
\`\`\`json
{
  "approved": true/false,
  "relevantPapers": [
    {
      "id": "paper-id",
      "title": "Paper Title",
      "authors": ["Author 1", "Author 2"],
      "year": 2023,
      "abstract": "...",
      "relevanceScore": 8,
      "relevanceReason": "Why this paper is relevant"
    }
  ],
  "confidence": 0.85,
  "coverage": {
    "score": 0.8,
    "coveredTopics": ["topic1", "topic2"],
    "missingTopics": ["topic3"]
  },
  "issues": ["issue1", "issue2"],
  "suggestions": ["suggestion1"],
  "additionalQueries": ["query1", "query2"]
}
\`\`\`

## Scoring Guidelines

- Relevance score: 0-10 (10 = highly relevant)
- Keep papers with relevance >= 5
- Coverage score: 0-1 (1 = complete coverage)

## Approval Criteria

Set "approved": true if:
- At least 3 highly relevant papers (score >= 7)
- Coverage score >= 0.7
- No critical gaps in key topics

Set "approved": false if:
- Fewer than 3 relevant papers
- Major topic gaps identified
- Coverage score < 0.6

If not approved, provide "additionalQueries" for refinement.

IMPORTANT: Output ONLY the JSON object.`

const REVIEWER_CONSTRAINTS = [
  'Output ONLY valid JSON',
  'Score each paper 0-10 for relevance',
  'Identify specific topic gaps',
  'Provide actionable suggestions',
  'Be critical but fair in assessment',
  'additionalQueries should only be set if approved is false'
]

/**
 * Create an LLM-powered Reviewer Agent
 */
export function createLLMReviewerAgent(config: ReviewerConfig): LLMReviewerAgent {
  const { apiKey, projectPath = process.cwd(), model = 'gpt-4o-mini' } = config

  const agentDef = defineAgent({
    id: 'reviewer-llm',
    name: 'Quality Reviewer Agent',
    identity: REVIEWER_IDENTITY,
    constraints: REVIEWER_CONSTRAINTS,
    packs: [packs.safe()],
    model: { default: model, maxTokens: 4096 },
    maxSteps: 3
  })

  let agentInstance: AgentInstance | null = null
  let reviewCount = 0

  const getAgent = () => {
    if (!agentInstance) {
      agentInstance = agentDef({ apiKey, projectPath })
    }
    return agentInstance
  }

  return {
    id: 'reviewer',

    async run(input: string): Promise<{ success: boolean; output: string }> {
      reviewCount++
      console.log(`  [Reviewer-LLM] Review #${reviewCount}, evaluating with LLM...`)

      const agent = getAgent()

      // Parse input
      let searchResults: { papers?: unknown[]; queriesUsed?: string[] }
      try {
        searchResults = JSON.parse(input)
      } catch {
        return { success: false, output: JSON.stringify({ error: 'Invalid input format' }) }
      }

      const papers = searchResults.papers || []
      const queries = searchResults.queriesUsed || []

      console.log(`  [Reviewer-LLM] Reviewing ${papers.length} papers...`)

      // Build paper summaries for the LLM
      const paperSummaries = (papers as Array<{
        id?: string
        title?: string
        authors?: string[]
        year?: number
        abstract?: string
        citationCount?: number
      }>).slice(0, 20).map((p, i) => `
Paper ${i + 1}:
- ID: ${p.id || 'unknown'}
- Title: ${p.title || 'Unknown'}
- Authors: ${(p.authors || []).slice(0, 3).join(', ')}
- Year: ${p.year || 'N/A'}
- Citations: ${p.citationCount || 'N/A'}
- Abstract: ${(p.abstract || '').slice(0, 300)}...
`).join('\n')

      const prompt = `Review these academic paper search results.

Original search queries: ${queries.join(', ')}
Review iteration: ${reviewCount}

Papers found:
${paperSummaries || 'No papers found'}

Evaluate:
1. Relevance of each paper (score 0-10)
2. Topic coverage (what's covered, what's missing)
3. Whether results are sufficient (approved: true/false)
4. If not approved, suggest additional search queries

${reviewCount >= 2 ? 'Note: This is review #' + reviewCount + '. Be more lenient - approve if there are at least some relevant papers.' : ''}

Output ONLY the JSON review object.`

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
          console.log(`  [Reviewer-LLM] ${parsed.approved ? 'APPROVED' : 'NEEDS REFINEMENT'}: ${parsed.relevantPapers?.length || 0} relevant papers`)
          return { success: true, output: JSON.stringify(parsed) }
        } catch {
          const jsonStart = jsonOutput.indexOf('{')
          const jsonEnd = jsonOutput.lastIndexOf('}')
          if (jsonStart !== -1 && jsonEnd !== -1) {
            const extracted = jsonOutput.slice(jsonStart, jsonEnd + 1)
            try {
              const parsed = JSON.parse(extracted)
              console.log(`  [Reviewer-LLM] ${parsed.approved ? 'APPROVED' : 'NEEDS REFINEMENT'}: ${parsed.relevantPapers?.length || 0} relevant papers`)
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
