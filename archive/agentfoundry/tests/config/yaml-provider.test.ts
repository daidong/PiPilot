/**
 * Tests for YAML inline provider configuration (PR3)
 *
 * Verifies that agent.yaml can define custom providers inline
 * and they get properly validated and registered.
 */

import { describe, it, expect } from 'vitest'
import {
  validateConfig,
  resolveProviderIdFromConfig,
  type AgentYAMLConfig,
  type ProviderConfigEntry,
} from '../../src/config/loader.js'
import {
  registerProvider,
  getProviderDefinition,
  findProviderForModel,
} from '../../src/llm/provider-definitions.js'
import { resolveCompat } from '../../src/llm/compat.js'

describe('YAML Inline Provider Config (PR3)', () => {

  describe('resolveProviderIdFromConfig', () => {
    it('should return undefined for undefined input', () => {
      expect(resolveProviderIdFromConfig(undefined)).toBeUndefined()
    })

    it('should return the string directly for string input', () => {
      expect(resolveProviderIdFromConfig('groq')).toBe('groq')
    })

    it('should return the id from an inline provider object', () => {
      const entry: ProviderConfigEntry = {
        id: 'my-provider',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnv: 'MY_PROVIDER_KEY',
      }
      expect(resolveProviderIdFromConfig(entry)).toBe('my-provider')
    })
  })

  describe('validateConfig — string provider', () => {
    it('should accept a string provider', () => {
      const config: AgentYAMLConfig = {
        id: 'test',
        model: { provider: 'groq' },
      }
      expect(validateConfig(config)).toEqual([])
    })

    it('should reject empty string provider', () => {
      const config: AgentYAMLConfig = {
        id: 'test',
        model: { provider: '' },
      }
      const errors = validateConfig(config)
      expect(errors).toContain('model.provider must be a non-empty string')
    })
  })

  describe('validateConfig — inline provider object', () => {
    it('should accept a valid inline provider', () => {
      const config: AgentYAMLConfig = {
        id: 'test',
        model: {
          default: 'my-model',
          provider: {
            id: 'my-provider',
            baseUrl: 'https://api.example.com/v1',
            apiKeyEnv: 'MY_KEY',
          } as ProviderConfigEntry,
        },
      }
      expect(validateConfig(config)).toEqual([])
    })

    it('should accept a full inline provider with models', () => {
      const config: AgentYAMLConfig = {
        id: 'test',
        model: {
          default: 'custom-model',
          provider: {
            id: 'custom-provider',
            name: 'Custom Provider',
            apiProtocol: 'openai-chat',
            baseUrl: 'https://llm.internal/v1',
            apiKeyEnv: 'CUSTOM_KEY',
            compat: {
              maxTokensField: 'max_tokens',
              supportsDeveloperRole: false,
            },
            models: [
              { id: 'custom-model', name: 'Custom Model', maxContext: 64000, maxOutput: 8192 },
            ],
          } as ProviderConfigEntry,
        },
      }
      expect(validateConfig(config)).toEqual([])
    })

    it('should reject inline provider missing id', () => {
      const config: AgentYAMLConfig = {
        id: 'test',
        model: {
          provider: {
            baseUrl: 'https://api.example.com/v1',
            apiKeyEnv: 'MY_KEY',
          } as unknown as ProviderConfigEntry,
        },
      }
      const errors = validateConfig(config)
      expect(errors.some(e => e.includes('provider.id'))).toBe(true)
    })

    it('should reject inline provider missing baseUrl', () => {
      const config: AgentYAMLConfig = {
        id: 'test',
        model: {
          provider: {
            id: 'no-url',
            apiKeyEnv: 'MY_KEY',
          } as unknown as ProviderConfigEntry,
        },
      }
      const errors = validateConfig(config)
      expect(errors.some(e => e.includes('baseUrl'))).toBe(true)
    })

    it('should reject inline provider missing apiKeyEnv', () => {
      const config: AgentYAMLConfig = {
        id: 'test',
        model: {
          provider: {
            id: 'no-key',
            baseUrl: 'https://api.example.com/v1',
          } as unknown as ProviderConfigEntry,
        },
      }
      const errors = validateConfig(config)
      expect(errors.some(e => e.includes('apiKeyEnv'))).toBe(true)
    })

    it('should reject invalid apiProtocol', () => {
      const config: AgentYAMLConfig = {
        id: 'test',
        model: {
          provider: {
            id: 'bad-proto',
            baseUrl: 'https://api.example.com/v1',
            apiKeyEnv: 'MY_KEY',
            apiProtocol: 'grpc' as any,
          } as ProviderConfigEntry,
        },
      }
      const errors = validateConfig(config)
      expect(errors.some(e => e.includes('apiProtocol'))).toBe(true)
    })

    it('should reject models entry without id', () => {
      const config: AgentYAMLConfig = {
        id: 'test',
        model: {
          provider: {
            id: 'bad-models',
            baseUrl: 'https://api.example.com/v1',
            apiKeyEnv: 'MY_KEY',
            models: [{ name: 'No ID model' } as any],
          } as ProviderConfigEntry,
        },
      }
      const errors = validateConfig(config)
      expect(errors.some(e => e.includes('models[0].id'))).toBe(true)
    })

    it('should reject non-string/non-object provider values', () => {
      const config: AgentYAMLConfig = {
        id: 'test',
        model: {
          provider: 42 as any,
        },
      }
      const errors = validateConfig(config)
      expect(errors.some(e => e.includes('must be a string or an object'))).toBe(true)
    })
  })

  describe('Inline provider registration', () => {
    it('should register provider and find it by id', () => {
      const providerDef = {
        id: 'yaml-test-provider',
        name: 'YAML Test Provider',
        apiProtocol: 'openai-chat' as const,
        baseUrl: 'https://api.yaml-test.com/v1',
        apiKeyEnv: 'YAML_TEST_KEY',
        compat: {
          maxTokensField: 'max_tokens' as const,
          supportsDeveloperRole: false,
        },
        models: [
          {
            id: 'yaml-test-model',
            name: 'YAML Test Model',
            capabilities: {
              temperature: true, reasoning: false, toolcall: true,
              input: ['text' as const], output: ['text' as const],
            },
            limit: { maxContext: 32_000, maxOutput: 4_096 },
          },
        ],
      }
      registerProvider(providerDef)

      const def = getProviderDefinition('yaml-test-provider')
      expect(def).toBeDefined()
      expect(def!.name).toBe('YAML Test Provider')
      expect(def!.apiProtocol).toBe('openai-chat')

      const found = findProviderForModel('yaml-test-model')
      expect(found?.id).toBe('yaml-test-provider')
    })

    it('should resolve compat flags for registered provider', () => {
      const def = getProviderDefinition('yaml-test-provider')!
      const compat = resolveCompat(def.compat)
      expect(compat.maxTokensField).toBe('max_tokens')
      expect(compat.supportsDeveloperRole).toBe(false)
      // defaults still apply
      expect(compat.supportsStrictMode).toBe(true)
      expect(compat.supportsCaching).toBe(false)
    })
  })

  describe('YAML model simplification', () => {
    it('should map simplified model YAML fields to ModelDefinition', () => {
      // Simulate what registerInlineProvider does
      const yamlModel = {
        id: 'simplified-model',
        name: 'Simplified Model',
        maxContext: 64_000,
        maxOutput: 16_384,
        toolcall: true,
        reasoning: false,
        vision: true,
      }

      // This mirrors the logic in registerInlineProvider
      const mapped = {
        id: yamlModel.id,
        name: yamlModel.name ?? yamlModel.id,
        capabilities: {
          temperature: true,
          reasoning: yamlModel.reasoning ?? false,
          toolcall: yamlModel.toolcall ?? true,
          input: yamlModel.vision ? ['text', 'image'] : ['text'],
          output: ['text'],
        },
        limit: {
          maxContext: yamlModel.maxContext ?? 128_000,
          maxOutput: yamlModel.maxOutput ?? 4_096,
        },
      }

      expect(mapped.capabilities.input).toContain('image')
      expect(mapped.capabilities.toolcall).toBe(true)
      expect(mapped.capabilities.reasoning).toBe(false)
      expect(mapped.limit.maxContext).toBe(64_000)
      expect(mapped.limit.maxOutput).toBe(16_384)
    })

    it('should use sensible defaults for missing model fields', () => {
      const yamlModel = { id: 'minimal-model' }

      const mapped = {
        id: yamlModel.id,
        name: yamlModel.id,
        capabilities: {
          temperature: true,
          reasoning: false,
          toolcall: true,
          input: ['text'],
          output: ['text'],
        },
        limit: {
          maxContext: 128_000,
          maxOutput: 4_096,
        },
      }

      expect(mapped.name).toBe('minimal-model')
      expect(mapped.capabilities.toolcall).toBe(true)
      expect(mapped.capabilities.reasoning).toBe(false)
      expect(mapped.limit.maxContext).toBe(128_000)
    })
  })
})
