/**
 * AdaptiveMessageSelector - Dynamic message selection based on token budget
 *
 * Selects messages from conversation history to fit within available budget.
 * Strategies:
 * - recent-first: Prioritize most recent messages
 * - important-first: Prioritize messages with tool calls and key interactions
 *
 * Hard requirement: The last user message MUST fit. If it doesn't,
 * the caller should reduce tools/system first.
 */

import { countTokens } from '../utils/tokenizer.js'

/**
 * Selection strategy
 */
export type SelectionStrategy = 'recent-first' | 'important-first'

/**
 * Message-like shape for selection.
 * Supports both session-store messages (string content)
 * and live LLM messages (string or structured content).
 */
export interface MessageLike {
  role: string
  content: string | unknown
  toolCall?: {
    result?: {
      success?: boolean
      error?: string
    }
  }
  tokens?: number
}

/**
 * Selection options
 */
export interface MessageSelectionOptions {
  /** Available token budget for messages */
  budget: number
  /** Selection strategy (default: recent-first) */
  strategy?: SelectionStrategy
  /** Minimum messages to include (default: 1) */
  minMessages?: number
  /** Always include first user message (task description) */
  includeFirstUser?: boolean
  /** Maximum messages to consider (for performance) */
  maxConsider?: number
}

/**
 * Selection result
 */
export interface MessageSelectionResult {
  /** Selected messages in original order */
  messages: MessageLike[]
  /** Total tokens used */
  totalTokens: number
  /** Number of messages excluded */
  excludedCount: number
  /** Whether budget was sufficient */
  budgetSufficient: boolean
  /** Warning message if any */
  warning?: string
}

/**
 * Error thrown when budget is insufficient for minimum messages
 */
export class InsufficientBudgetError extends Error {
  constructor(
    public readonly requiredTokens: number,
    public readonly availableBudget: number
  ) {
    super(
      `Insufficient budget for messages. Required: ${requiredTokens}, Available: ${availableBudget}. ` +
      `Reduce system prompt or tools first.`
    )
    this.name = 'InsufficientBudgetError'
  }
}

/**
 * Calculate importance score for a message
 */
function calculateImportance(message: MessageLike, index: number, total: number): number {
  let score = 0

  // Recency bonus (0-50 points)
  score += (index / total) * 50

  // Role-based scoring
  switch (message.role) {
    case 'user':
      score += 30  // User messages are important
      break
    case 'assistant':
      score += 20
      break
    case 'tool':
      // Tool messages with results are valuable
      if (message.toolCall?.result?.success) {
        score += 25
      } else if (message.toolCall?.result?.error) {
        score += 15  // Errors are less valuable but still informative
      }
      break
    case 'system':
      score += 10
      break
  }

  // Content length penalty (very long messages are less valuable per token)
  const tokens = message.tokens ?? countTokens(contentToString(message.content))
  if (tokens > 2000) {
    score -= 10
  }

  return score
}

/**
 * Get token count for a message, using cached value or calculating
 */
function getMessageTokens(message: MessageLike): number {
  if (message.tokens !== undefined) {
    return message.tokens
  }

  // Calculate tokens for content
  let tokens = countTokens(contentToString(message.content))

  // Add tokens for tool call if present
  if (message.toolCall) {
    tokens += countTokens(JSON.stringify(message.toolCall))
  }

  return tokens
}

/**
 * Normalize content to string for token estimation.
 */
function contentToString(content: unknown): string {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content)
  } catch {
    return ''
  }
}

/**
 * AdaptiveMessageSelector - Select messages to fit within budget
 */
