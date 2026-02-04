/**
 * Summary Card Generator - RFC-009
 *
 * Generates bounded summary cards for entities using a hybrid approach:
 * 1. Deterministic extraction for short content (< llmThreshold tokens)
 * 2. LLM fallback for long or low-density content
 *
 * Summary cards are used for:
 * - Context assembly (shape degradation)
 * - WorkingSet retrieval
 * - Index display
 */

import { createHash } from 'crypto'
import { countTokens, truncateToTokens } from '../utils/tokenizer.js'
import type {
  SummaryCardConfig,
  SummaryCardMethod,
  MemoryEntityType
} from '../types/memory-entity.js'
import { DEFAULT_SUMMARY_CARD_CONFIG } from '../types/memory-entity.js'

// ============ Types ============

/**
 * Result of summary card generation
 */
export interface SummaryCardResult {
  /** Generated summary card content */
  summaryCard: string
  /** Method used to generate the summary */
  method: SummaryCardMethod
  /** Hash of the source content */
  contentHash: string
  /** Token count of the summary */
  tokens: number
}

/**
 * Options for generating a summary card
 */
export interface GenerateSummaryCardOptions {
  /** Entity type */
  type: MemoryEntityType
  /** Entity title */
  title: string
  /** Entity content */
  content: string
  /** Entity tags */
  tags?: string[]
  /** Configuration override */
  config?: Partial<SummaryCardConfig>
  /** LLM function for fallback (if not provided, deterministic only) */
  llmSummarize?: (prompt: string) => Promise<string>
}

// ============ Hash Generation ============

/**
 * Generate content hash for change detection
 */
export function generateContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

// ============ Deterministic Extraction ============

/**
 * Extract key sentences from content (heuristic-based)
 *
 * Strategy:
 * 1. First sentence (usually topic statement)
 * 2. Sentences with key indicators (numbers, "important", "key", etc.)
 * 3. Last sentence (often conclusion)
 */
function extractKeySentences(content: string, maxSentences: number = 5): string[] {
  // Split into sentences (simple heuristic)
  const sentences = content
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 10) // Filter very short fragments

  if (sentences.length === 0) {
    return [content.slice(0, 500)]
  }

  if (sentences.length <= maxSentences) {
    return sentences
  }

  const selected: string[] = []
  const usedIndices = new Set<number>()

  // Always include first sentence (safe: we checked length > maxSentences above)
  const firstSentence = sentences[0]
  if (firstSentence) {
    selected.push(firstSentence)
    usedIndices.add(0)
  }

  // Key indicators that suggest important sentences
  const keyIndicators = [
    /\b(important|key|critical|essential|main|primary|significant)\b/i,
    /\b(conclusion|summary|result|finding|therefore|thus|hence)\b/i,
    /\b(first|second|third|finally|lastly)\b/i,
    /\d+%|\d+\.\d+/,  // Numbers and percentages
    /\b(must|should|need|require)\b/i
  ]

  // Score sentences by importance
  const scoredSentences = sentences.map((sentence, index) => {
    if (usedIndices.has(index)) return { index, score: -1 }

    let score = 0
    for (const indicator of keyIndicators) {
      if (indicator.test(sentence)) {
        score += 1
      }
    }

    // Bonus for shorter sentences (usually more dense)
    if (sentence.length < 150) {
      score += 0.5
    }

    // Bonus for sentences near the end (conclusions)
    if (index > sentences.length * 0.7) {
      score += 0.5
    }

    return { index, score }
  })

  // Sort by score and take top sentences
  scoredSentences
    .filter(s => s.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences - 1)
    .forEach(s => {
      const sentence = sentences[s.index]
      if (sentence) {
        selected.push(sentence)
        usedIndices.add(s.index)
      }
    })

  // Always include last sentence if not already included
  const lastIndex = sentences.length - 1
  const lastSentence = sentences[lastIndex]
  if (!usedIndices.has(lastIndex) && selected.length < maxSentences && lastSentence) {
    selected.push(lastSentence)
  }

  // Sort by original order
  return selected.sort((a, b) => {
    const indexA = sentences.indexOf(a)
    const indexB = sentences.indexOf(b)
    return indexA - indexB
  })
}

/**
 * Generate deterministic summary card
 */
function generateDeterministicSummary(
  type: MemoryEntityType,
  title: string,
  content: string,
  tags: string[],
  maxTokens: number
): string {
  const parts: string[] = []

  // Type indicator
  const typeLabel = {
    note: 'Note',
    literature: 'Literature',
    data: 'Data',
    task: 'Task'
  }[type]

  // Title line
  parts.push(`**${typeLabel}: ${title}**`)

  // Tags if present
  if (tags.length > 0) {
    parts.push(`Tags: ${tags.join(', ')}`)
  }

  // Content summary
  const headerTokens = countTokens(parts.join('\n'))
  const remainingTokens = maxTokens - headerTokens - 10 // Buffer

  if (remainingTokens > 50) {
    // Extract key sentences
    const keySentences = extractKeySentences(content, 5)
    let summary = keySentences.join(' ')

    // Truncate if still too long
    if (countTokens(summary) > remainingTokens) {
      summary = truncateToTokens(summary, remainingTokens, 'tail')
    }

    parts.push('')
    parts.push(summary)
  }

  return parts.join('\n')
}

