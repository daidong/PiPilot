/**
 * Provider - LLM Provider 管理
 *
 * 基于 Vercel AI SDK 的统一 Provider 管理，支持 SDK 缓存
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
 * SDK 实例类型
 */
type SDKInstance = OpenAIProvider | AnthropicProvider

/**
 * SDK 缓存 - 按 provider + apiKey 缓存 SDK 实例
 */
const sdkCache = new Map<string, SDKInstance>()

/**
 * 生成缓存键
 */
function getCacheKey(provider: ProviderID, apiKey: string): string {
  return `${provider}:${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`
}

/**
 * 获取或创建 OpenAI SDK 实例
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
 * 获取或创建 Anthropic SDK 实例
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
 * 获取或创建 DeepSeek SDK 实例 (使用 OpenAI 兼容 API)
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
 * 获取或创建 Google SDK 实例 (使用 OpenAI 兼容 API)
 * 注意: 实际使用时应该用 @ai-sdk/google
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
 * 获取 Language Model 实例
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
 * 根据模型 ID 获取 Language Model
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
 * 清除 SDK 缓存
 */
export function clearSDKCache(): void {
  sdkCache.clear()
}

/**
 * 获取缓存的 SDK 数量
 */
export function getSDKCacheSize(): number {
  return sdkCache.size
}

/**
 * Provider 信息
 */
export interface ProviderInfo {
  id: ProviderID
  name: string
  description: string
  requiresApiKey: boolean
  supportedFeatures: string[]
}

/**
 * 获取 Provider 信息
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
 * 获取所有支持的 Provider
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
 * 根据 API 密钥格式检测 Provider
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
 * 验证模型是否属于指定的 Provider
 */
export function validateModelProvider(
  modelId: string,
  providerId: ProviderID
): boolean {
  const model = getModel(modelId)
  return model?.providerID === providerId
}

/**
 * 获取模型的默认配置参数
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
 * 检查模型是否支持工具调用
 */
export function supportsTools(modelId: string): boolean {
  const model = getModel(modelId)
  return model?.capabilities.toolcall ?? false
}

/**
 * 检查模型是否支持推理模式
 */
export function supportsReasoning(modelId: string): boolean {
  const model = getModel(modelId)
  return model?.capabilities.reasoning ?? false
}

/**
 * 检查模型是否支持图像输入
 */
export function supportsVision(modelId: string): boolean {
  const model = getModel(modelId)
  return model?.capabilities.input.includes('image') ?? false
}
