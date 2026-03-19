/**
 * Tests for Provider Definitions and Compat system
 */

import { describe, it, expect } from 'vitest'
import {
  BUILTIN_PROVIDERS,
  registerProvider,
  getProviderDefinition,
  getAllProviderDefinitions,
  findProviderForModel,
  findModelDefinition,
  type ProviderDefinition
} from '../../src/llm/provider-definitions.js'
import { resolveCompat, type OpenAICompat } from '../../src/llm/compat.js'
import { getModel, getAllModels } from '../../src/llm/models.js'

describe('Provider Definitions', () => {
  describe('BUILTIN_PROVIDERS', () => {
    it('should include Tier 1 providers', () => {
      const ids = BUILTIN_PROVIDERS.map(p => p.id)
      expect(ids).toContain('openai')
      expect(ids).toContain('anthropic')
      expect(ids).toContain('google')
      expect(ids).toContain('deepseek')
    })

    it('should include Tier 2 providers', () => {
      const ids = BUILTIN_PROVIDERS.map(p => p.id)
      expect(ids).toContain('groq')
      expect(ids).toContain('xai')
      expect(ids).toContain('cerebras')
      expect(ids).toContain('openrouter')
      expect(ids).toContain('together')
      expect(ids).toContain('fireworks')
      expect(ids).toContain('mistral')
    })

    it('every provider should have at least one model', () => {
      for (const provider of BUILTIN_PROVIDERS) {
        expect(provider.models.length).toBeGreaterThan(0)
      }
    })

    it('every provider should have required fields', () => {
      for (const provider of BUILTIN_PROVIDERS) {
        expect(provider.id).toBeTruthy()
        expect(provider.name).toBeTruthy()
        expect(provider.apiProtocol).toBeTruthy()
        expect(provider.baseUrl).toBeTruthy()
        expect(provider.apiKeyEnv).toBeTruthy()
      }
    })

    it('Tier 2 providers should use openai-chat protocol', () => {
      const tier2 = ['groq', 'xai', 'cerebras', 'openrouter', 'together', 'fireworks', 'mistral']
      for (const id of tier2) {
        const provider = BUILTIN_PROVIDERS.find(p => p.id === id)
        expect(provider?.apiProtocol).toBe('openai-chat')
      }
    })
  })

  describe('getProviderDefinition', () => {
    it('should return definition for known providers', () => {
      expect(getProviderDefinition('groq')).toBeDefined()
      expect(getProviderDefinition('openai')).toBeDefined()
    })

    it('should return undefined for unknown providers', () => {
      expect(getProviderDefinition('nonexistent')).toBeUndefined()
    })
  })

  describe('getAllProviderDefinitions', () => {
    it('should return all providers', () => {
      const all = getAllProviderDefinitions()
      expect(all.length).toBeGreaterThanOrEqual(BUILTIN_PROVIDERS.length)
    })
  })

  describe('findProviderForModel', () => {
    it('should find provider for Tier 1 model', () => {
      const provider = findProviderForModel('gpt-5.4')
      expect(provider?.id).toBe('openai')
    })

    it('should find provider for Tier 2 model', () => {
      const provider = findProviderForModel('llama-3.3-70b-versatile')
      expect(provider?.id).toBe('groq')
    })

    it('should return undefined for unknown model', () => {
      expect(findProviderForModel('nonexistent-model')).toBeUndefined()
    })
  })

  describe('findModelDefinition', () => {
    it('should return both provider and model', () => {
      const result = findModelDefinition('grok-3')
      expect(result).toBeDefined()
      expect(result!.provider.id).toBe('xai')
      expect(result!.model.name).toBe('Grok 3')
    })
  })

  describe('registerProvider', () => {
    it('should register a custom provider', () => {
      registerProvider({
        id: 'test-provider',
        name: 'Test Provider',
        apiProtocol: 'openai-chat',
        baseUrl: 'https://api.test.dev/v1',
        apiKeyEnv: 'TEST_API_KEY',
        models: [
          {
            id: 'test-model-1',
            name: 'Test Model 1',
            capabilities: {
              temperature: true, reasoning: false, toolcall: true,
              input: ['text'], output: ['text']
            },
            limit: { maxContext: 32_000, maxOutput: 4_096 }
          }
        ]
      })

      const def = getProviderDefinition('test-provider')
      expect(def).toBeDefined()
      expect(def!.name).toBe('Test Provider')

      const found = findProviderForModel('test-model-1')
      expect(found?.id).toBe('test-provider')
    })
  })
})

describe('Compat System', () => {
  describe('resolveCompat', () => {
    it('should return defaults when no compat given', () => {
      const resolved = resolveCompat()
      expect(resolved.supportsDeveloperRole).toBe(true)
      expect(resolved.maxTokensField).toBe('max_completion_tokens')
      expect(resolved.supportsReasoningEffort).toBe(false)
      expect(resolved.thinkingFormat).toBeNull()
      expect(resolved.supportsStrictMode).toBe(true)
      expect(resolved.requiresToolResultName).toBe(false)
      expect(resolved.supportsCaching).toBe(false)
      expect(resolved.supportsStreamOptions).toBe(true)
    })

    it('should merge provider-level compat', () => {
      const resolved = resolveCompat({
        maxTokensField: 'max_tokens',
        supportsDeveloperRole: false,
      })
      expect(resolved.maxTokensField).toBe('max_tokens')
      expect(resolved.supportsDeveloperRole).toBe(false)
      // Others stay default
      expect(resolved.supportsStrictMode).toBe(true)
    })

    it('should let model-level override provider-level', () => {
      const resolved = resolveCompat(
        { supportsStrictMode: true, maxTokensField: 'max_tokens' },
        { supportsStrictMode: false }
      )
      expect(resolved.supportsStrictMode).toBe(false)
      expect(resolved.maxTokensField).toBe('max_tokens')
    })

    it('should resolve thinkingFormat from model over provider', () => {
      const resolved = resolveCompat(
        { thinkingFormat: 'openai' },
        { thinkingFormat: 'deepseek' }
      )
      expect(resolved.thinkingFormat).toBe('deepseek')
    })
  })
})

describe('Model Registry Integration', () => {
  it('Tier 2 models should be in the global model registry', () => {
    // Groq models
    expect(getModel('llama-3.3-70b-versatile')).toBeDefined()
    expect(getModel('llama-3.3-70b-versatile')?.providerID).toBe('groq')

    // xAI models
    expect(getModel('grok-3')).toBeDefined()
    expect(getModel('grok-3')?.providerID).toBe('xai')

    // Mistral models
    expect(getModel('mistral-large-latest')).toBeDefined()
    expect(getModel('mistral-large-latest')?.providerID).toBe('mistral')
  })

  it('should have significantly more models than before', () => {
    const all = getAllModels()
    // Was 16 Tier 1 models; now should have Tier 2 models too
    expect(all.length).toBeGreaterThan(25)
  })

  it('Tier 1 models should still be present and unchanged', () => {
    const gpt5 = getModel('gpt-5.4')
    expect(gpt5).toBeDefined()
    expect(gpt5?.providerID).toBe('openai')
    expect(gpt5?.cost?.input).toBe(2.0)

    const claude = getModel('claude-opus-4-6')
    expect(claude).toBeDefined()
    expect(claude?.providerID).toBe('anthropic')
  })
})