// ============ LLM Summarization ============

/**
 * Generate LLM prompt for summarization
 */
function buildSummarizationPrompt(
  type: MemoryEntityType,
  title: string,
  content: string,
  tags: string[],
  maxTokens: number
): string {
  return `Summarize the following ${type} in a concise format suitable for quick reference.

Title: ${title}
${tags.length > 0 ? `Tags: ${tags.join(', ')}` : ''}

Content:
${content}

Requirements:
- Maximum ${maxTokens} tokens
- Start with "**${type.charAt(0).toUpperCase() + type.slice(1)}: ${title}**"
- Include key points, findings, or decisions
- Preserve important numbers, dates, and names
- Use bullet points for multiple items
- Be factual and concise

Summary:`
}

// ============ Main Generator ============

/**
 * Generate a summary card for an entity
 *
 * Uses deterministic extraction for short content, LLM for long content.
 */
export async function generateSummaryCard(
  options: GenerateSummaryCardOptions
): Promise<SummaryCardResult> {
  const {
    type,
    title,
    content,
    tags = [],
    config: configOverride,
    llmSummarize
  } = options

  // Merge config with defaults
  const config: SummaryCardConfig = {
    ...DEFAULT_SUMMARY_CARD_CONFIG,
    ...configOverride
  }

  // Generate content hash
  const contentHash = generateContentHash(content)

  // Count tokens in content
  const contentTokens = countTokens(content)

  // Decide method based on content length
  let summaryCard: string
  let method: SummaryCardMethod

  if (contentTokens <= config.llmThreshold || !llmSummarize) {
    // Use deterministic extraction
    summaryCard = generateDeterministicSummary(
      type,
      title,
      content,
      tags,
      config.maxTokens
    )
    method = 'deterministic'
  } else {
    // Use LLM summarization
    try {
      const prompt = buildSummarizationPrompt(
        type,
        title,
        content,
        tags,
        config.llmMaxOutput
      )
      summaryCard = await llmSummarize(prompt)
      method = 'llm'

      // Ensure LLM output doesn't exceed max tokens
      if (countTokens(summaryCard) > config.maxTokens) {
        summaryCard = truncateToTokens(summaryCard, config.maxTokens, 'tail')
      }
    } catch (error) {
      // Fallback to deterministic if LLM fails
      console.warn('[SummaryCard] LLM summarization failed, falling back to deterministic:', error)
      summaryCard = generateDeterministicSummary(
        type,
        title,
        content,
        tags,
        config.maxTokens
      )
      method = 'deterministic'
    }
  }

  // Final token count
  const tokens = countTokens(summaryCard)

  return {
    summaryCard,
    method,
    contentHash,
    tokens
  }
}

/**
 * Check if a summary card needs regeneration
 */
export function needsRegeneration(
  currentHash: string | undefined,
  content: string
): boolean {
  if (!currentHash) return true
  const newHash = generateContentHash(content)
  return currentHash !== newHash
}

// ============ Shape Rendering ============

/**
 * Render entity in different shapes for context assembly
 */
export interface EntityShapeOptions {
  type: MemoryEntityType
  title: string
  content: string
  tags?: string[]
  summaryCard: string
  id: string
}

/**
 * Render entity as full content
 */
export function renderFullShape(options: EntityShapeOptions): string {
  const { type, title, content, tags = [], id } = options
  const tagLine = tags.length > 0 ? `\nTags: ${tags.join(', ')}` : ''
  return `### ${type}: ${title} [id:${id}]${tagLine}\n\n${content}`
}

/**
 * Render entity as excerpt (first ~500 tokens)
 */
export function renderExcerptShape(options: EntityShapeOptions): string {
  const { type, title, content, tags = [], id } = options
  const tagLine = tags.length > 0 ? `\nTags: ${tags.join(', ')}` : ''
  const excerpt = truncateToTokens(content, 500, 'head')
  return `### ${type}: ${title} [id:${id}]${tagLine}\n\n${excerpt}`
}

/**
 * Render entity as summary card
 */
export function renderCardShape(options: EntityShapeOptions): string {
  const { summaryCard, id } = options
  return `${summaryCard} [id:${id}]`
}

/**
 * Render entity as index line (minimal)
 */
export function renderIndexLineShape(options: EntityShapeOptions): string {
  const { type, title, tags = [], id } = options
  const tagStr = tags.length > 0 ? ` [${tags.slice(0, 3).join(', ')}]` : ''
  return `- ${type}:${id} "${title}"${tagStr}`
}

/**
 * Render entity in specified shape
 */
export function renderEntityShape(
  shape: 'full' | 'excerpt' | 'card' | 'index-line',
  options: EntityShapeOptions
): string {
  switch (shape) {
    case 'full':
      return renderFullShape(options)
    case 'excerpt':
      return renderExcerptShape(options)
    case 'card':
      return renderCardShape(options)
    case 'index-line':
      return renderIndexLineShape(options)
    default:
      return renderCardShape(options)
  }
}

/**
 * Estimate tokens for each shape
 */
export function estimateShapeTokens(
  shape: 'full' | 'excerpt' | 'card' | 'index-line',
  options: EntityShapeOptions
): number {
  const rendered = renderEntityShape(shape, options)
  return countTokens(rendered)
}
