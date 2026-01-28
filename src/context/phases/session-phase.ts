/**
 * Session Phase - Assembles recent conversation history
 *
 * Priority: 50
 * Budget: remaining (takes what's left after other phases)
 *
 * This phase includes recent messages from the conversation history,
 * newest first. Messages that don't fit are tracked in excludedMessages
 * for the index phase to compress.
 */

import type { ContextPhase, ContextFragment, AssemblyContext } from '../../types/context-pipeline.js'
import type { Message } from '../../types/session.js'
import { PHASE_PRIORITIES, DEFAULT_BUDGETS } from '../pipeline.js'

/**
 * Configuration for session phase
 */
export interface SessionPhaseConfig {
  /** Maximum number of messages to consider (default: 100) */
  maxMessages?: number
  /** Include tool messages (default: true) */
  includeToolMessages?: boolean
  /** Message format: 'full' or 'compact' */
  format?: 'full' | 'compact'
}

/**
 * Create the session phase
 */
export function createSessionPhase(config: SessionPhaseConfig = {}): ContextPhase {
  const {
    maxMessages = 100,
    includeToolMessages = true,
    format = 'full'
  } = config

  return {
    id: 'session',
    priority: PHASE_PRIORITIES.session,
    budget: DEFAULT_BUDGETS.session,

    async assemble(ctx: AssemblyContext): Promise<ContextFragment[]> {
      const { runtime, remainingBudget } = ctx
      const fragments: ContextFragment[] = []

      // Get messages from message store or runtime state
      const messages = await getMessages(runtime, maxMessages, includeToolMessages)

      if (messages.length === 0) {
        return fragments
      }

      // Calculate how many messages we can fit
      let usedTokens = 0
      const includedMessages: Message[] = []
      const excludedMessages: Message[] = []

      // Process messages from newest to oldest
      const reversedMessages = [...messages].reverse()

      for (const msg of reversedMessages) {
        const formatted = formatMessage(msg, format)
        const msgTokens = estimateTokens(formatted)

        if (usedTokens + msgTokens <= remainingBudget) {
          includedMessages.unshift(msg) // Add to front to maintain order
          usedTokens += msgTokens
        } else {
          excludedMessages.unshift(msg) // Track excluded messages
        }
      }

      // Update context with excluded messages for index phase
      ctx.excludedMessages = excludedMessages

      // If no messages fit, still return header
      if (includedMessages.length === 0) {
        const headerContent = `## Conversation\n\n[All ${messages.length} messages excluded due to token budget. Use ctx-expand to retrieve specific messages.]`
        fragments.push({
          source: 'session:header',
          content: headerContent,
          tokens: estimateTokens(headerContent)
        })
        return fragments
      }

      // Build conversation content
      const parts: string[] = ['## Prior Conversation']

      if (excludedMessages.length > 0) {
        parts.push(`\n[${excludedMessages.length} earlier messages in index - use ctx-expand to retrieve]`)
      }

      parts.push('')

      for (const msg of includedMessages) {
        parts.push(formatMessage(msg, format))
        parts.push('')
      }

      const content = parts.join('\n')

      fragments.push({
        source: 'session:messages',
        content,
        tokens: estimateTokens(content),
        metadata: {
          includedCount: includedMessages.length,
          excludedCount: excludedMessages.length,
          totalCount: messages.length
        }
      })

      return fragments
    },

    // Always enabled if we have a message store or messages in state
    enabled(ctx: AssemblyContext): boolean {
      return ctx.runtime.messageStore !== undefined ||
             ctx.runtime.sessionState.has('messages')
    }
  }
}

/**
 * Get messages from runtime
 */
async function getMessages(
  runtime: import('../../types/runtime.js').Runtime,
  maxMessages: number,
  includeToolMessages: boolean
): Promise<Message[]> {
  let messages: Message[] = []

  // Try message store first
  if (runtime.messageStore) {
    try {
      messages = await runtime.messageStore.getRecentMessages(
        runtime.sessionId,
        maxMessages
      )
    } catch (error) {
      console.error('[SessionPhase] Failed to get messages from store:', error)
    }
  }

  // Fall back to session state if no messages
  if (messages.length === 0) {
    const storedMessages = runtime.sessionState.get<Message[]>('messages')
    if (storedMessages) {
      messages = storedMessages.slice(-maxMessages)
    }
  }

  // Filter tool messages if needed
  if (!includeToolMessages) {
    messages = messages.filter(m => m.role !== 'tool')
  }

  return messages
}

/**
 * Format a message for display
 */
function formatMessage(msg: Message, format: 'full' | 'compact'): string {
  const roleLabels: Record<string, string> = {
    user: 'User',
    assistant: 'Assistant',
    tool: 'Tool',
    system: 'System'
  }

  const roleLabel = roleLabels[msg.role] || msg.role

  if (format === 'compact') {
    // Compact format: single line summary
    const contentPreview = msg.content.slice(0, 100).replace(/\n/g, ' ')
    const suffix = msg.content.length > 100 ? '...' : ''
    return `**${roleLabel}**: ${contentPreview}${suffix}`
  }

  // Full format
  if (msg.role === 'tool' && msg.toolCall) {
    return [
      `**${roleLabel}** (${msg.toolCall.name}):`,
      '```',
      msg.content,
      '```'
    ].join('\n')
  }

  return `**${roleLabel}**: ${msg.content}`
}

/**
 * Estimate token count
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 3)
}
