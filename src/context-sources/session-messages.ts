/**
 * session.messages - Context source for conversation messages
 *
 * Provides a view of recent conversation turns (user/assistant messages).
 * This is different from session.trace which returns operation events.
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { Message } from '../types/session.js'

export interface SessionMessagesParams {
  /** Number of recent turns to include (default: 10) */
  turns?: number
  /** Include tool call messages (default: true) */
  includeTools?: boolean
  /** Include tool results in output (default: false) */
  includeResults?: boolean
  /** Output format: summary or full (default: summary) */
  format?: 'summary' | 'full'
}

export interface SessionMessagesData {
  messages: {
    id: string
    role: 'user' | 'assistant' | 'tool' | 'system'
    summary: string
    content?: string
    timestamp: string
    toolName?: string
    toolResult?: unknown
  }[]
  sessionId: string
  totalMessages: number
}

export const sessionMessages: ContextSource<SessionMessagesParams, SessionMessagesData> = defineContextSource({
  id: 'session.messages',
  kind: 'index',
  description: 'Get recent conversation messages. Shows the last N user/assistant turns.',
  shortDescription: 'Get conversation messages',
  resourceTypes: ['session'],
  params: [
    { name: 'turns', type: 'number', required: false, default: 10, description: 'Number of recent turns' },
    { name: 'includeTools', type: 'boolean', required: false, default: true, description: 'Include tool messages' },
    { name: 'includeResults', type: 'boolean', required: false, default: false, description: 'Include tool results' },
    { name: 'format', type: 'string', required: false, default: 'summary', description: 'Output format', enum: ['summary', 'full'] }
  ],
  examples: [
    { description: 'Get last 10 messages', params: {}, resultSummary: 'Recent 10 conversation turns' },
    { description: 'Get last 5 turns without tools', params: { turns: 5, includeTools: false }, resultSummary: 'Last 5 user/assistant messages' },
    { description: 'Get full content', params: { turns: 3, format: 'full' }, resultSummary: 'Full content of last 3 turns' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 30 * 1000, // 30 seconds
    invalidateOn: ['session:message']
  },
  render: {
    maxTokens: 800,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<SessionMessagesData>> => {
    const startTime = Date.now()

    const messageStore = runtime.messageStore
    if (!messageStore) {
      return createErrorResult('Message store not available. Make sure session-history pack is loaded.', {
        durationMs: Date.now() - startTime
      })
    }

    const turns = params?.turns ?? 10
    const includeTools = params?.includeTools ?? true
    const includeResults = params?.includeResults ?? false
    const format = params?.format ?? 'summary'

    // Get current session
    const sessionId = await messageStore.getCurrentSessionId()
    if (!sessionId) {
      return createErrorResult('No active session. Create a session first.', {
        durationMs: Date.now() - startTime,
        suggestions: ['Start a new conversation to create a session']
      })
    }

    // Get recent messages
    // Request more than needed to account for filtering
    const rawMessages = await messageStore.getRecentMessages(sessionId, turns * 2)

    // Filter messages
    let messages = rawMessages
    if (!includeTools) {
      messages = messages.filter(m => m.role !== 'tool')
    }

    // Take only requested turns
    messages = messages.slice(-turns)

    // Transform to output format
    const outputMessages = messages.map(m => {
      const msg: SessionMessagesData['messages'][0] = {
        id: m.id,
        role: m.role,
        summary: createSummary(m),
        timestamp: m.timestamp
      }

      if (format === 'full') {
        msg.content = m.content
      }

      if (m.toolCall) {
        msg.toolName = m.toolCall.name
        if (includeResults && m.toolCall.result) {
          msg.toolResult = m.toolCall.result
        }
      }

      return msg
    })

    // Get session meta for total count
    const session = await messageStore.getSession(sessionId)
    const totalMessages = session?.messageCount ?? messages.length

    // Render output
    const lines: string[] = [
      '# Conversation Messages',
      '',
      `**Session:** ${sessionId}`,
      `**Showing:** ${outputMessages.length} of ${totalMessages} messages`,
      ''
    ]

    for (const msg of outputMessages) {
      const roleIcon = getRoleIcon(msg.role)
      const timestamp = new Date(msg.timestamp).toLocaleTimeString()

      if (format === 'full' && msg.content) {
        lines.push(`### ${roleIcon} ${msg.role} (${timestamp})`)
        lines.push('')
        lines.push(msg.content)
        lines.push('')
      } else {
        lines.push(`- ${roleIcon} **${msg.role}** [${timestamp}]: ${msg.summary}`)
      }

      if (msg.toolName) {
        lines.push(`  - Tool: \`${msg.toolName}\``)
      }
    }

    return createSuccessResult(
      {
        messages: outputMessages,
        sessionId,
        totalMessages
      },
      lines.join('\n'),
      {
        provenance: {
          operations: [],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete: outputMessages.length >= totalMessages,
          limitations: outputMessages.length < totalMessages
            ? [`Showing ${outputMessages.length} of ${totalMessages}. Use larger turns value to see more.`]
            : undefined
        },
        kindEcho: {
          source: 'session.messages',
          kind: 'index',
          paramsUsed: { turns, includeTools, format }
        },
        next: [
          {
            source: 'session.search',
            params: { query: '' },
            why: 'Search for specific topics in history',
            confidence: 0.6
          }
        ]
      }
    )
  }
})

function createSummary(message: Message): string {
  let summary = message.content
  if (summary.length > 100) {
    summary = summary.substring(0, 97) + '...'
  }
  summary = summary.replace(/\n/g, ' ')
  return summary
}

function getRoleIcon(role: string): string {
  switch (role) {
    case 'user': return '👤'
    case 'assistant': return '🤖'
    case 'tool': return '🔧'
    case 'system': return '⚙️'
    default: return '📝'
  }
}
