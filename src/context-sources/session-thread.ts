/**
 * session.thread - Context source for expanding context around a message
 *
 * Given an anchor message ID, returns surrounding context (before and after).
 * Helps avoid out-of-context interpretation of search results.
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'

export interface SessionThreadParams {
  /** Anchor message ID to expand context around (required) */
  anchorMessageId: string
  /** Number of turns to include before and after anchor (default: 5) */
  windowTurns?: number
  /** Include tool messages (default: true) */
  includeTools?: boolean
}

export interface SessionThreadData {
  anchor: {
    id: string
    index: number
  }
  messages: {
    id: string
    role: string
    content: string
    timestamp: string
    isAnchor: boolean
    toolName?: string
  }[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  sessionId: string
}

export const sessionThread: ContextSource<SessionThreadParams, SessionThreadData> = defineContextSource({
  id: 'session.thread',
  kind: 'open',
  description: 'Expand context around a specific message. Shows messages before and after the anchor.',
  shortDescription: 'Get context around a message',
  resourceTypes: ['session'],
  params: [
    { name: 'anchorMessageId', type: 'string', required: true, description: 'Message ID to center on' },
    { name: 'windowTurns', type: 'number', required: false, default: 5, description: 'Turns before and after anchor' },
    { name: 'includeTools', type: 'boolean', required: false, default: true, description: 'Include tool messages' }
  ],
  examples: [
    { description: 'Get context around message', params: { anchorMessageId: 'msg_abc123' }, resultSummary: '5 turns before and after' },
    { description: 'Larger context window', params: { anchorMessageId: 'msg_abc123', windowTurns: 10 }, resultSummary: '10 turns before and after' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 60 * 1000, // 1 minute
    invalidateOn: ['session:message']
  },
  render: {
    maxTokens: 2000,
    truncateStrategy: 'middle'
  },

  fetch: async (params, runtime): Promise<ContextResult<SessionThreadData>> => {
    const startTime = Date.now()

    // Validate required params
    if (!params?.anchorMessageId) {
      return createErrorResult('Missing required field "anchorMessageId"', {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Provide anchor: ctx.get("session.thread", { anchorMessageId: "msg_xxx" })',
          'Use ctx.get("session.search") first to find message IDs'
        ]
      })
    }

    const messageStore = runtime.messageStore
    if (!messageStore) {
      return createErrorResult('Message store not available. Make sure session-history pack is loaded.', {
        durationMs: Date.now() - startTime
      })
    }

    const windowTurns = params.windowTurns ?? 5
    const includeTools = params.includeTools ?? true

    // Get the anchor message
    const anchorMessage = await messageStore.getMessage(params.anchorMessageId)
    if (!anchorMessage) {
      return createErrorResult(`Message not found: ${params.anchorMessageId}`, {
        durationMs: Date.now() - startTime,
        suggestions: [
          'Check the message ID spelling',
          'Use ctx.get("session.search") to find valid message IDs'
        ]
      })
    }

    const sessionId = anchorMessage.sessionId

    // Get all messages for the session to find anchor position
    // This is not ideal for large sessions, but works for MVP
    const allMessages = await messageStore.getRecentMessages(sessionId, 10000)

    // Find anchor index
    let anchorIndex = -1
    for (let i = 0; i < allMessages.length; i++) {
      if (allMessages[i]!.id === params.anchorMessageId) {
        anchorIndex = i
        break
      }
    }

    if (anchorIndex === -1) {
      return createErrorResult(`Message not found in session: ${params.anchorMessageId}`, {
        durationMs: Date.now() - startTime
      })
    }

    // Calculate window
    const startIdx = Math.max(0, anchorIndex - windowTurns)
    const endIdx = Math.min(allMessages.length, anchorIndex + windowTurns + 1)

    // Get messages in window
    let windowMessages = allMessages.slice(startIdx, endIdx)

    // Filter if needed
    if (!includeTools) {
      // Keep anchor even if it's a tool message
      windowMessages = windowMessages.filter(m =>
        m.role !== 'tool' || m.id === params.anchorMessageId
      )
    }

    // Transform to output format
    const outputMessages = windowMessages.map(m => {
      const msg: SessionThreadData['messages'][0] = {
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        isAnchor: m.id === params.anchorMessageId
      }

      if (m.toolCall) {
        msg.toolName = m.toolCall.name
      }

      return msg
    })

    // Check if there's more before/after
    const hasMoreBefore = startIdx > 0
    const hasMoreAfter = endIdx < allMessages.length

    // Render output
    const lines: string[] = [
      '# Conversation Thread',
      '',
      `**Session:** ${sessionId}`,
      `**Anchor:** ${params.anchorMessageId}`,
      `**Window:** ${windowTurns} turns before/after`,
      ''
    ]

    if (hasMoreBefore) {
      lines.push(`*... ${startIdx} earlier messages ...*`)
      lines.push('')
    }

    for (const msg of outputMessages) {
      const roleIcon = getRoleIcon(msg.role)
      const timestamp = new Date(msg.timestamp).toLocaleTimeString()
      const anchorMarker = msg.isAnchor ? ' ← **ANCHOR**' : ''

      lines.push(`### ${roleIcon} ${msg.role} (${timestamp})${anchorMarker}`)
      lines.push('')

      // Truncate very long messages
      let content = msg.content
      if (content.length > 500 && !msg.isAnchor) {
        content = content.substring(0, 497) + '...'
      }
      lines.push(content)
      lines.push('')

      if (msg.toolName) {
        lines.push(`*Tool: \`${msg.toolName}\`*`)
        lines.push('')
      }
    }

    if (hasMoreAfter) {
      lines.push(`*... ${allMessages.length - endIdx} later messages ...*`)
    }

    return createSuccessResult(
      {
        anchor: {
          id: params.anchorMessageId,
          index: anchorIndex
        },
        messages: outputMessages,
        hasMoreBefore,
        hasMoreAfter,
        sessionId
      },
      lines.join('\n'),
      {
        provenance: {
          operations: [],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete: !hasMoreBefore && !hasMoreAfter,
          limitations: (hasMoreBefore || hasMoreAfter)
            ? ['More messages available. Increase windowTurns to see more.']
            : undefined
        },
        kindEcho: {
          source: 'session.thread',
          kind: 'open',
          paramsUsed: { anchorMessageId: params.anchorMessageId, windowTurns }
        }
      }
    )
  }
})

function getRoleIcon(role: string): string {
  switch (role) {
    case 'user': return '👤'
    case 'assistant': return '🤖'
    case 'tool': return '🔧'
    case 'system': return '⚙️'
    default: return '📝'
  }
}
