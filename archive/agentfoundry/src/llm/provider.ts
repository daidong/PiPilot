/**
 * Provider - LLM Provider management
 *
 * Unified Provider management based on Vercel AI SDK, with SDK caching support
 */

import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai'
import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import type {
  ProviderID,
  ProviderSDKConfig,
  ProviderOptions
} from './provider.types.js'
import { getModel } from './models.js'
import { getProviderDefinition, getAllProviderDefinitions, type ProviderDefinition } from './provider-definitions.js'

/**
 * SDK instance type
 */
type SDKInstance = OpenAIProvider | AnthropicProvider

/**
 * SDK cache - caches SDK instances by provider + apiKey
 */
const sdkCache = new Map<string, SDKInstance>()

/**
 * Per-provider environment variable mapping (legacy static map).
 * For dynamic providers, the env var comes from ProviderDefinition.apiKeyEnv.
 */
const LEGACY_PROVIDER_ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GOOGLE_API_KEY',
}

/**
 * Resolve the environment variable name for a provider's API key.
 */
function getApiKeyEnvVar(providerId: string): string | undefined {
  // Check provider definitions first (covers Tier 2 providers)
  const def = getProviderDefinition(providerId)
  if (def) return def.apiKeyEnv
  // Fallback to legacy static map
  return LEGACY_PROVIDER_ENV_KEYS[providerId]
}

/**
 * Resolve API key from config or provider-specific environment variable
 */
function resolveApiKey(provider: ProviderID, config: ProviderSDKConfig): string {
  if (config.apiKey) return config.apiKey
  const envVarName = getApiKeyEnvVar(provider)
  if (envVarName) {
    const envKey = process.env[envVarName]?.trim()
    if (envKey) return envKey
  }
  throw new Error(
    `No API key for ${provider}. Set ${getApiKeyEnvVar(provider) || provider.toUpperCase() + '_API_KEY'} or pass apiKey.`
  )
}

/**
 * Generate cache key
 */
function getCacheKey(provider: ProviderID, apiKey: string): string {
  return `${provider}:${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`
}

/**
 * Get or create OpenAI SDK instance
 */
function getOpenAISDK(config: ProviderSDKConfig): OpenAIProvider {
  const apiKey = resolveApiKey('openai', config)
  const cacheKey = getCacheKey('openai', apiKey)

  let sdk = sdkCache.get(cacheKey) as OpenAIProvider | undefined
  if (!sdk) {
    sdk = createOpenAI({
      apiKey,
      baseURL: config.baseURL
    })
    sdkCache.set(cacheKey, sdk)
  }

  return sdk
}

/**
 * Get or create Anthropic SDK instance
 */
function getAnthropicSDK(config: ProviderSDKConfig): AnthropicProvider {
  const apiKey = resolveApiKey('anthropic', config)
  const cacheKey = getCacheKey('anthropic', apiKey)

  let sdk = sdkCache.get(cacheKey) as AnthropicProvider | undefined
  if (!sdk) {
    sdk = createAnthropic({
      apiKey,
      baseURL: config.baseURL
    })
    sdkCache.set(cacheKey, sdk)
  }

  return sdk
}

/**
 * Get or create DeepSeek SDK instance (uses OpenAI-compatible API)
 */
function getDeepSeekSDK(config: ProviderSDKConfig): OpenAIProvider {
  const apiKey = resolveApiKey('deepseek', config)
  const cacheKey = getCacheKey('deepseek', apiKey)

  let sdk = sdkCache.get(cacheKey) as OpenAIProvider | undefined
  if (!sdk) {
    sdk = createOpenAI({
      apiKey,
      baseURL: config.baseURL || 'https://api.deepseek.com/v1'
    })
    sdkCache.set(cacheKey, sdk)
  }

  return sdk
}

/**
 * Get or create Google SDK instance (uses OpenAI-compatible API)
 * Note: For production use, @ai-sdk/google should be used instead
 */
function getGoogleSDK(config: ProviderSDKConfig): OpenAIProvider {
  const apiKey = resolveApiKey('google', config)
  const cacheKey = getCacheKey('google', apiKey)

  let sdk = sdkCache.get(cacheKey) as OpenAIProvider | undefined
  if (!sdk) {
    // Google AI uses OpenAI-compatible API through a proxy or direct endpoint
    sdk = createOpenAI({
      apiKey,
      baseURL:
        config.baseURL || 'https://generativelanguage.googleapis.com/v1beta'
    })
    sdkCache.set(cacheKey, sdk)
  }

  return sdk
}

