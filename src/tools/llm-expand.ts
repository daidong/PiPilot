/**
 * llm-expand - LLM text expansion tool
 *
 * Uses LLM to expand text into multiple variations for:
 * - Query expansion (search optimization)
 * - Synonym generation
 * - Multi-perspective rephrasing
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface LLMExpandInput {
  /** Original text */
  text: string
  /** Number of variations to generate, defaults to 3 */
  numVariations?: number
  /** Expansion style: search (search-optimized), synonyms, rephrase */
  style?: 'search' | 'synonyms' | 'rephrase'
  /** Domain hint (e.g. "academic", "technical", "casual") */
  domain?: string
  /** Additional context */
  context?: string
}

export interface LLMExpandOutput {
  /** Original text */
  original: string
  /** Expanded variations */
  variations: string[]
  /** Expansion strategy explanation */
  explanation: string
}

const STYLE_PROMPTS: Record<string, string> = {
  search: `Generate search query variations that:
- Use technical/domain-specific terminology
- Include relevant synonyms and related concepts
- Keep queries concise (3-7 words each)
- Focus on key concepts, not full sentences`,

  synonyms: `Generate synonym variations that:
- Preserve the original meaning
- Use different vocabulary
- Cover formal and informal registers
- Include domain-specific alternatives if applicable`,

  rephrase: `Generate rephrased variations that:
- Express the same idea differently
- Vary sentence structure
- Maintain the core meaning
- Use different perspectives or framings`
}

export const llmExpand: Tool<LLMExpandInput, LLMExpandOutput> = defineTool({
  name: 'llm-expand',
  description: `Expand text into multiple variations using LLM. Styles: search, synonyms, rephrase. Returns original plus variations.`,

  parameters: {
    text: {
      type: 'string',
      description: 'The original text to expand',
      required: true
    },
    numVariations: {
      type: 'number',
      description: 'Number of variations to generate (default: 3, max: 10)',
      required: false,
      default: 3
    },
    style: {
      type: 'string',
      description: 'Expansion style: search, synonyms, or rephrase',
      required: false,
      default: 'search',
      enum: ['search', 'synonyms', 'rephrase']
    },
    domain: {
      type: 'string',
      description: 'Domain hint (e.g., "academic", "technical", "medical")',
      required: false
    },
    context: {
      type: 'string',
      description: 'Additional context to guide expansion',
      required: false
    }
  },

  execute: async (input, { runtime }) => {
    const {
      text,
      numVariations = 3,
      style = 'search',
      domain,
      context
    } = input

    const actualVariations = Math.min(Math.max(1, numVariations), 10)
    const stylePrompt = STYLE_PROMPTS[style] || STYLE_PROMPTS.search

    const systemPrompt = `You are an expert at text expansion and variation generation.
${stylePrompt}
${domain ? `Domain: ${domain}` : ''}

Output JSON only, no explanation.`

    const userPrompt = `Generate ${actualVariations} variations of this text:

Text: "${text}"
${context ? `Context: ${context}` : ''}

Return JSON in this exact format:
{
  "variations": ["variation1", "variation2", "variation3"],
  "explanation": "Brief explanation of the expansion strategy"
}`

    try {
      const result = await runtime.toolRegistry.call('llm-call', {
        prompt: userPrompt,
        systemPrompt,
        maxTokens: 500,
        jsonMode: true
      }, {
        runtime,
        sessionId: runtime.sessionId,
        step: runtime.step,
        agentId: runtime.agentId
      })

      if (!result.success) {
        // Fallback: return original text only
        return {
          success: true,
          data: {
            original: text,
            variations: [text],
            explanation: 'Using original text (LLM expansion failed)'
          }
        }
      }

      const llmResult = result.data as { text: string }

      // Parse JSON response
      let parsed: { variations?: string[]; explanation?: string }
      try {
        parsed = JSON.parse(llmResult.text)
      } catch {
        // Try to extract JSON from markdown code block
        const jsonMatch = llmResult.text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
        if (jsonMatch && jsonMatch[1]) {
          parsed = JSON.parse(jsonMatch[1])
        } else {
          // Fallback
          return {
            success: true,
            data: {
              original: text,
              variations: [text],
              explanation: 'Using original text (failed to parse LLM response)'
            }
          }
        }
      }

      const variations = parsed.variations || [text]

      return {
        success: true,
        data: {
          original: text,
          variations: variations.slice(0, actualVariations),
          explanation: parsed.explanation || `Generated ${variations.length} ${style} variations`
        }
      }
    } catch (error) {
      // Fallback on any error
      return {
        success: true,
        data: {
          original: text,
          variations: [text],
          explanation: `Using original text (error: ${error instanceof Error ? error.message : 'unknown'})`
        }
      }
    }
  }
})
