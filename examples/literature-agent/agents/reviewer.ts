/**
 * Reviewer Agent
 *
 * Reviews search results, filters by relevance, identifies gaps,
 * and provides feedback for iterative refinement.
 */

import type { Paper } from '../types.js'

export interface ReviewInput {
  papers: Paper[]
  originalRequest: string
  expectedTopics?: string[]
  previousReviewCount?: number
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
  previousResults?: Paper[]
}

export interface ReviewerAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
}

/**
 * Create a Reviewer Agent
 *
 * Evaluates search results for relevance and coverage.
 * Can suggest additional searches if gaps are found.
 */
export function createReviewerAgent(): ReviewerAgent {
  let reviewCount = 0

  return {
    id: 'reviewer',

    async run(input: string): Promise<{ success: boolean; output: string }> {
      reviewCount++
      console.log(`  [Reviewer] Review #${reviewCount}, evaluating results...`)

      let reviewInput: ReviewInput
      try {
        const parsed = JSON.parse(input)
        // Handle SearchResults format
        if (parsed.papers && !parsed.originalRequest) {
          reviewInput = {
            papers: parsed.papers,
            originalRequest: parsed.queriesUsed?.[0] || '',
            previousReviewCount: reviewCount - 1
          }
        } else {
          reviewInput = parsed as ReviewInput
        }
      } catch {
        return { success: false, output: JSON.stringify({ error: 'Invalid input format' }) }
      }

      const { papers, originalRequest, expectedTopics = [] } = reviewInput

      // Score papers by relevance (simplified scoring)
      const scoredPapers = papers.map(paper => {
        let score = 0
        const requestTerms = originalRequest.toLowerCase().split(/\s+/)
        const paperText = `${paper.title} ${paper.abstract}`.toLowerCase()

        // Term matching
        for (const term of requestTerms) {
          if (term.length > 3 && paperText.includes(term)) {
            score += 2
          }
        }

        // Boost recent papers
        if (paper.year >= 2023) score += 2
        else if (paper.year >= 2020) score += 1

        // Boost highly cited papers
        if (paper.citationCount && paper.citationCount > 1000) score += 2
        else if (paper.citationCount && paper.citationCount > 100) score += 1

        return { paper, score }
      })

      // Sort by score and filter
      scoredPapers.sort((a, b) => b.score - a.score)
      const relevantPapers = scoredPapers
        .filter(sp => sp.score >= 3)
        .map(sp => ({ ...sp.paper, relevanceScore: sp.score }))

      // Analyze coverage
      const coveredTopics: string[] = []
      const missingTopics: string[] = []

      // Simple topic detection
      const allText = relevantPapers.map(p => `${p.title} ${p.abstract}`).join(' ').toLowerCase()

      const topicKeywords: Record<string, string[]> = {
        'Retrieval techniques': ['retrieval', 'dense passage', 'embedding', 'vector'],
        'LLM integration': ['language model', 'llm', 'gpt', 'generation'],
        'Evaluation': ['evaluation', 'benchmark', 'metrics', 'performance'],
        'Architecture': ['architecture', 'transformer', 'attention', 'model'],
        'Applications': ['question answering', 'qa', 'application', 'task']
      }

      for (const [topic, keywords] of Object.entries(topicKeywords)) {
        if (keywords.some(kw => allText.includes(kw))) {
          coveredTopics.push(topic)
        } else if (expectedTopics.includes(topic)) {
          missingTopics.push(topic)
        }
      }

      const coverageScore = coveredTopics.length / Math.max(Object.keys(topicKeywords).length, 1)
      const issues: string[] = []
      const suggestions: string[] = []
      let additionalQueries: string[] | undefined

      // First review: might find gaps
      if (reviewCount === 1 && relevantPapers.length < 5) {
        issues.push('Limited relevant papers found')
        suggestions.push('Consider broader search terms')
        additionalQueries = ['survey ' + originalRequest.split(' ').slice(0, 2).join(' ')]
      }

      if (missingTopics.length > 0 && reviewCount === 1) {
        issues.push(`Missing coverage for: ${missingTopics.join(', ')}`)
        suggestions.push('Additional targeted searches recommended')
      }

      // Determine if approved
      const approved = issues.length === 0 || reviewCount >= 2

      const result: ReviewResult = {
        approved,
        relevantPapers,
        confidence: approved ? 0.85 : 0.6,
        coverage: {
          score: coverageScore,
          coveredTopics,
          missingTopics
        },
        issues,
        suggestions: approved ? ['Results look good!'] : suggestions,
        additionalQueries: approved ? undefined : additionalQueries,
        previousResults: relevantPapers
      }

      console.log(`  [Reviewer] ${approved ? 'APPROVED' : 'NEEDS REFINEMENT'}: ${relevantPapers.length} relevant papers, coverage: ${(coverageScore * 100).toFixed(0)}%`)

      return { success: true, output: JSON.stringify(result) }
    },

    async destroy() {
      // Cleanup if needed
    }
  }
}