/**
 * Get Language Model instance
 *
 * Handles both Tier 1 (dedicated SDK) and Tier 2 (OpenAI-compatible) providers.
 *
 * For OpenAI: AI SDK v5+ defaults to Responses API.
 * - reasoning: true  -> use sdk.responses(model) (GPT-5.x, o-series)
 * - reasoning: false -> use sdk.chat(model) (GPT-4o, etc.)
 */
export function getLanguageModel(options: ProviderOptions): LanguageModel {
  const { provider, model, config } = options

  // Get model config to determine API type
  const modelConfig = getModel(model)

  // Tier 1: Dedicated SDK providers
  switch (provider) {
    case 'openai': {
      const sdk = getOpenAISDK(config)
      if (modelConfig?.capabilities.reasoning) {
        return sdk.responses(model)
      }
      return sdk.chat(model)
    }
    case 'anthropic': {
      const sdk = getAnthropicSDK(config)
      return sdk(model)
    }
    case 'deepseek': {
      const sdk = getDeepSeekSDK(config)
      return sdk(model)
    }
    case 'google': {
      const sdk = getGoogleSDK(config)
      return sdk(model)
    }
  }

  // Tier 2: Dynamic providers via provider definitions
  const providerDef = getProviderDefinition(provider)
  if (providerDef) {
    return getLanguageModelFromDefinition(providerDef, model, config)
  }

  throw new Error(`Unsupported provider: ${provider}. Register it with registerProvider() first.`)
}

/**
 * Create a LanguageModel from a ProviderDefinition.
 * Used for Tier 2 (OpenAI-compatible) and user-registered providers.
 */
function getLanguageModelFromDefinition(
  providerDef: ProviderDefinition,
  model: string,
  config: ProviderSDKConfig
): LanguageModel {
  const apiKey = resolveApiKey(providerDef.id as ProviderID, config)
  const cacheKey = getCacheKey(providerDef.id, apiKey)

  switch (providerDef.apiProtocol) {
    case 'openai-chat': {
      let sdk = sdkCache.get(cacheKey) as OpenAIProvider | undefined
      if (!sdk) {
        sdk = createOpenAI({
          apiKey,
          baseURL: config.baseURL || providerDef.baseUrl,
          headers: providerDef.headers,
        })
        sdkCache.set(cacheKey, sdk)
      }
      return sdk.chat(model)
    }
    case 'openai-responses': {
      let sdk = sdkCache.get(cacheKey) as OpenAIProvider | undefined
      if (!sdk) {
        sdk = createOpenAI({
          apiKey,
          baseURL: config.baseURL || providerDef.baseUrl,
          headers: providerDef.headers,
        })
        sdkCache.set(cacheKey, sdk)
      }
      const modelConfig = getModel(model)
      if (modelConfig?.capabilities.reasoning) {
        return sdk.responses(model)
      }
      return sdk.chat(model)
    }
    case 'anthropic-messages': {
      let sdk = sdkCache.get(cacheKey) as AnthropicProvider | undefined
      if (!sdk) {
        sdk = createAnthropic({
          apiKey,
          baseURL: config.baseURL || providerDef.baseUrl,
        })
        sdkCache.set(cacheKey, sdk)
      }
      return sdk(model)
    }
    case 'google-generative': {
      let sdk = sdkCache.get(cacheKey) as OpenAIProvider | undefined
      if (!sdk) {
        sdk = createOpenAI({
          apiKey,
          baseURL: config.baseURL || providerDef.baseUrl,
        })
        sdkCache.set(cacheKey, sdk)
      }
      return sdk(model)
    }
    default:
      throw new Error(`Unsupported API protocol: ${providerDef.apiProtocol}`)
  }
}

/**
 * Get Language Model by model ID
 */
export function getLanguageModelByModelId(
  modelId: string,
  config: ProviderSDKConfig
): LanguageModel {
  const modelConfig = getModel(modelId)
  if (!modelConfig) {
    throw new Error(`Unknown model: ${modelId}`)
  }

  return getLanguageModel({
    provider: modelConfig.providerID,
    model: modelId,
    config
  })
}

/**
 * Clear SDK cache
 */
export function clearSDKCache(): void {
  sdkCache.clear()
}

/**
 * Get the number of cached SDK instances
 */
export function getSDKCacheSize(): number {
  return sdkCache.size
}

