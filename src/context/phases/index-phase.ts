/**
 * Index Phase - Generates compressed history index
 *
 * Priority: 30 (lowest)
 * Budget: fixed 500 tokens
 *
 * This phase compresses excluded messages from the session phase into
 * addressable segments. It provides a "knowledge index" that the LLM
 * can reference and expand using the ctx-expand tool.
 */

import type {
  ContextPhase,
  ContextFragment,
  AssemblyContext,
  HistoryCompressor,
  CompressedHistory
} from '../../types/context-pipeline.js'
import { PHASE_PRIORITIES, DEFAULT_BUDGETS } from '../pipeline.js'
import { SimpleHistoryCompressor } from '../compressors/simple-compressor.js'

/**
 * Configuration for index phase
 */
export interface IndexPhaseConfig {
  /** Custom history compressor */
  compressor?: HistoryCompressor
  /** Segment size for default compressor */
  segmentSize?: number
}

/**
 * Create the index phase
 */
export function createIndexPhase(config: IndexPhaseConfig = {}): ContextPhase {
  const compressor = config.compressor ?? new SimpleHistoryCompressor({
    segmentSize: config.segmentSize ?? 20
  })

  return {
    id: 'index',
    priority: PHASE_PRIORITIES.index,
    budget: DEFAULT_BUDGETS.index,

    async assemble(ctx: AssemblyContext): Promise<ContextFragment[]> {
      const { excludedMessages } = ctx
      const fragments: ContextFragment[] = []

      // If no excluded messages, skip this phase
      if (!excludedMessages || excludedMessages.length === 0) {
        return fragments
      }

      try {
        // Calculate budget for compression
        const budget = DEFAULT_BUDGETS.index.tokens ?? 500

        // Compress excluded messages
        const compressed = await compressor.compress(excludedMessages, budget)

        // Store compressed history for ctx-expand tool
        ctx.compressedHistory = compressed

        // Build the index content
        const content = buildIndexContent(compressed)

        fragments.push({
          source: 'index:compressed',
          content,
          tokens: compressed.tokens,
          metadata: {
            compressedHistory: compressed,
            segmentCount: compressed.segments.length,
            messageCount: excludedMessages.length
          }
        })
      } catch (error) {
        console.error('[IndexPhase] Compression failed:', error)

        // Provide a fallback summary
        const fallbackContent = `## History Index\n\n[Compression failed. ${excludedMessages.length} messages available via ctx-expand.]`
        fragments.push({
          source: 'index:fallback',
          content: fallbackContent,
          tokens: estimateTokens(fallbackContent)
        })
      }

      return fragments
    },

    // Only enable if there are excluded messages
    enabled(ctx: AssemblyContext): boolean {
      return (ctx.excludedMessages?.length ?? 0) > 0
    }
  }
}

/**
 * Build index content from compressed history
 */
function buildIndexContent(compressed: CompressedHistory): string {
  const lines: string[] = []

  lines.push('## History Index')
  lines.push('')
  lines.push(compressed.summary)
  lines.push('')

  if (compressed.segments.length > 0) {
    lines.push('### Available Segments')
    lines.push('')
    lines.push('Use `ctx-expand` tool to retrieve segment details:')
    lines.push('')

    for (const seg of compressed.segments) {
      const keywords = seg.keywords.length > 0
        ? ` [${seg.keywords.slice(0, 5).join(', ')}]`
        : ''
      lines.push(`- **${seg.id}**: ${seg.summary}${keywords}`)
    }
  }

  lines.push('')
  lines.push('### ctx-expand Usage')
  lines.push('')
  lines.push('To retrieve segment details:')
  lines.push('```json')
  lines.push('{ "type": "segment", "ref": "seg-0" }')
  lines.push('```')
  lines.push('')
  lines.push('To retrieve specific message range:')
  lines.push('```json')
  lines.push('{ "type": "message", "ref": "0-5" }')
  lines.push('```')

  return lines.join('\n')
}

/**
 * Estimate token count
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 3)
}
