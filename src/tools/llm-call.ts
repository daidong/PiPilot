/**
 * llm-call - LLM sub-call tool
 *
 * Allows LLM calls within tools for tasks like query rewriting,
 * classification, filtering, etc.
 * Uses the same LLM client as the main Agent.
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface LLMCallInput {
  /** User prompt */
  prompt: string
  /** System prompt (optional) */
  systemPrompt?: string
  /** Max tokens to generate, defaults to 1000 */
  maxTokens?: number
  /** Temperature (0-1), defaults to model default */
  temperature?: number
  /** Whether to return JSON format (if model supports it) */
  jsonMode?: boolean
}

export interface LLMCallOutput {
  /** Generated text */
  text: string
  /** Token usage */
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  /** Finish reason */
  finishReason: string
}

export const llmCall: Tool<LLMCallInput, LLMCallOutput> = defineTool({
  name: 'llm-call',
  description: `Make an LLM sub-call for text processing (rewriting, classification, summarization, extraction). Uses the main Agent's model. Consumes tokens; use judiciously.`,
  parameters: {
    prompt: {
      type: 'string',
      description: 'User prompt (task description and input data)',
      required: true
    },
    systemPrompt: {
      type: 'string',
      description: 'System prompt (defines the LLM role and behavior)',
      required: false
    },
    maxTokens: {
      type: 'number',
      description: 'Max tokens to generate, defaults to 1000',
      required: false,
      default: 1000
    },
    temperature: {
      type: 'number',
      description: 'Temperature (0-1), controls output randomness',
      required: false
    },
    jsonMode: {
      type: 'boolean',
      description: 'Whether to expect JSON format response',
      required: false,
      default: false
    }
  },
  execute: async (input, { runtime }) => {
    const {
      prompt,
      systemPrompt,
      maxTokens = 1000,
      temperature,
      jsonMode = false
    } = input

    // Check if LLM client is available
    if (!runtime.llmClient) {
      return {
        success: false,
        error: 'LLM client not available in runtime. Make sure the agent is properly configured.'
      }
    }

    try {
      // Emit event
      runtime.eventBus.emit('tool:llm-call:start', {
        promptLength: prompt.length,
        maxTokens
      })

      // Build system prompt
      let finalSystemPrompt = systemPrompt || 'You are a helpful assistant.'
      if (jsonMode) {
        finalSystemPrompt += '\n\nIMPORTANT: Respond with valid JSON only. No markdown, no explanation, just JSON.'
      }

      // Call LLM
      const response = await runtime.llmClient.generate({
        system: finalSystemPrompt,
        messages: [{
          role: 'user',
          content: prompt
        }],
        maxTokens,
        temperature
      })

      // Consume token budget (using 'expensive' tier since LLM calls are costly)
      runtime.tokenBudget.consume('expensive', response.usage.totalTokens)

      // Emit event
      runtime.eventBus.emit('tool:llm-call:complete', {
        usage: response.usage,
        finishReason: response.finishReason
      })

      // If JSON mode, try to validate JSON
      let text = response.text
      if (jsonMode) {
        try {
          // Try to extract JSON (handles possible markdown code blocks)
          const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
          if (jsonMatch && jsonMatch[1]) {
            text = jsonMatch[1].trim()
          }
          // Validate JSON
          JSON.parse(text)
        } catch {
          // JSON parsing failed, but still return the raw text
          runtime.eventBus.emit('tool:llm-call:warning', {
            message: 'JSON mode enabled but response is not valid JSON'
          })
        }
      }

      return {
        success: true,
        data: {
          text,
          usage: response.usage,
          finishReason: response.finishReason
        }
      }
    } catch (error) {
      // Emit error event
      runtime.eventBus.emit('tool:llm-call:error', {
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      return {
        success: false,
        error: error instanceof Error ? error.message : 'LLM call failed'
      }
    }
  }
})
