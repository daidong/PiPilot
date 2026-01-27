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

/**
 * Writing Outliner - Creates structured outlines
 */
export const writingOutliner = defineSimpleAgent({
  id: 'writing-outliner',
  description: 'Creates structured outlines for research documents',

  system: `You are a Research Writing Specialist who creates clear, well-structured outlines.

When given a topic and optional notes/literature, create an outline that:
1. Has a logical flow from introduction to conclusion
2. Identifies key sections and subsections
3. Notes where citations would be appropriate
4. Suggests word count estimates per section

Output JSON:
{
  "title": "Proposed document title",
  "type": "paper|report|review|proposal",
  "sections": [
    {
      "heading": "Section heading",
      "level": 1,
      "description": "What this section covers",
      "subsections": [...],
      "suggestedWordCount": 500,
      "citationsNeeded": ["topic1", "topic2"]
    }
  ],
  "estimatedTotalWords": 3000,
  "notes": "Additional suggestions for the author"
}`,

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

  system: `You are a Research Writing Specialist who drafts clear, scholarly prose.

When given a section outline and context, write content that:
1. Is clear, concise, and academically appropriate
2. Integrates citations naturally using [Author, Year] format
3. Maintains logical flow between paragraphs
4. Uses topic sentences effectively

Output JSON:
{
  "sectionHeading": "The section heading",
  "content": "The drafted content with [citations]...",
  "wordCount": 500,
  "citationsUsed": [
    { "key": "Author2024", "context": "Where/how it was cited" }
  ],
  "suggestions": "Any notes for the author about this section"
}`,

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
  const { apiKey, model = 'gpt-4o' } = config

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
