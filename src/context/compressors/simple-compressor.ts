/**
 * SimpleHistoryCompressor - Simple message history compression
 *
 * Groups messages into fixed-size segments, extracts keywords, and generates summaries.
 * This provides a baseline implementation that doesn't require LLM calls.
 */

import type {
  HistoryCompressor,
  CompressedHistory,
  HistorySegment
} from '../../types/context-pipeline.js'
import type { Message } from '../../types/session.js'

/**
 * Configuration for SimpleHistoryCompressor
 */
export interface SimpleHistoryCompressorConfig {
  /** Number of messages per segment (default: 20) */
  segmentSize?: number
  /** Maximum keywords to extract per segment (default: 10) */
  maxKeywordsPerSegment?: number
  /** Minimum word length for keyword extraction (default: 4) */
  minKeywordLength?: number
  /** Stop words to exclude from keywords */
  stopWords?: Set<string>
}

/**
 * Default English stop words
 */
const DEFAULT_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'he',
  'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'whose', 'where',
  'when', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'also', 'now', 'here',
  'there', 'then', 'once', 'if', 'because', 'until', 'while', 'about',
  'against', 'between', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'up', 'down', 'out', 'off', 'over', 'under', 'again'
])

/**
 * Simple history compressor implementation
 */
export class SimpleHistoryCompressor implements HistoryCompressor {
  private config: Required<SimpleHistoryCompressorConfig>

  constructor(config: SimpleHistoryCompressorConfig = {}) {
    this.config = {
      segmentSize: config.segmentSize ?? 20,
      maxKeywordsPerSegment: config.maxKeywordsPerSegment ?? 10,
      minKeywordLength: config.minKeywordLength ?? 4,
      stopWords: config.stopWords ?? DEFAULT_STOP_WORDS
    }
  }

  /**
   * Compress messages into addressable segments
   */
  async compress(messages: Message[], maxTokens: number): Promise<CompressedHistory> {
    if (messages.length === 0) {
      return {
        summary: 'No conversation history.',
        segments: [],
        tokens: 10 // Approximate token count for empty summary
      }
    }

    // Group messages into segments
    const segments = this.createSegments(messages)

    // Generate compressed output
    const segmentDescriptions = segments.map(seg => {
      const keywordStr = seg.keywords.length > 0 ? ` [${seg.keywords.join(', ')}]` : ''
      return `- ${seg.id}: ${seg.summary}${keywordStr} (msgs ${seg.range[0]}-${seg.range[1] - 1})`
    })

    const summary = this.generateOverallSummary(messages, segments)

    // Build the compressed content
    const content = [
      '## Conversation History Index',
      '',
      summary,
      '',
      '### Segments (use ctx-expand to retrieve details)',
      '',
      ...segmentDescriptions
    ].join('\n')

    // Estimate tokens (roughly 3 characters per token)
    const tokens = Math.ceil(content.length / 3)

    // If we're over budget, truncate segments
    if (tokens > maxTokens) {
      return this.truncateToFit(summary, segments, maxTokens)
    }

    return {
      summary,
      segments,
      tokens
    }
  }

  /**
   * Create segments from messages
   */
  private createSegments(messages: Message[]): HistorySegment[] {
    const segments: HistorySegment[] = []
    const { segmentSize } = this.config

    for (let i = 0; i < messages.length; i += segmentSize) {
      const end = Math.min(i + segmentSize, messages.length)
      const segmentMessages = messages.slice(i, end)

      const segment: HistorySegment = {
        id: `seg-${segments.length}`,
        range: [i, end],
        summary: this.summarizeSegment(segmentMessages),
        keywords: this.extractKeywords(segmentMessages),
        messageCount: segmentMessages.length
      }

      segments.push(segment)
    }

    return segments
  }

  /**
   * Summarize a segment of messages
   */
  private summarizeSegment(messages: Message[]): string {
    // Count message types
    const userCount = messages.filter(m => m.role === 'user').length
    const assistantCount = messages.filter(m => m.role === 'assistant').length
    const toolCount = messages.filter(m => m.role === 'tool').length

    // Extract main topics from user messages
    const userMessages = messages.filter(m => m.role === 'user')
    const topics = this.extractTopics(userMessages)

    // Build summary
    const parts: string[] = []

    if (topics.length > 0) {
      parts.push(`Topics: ${topics.slice(0, 3).join(', ')}`)
    }

    parts.push(`[${userCount}u/${assistantCount}a${toolCount > 0 ? `/${toolCount}t` : ''}]`)

    return parts.join(' ')
  }

