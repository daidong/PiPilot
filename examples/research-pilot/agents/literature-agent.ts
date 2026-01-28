/**
 * Literature Agent
 *
 * Wraps the literature-agent team for literature search and review.
 * Uses the existing implementation from examples/literature-agent.
 */

import createLiteratureTeam from '../../literature-agent/index.js'

export interface LiteratureSearchResult {
  success: boolean
  summary?: {
    title: string
    overview: string
    papers: Array<{
      title: string
      authors: string
      year: number
      summary: string
      url?: string
    }>
    themes: Array<{
      name: string
      papers: string[]
      insight: string
    }>
    keyFindings: string[]
    researchGaps: string[]
  }
  error?: string
  steps: number
  durationMs: number
}

/**
 * Create the literature agent
 */
export function createLiteratureAgent(config: {
  apiKey: string
  model?: string
  maxReviewIterations?: number
}) {
  const team = createLiteratureTeam({
    apiKey: config.apiKey,
    model: config.model ?? 'gpt-5.2',
    maxReviewIterations: config.maxReviewIterations ?? 2
  })

  return {
    /**
     * Search for literature on a topic
     */
    async search(query: string): Promise<LiteratureSearchResult> {
      console.log('[Literature Agent] Starting search...')

      // Subscribe to events
      const unsubStart = team.onAgentStarted(({ agentId, step }) => {
        console.log(`  [Step ${step}] ${agentId}...`)
      })

      const unsubComplete = team.onAgentCompleted(({ agentId, durationMs }) => {
        console.log(`  [✓] ${agentId} completed in ${(durationMs / 1000).toFixed(1)}s`)
      })

      try {
        const result = await team.research(query)

        // Unsubscribe from events
        unsubStart()
        unsubComplete()

        if (result.success && result.summary) {
          return {
            success: true,
            summary: result.summary as LiteratureSearchResult['summary'],
            steps: result.steps,
            durationMs: result.durationMs
          }
        }

        return {
          success: false,
          error: result.error ?? 'Search failed',
          steps: result.steps,
          durationMs: result.durationMs
        }
      } catch (error) {
        // Unsubscribe from events
        unsubStart()
        unsubComplete()

        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          steps: 0,
          durationMs: 0
        }
      }
    }
  }
}
