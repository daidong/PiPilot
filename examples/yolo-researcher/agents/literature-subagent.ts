import { defineTool } from '../../../src/factories/define-tool.js'
import type { Tool, ToolContext } from '../../../src/types/tool.js'
import type { TokenTracker } from '../../../src/core/token-tracker.js'

import { createLiteratureTeam } from './literature/literature-team.js'
import { PATHS } from './literature/types.js'

interface LiteratureSearchInput {
  query: string
  context?: string
}

interface LiteratureSearchResult {
  briefSummary: string
  coverage: {
    score: number
    subTopics: Array<{
      name: string
      paperCount: number
      covered: boolean
      gaps: string[]
    }>
    queriesExecuted: string[]
  }
  totalPapersFound: number
  papersAutoSaved: number
  fullReviewPath: string
  paperListPath: string
  durationMs: number
  llmCallCount: number
  apiCallCount: number
  apiFailureCount: number
  persistedPapersPath: string
}

export interface LiteratureSubagentConfig {
  apiKey?: string
  model: string
  projectPath: string
  sessionId?: string
  maxCallsPerTurn?: number
  tokenTracker?: TokenTracker
}

function resolveApiKey(explicit?: string): string | undefined {
  if (explicit?.trim()) return explicit.trim()

  const candidates = [
    process.env['OPENAI_API_KEY'],
    process.env['ANTHROPIC_API_KEY'],
    process.env['DEEPSEEK_API_KEY'],
    process.env['GOOGLE_API_KEY'],
    process.env['GEMINI_API_KEY']
  ]

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function createLiteratureSearchTool(config: LiteratureSubagentConfig): Tool<LiteratureSearchInput, LiteratureSearchResult> {
  let callCount = 0
  let lastTurnStep = -1

  return defineTool<LiteratureSearchInput, LiteratureSearchResult>({
    name: 'literature-search',
    description: 'Run a full literature-study subagent (plan/search/review/summarize), auto-save relevant papers, and return coverage + local review paths.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Main literature question or topic.'
      },
      context: {
        type: 'string',
        required: false,
        description: 'Optional additional context to disambiguate the topic.'
      }
    },
    execute: async (input, toolContext?: ToolContext) => {
      const query = input.query?.trim()
      if (!query) {
        return { success: false, error: 'literature-search requires a non-empty query' }
      }

      const currentStep = toolContext?.step ?? 0
      if (currentStep !== lastTurnStep) {
        callCount = 0
        lastTurnStep = currentStep
      }
      callCount += 1

      const maxCalls = Math.max(1, config.maxCallsPerTurn ?? 1)
      if (callCount > maxCalls) {
        return {
          success: false,
          error: `literature-search already called ${maxCalls} time(s) in this turn; reuse the existing results.`
        }
      }

      const apiKey = resolveApiKey(config.apiKey)
      if (!apiKey) {
        return {
          success: false,
          error: 'No API key available for literature subagent.'
        }
      }

      try {
        const team = createLiteratureTeam({
          apiKey,
          model: config.model,
          projectPath: config.projectPath,
          sessionId: config.sessionId ?? 'yolo',
          messages: toolContext?.messages as unknown[] | undefined,
          toolContext,
          tokenTracker: config.tokenTracker
        })

        const request = input.context?.trim()
          ? `${query}\n\nAdditional context: ${input.context.trim()}`
          : query
        const result = await team.research(request)

        if (!result.success || !result.result?.data) {
          return {
            success: false,
            error: result.error ?? 'literature-search failed'
          }
        }

        return {
          success: true,
          data: {
            ...result.result.data,
            persistedPapersPath: PATHS.papers
          }
        }
      } catch (error) {
        return {
          success: false,
          error: `literature-search error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
  })
}