/**
 * Provider information
 */
export interface ProviderInfo {
  id: ProviderID
  name: string
  description: string
  requiresApiKey: boolean
  supportedFeatures: string[]
}

/**
 * Get Provider information.
 * Falls back to provider definitions for Tier 2 providers.
 */
export function getProviderInfo(id: ProviderID): ProviderInfo {
  const staticProviders: Record<string, ProviderInfo> = {
    openai: {
      id: 'openai',
      name: 'OpenAI',
      description: 'OpenAI GPT models including GPT-4o and o1 series',
      requiresApiKey: true,
      supportedFeatures: ['chat', 'tools', 'vision', 'reasoning']
    },
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic',
      description: 'Anthropic Claude models including Claude 3.5 and Claude 4',
      requiresApiKey: true,
      supportedFeatures: ['chat', 'tools', 'vision', 'reasoning']
    },
    deepseek: {
      id: 'deepseek',
      name: 'DeepSeek',
      description: 'DeepSeek models including chat and reasoner',
      requiresApiKey: true,
      supportedFeatures: ['chat', 'tools', 'reasoning']
    },
    google: {
      id: 'google',
      name: 'Google AI',
      description: 'Google Gemini models',
      requiresApiKey: true,
      supportedFeatures: ['chat', 'tools', 'vision', 'reasoning']
    }
  }

  if (staticProviders[id]) return staticProviders[id]

  // Dynamic lookup from provider definitions
  const def = getProviderDefinition(id)
  if (def) {
    const features: string[] = ['chat']
    const hasTools = def.models.some(m => m.capabilities.toolcall)
    const hasVision = def.models.some(m => m.capabilities.input.includes('image'))
    const hasReasoning = def.models.some(m => m.capabilities.reasoning)
    if (hasTools) features.push('tools')
    if (hasVision) features.push('vision')
    if (hasReasoning) features.push('reasoning')
    return {
      id,
      name: def.name,
      description: `${def.name} models (${def.apiProtocol})`,
      requiresApiKey: true,
      supportedFeatures: features,
    }
  }

  // Unknown provider — return minimal info
  return {
    id,
    name: id,
    description: `Unknown provider: ${id}`,
    requiresApiKey: true,
    supportedFeatures: ['chat'],
  }
}

/**
 * Get all supported Providers (Tier 1 + Tier 2)
 */
export function getAllProviders(): ProviderInfo[] {
  return getAllProviderDefinitions().map(def => getProviderInfo(def.id as ProviderID))
}

/**
 * Detect Provider from API key format
 */
export function detectProviderFromApiKey(apiKey: string): ProviderID | null {
  if (apiKey.startsWith('sk-ant-')) {
    return 'anthropic'
  }
  if (apiKey.startsWith('sk-')) {
    return 'openai'
  }
  if (apiKey.startsWith('sk-') && apiKey.includes('deepseek')) {
    return 'deepseek'
  }
  return null
}

/**
 * Validate whether a model belongs to the specified Provider
 */
export function validateModelProvider(
  modelId: string,
  providerId: ProviderID
): boolean {
  const model = getModel(modelId)
  return model?.providerID === providerId
}

/**
 * Get default configuration parameters for a model
 */
export function getModelDefaults(modelId: string): {
  maxTokens: number
  temperature?: number
} {
  const model = getModel(modelId)
  if (!model) {
    return { maxTokens: 16384, temperature: 0.7 }
  }

  // Use a generous default for agentic use: tool calls often contain large
  // payloads (e.g., full file rewrites). 4096 is too small and causes the
  // Vercel AI SDK to silently drop incomplete tool call JSON.
  const defaultMaxOutput = model.capabilities.reasoning ? 32768 : 16384
  return {
    maxTokens: Math.min(model.limit.maxOutput, defaultMaxOutput),
    temperature: model.capabilities.temperature ? 0.7 : undefined
  }
}

/**
 * Check if a model supports tool calling
 */
export function supportsTools(modelId: string): boolean {
  const model = getModel(modelId)
  return model?.capabilities.toolcall ?? false
}

/**
 * Check if a model supports reasoning mode
 */
export function supportsReasoning(modelId: string): boolean {
  const model = getModel(modelId)
  return model?.capabilities.reasoning ?? false
}

/**
 * Check if a model supports image input
 */
export function supportsVision(modelId: string): boolean {
  const model = getModel(modelId)
  return model?.capabilities.input.includes('image') ?? false
}
