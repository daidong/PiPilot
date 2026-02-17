/**
 * Tests for the error feedback system (RFC-005)
 */

import { describe, it, expect } from 'vitest'
import {
  buildFeedback,
  toolValidationFeedback,
  executionFailureFeedback,
  policyDenialFeedback,
  contextDropFeedback,
  formatFeedbackAsToolResult
} from '../../src/core/feedback.js'
import type { AgentError } from '../../src/core/errors.js'

describe('buildFeedback', () => {
  it('should build feedback from AgentError', () => {
    const error: AgentError = {
      category: 'validation',
      source: { kind: 'tool', toolName: 'my-tool' },
      message: 'param error',
      recoverability: 'yes'
    }
    const feedback = buildFeedback(error)
    expect(feedback.facts.category).toBe('validation')
    expect(feedback.facts.source).toBe('tool:my-tool')
    expect(feedback.guidance).toContain('Fix')
  })

  it('should include details when present', () => {
    const error: AgentError = {
      category: 'execution',
      source: { kind: 'python' },
      message: 'ValueError',
      recoverability: 'yes',
      details: { exceptionType: 'ValueError' }
    }
    const feedback = buildFeedback(error)
    expect(feedback.facts.data?.exceptionType).toBe('ValueError')
  })

  it('should include attempt number', () => {
    const error: AgentError = {
      category: 'validation',
      source: { kind: 'tool', toolName: 'x' },
      message: 'bad',
      recoverability: 'yes',
      attempt: 2
    }
    const feedback = buildFeedback(error)
    expect(feedback.facts.attempt).toBe(2)
  })

  it('should enrich guidance with tool schema context', () => {
    const error: AgentError = {
      category: 'validation',
      source: { kind: 'tool', toolName: 'x' },
      message: 'bad',
      recoverability: 'yes'
    }
    const feedback = buildFeedback(error, {
      toolSchema: { name: 'x', params: [{ name: 'file', type: 'string', required: true }] }
    })
    expect(feedback.guidance).toContain('file: string (required)')
  })
})

describe('toolValidationFeedback', () => {
  it('should list param errors in guidance', () => {
    const feedback = toolValidationFeedback('my-tool', [
      { param: 'name', message: 'required' },
      { param: 'count', message: 'must be number' }
    ])
    expect(feedback.facts.category).toBe('validation')
    expect(feedback.facts.data?.tool).toBe('my-tool')
    expect(feedback.guidance).toContain('name: required')
    expect(feedback.guidance).toContain('count: must be number')
  })
})

describe('executionFailureFeedback', () => {
  it('should include Python exception details in guidance', () => {
    const error: AgentError = {
      category: 'execution',
      source: { kind: 'python' },
      message: 'ValueError: bad value',
      recoverability: 'yes',
      details: {
        exceptionType: 'ValueError',
        exceptionMessage: 'bad value'
      }
    }
    const feedback = executionFailureFeedback(error)
    expect(feedback.guidance).toContain('ValueError')
    expect(feedback.guidance).toContain('bad value')
  })

  it('should use generic guidance without exception details', () => {
    const error: AgentError = {
      category: 'execution',
      source: { kind: 'tool', toolName: 'bash' },
      message: 'something broke',
      recoverability: 'yes'
    }
    const feedback = executionFailureFeedback(error)
    expect(feedback.guidance).toContain('failed at runtime')
  })
})

describe('policyDenialFeedback', () => {
  it('should suggest different approach', () => {
    const feedback = policyDenialFeedback('bash', 'no shell access')
    expect(feedback.facts.category).toBe('policy_denied')
    expect(feedback.guidance).toContain('different tool or approach')
    expect(feedback.facts.data?.policyId).toBe('unknown')
  })

  it('should include policyId when provided', () => {
    const feedback = policyDenialFeedback('bash', 'approval required', 'require-approval-destructive')
    expect(feedback.facts.source).toBe('policy:require-approval-destructive')
    expect(feedback.facts.data?.policyId).toBe('require-approval-destructive')
  })
})

describe('contextDropFeedback', () => {
  it('should report dropped items', () => {
    const feedback = contextDropFeedback(['docs.index', 'session.trace'], 'budget exceeded')
    expect(feedback.facts.category).toBe('context_overflow')
    expect(feedback.facts.data?.droppedItems).toEqual(['docs.index', 'session.trace'])
    expect(feedback.guidance).toContain('dropped')
  })
})

describe('formatFeedbackAsToolResult', () => {
  it('should produce valid JSON with success:false', () => {
    const feedback = toolValidationFeedback('test', [{ param: 'x', message: 'bad' }])
    const json = formatFeedbackAsToolResult(feedback)
    const parsed = JSON.parse(json)
    expect(parsed.success).toBe(false)
    expect(parsed.error.category).toBe('validation')
    expect(parsed.guidance).toContain('Fix')
  })

  it('should include repairedInput when present', () => {
    const feedback = toolValidationFeedback('test', [{ param: 'x', message: 'bad' }])
    feedback.repairedInput = { x: 'fixed' }
    const json = formatFeedbackAsToolResult(feedback)
    const parsed = JSON.parse(json)
    expect(parsed.repairedInput).toEqual({ x: 'fixed' })
  })
})
