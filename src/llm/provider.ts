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

/**
 * SDK instance type
 */
type SDKInstance = OpenAIProvider | AnthropicProvider

/**
 * SDK cache - caches SDK instances by provider + apiKey
 */
const sdkCache = new Map<string, SDKInstance>()

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
  const cacheKey = getCacheKey('openai', config.apiKey)

  let sdk = sdkCache.get(cacheKey) as OpenAIProvider | undefined
  if (!sdk) {
    sdk = createOpenAI({
      apiKey: config.apiKey,
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
  const cacheKey = getCacheKey('anthropic', config.apiKey)

  let sdk = sdkCache.get(cacheKey) as AnthropicProvider | undefined
  if (!sdk) {
    sdk = createAnthropic({
      apiKey: config.apiKey,
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
  const cacheKey = getCacheKey('deepseek', config.apiKey)

  let sdk = sdkCache.get(cacheKey) as OpenAIProvider | undefined
  if (!sdk) {
    sdk = createOpenAI({
      apiKey: config.apiKey,
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
  const cacheKey = getCacheKey('google', config.apiKey)

  let sdk = sdkCache.get(cacheKey) as OpenAIProvider | undefined
  if (!sdk) {
    // Google AI uses OpenAI-compatible API through a proxy or direct endpoint
    sdk = createOpenAI({
      apiKey: config.apiKey,
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
 * Note: AI SDK v5+ defaults to Responses API for OpenAI.
 * We need to explicitly use .chat() for Chat Completions API
 * or .responses() for Responses API based on model capabilities.
 *
 * - reasoning: true  -> use sdk.responses(model) (GPT-5.x, o-series)
 * - reasoning: false -> use sdk.chat(model) (GPT-4o, etc.)
 */
export function getLanguageModel(options: ProviderOptions): LanguageModel {
  const { provider, model, config } = options

  // Get model config to determine API type
  const modelConfig = getModel(model)

  switch (provider) {
    case 'openai': {
      const sdk = getOpenAISDK(config)
      // GPT-5.x and reasoning models (o-series) use Responses API
      // GPT-4o and older models use Chat Completions API
      if (modelConfig?.capabilities.reasoning) {
        return sdk.responses(model)
      }
      // Must explicitly use .chat() for Chat Completions API in AI SDK v5+
      return sdk.chat(model)
    }
    case 'anthropic': {
      const sdk = getAnthropicSDK(config)
      // Prompt caching is enabled via message-level providerOptions
      // in stream.ts convertMessages function
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
    default:
      throw new Error(`Unsupported provider: ${provider}`)
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
 * Get Provider information
 */
export function getProviderInfo(id: ProviderID): ProviderInfo {
  const providers: Record<ProviderID, ProviderInfo> = {
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

  return providers[id]
}

/**
 * Get all supported Providers
 */
export function getAllProviders(): ProviderInfo[] {
  return [
    getProviderInfo('openai'),
    getProviderInfo('anthropic'),
    getProviderInfo('deepseek'),
    getProviderInfo('google')
  ]
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
