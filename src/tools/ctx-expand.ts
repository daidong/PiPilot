/**
 * ctx-expand - Context expansion tool for retrieving compressed history
 *
 * This tool allows the LLM to request specific context that was compressed
 * or excluded during context assembly. It can retrieve:
 * - Segments: Compressed history segments (from index phase)
 * - Messages: Specific message ranges
 * - Memory: Memory items by key
 * - Search: Search through compressed history by keywords
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import type {
  CompressedHistory,
  HistorySegment,
  RuntimeWithCompressor
} from '../types/context-pipeline.js'
import type { Message } from '../types/session.js'

/**
 * Expansion type
 */
export type CtxExpandType = 'segment' | 'message' | 'memory' | 'search'

/**
 * Input for ctx-expand tool
 */
export interface CtxExpandInput {
  /** Type of expansion */
  type: CtxExpandType
  /** Reference (segment ID, message range, memory key, or search query) */
  ref: string
  /** Maximum tokens for the response (optional) */
  maxTokens?: number
}

/**
 * Output from ctx-expand tool
 */
export interface CtxExpandOutput {
  /** Type of content returned */
  type: CtxExpandType
  /** Reference that was expanded */
  ref: string
  /** Expanded content */
  content: string
  /** Estimated token count */
  tokens: number
  /** Whether content was truncated */
  truncated: boolean
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Estimate token count
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

/**
 * Truncate content to fit token limit
 */
function truncateToTokens(content: string, maxTokens: number): string {
  const maxChars = maxTokens * 3 - 30
  if (content.length <= maxChars) return content
  return content.slice(0, maxChars) + '\n[...truncated]'
}

/**
 * Format messages for output
 */
function formatMessages(messages: Message[]): string {
  return messages.map(msg => {
    const roleLabel = msg.role.charAt(0).toUpperCase() + msg.role.slice(1)
    if (msg.role === 'tool' && msg.toolCall) {
      return `**${roleLabel}** (${msg.toolCall.name}):\n\`\`\`\n${msg.content}\n\`\`\``
    }
    return `**${roleLabel}**: ${msg.content}`
  }).join('\n\n')
}

/**
 * Expand a segment from compressed history
 */
async function expandSegment(
  segmentId: string,
  compressedHistory: CompressedHistory | undefined,
  runtime: RuntimeWithCompressor,
  maxTokens?: number
): Promise<CtxExpandOutput> {
  // Find segment
  const segment = compressedHistory?.segments.find(s => s.id === segmentId)

  if (!segment) {
    return {
      type: 'segment',
      ref: segmentId,
      content: `[Segment not found: ${segmentId}]`,
      tokens: 15,
      truncated: false
    }
  }

  // Get messages for this segment range
  const messages = await getMessagesInRange(runtime, segment.range[0], segment.range[1])

  if (messages.length === 0) {
    return {
      type: 'segment',
      ref: segmentId,
      content: `[No messages in segment: ${segmentId}]`,
      tokens: 15,
      truncated: false
    }
  }

  // Format content
  let content = [
    `## Segment: ${segmentId}`,
    `Messages ${segment.range[0]}-${segment.range[1] - 1}`,
    '',
    formatMessages(messages)
  ].join('\n')

  // Truncate if needed
  let truncated = false
  const tokens = estimateTokens(content)
  if (maxTokens && tokens > maxTokens) {
    content = truncateToTokens(content, maxTokens)
    truncated = true
  }

  return {
    type: 'segment',
    ref: segmentId,
    content,
    tokens: maxTokens ? Math.min(tokens, maxTokens) : tokens,
    truncated,
    metadata: {
      messageCount: messages.length,
      range: segment.range,
      keywords: segment.keywords
    }
  }
}

/**
 * Expand a message range
 */
async function expandMessages(
  rangeRef: string,
  runtime: RuntimeWithCompressor,
  maxTokens?: number
): Promise<CtxExpandOutput> {
  // Parse range: "start-end" or "last-N"
  let startIdx = 0
  let endIdx = 10

  if (rangeRef.startsWith('last-')) {
    const count = parseInt(rangeRef.slice(5), 10)
    if (!isNaN(count) && runtime.messageStore) {
      const recentMsgs = await runtime.messageStore.getRecentMessages(runtime.sessionId, 1000)
      startIdx = Math.max(0, recentMsgs.length - count)
      endIdx = recentMsgs.length
    }
  } else if (rangeRef.includes('-')) {
    const parts = rangeRef.split('-')
    const start = parseInt(parts[0] ?? '0', 10)
    const end = parseInt(parts[1] ?? '10', 10)
    if (!isNaN(start) && !isNaN(end)) {
      startIdx = start
      endIdx = end
    }
  }

  // Get messages
  const messages = await getMessagesInRange(runtime, startIdx, endIdx)

  if (messages.length === 0) {
    return {
      type: 'message',
      ref: rangeRef,
      content: `[No messages in range: ${rangeRef}]`,
      tokens: 15,
      truncated: false
    }
  }

  // Format content
  let content = [
    `## Messages ${startIdx}-${endIdx - 1}`,
    '',
    formatMessages(messages)
  ].join('\n')

  // Truncate if needed
  let truncated = false
  const tokens = estimateTokens(content)
  if (maxTokens && tokens > maxTokens) {
    content = truncateToTokens(content, maxTokens)
    truncated = true
  }

  return {
    type: 'message',
    ref: rangeRef,
    content,
    tokens: maxTokens ? Math.min(tokens, maxTokens) : tokens,
    truncated,
    metadata: {
      messageCount: messages.length,
      range: [startIdx, endIdx]
    }
  }
}

/**
 * Expand memory by key
 */
async function expandMemory(
  key: string,
  runtime: RuntimeWithCompressor,
  maxTokens?: number
): Promise<CtxExpandOutput> {
  if (!runtime.memoryStorage) {
    return {
      type: 'memory',
      ref: key,
      content: '[Memory storage not available]',
      tokens: 10,
      truncated: false
    }
  }

  // Parse namespace:key format
  const parts = key.split(':')
  const namespace = parts[0] ?? 'project'
  const keyParts = parts.slice(1)
  const actualKey = keyParts.length > 0 ? keyParts.join(':') : namespace

  const item = await runtime.memoryStorage.get(
    keyParts.length > 0 ? namespace : 'project',
    keyParts.length > 0 ? actualKey : namespace
  )

  if (!item) {
    return {
      type: 'memory',
      ref: key,
      content: `[Memory key not found: ${key}]`,
      tokens: 15,
      truncated: false
    }
  }

  // Format content
  let content: string
  if (item.valueText) {
    content = `## Memory: ${item.key}\n\n${item.valueText}`
  } else if (typeof item.value === 'string') {
    content = `## Memory: ${item.key}\n\n${item.value}`
  } else {
    content = `## Memory: ${item.key}\n\n\`\`\`json\n${JSON.stringify(item.value, null, 2)}\n\`\`\``
  }

  // Truncate if needed
  let truncated = false
  const tokens = estimateTokens(content)
  if (maxTokens && tokens > maxTokens) {
    content = truncateToTokens(content, maxTokens)
    truncated = true
  }

  return {
    type: 'memory',
    ref: key,
    content,
    tokens: maxTokens ? Math.min(tokens, maxTokens) : tokens,
    truncated,
    metadata: {
      namespace: item.namespace,
      key: item.key,
      tags: item.tags
    }
  }
}

/**
 * Search through compressed history
 */
async function expandSearch(
  query: string,
  compressedHistory: CompressedHistory | undefined,
  _runtime: RuntimeWithCompressor,
  maxTokens?: number
): Promise<CtxExpandOutput> {
  if (!compressedHistory || compressedHistory.segments.length === 0) {
    return {
      type: 'search',
      ref: query,
      content: '[No compressed history available for search]',
      tokens: 15,
      truncated: false
    }
  }

  // Search segments by keyword match
  const queryWords = query.toLowerCase().split(/\s+/)
  const matchingSegments: Array<{ segment: HistorySegment; score: number }> = []

  for (const segment of compressedHistory.segments) {
    const segmentKeywords = new Set(segment.keywords.map(k => k.toLowerCase()))
    const summaryWords = new Set(segment.summary.toLowerCase().split(/\s+/))

    let score = 0
    for (const word of queryWords) {
      if (segmentKeywords.has(word)) score += 2
      if (summaryWords.has(word)) score += 1
    }

    if (score > 0) {
      matchingSegments.push({ segment, score })
    }
  }

  if (matchingSegments.length === 0) {
    return {
      type: 'search',
      ref: query,
      content: `[No segments match query: ${query}]\n\nAvailable keywords: ${getTopKeywords(compressedHistory, 20).join(', ')}`,
      tokens: 50,
      truncated: false
    }
  }

  // Sort by score descending
  matchingSegments.sort((a, b) => b.score - a.score)

  // Build result
  const lines: string[] = [
    `## Search Results: "${query}"`,
    '',
    `Found ${matchingSegments.length} matching segment(s):`,
    ''
  ]

  for (const { segment, score } of matchingSegments.slice(0, 5)) {
    lines.push(`### ${segment.id} (score: ${score})`)
    lines.push(`Messages ${segment.range[0]}-${segment.range[1] - 1}`)
    lines.push(segment.summary)
    lines.push(`Keywords: ${segment.keywords.join(', ')}`)
    lines.push('')
  }

  if (matchingSegments.length > 5) {
    lines.push(`[+${matchingSegments.length - 5} more results]`)
  }

  let content = lines.join('\n')

  // Truncate if needed
  let truncated = false
  const tokens = estimateTokens(content)
  if (maxTokens && tokens > maxTokens) {
    content = truncateToTokens(content, maxTokens)
    truncated = true
  }

  return {
    type: 'search',
    ref: query,
    content,
    tokens: maxTokens ? Math.min(tokens, maxTokens) : tokens,
    truncated,
    metadata: {
      matchCount: matchingSegments.length,
      topSegments: matchingSegments.slice(0, 5).map(m => m.segment.id)
    }
  }
}

/**
 * Get top keywords from compressed history
 */
function getTopKeywords(compressedHistory: CompressedHistory, limit: number): string[] {
  const keywordCount = new Map<string, number>()

  for (const segment of compressedHistory.segments) {
    for (const keyword of segment.keywords) {
      keywordCount.set(keyword, (keywordCount.get(keyword) ?? 0) + 1)
    }
  }

  return [...keywordCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word)
}

/**
 * Get messages in a range from runtime
 */
async function getMessagesInRange(
  runtime: RuntimeWithCompressor,
  startIdx: number,
  endIdx: number
): Promise<Message[]> {
  // Try message store first
  if (runtime.messageStore) {
    try {
      return await runtime.messageStore.getMessageRange(runtime.sessionId, startIdx, endIdx)
    } catch (error) {
      console.error('[ctx-expand] Failed to get messages from store:', error)
    }
  }

  // Fall back to session state
  const storedMessages = runtime.sessionState.get<Message[]>('messages')
  if (storedMessages) {
    return storedMessages.slice(startIdx, endIdx)
  }

  return []
}

/**
 * Create ctx-expand tool
 */
export const ctxExpand: Tool<CtxExpandInput, CtxExpandOutput> = defineTool({
  name: 'ctx-expand',
  activity: {
    formatCall: (a) => {
      const seg = (a.ref as string) || (a.segment as string) || (a.query as string) || ''
      return { label: `Expand: ${seg.slice(0, 40)}`, icon: 'memory' }
    },
    formatResult: (_r, a) => {
      const seg = (a?.ref as string) || (a?.segment as string) || (a?.query as string) || ''
      return { label: seg ? `Expanded "${seg.slice(0, 30)}"` : 'Expanded context', icon: 'memory' }
    }
  },
  description: `Expand compressed context from history index. Types: segment (by ID e.g. "seg-0"), message (range e.g. "last-10"), memory (key e.g. "project:rules"), search (keywords).`,
  parameters: {
    type: {
      type: 'string',
      description: 'Type of expansion: segment, message, memory, or search',
      required: true,
      enum: ['segment', 'message', 'memory', 'search']
    },
    ref: {
      type: 'string',
      description: 'Reference: segment ID (seg-0), message range (0-10), memory key (namespace:key), or search query',
      required: true
    },
    maxTokens: {
      type: 'number',
      description: 'Maximum tokens for the response (optional)',
      required: false
    }
  },
  execute: async (input, { runtime }) => {
    const { type, ref, maxTokens } = input
    const extendedRuntime = runtime as RuntimeWithCompressor

    // Best-effort: record WorkingSet continuity if ref looks like an entity id
    if (runtime.workingSetTracker?.recordUsage && ref) {
      const uuidMatch = ref.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
      const idMatch = ref.match(/\bid:([0-9a-f-]{6,})\b/i)
      const candidate = (idMatch && idMatch[1]) || (uuidMatch && uuidMatch[0])
      if (candidate) {
        runtime.workingSetTracker.recordUsage(candidate, 'tool-access')
      }
    }

    // Get compressed history from runtime or session state
    const compressedHistory = extendedRuntime.compressedHistory ??
      extendedRuntime.sessionState.get<CompressedHistory>('compressedHistory')

    let output: CtxExpandOutput

    switch (type) {
      case 'segment':
        output = await expandSegment(ref, compressedHistory, extendedRuntime, maxTokens)
        break

      case 'message':
        output = await expandMessages(ref, extendedRuntime, maxTokens)
        break

      case 'memory':
        output = await expandMemory(ref, extendedRuntime, maxTokens)
        break

      case 'search':
        output = await expandSearch(ref, compressedHistory, extendedRuntime, maxTokens)
        break

      default:
        return {
          success: false,
          error: `Unknown expansion type: ${type}. Use: segment, message, memory, or search`
        }
    }

    return {
      success: true,
      data: output
    }
  }
})
