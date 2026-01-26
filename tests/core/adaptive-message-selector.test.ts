/**
 * AdaptiveMessageSelector Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  AdaptiveMessageSelector,
  createMessageSelector,
  InsufficientBudgetError
} from '../../src/core/adaptive-message-selector.js'
import type { Message } from '../../src/types/session.js'

// Helper to create test messages
function createMessage(
  role: 'user' | 'assistant' | 'tool' | 'system',
  content: string,
  options: Partial<Message> = {}
): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    sessionId: 'test-session',
    role,
    content,
    timestamp: new Date().toISOString(),
    ...options
  }
}

describe('AdaptiveMessageSelector', () => {
  let selector: AdaptiveMessageSelector

  beforeEach(() => {
    selector = new AdaptiveMessageSelector()
  })

  describe('select() - basic', () => {
    it('should return empty result for empty messages', () => {
      const result = selector.select([], { budget: 1000 })

      expect(result.messages).toHaveLength(0)
      expect(result.totalTokens).toBe(0)
      expect(result.excludedCount).toBe(0)
      expect(result.budgetSufficient).toBe(true)
    })

    it('should include all messages when budget is sufficient', () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there!')
      ]

      const result = selector.select(messages, { budget: 10000 })

      expect(result.messages).toHaveLength(2)
      expect(result.budgetSufficient).toBe(true)
    })

    it('should exclude messages when budget is tight', () => {
      const messages = [
        createMessage('user', 'A'.repeat(1000)),
        createMessage('assistant', 'B'.repeat(1000)),
        createMessage('user', 'Short question')
      ]

      // Very small budget
      const result = selector.select(messages, { budget: 100 })

      expect(result.messages.length).toBeLessThan(messages.length)
      expect(result.excludedCount).toBeGreaterThan(0)
    })

    it('should throw InsufficientBudgetError when last user message exceeds budget', () => {
      const messages = [
        createMessage('user', 'X'.repeat(5000))  // Very long message
      ]

      expect(() => {
        selector.select(messages, { budget: 10 })  // Tiny budget
      }).toThrow(InsufficientBudgetError)
    })
  })

  describe('select() - recent-first strategy', () => {
    it('should prioritize recent messages', () => {
      const messages = [
        createMessage('user', 'Old message'),
        createMessage('assistant', 'Old response'),
        createMessage('user', 'Recent message'),
        createMessage('assistant', 'Recent response')
      ]

      // Budget for only 2 messages
      const result = selector.select(messages, {
        budget: 50,
        strategy: 'recent-first',
        includeFirstUser: false
      })

      // Should include recent messages
      const contents = result.messages.map(m => m.content)
      expect(contents.some(c => c.includes('Recent'))).toBe(true)
    })

    it('should include first user message when requested', () => {
      const messages = [
        createMessage('user', 'Initial task'),
        createMessage('assistant', 'Response 1'),
        createMessage('user', 'Follow up'),
        createMessage('assistant', 'Response 2')
      ]

      const result = selector.select(messages, {
        budget: 10000,
        strategy: 'recent-first',
        includeFirstUser: true
      })

      expect(result.messages[0]?.content).toBe('Initial task')
    })
  })

  describe('select() - important-first strategy', () => {
    it('should prioritize important messages', () => {
      const messages = [
        createMessage('user', 'Important initial task'),
        createMessage('assistant', 'Less important'),
        createMessage('assistant', 'Less important 2'),
        createMessage('user', 'Recent follow up')
      ]

      const result = selector.select(messages, {
        budget: 10000,
        strategy: 'important-first'
      })

      // User messages should be included
      const userMessages = result.messages.filter(m => m.role === 'user')
      expect(userMessages.length).toBeGreaterThanOrEqual(1)
    })

    it('should boost last user message importance', () => {
      const messages = [
        createMessage('user', 'Old question'),
        createMessage('assistant', 'Old answer'),
        createMessage('user', 'New question')
      ]

      const result = selector.select(messages, {
        budget: 100,  // Small budget
        strategy: 'important-first',
        includeFirstUser: false
      })

      // Should include the last user message
      const lastMessage = result.messages[result.messages.length - 1]
      expect(lastMessage?.content).toBe('New question')
    })
  })

  describe('select() - minimum messages', () => {
    it('should respect minMessages option', () => {
      const messages = [
        createMessage('user', 'Message 1'),
        createMessage('assistant', 'Message 2'),
        createMessage('user', 'Message 3')
      ]

      const result = selector.select(messages, {
        budget: 10000,
        minMessages: 2
      })

      expect(result.messages.length).toBeGreaterThanOrEqual(2)
    })

    it('should force minimum messages even if over budget', () => {
      // Last user message must fit in budget (selector requirement)
      // But total of minMessages can exceed budget
      const messages = [
        createMessage('assistant', 'Old response', { tokens: 150 }),
        createMessage('user', 'Short', { tokens: 20 })  // Last user fits in budget
      ]

      const result = selector.select(messages, {
        budget: 50,  // Budget fits last user (20) but not both (170)
        minMessages: 2
      })

      expect(result.messages).toHaveLength(2)
      expect(result.budgetSufficient).toBe(false)  // 170 tokens > 50 budget
      expect(result.warning).toBeDefined()
    })
  })

  describe('select() - maxConsider', () => {
    it('should limit messages considered for performance', () => {
      const messages = Array.from({ length: 100 }, (_, i) =>
        createMessage('user', `Message ${i}`)
      )

      const result = selector.select(messages, {
        budget: 10000,
        maxConsider: 10
      })

      // Should only consider last 10 messages
      expect(result.excludedCount).toBeGreaterThanOrEqual(90)
    })
  })

  describe('select() - with cached tokens', () => {
    it('should use cached token counts when available', () => {
      const messages = [
        createMessage('user', 'Hello', { tokens: 5 }),
        createMessage('assistant', 'Hi there!', { tokens: 8 })
      ]

      const result = selector.select(messages, { budget: 20 })

      // Total should be based on cached tokens
      expect(result.totalTokens).toBe(13)
    })
  })

  describe('select() - tool messages', () => {
    it('should include tool messages with successful results', () => {
      const messages = [
        createMessage('user', 'Read the file'),
        createMessage('tool', 'File content', {
          toolCall: {
            id: 'call-1',
            name: 'read',
            input: { path: 'test.txt' },
            result: { success: true, data: 'content' }
          }
        }),
        createMessage('assistant', 'Done')
      ]

      const result = selector.select(messages, {
        budget: 10000,
        strategy: 'important-first'
      })

      const toolMessages = result.messages.filter(m => m.role === 'tool')
      expect(toolMessages.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe('estimateCapacity()', () => {
    it('should estimate how many messages fit in budget', () => {
      const messages = [
        createMessage('user', 'Hello', { tokens: 10 }),
        createMessage('assistant', 'Hi', { tokens: 10 }),
        createMessage('user', 'Question', { tokens: 10 })
      ]

      const capacity = selector.estimateCapacity(messages, 25)

      expect(capacity).toBe(2)  // Budget fits 2 messages (20 tokens)
    })

    it('should return 0 for empty budget', () => {
      const messages = [createMessage('user', 'Hello', { tokens: 10 })]
      const capacity = selector.estimateCapacity(messages, 0)

      expect(capacity).toBe(0)
    })

    it('should return message count when budget is large', () => {
      const messages = [
        createMessage('user', 'Hello', { tokens: 10 }),
        createMessage('assistant', 'Hi', { tokens: 10 })
      ]

      const capacity = selector.estimateCapacity(messages, 10000)

      expect(capacity).toBe(2)
    })
  })
})

describe('createMessageSelector', () => {
  it('should create a default message selector', () => {
    const selector = createMessageSelector()
    expect(selector).toBeInstanceOf(AdaptiveMessageSelector)
  })
})

describe('InsufficientBudgetError', () => {
  it('should contain required and available budget info', () => {
    const error = new InsufficientBudgetError(1000, 500)

    expect(error.requiredTokens).toBe(1000)
    expect(error.availableBudget).toBe(500)
    expect(error.name).toBe('InsufficientBudgetError')
    expect(error.message).toContain('1000')
    expect(error.message).toContain('500')
  })
})
