/**
 * fact-forget - Tool for deprecating facts and decisions
 *
 * For facts: Permanently deletes the fact
 * For decisions: Deprecates (never deletes for audit trail)
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface FactForgetInput {
  /** Type of memory to forget */
  type: 'fact' | 'decision'
  /** ID of the fact or decision */
  id: string
  /** Reason for forgetting/deprecating */
  reason?: string
  /** For decisions: ID of superseding decision (if any) */
  supersededBy?: string
}

export interface FactForgetOutput {
  success: boolean
  type: 'fact' | 'decision'
  id: string
  action: 'deleted' | 'deprecated' | 'superseded'
  error?: string
}

export const factForget: Tool<FactForgetInput, FactForgetOutput> = defineTool({
  name: 'fact-forget',
  description: `Forget a fact or deprecate a decision.

## Behavior
- **Facts**: Permanently deleted
- **Decisions**: Deprecated with reason (never deleted for audit trail)

## Examples
- Delete fact: { type: "fact", id: "fact_abc123", reason: "No longer accurate" }
- Deprecate decision: { type: "decision", id: "dec_xyz789", reason: "Requirements changed" }
- Supersede decision: { type: "decision", id: "dec_xyz789", reason: "Replaced", supersededBy: "dec_new123" }

## Notes
- Always provide a reason for clarity
- Deprecated decisions remain in history for audit`,
  parameters: {
    type: {
      type: 'string',
      description: 'Type: "fact" or "decision"',
      required: true
    },
    id: {
      type: 'string',
      description: 'ID of the fact or decision',
      required: true
    },
    reason: {
      type: 'string',
      description: 'Reason for forgetting/deprecating',
      required: false
    },
    supersededBy: {
      type: 'string',
      description: 'For decisions: ID of superseding decision',
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
          id: input.id,
          action: 'deleted',
          error: 'Facts/decisions store not available. Make sure session-memory pack is loaded.'
        }
      }

      if (input.type === 'fact') {
        // Facts are permanently deleted
        const deleted = await store.deleteFact(input.id)

        if (!deleted) {
          return {
            success: false,
            type: 'fact',
            id: input.id,
            action: 'deleted',
            error: `Fact not found: ${input.id}`
          }
        }

        return {
          success: true,
          type: 'fact',
          id: input.id,
          action: 'deleted'
        }
      } else {
        // Decisions are deprecated (never deleted)
        const reason = input.reason ?? 'Deprecated via fact-forget tool'
        const result = await store.deprecateDecision(input.id, reason, input.supersededBy)

        if (!result) {
          return {
            success: false,
            type: 'decision',
            id: input.id,
            action: 'deprecated',
            error: `Decision not found: ${input.id}`
          }
        }

        return {
          success: true,
          type: 'decision',
          id: input.id,
          action: input.supersededBy ? 'superseded' : 'deprecated'
        }
      }
    } catch (error) {
      return {
        success: false,
        type: input.type,
        id: input.id,
        action: 'deleted',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
})
