/**
 * Data Agent
 *
 * Analyzes datasets and generates insights:
 * - Schema inference
 * - Statistical summaries
 * - Pattern detection
 * - Visualization suggestions
 */

import {
  defineAgent as defineSimpleAgent,
  type AgentContext
} from '../../../src/agent/define-simple-agent.js'

import { getLanguageModelByModelId } from '../../../src/index.js'
import { loadPrompt } from './prompts/index.js'

/**
 * Data Analyzer - Analyzes datasets
 */
export const dataAnalyzer = defineSimpleAgent({
  id: 'data-analyzer',
  description: 'Analyzes datasets and generates insights',

  system: loadPrompt('data-analyzer-system'),

  prompt: (input) => {
    const data = input as {
      name?: string
      schema?: {
        columns?: Array<{ name: string; type: string }>
        rowCount?: number
      }
      sampleData?: string
      statistics?: Record<string, unknown>
      question?: string
    }

    let prompt = `Analyze this dataset:\n\n`
    prompt += `Name: ${data.name ?? 'Unknown dataset'}\n`

    if (data.schema) {
      prompt += `\nSchema:\n`
      if (data.schema.columns) {
        for (const col of data.schema.columns) {
          prompt += `  - ${col.name}: ${col.type}\n`
        }
      }
      if (data.schema.rowCount) {
        prompt += `Rows: ${data.schema.rowCount}\n`
      }
    }

    if (data.sampleData) {
      prompt += `\nSample data:\n${data.sampleData}\n`
    }

    if (data.statistics) {
      prompt += `\nStatistics:\n${JSON.stringify(data.statistics, null, 2)}\n`
    }

    if (data.question) {
      prompt += `\nSpecific question: ${data.question}`
    }

    return prompt
  }
})

/**
 * Create the data agent
 */
export function createDataAgent(config: {
  apiKey: string
  model?: string
}) {
  const { apiKey, model = 'gpt-5.2' } = config

  const languageModel = getLanguageModelByModelId(model, { apiKey })

  const agentCtx: AgentContext = {
    getLanguageModel: () => languageModel
  }

  return {
    /**
     * Analyze a dataset
     */
    async analyze(input: {
      name: string
      schema?: {
        columns?: Array<{ name: string; type: string }>
        rowCount?: number
      }
      sampleData?: string
      statistics?: Record<string, unknown>
      question?: string
    }): Promise<{ success: boolean; analysis?: unknown; error?: string }> {
      try {
        const result = await dataAnalyzer.run(input, agentCtx)

        if (result.success) {
          return { success: true, analysis: result.output }
        }

        return { success: false, error: result.error }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }
}