export class AdaptiveMessageSelector {
  /**
   * Select messages based on budget and strategy
   *
   * @throws InsufficientBudgetError if budget cannot fit minimum required messages
   */
  select(
    messages: MessageLike[],
    options: MessageSelectionOptions
  ): MessageSelectionResult {
    const {
      budget,
      strategy = 'recent-first',
      minMessages = 1,
      includeFirstUser = true,
      maxConsider = 1000
    } = options

    if (messages.length === 0) {
      return {
        messages: [],
        totalTokens: 0,
        excludedCount: 0,
        budgetSufficient: true
      }
    }

    // Limit messages to consider for performance
    const consideredMessages = messages.slice(-maxConsider)
    const skippedCount = messages.length - consideredMessages.length

    // Find first user message and last user message
    const firstUserIndex = includeFirstUser
      ? consideredMessages.findIndex(m => m.role === 'user')
      : -1
    const lastUserIndex = this.findLastIndex(consideredMessages, m => m.role === 'user')

    // Calculate tokens for required messages
    const lastUserMessage = lastUserIndex >= 0 ? consideredMessages[lastUserIndex] : null
    const lastUserTokens = lastUserMessage ? getMessageTokens(lastUserMessage) : 0

    // Check if last user message fits
    if (lastUserTokens > budget) {
      throw new InsufficientBudgetError(lastUserTokens, budget)
    }

    // Select based on strategy
    let selectedIndices: number[]

    if (strategy === 'recent-first') {
      selectedIndices = this.selectRecentFirst(
        consideredMessages,
        budget,
        firstUserIndex,
        lastUserIndex
      )
    } else {
      selectedIndices = this.selectImportantFirst(
        consideredMessages,
        budget,
        firstUserIndex,
        lastUserIndex
      )
    }

    // Ensure minimum messages
    if (selectedIndices.length < minMessages && consideredMessages.length >= minMessages) {
      // Force include last minMessages
      const lastIndices = Array.from(
        { length: Math.min(minMessages, consideredMessages.length) },
        (_, i) => consideredMessages.length - 1 - i
      ).reverse()

      for (const idx of lastIndices) {
        if (!selectedIndices.includes(idx)) {
          selectedIndices.push(idx)
        }
      }
      selectedIndices.sort((a, b) => a - b)
    }

    // Build result
    const selectedMessages = selectedIndices.map(i => consideredMessages[i]!)
    const totalTokens = selectedMessages.reduce((sum, m) => sum + getMessageTokens(m), 0)
    const excludedCount = skippedCount + (consideredMessages.length - selectedIndices.length)

    // Check if we're over budget (can happen with minMessages forcing)
    const budgetSufficient = totalTokens <= budget
    const warning = !budgetSufficient
      ? `Selected ${selectedMessages.length} messages (${totalTokens} tokens) exceeds budget (${budget})`
      : selectedIndices.length < consideredMessages.length
        ? `Excluded ${consideredMessages.length - selectedIndices.length} messages to fit budget`
        : undefined

    return {
      messages: selectedMessages,
      totalTokens,
      excludedCount,
      budgetSufficient,
      warning
    }
  }

  /**
   * Select messages using recent-first strategy
   */
  private selectRecentFirst(
    messages: MessageLike[],
    budget: number,
    firstUserIndex: number,
    _lastUserIndex: number
  ): number[] {
    const selected: number[] = []
    let usedTokens = 0

    // Always include first user message if requested and it exists
    if (firstUserIndex >= 0) {
      const tokens = getMessageTokens(messages[firstUserIndex]!)
      if (usedTokens + tokens <= budget) {
        selected.push(firstUserIndex)
        usedTokens += tokens
      }
    }

    // Add messages from most recent to oldest
    for (let i = messages.length - 1; i >= 0; i--) {
      if (selected.includes(i)) continue

      const tokens = getMessageTokens(messages[i]!)
      if (usedTokens + tokens <= budget) {
        selected.push(i)
        usedTokens += tokens
      } else {
        // Budget exhausted
        break
      }
    }

    // Sort to maintain original order
    return selected.sort((a, b) => a - b)
  }

  /**
   * Select messages using important-first strategy
   */
  private selectImportantFirst(
    messages: MessageLike[],
    budget: number,
    firstUserIndex: number,
    lastUserIndex: number
  ): number[] {
    // Score all messages
    const scored = messages.map((msg, idx) => ({
      index: idx,
      message: msg,
      tokens: getMessageTokens(msg),
      importance: calculateImportance(msg, idx, messages.length)
    }))

    // Boost first and last user messages
    if (firstUserIndex >= 0) {
      scored[firstUserIndex]!.importance += 100
    }
    if (lastUserIndex >= 0) {
      scored[lastUserIndex]!.importance += 200  // Last user message is most important
    }

    // Sort by importance (descending)
    const sortedByImportance = [...scored].sort((a, b) => b.importance - a.importance)

    // Select messages by importance until budget exhausted
    const selected: number[] = []
    let usedTokens = 0

    for (const item of sortedByImportance) {
      if (usedTokens + item.tokens <= budget) {
        selected.push(item.index)
        usedTokens += item.tokens
      }
    }

    // Sort to maintain original order
    return selected.sort((a, b) => a - b)
  }

  /**
   * Find last index matching predicate
   */
  private findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (predicate(arr[i]!)) {
        return i
      }
    }
    return -1
  }

  /**
   * Estimate how many messages can fit in budget
   */
  estimateCapacity(messages: MessageLike[], budget: number): number {
    let count = 0
    let usedTokens = 0

    // Start from most recent
    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = getMessageTokens(messages[i]!)
      if (usedTokens + tokens <= budget) {
        count++
        usedTokens += tokens
      } else {
        break
      }
    }

    return count
  }
}

/**
 * Create a default message selector
 */
export function createMessageSelector(): AdaptiveMessageSelector {
  return new AdaptiveMessageSelector()
}
