/**
 * Writing Agent
 *
 * Assists with research writing:
 * - Creates structured outlines
 * - Drafts sections with citations
 * - Provides editing suggestions
 */

import {
  defineAgent as defineSimpleAgent,
  type AgentContext
} from '../../../src/agent/define-simple-agent.js'

import { getLanguageModelByModelId } from '../../../src/index.js'
import { loadPrompt } from './prompts/index.js'

/**
 * Writing Outliner - Creates structured outlines
 */
export const writingOutliner = defineSimpleAgent({
  id: 'writing-outliner',
  description: 'Creates structured outlines for research documents',

  system: loadPrompt('writing-outliner-system'),

  prompt: (input) => {
    const data = input as {
      topic?: string
      notes?: string[]
      literature?: string[]
      type?: string
    }

    let prompt = `Create an outline for a ${data.type ?? 'research document'} on:\n\n"${data.topic ?? input}"`

    if (data.notes?.length) {
      prompt += `\n\nRelevant notes:\n${data.notes.join('\n')}`
    }

    if (data.literature?.length) {
      prompt += `\n\nAvailable literature:\n${data.literature.join('\n')}`
    }

    return prompt
  }
})

/**
 * Writing Drafter - Drafts sections with citations
 */
export const writingDrafter = defineSimpleAgent({
  id: 'writing-drafter',
  description: 'Drafts research document sections',

  system: loadPrompt('writing-drafter-system'),

  prompt: (input) => {
    const data = input as {
      section?: { heading: string; description: string }
      context?: string
      literature?: Array<{ citeKey: string; title: string; abstract: string }>
      style?: string
    }

    let prompt = `Draft the following section:\n\n`
    prompt += `Heading: ${data.section?.heading ?? 'Introduction'}\n`
    prompt += `Description: ${data.section?.description ?? 'Write an introduction'}\n`

    if (data.context) {
      prompt += `\nContext:\n${data.context}`
    }

    if (data.literature?.length) {
      prompt += `\n\nAvailable sources to cite:\n`
      for (const lit of data.literature) {
        prompt += `- [${lit.citeKey}] ${lit.title}\n  ${lit.abstract.slice(0, 200)}...\n`
      }
    }

    if (data.style) {
      prompt += `\nStyle: ${data.style}`
    }

    return prompt
  }
})

/**
 * Create the writing agent
 */
export function createWritingAgent(config: {
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
     * Create an outline for a document
     */
    async createOutline(input: {
      topic: string
      notes?: string[]
      literature?: string[]
      type?: string
    }): Promise<{ success: boolean; outline?: unknown; error?: string }> {
      try {
        const result = await writingOutliner.run(input, agentCtx)

        if (result.success) {
          return { success: true, outline: result.output }
        }

        return { success: false, error: result.error }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    },

    /**
     * Draft a section
     */
    async draftSection(input: {
      section: { heading: string; description: string }
      context?: string
      literature?: Array<{ citeKey: string; title: string; abstract: string }>
      style?: string
    }): Promise<{ success: boolean; draft?: unknown; error?: string }> {
      try {
        const result = await writingDrafter.run(input, agentCtx)

        if (result.success) {
          return { success: true, draft: result.output }
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
