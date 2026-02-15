import { defineTool } from '../../../src/factories/define-tool.js'
import type { Tool, ToolContext } from '../../../src/types/tool.js'
import type { TokenTracker } from '../../../src/core/token-tracker.js'
import { createDataAnalyzer } from './data/data-team.js'

interface DataAnalyzeInput {
  filePath: string
  taskType?: 'analyze' | 'visualize' | 'transform' | 'model'
  instructions: string
}

interface DataAnalyzeResult {
  stdout?: string
  outputs: Array<{
    path: string
    name: string
    category: 'figures' | 'tables' | 'data'
    title?: string
    description?: string
  }>
  attempts: number
  manifest?: {
    summary: Record<string, unknown>
    warnings: string[]
  }
}

export interface DataSubagentConfig {
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

export function createDataAnalyzeTool(config: DataSubagentConfig): Tool<DataAnalyzeInput, DataAnalyzeResult> {
  let callCount = 0
  let lastTurnStep = -1
  let analyzer: ReturnType<typeof createDataAnalyzer> | null = null

  return defineTool<DataAnalyzeInput, DataAnalyzeResult>({
    name: 'data-analyze',
    description: 'Run Python-based data analysis on a local dataset and return generated output files + manifest summary.',
    parameters: {
      filePath: {
        type: 'string',
        required: true,
        description: 'Path to the input dataset, relative to project root.'
      },
      taskType: {
        type: 'string',
        required: false,
        enum: ['analyze', 'visualize', 'transform', 'model'],
        description: 'Type of analysis.'
      },
      instructions: {
        type: 'string',
        required: true,
        description: 'Concrete analysis request.'
      }
    },
    execute: async (input, toolContext?: ToolContext) => {
      if (!input.filePath?.trim()) {
        return { success: false, error: 'data-analyze requires a non-empty filePath' }
      }
      if (!input.instructions?.trim()) {
        return { success: false, error: 'data-analyze requires non-empty instructions' }
      }

      const currentStep = toolContext?.step ?? 0
      if (currentStep !== lastTurnStep) {
        callCount = 0
        lastTurnStep = currentStep
      }
      callCount += 1

      const maxCalls = Math.max(1, config.maxCallsPerTurn ?? 2)
      if (callCount > maxCalls) {
        return {
          success: false,
          error: `data-analyze already called ${maxCalls} time(s) in this turn; reuse existing outputs.`
        }
      }

      const apiKey = resolveApiKey(config.apiKey)
      if (!apiKey) {
        return { success: false, error: 'No API key available for data subagent.' }
      }

      try {
        if (!analyzer) {
          analyzer = createDataAnalyzer({
            apiKey,
            model: config.model,
            projectPath: config.projectPath,
            sessionId: config.sessionId ?? 'yolo',
            tokenTracker: config.tokenTracker
          })
        }

        const result = await analyzer.analyze({
          filePath: input.filePath.trim(),
          taskType: input.taskType,
          instructions: input.instructions.trim()
        })

        if (!result.success) {
          return { success: false, error: result.error ?? 'data-analyze failed' }
        }

        return {
          success: true,
          data: {
            stdout: result.stdout,
            outputs: result.outputs,
            attempts: result.attempts,
            manifest: result.manifest
              ? {
                  summary: result.manifest.summary,
                  warnings: result.manifest.warnings
                }
              : undefined
          }
        }
      } catch (error) {
        return {
          success: false,
          error: `data-analyze error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
  })
}
