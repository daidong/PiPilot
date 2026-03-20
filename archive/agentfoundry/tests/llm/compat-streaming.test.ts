/**
 * Tests for compat-driven streaming behavior (PR2)
 *
 * Verifies that the streaming layer correctly uses API protocol and compat flags
 * instead of hardcoded provider name checks.
 */

import { describe, it, expect } from 'vitest'
import { resolveCompat } from '../../src/llm/compat.js'
import { getProviderDefinition, findModelDefinition } from '../../src/llm/provider-definitions.js'
import { getProviderStyleNormalization } from '../../src/llm/provider-style.js'

describe('Compat-driven streaming (PR2)', () => {

  describe('Provider context resolution', () => {
    it('Tier 1 providers should have correct API protocols', () => {
      expect(getProviderDefinition('openai')?.apiProtocol).toBe('openai-responses')
      expect(getProviderDefinition('anthropic')?.apiProtocol).toBe('anthropic-messages')
      expect(getProviderDefinition('google')?.apiProtocol).toBe('google-generative')
      expect(getProviderDefinition('deepseek')?.apiProtocol).toBe('openai-chat')
    })

    it('Tier 2 providers should all use openai-chat protocol', () => {
      const tier2 = ['groq', 'xai', 'cerebras', 'openrouter', 'together', 'fireworks', 'mistral']
      for (const id of tier2) {
        const def = getProviderDefinition(id)
        expect(def?.apiProtocol, `${id} should use openai-chat`).toBe('openai-chat')
      }
    })

    it('should resolve compat for Groq (typical Tier 2)', () => {
      const def = getProviderDefinition('groq')!
      const compat = resolveCompat(def.compat)
      expect(compat.maxTokensField).toBe('max_tokens')
      expect(compat.supportsDeveloperRole).toBe(false)
      expect(compat.supportsStrictMode).toBe(false)
      expect(compat.supportsStreamOptions).toBe(false)
    })

    it('should resolve compat for OpenAI (Tier 1)', () => {
      const def = getProviderDefinition('openai')!
      const compat = resolveCompat(def.compat)
      expect(compat.supportsCaching).toBe(true)
      expect(compat.supportsReasoningEffort).toBe(true)
      expect(compat.supportsStrictMode).toBe(true)
    })

    it('should merge model-level compat over provider-level', () => {
      // DeepSeek Reasoner has model-level thinkingFormat
      const result = findModelDefinition('deepseek-reasoner')!
      const compat = resolveCompat(result.provider.compat, result.model.compat)
      expect(compat.thinkingFormat).toBe('deepseek')
      // Provider-level flags still apply
      expect(compat.maxTokensField).toBe('max_tokens')
      expect(compat.supportsDeveloperRole).toBe(false)
    })

    it('GPT-4o model should override provider supportsReasoningEffort', () => {
      const result = findModelDefinition('gpt-4o')!
      const compat = resolveCompat(result.provider.compat, result.model.compat)
      // gpt-4o has model-level compat: { supportsReasoningEffort: false }
      expect(compat.supportsReasoningEffort).toBe(false)
    })
  })

  describe('Caching protocol check', () => {
    it('only anthropic-messages protocol should enable message caching', () => {
      // Anthropic: caching enabled
      const anthropicDef = getProviderDefinition('anthropic')!
      expect(anthropicDef.apiProtocol).toBe('anthropic-messages')
      expect(resolveCompat(anthropicDef.compat).supportsCaching).toBe(true)

      // Groq: no caching (openai-chat, no caching flag)
      const groqDef = getProviderDefinition('groq')!
      expect(groqDef.apiProtocol).toBe('openai-chat')
      expect(resolveCompat(groqDef.compat).supportsCaching).toBe(false)

      // OpenAI: has caching flag but protocol is openai-responses
      // Cache control in convertMessages is Anthropic SDK-specific
      const openaiDef = getProviderDefinition('openai')!
      expect(openaiDef.apiProtocol).toBe('openai-responses')
      // OpenAI caching uses a different mechanism (response-level), not message-level
    })
  })

  describe('Style normalization', () => {
    it('Anthropic should skip style normalization', () => {
      expect(getProviderStyleNormalization('anthropic')).toBeUndefined()
    })

    it('Tier 1 non-Anthropic providers should get style text', () => {
      expect(getProviderStyleNormalization('openai')).toBeDefined()
      expect(getProviderStyleNormalization('deepseek')).toBeDefined()
      expect(getProviderStyleNormalization('google')).toBeDefined()
    })

    it('Tier 2 providers should get style text', () => {
      expect(getProviderStyleNormalization('groq')).toBeDefined()
      expect(getProviderStyleNormalization('xai')).toBeDefined()
      expect(getProviderStyleNormalization('cerebras')).toBeDefined()
      expect(getProviderStyleNormalization('openrouter')).toBeDefined()
      expect(getProviderStyleNormalization('together')).toBeDefined()
      expect(getProviderStyleNormalization('fireworks')).toBeDefined()
      expect(getProviderStyleNormalization('mistral')).toBeDefined()
    })
  })

  describe('Reasoning support flags', () => {
    it('OpenAI should support reasoning effort', () => {
      const compat = resolveCompat(getProviderDefinition('openai')!.compat)
      expect(compat.supportsReasoningEffort).toBe(true)
    })

    it('Groq should not support reasoning effort', () => {
      const compat = resolveCompat(getProviderDefinition('groq')!.compat)
      expect(compat.supportsReasoningEffort).toBe(false)
    })

    it('xAI should not support reasoning effort (default)', () => {
      const compat = resolveCompat(getProviderDefinition('xai')!.compat)
      expect(compat.supportsReasoningEffort).toBe(false)
    })
  })

  describe('Strict mode support', () => {
    it('OpenAI should support strict mode', () => {
      const compat = resolveCompat(getProviderDefinition('openai')!.compat)
      expect(compat.supportsStrictMode).toBe(true)
    })

    it('Tier 2 providers typically disable strict mode', () => {
      const tier2NoStrict = ['groq', 'cerebras', 'openrouter', 'together', 'fireworks', 'mistral']
      for (const id of tier2NoStrict) {
        const compat = resolveCompat(getProviderDefinition(id)!.compat)
        expect(compat.supportsStrictMode, `${id} should not support strict mode`).toBe(false)
      }
    })
  })
})
