/**
 * Summarizer Agent
 *
 * Creates a final synthesis of the research findings,
 * organizing papers by theme and providing insights.
 */

import type { Paper } from '../types.js'

export interface SummaryInput {
  relevantPapers: Paper[]
  originalRequest: string
  coverage: {
    coveredTopics: string[]
    missingTopics: string[]
  }
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
  limitations: string[]
  suggestedFollowUp: string[]
}

export interface SummarizerAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
}

/**
 * Create a Summarizer Agent
 *
 * Synthesizes research findings into a structured summary.
 */
export function createSummarizerAgent(): SummarizerAgent {
  return {
    id: 'summarizer',

    async run(input: string): Promise<{ success: boolean; output: string }> {
      console.log('  [Summarizer] Creating research synthesis...')

      let summaryInput: SummaryInput
      try {
        const parsed = JSON.parse(input)
        // Handle ReviewResult format
        if (parsed.approved !== undefined) {
          summaryInput = {
            relevantPapers: parsed.relevantPapers || [],
            originalRequest: '',
            coverage: parsed.coverage || { coveredTopics: [], missingTopics: [] }
          }
        } else {
          summaryInput = parsed as SummaryInput
        }
      } catch {
        return { success: false, output: JSON.stringify({ error: 'Invalid input format' }) }
      }

      const { relevantPapers, coverage } = summaryInput

      // Sort papers by citation count (most influential first)
      const sortedPapers = [...relevantPapers].sort((a, b) =>
        (b.citationCount || 0) - (a.citationCount || 0)
      )

      // Create paper summaries
      const paperSummaries = sortedPapers.slice(0, 10).map(paper => ({
        title: paper.title,
        authors: paper.authors.slice(0, 3).join(', ') + (paper.authors.length > 3 ? ' et al.' : ''),
        year: paper.year,
        venue: paper.venue,
        citations: paper.citationCount,
        summary: paper.abstract.length > 200
          ? paper.abstract.substring(0, 200) + '...'
          : paper.abstract,
        url: paper.url
      }))

      // Group papers by theme
      const themes: Array<{ name: string; papers: string[]; insight: string }> = []

      // Detect themes based on keywords
      const themePatterns: Record<string, { keywords: string[]; insight: string }> = {
        'Foundational Models': {
          keywords: ['bert', 'transformer', 'attention', 'pre-train'],
          insight: 'Core architectural advances that enabled modern retrieval systems'
        },
        'Retrieval Methods': {
          keywords: ['retrieval', 'dense', 'passage', 'embedding'],
          insight: 'Techniques for efficient and accurate document retrieval'
        },
        'RAG Systems': {
          keywords: ['rag', 'retrieval-augmented', 'generation', 'knowledge'],
          insight: 'Integration of retrieval with language generation'
        },
        'Evaluation & Analysis': {
          keywords: ['evaluation', 'benchmark', 'analysis', 'performance'],
          insight: 'Understanding model behavior and measuring effectiveness'
        }
      }

      for (const [themeName, { keywords, insight }] of Object.entries(themePatterns)) {
        const matchingPapers = sortedPapers.filter(paper => {
          const text = `${paper.title} ${paper.abstract}`.toLowerCase()
          return keywords.some(kw => text.includes(kw))
        })

        if (matchingPapers.length > 0) {
          themes.push({
            name: themeName,
            papers: matchingPapers.slice(0, 3).map(p => p.title),
            insight
          })
        }
      }

      // Generate overview
      const totalPapers = relevantPapers.length
      const yearRange = relevantPapers.length > 0
        ? `${Math.min(...relevantPapers.map(p => p.year))}-${Math.max(...relevantPapers.map(p => p.year))}`
        : 'N/A'
      const topCited = sortedPapers[0]

      const overview = `Found ${totalPapers} relevant papers spanning ${yearRange}. ` +
        `The research covers ${coverage.coveredTopics.length} key themes. ` +
        (topCited
          ? `Most influential work: "${topCited.title}" with ${topCited.citationCount?.toLocaleString() || 'N/A'} citations.`
          : '')

      // Compile summary
      const summary: ResearchSummary = {
        title: 'Literature Research Summary',
        overview,
        papers: paperSummaries,
        themes,
        limitations: [
          coverage.missingTopics.length > 0
            ? `Limited coverage of: ${coverage.missingTopics.join(', ')}`
            : null,
          'Results limited to English-language papers',
          'Citation counts may not reflect recent impact'
        ].filter((l): l is string => l !== null),
        suggestedFollowUp: [
          'Explore specific techniques mentioned in top papers',
          'Review recent workshop papers for cutting-edge developments',
          'Consider domain-specific applications'
        ]
      }

      console.log(`  [Summarizer] Summary created: ${paperSummaries.length} papers, ${themes.length} themes`)

      return { success: true, output: JSON.stringify(summary) }
    },

    async destroy() {
      // Cleanup if needed
    }
  }
}
