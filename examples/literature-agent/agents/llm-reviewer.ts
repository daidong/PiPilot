/**
 * LLM-Powered Reviewer Agent
 *
 * Uses direct LLM calls to evaluate search results, score relevance,
 * identify coverage gaps, and suggest refinements.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'
import type { Paper } from '../types.js'

export interface ReviewerConfig {
  apiKey: string
  model?: string
}

export interface ReviewResult {
  approved: boolean
  relevantPapers: Paper[]
  confidence: number
  coverage: {
    score: number
    coveredTopics: string[]
    missingTopics: string[]
  }
  issues: string[]
  suggestions: string[]
  additionalQueries?: string[]
}

export interface LLMReviewerAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
}

const SYSTEM_PROMPT = `You are a Research Quality Reviewer who evaluates academic paper search results.

Your task is to:
1. Assess the relevance of each paper
2. Analyze topic coverage and identify gaps
3. Decide if results are sufficient or need refinement

You MUST respond with ONLY a valid JSON object (no markdown, no explanation) in this format:
{
  "approved": true or false,
  "relevantPapers": [
    {
      "id": "paper-id",
      "title": "Paper Title",
      "authors": ["Author 1"],
      "year": 2023,
      "abstract": "...",
      "relevanceScore": 8,
      "url": "..."
    }
  ],
  "confidence": 0.85,
  "coverage": {
    "score": 0.8,
    "coveredTopics": ["topic1", "topic2"],
    "missingTopics": ["topic3"]
  },
  "issues": ["issue1"],
  "suggestions": ["suggestion1"],
  "additionalQueries": ["query1"]
}

Approval Criteria:
- Set "approved": true if at least 3 relevant papers (score >= 7) AND coverage >= 0.7
- Set "approved": false if fewer than 3 relevant papers OR major gaps
- Only include "additionalQueries" if approved is false

Scoring:
- relevanceScore: 0-10 (10 = highly relevant)
- Keep papers with relevanceScore >= 5
- coverage.score: 0-1 (1 = complete coverage)

IMPORTANT: Output ONLY the JSON object, nothing else.`

/**
 * Create an LLM-powered Reviewer Agent
 */
export function createLLMReviewerAgent(config: ReviewerConfig): LLMReviewerAgent {
  const { apiKey, model = 'gpt-4o-mini' } = config

  const openai = createOpenAI({ apiKey })
  let reviewCount = 0

  return {
    id: 'reviewer',

    async run(input: string): Promise<{ success: boolean; output: string }> {
      reviewCount++
      console.log(`  [Reviewer-LLM] Review #${reviewCount}, evaluating with LLM...`)

      // Parse input
      let searchResults: { papers?: Paper[]; queriesUsed?: string[] }
      try {
        searchResults = JSON.parse(input)
      } catch {
        return { success: false, output: JSON.stringify({ error: 'Invalid input format' }) }
      }

      const papers = searchResults.papers || []
      const queries = searchResults.queriesUsed || []

      console.log(`  [Reviewer-LLM] Reviewing ${papers.length} papers...`)

      if (papers.length === 0) {
        // No papers to review - auto-fail
        const result: ReviewResult = {
          approved: false,
          relevantPapers: [],
          confidence: 0.3,
          coverage: { score: 0, coveredTopics: [], missingTopics: ['all topics'] },
          issues: ['No papers found'],
          suggestions: ['Try broader search terms'],
          additionalQueries: queries.map(q => q.split(' ').slice(0, 2).join(' ') + ' survey')
        }
        return { success: true, output: JSON.stringify(result) }
      }

      // Build paper summaries for the LLM (limit to avoid token overflow)
      const paperSummaries = papers.slice(0, 15).map((p, i) => `
Paper ${i + 1}:
- Title: ${p.title}
- Authors: ${(p.authors || []).slice(0, 3).join(', ')}${p.authors?.length > 3 ? ' et al.' : ''}
- Year: ${p.year || 'N/A'}
- Citations: ${p.citationCount || 'N/A'}
- Abstract: ${(p.abstract || '').slice(0, 250)}...
- URL: ${p.url || 'N/A'}
- ID: ${p.id}
`).join('\n')

      const prompt = `Review these academic paper search results.

Original queries: ${queries.join(', ')}
Review iteration: ${reviewCount}
${reviewCount >= 2 ? '(Be more lenient on iteration 2+ - approve if there are some relevant papers)' : ''}

Papers (${papers.length} total, showing first 15):
${paperSummaries}

Evaluate relevance, coverage, and decide if approved.
Output ONLY the JSON review object.`

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
        const parsed = JSON.parse(jsonOutput) as ReviewResult
        console.log(`  [Reviewer-LLM] ${parsed.approved ? 'APPROVED' : 'NEEDS REFINEMENT'}: ${parsed.relevantPapers?.length || 0} relevant papers, coverage: ${((parsed.coverage?.score || 0) * 100).toFixed(0)}%`)

        return { success: true, output: JSON.stringify(parsed) }
      } catch (error) {
        console.error('  [Reviewer-LLM] Error:', error)
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
