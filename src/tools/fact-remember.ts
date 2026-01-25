/**
 * fact-remember - Tool for adding facts and decisions to long-term memory
 *
 * Facts: Learned preferences, constraints, knowledge
 * Decisions: Commitments with lifecycle tracking
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import type { FactConfidence, DecisionStatus, Fact, Decision } from '../types/session.js'

export interface FactRememberInput {
  /** Type of memory to add */
  type: 'fact' | 'decision'
  /** Content of the fact or decision */
  content: string
  /** Topics for categorization (for facts) */
  topics?: string[]
  /** Confidence level (for facts): confirmed or inferred */
  confidence?: FactConfidence
  /** Session ID for provenance (optional) */
  sessionId?: string
  /** Message ID for provenance (optional) */
  messageId?: string
}

export interface FactRememberOutput {
  success: boolean
  type: 'fact' | 'decision'
  id?: string
  item?: Fact | Decision
  error?: string
}

export const factRemember: Tool<FactRememberInput, FactRememberOutput> = defineTool({
  name: 'fact-remember',
  description: `Add a fact or decision to long-term memory.

## Usage
- **Facts**: Learned preferences, constraints, and knowledge
  - Use confidence="confirmed" for user-stated facts
  - Use confidence="inferred" for model-derived facts
  - Add topics for categorization

- **Decisions**: Commitments and choices
  - Start with status="active"
  - Use fact-forget to deprecate later

## Examples
- Add preference: { type: "fact", content: "User prefers TypeScript", topics: ["preference", "language"], confidence: "confirmed" }
- Add decision: { type: "decision", content: "Use PostgreSQL for this project" }

## Notes
- Use ctx.get("facts.list") or ctx.get("decisions.list") to retrieve
- Decisions are never deleted, only deprecated`,
  parameters: {
    type: {
      type: 'string',
      description: 'Type: "fact" or "decision"',
      required: true
    },
    content: {
      type: 'string',
      description: 'Content of the fact or decision',
      required: true
    },
    topics: {
      type: 'array',
      description: 'Topics for categorization (for facts)',
      required: false
    },
    confidence: {
      type: 'string',
      description: 'Confidence level for facts: "confirmed" or "inferred"',
      required: false
    },
    sessionId: {
      type: 'string',
      description: 'Session ID for provenance',
      required: false
    },
    messageId: {
      type: 'string',
      description: 'Message ID for provenance',
      required: false
    }
  },
  execute: async (input, { runtime }) => {
    try {
      const store = runtime.factsDecisionsStore
      if (!store) {
        return {
          success: false,
          type: input.type,
          error: 'Facts/decisions store not available. Make sure session-memory pack is loaded.'
        }
      }

      const provenance = {
        messageId: input.messageId,
        sessionId: input.sessionId ?? runtime.sessionId,
        timestamp: new Date().toISOString(),
        extractedBy: 'model' as const
      }

      if (input.type === 'fact') {
        // Check for existing similar facts to avoid duplicates
        const existingFacts = await store.getFacts({
          topics: input.topics,
          limit: 50
        })

        // Find if a similar fact already exists (same topics and similar content)
        const similarFact = existingFacts.find(f => {
          // Check if topics overlap
          const topicsMatch = input.topics?.some(t => f.topics.includes(t))
          if (!topicsMatch) return false

          // Check content similarity (simple substring match for now)
          const contentLower = input.content.toLowerCase()
          const existingLower = f.content.toLowerCase()

          // If new content is contained in existing or vice versa, consider it similar
          return contentLower.includes(existingLower.slice(0, 50)) ||
                 existingLower.includes(contentLower.slice(0, 50))
        })

        if (similarFact) {
          // Update existing fact instead of creating duplicate
          const updatedFact = await store.updateFact(similarFact.id, {
            content: input.content,
            confidence: input.confidence ?? similarFact.confidence
          })

          return {
            success: true,
            type: 'fact',
            id: similarFact.id,
            item: updatedFact ?? similarFact,
            message: `Updated existing fact ${similarFact.id} instead of creating duplicate`
          }
        }

        // No similar fact found, create new one
        const fact = await store.addFact({
          content: input.content,
          topics: input.topics ?? [],
          confidence: input.confidence ?? 'inferred',
          provenance
        })

        return {
          success: true,
          type: 'fact',
          id: fact.id,
          item: fact
        }
      } else {
        const decision = await store.addDecision({
          content: input.content,
          status: 'active' as DecisionStatus,
          provenance
        })

        return {
          success: true,
          type: 'decision',
          id: decision.id,
          item: decision
        }
      }
    } catch (error) {
      return {
        success: false,
        type: input.type,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
})