  /**
   * Extract topic keywords from messages
   */
  private extractTopics(messages: Message[]): string[] {
    const allContent = messages
      .map(m => m.content)
      .join(' ')

    // Extract words and count frequency
    const words = allContent
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= this.config.minKeywordLength)
      .filter(w => !this.config.stopWords.has(w))

    const wordFreq = new Map<string, number>()
    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1)
    }

    // Sort by frequency and take top keywords
    const sortedWords = [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([word]) => word)
      .slice(0, 5)

    return sortedWords
  }

  /**
   * Extract keywords from a segment
   */
  private extractKeywords(messages: Message[]): string[] {
    const allContent = messages
      .map(m => {
        // Include tool names if present
        const toolPart = m.toolCall ? ` tool:${m.toolCall.name}` : ''
        return m.content + toolPart
      })
      .join(' ')

    // Extract words
    const words = allContent
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= this.config.minKeywordLength)
      .filter(w => !this.config.stopWords.has(w))

    // Count frequency
    const wordFreq = new Map<string, number>()
    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1)
    }

    // Sort by frequency and take top keywords
    return [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([word]) => word)
      .slice(0, this.config.maxKeywordsPerSegment)
  }

  /**
   * Generate overall summary of the conversation
   */
  private generateOverallSummary(messages: Message[], segments: HistorySegment[]): string {
    const userCount = messages.filter(m => m.role === 'user').length
    const assistantCount = messages.filter(m => m.role === 'assistant').length
    const toolCount = messages.filter(m => m.role === 'tool').length

    // Collect all keywords for topic overview
    const allKeywords = new Map<string, number>()
    for (const seg of segments) {
      for (const kw of seg.keywords) {
        allKeywords.set(kw, (allKeywords.get(kw) ?? 0) + 1)
      }
    }

    const topKeywords = [...allKeywords.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([word]) => word)
      .slice(0, 5)

    const topicStr = topKeywords.length > 0 ? ` Key topics: ${topKeywords.join(', ')}.` : ''

    return `Conversation has ${messages.length} messages (${userCount} user, ${assistantCount} assistant${toolCount > 0 ? `, ${toolCount} tool` : ''}) in ${segments.length} segments.${topicStr}`
  }

  /**
   * Truncate compressed history to fit within token budget
   */
  private truncateToFit(
    summary: string,
    segments: HistorySegment[],
    maxTokens: number
  ): CompressedHistory {
    // Start with just the summary
    const baseSummary = `${summary} (${segments.length} segments available via ctx-expand)`
    const baseTokens = Math.ceil(baseSummary.length / 3)

    if (baseTokens >= maxTokens) {
      // Even summary is too long, truncate it
      const maxChars = maxTokens * 3 - 30 // Leave room for "..."
      return {
        summary: summary.slice(0, maxChars) + '...',
        segments: segments.map(s => ({
          ...s,
          summary: s.summary.slice(0, 50) + '...'
        })),
        tokens: maxTokens
      }
    }

    // Include as many segment references as we can
    const remainingTokens = maxTokens - baseTokens
    const tokensPerSegment = 30 // Rough estimate per segment line
    const segmentsToInclude = Math.min(
      segments.length,
      Math.floor(remainingTokens / tokensPerSegment)
    )

    const includedSegments = segments.slice(-segmentsToInclude) // Keep recent segments

    return {
      summary: baseSummary,
      segments: includedSegments,
      tokens: baseTokens + (includedSegments.length * tokensPerSegment)
    }
  }

  /**
   * Get configuration
   */
  getConfig(): Required<SimpleHistoryCompressorConfig> {
    return { ...this.config }
  }
}

/**
 * Create a simple history compressor with default configuration
 */
export function createSimpleCompressor(
  config?: SimpleHistoryCompressorConfig
): SimpleHistoryCompressor {
  return new SimpleHistoryCompressor(config)
}
