/**
 * Provider Definitions — declarative provider + model catalog
 *
 * Each ProviderDefinition describes a provider brand (Groq, xAI, …) and the
 * API protocol it speaks, its base URL, env var for the API key, optional
 * compat flags, and the list of models it hosts.
 *
 * Adding a new OpenAI-compatible provider is purely declarative: add an entry
 * to BUILTIN_PROVIDERS with the correct baseUrl and compat flags.
 */

import type { ApiProtocol, OpenAICompat } from './compat.js'
import type { ModelCapabilities, ModelCost, ModelLimit } from './provider.types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single model hosted by a provider. */
export interface ModelDefinition {
  /** Provider-native model ID (e.g. 'llama-3.3-70b-versatile') */
  id: string
  /** Human-readable name */
  name: string
  capabilities: ModelCapabilities
  cost?: ModelCost
  limit: ModelLimit
  /** Model-level compat overrides (merged on top of provider compat) */
  compat?: OpenAICompat
}

/** A provider brand and its configuration. */
export interface ProviderDefinition {
  /** Short unique slug (e.g. 'groq', 'xai') */
  id: string
  /** Display name */
  name: string
  /** Which wire protocol this provider speaks */
  apiProtocol: ApiProtocol
  /** Base URL for API requests */
  baseUrl: string
  /** Environment variable name holding the API key */
  apiKeyEnv: string
  /** Provider-level compat flags */
  compat?: OpenAICompat
  /** Static headers to add to every request */
  headers?: Record<string, string>
  /** Models hosted by this provider */
  models: ModelDefinition[]
}

// ---------------------------------------------------------------------------
// Helper — reusable capability presets
// ---------------------------------------------------------------------------

const TEXT_TOOL: ModelCapabilities = {
  temperature: true, reasoning: false, toolcall: true,
  input: ['text'], output: ['text'],
}

const TEXT_VISION_TOOL: ModelCapabilities = {
  temperature: true, reasoning: false, toolcall: true,
  input: ['text', 'image'], output: ['text'],
}

const REASONING: ModelCapabilities = {
  temperature: false, reasoning: true, toolcall: true,
  input: ['text', 'image'], output: ['text'],
}

const REASONING_TEXT_ONLY: ModelCapabilities = {
  temperature: false, reasoning: true, toolcall: true,
  input: ['text'], output: ['text'],
}

const REASONING_NO_TOOLS: ModelCapabilities = {
  temperature: false, reasoning: true, toolcall: false,
  input: ['text'], output: ['text'],
}

// ---------------------------------------------------------------------------
// Built-in providers
// ---------------------------------------------------------------------------

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // Tier 1 — first-class providers with dedicated SDK support
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'openai',
    name: 'OpenAI',
    apiProtocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    compat: { supportsCaching: true, supportsReasoningEffort: true, supportsStrictMode: true },
    models: [
      // GPT-5.4 (Responses API)
      { id: 'gpt-5.4', name: 'GPT-5.4', capabilities: REASONING,
        cost: { input: 2.0, cachedInput: 0.2, output: 16 },
        limit: { maxContext: 128_000, maxOutput: 16_384 } },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', capabilities: REASONING,
        cost: { input: 0.3, cachedInput: 0.03, output: 2.4 },
        limit: { maxContext: 128_000, maxOutput: 16_384 } },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', capabilities: REASONING,
        cost: { input: 0.06, cachedInput: 0.006, output: 0.48 },
        limit: { maxContext: 128_000, maxOutput: 16_384 } },
      // GPT-4o (Chat Completions)
      { id: 'gpt-4o', name: 'GPT-4o', capabilities: TEXT_VISION_TOOL,
        cost: { input: 2.5, cachedInput: 1.25, output: 10 },
        limit: { maxContext: 128_000, maxOutput: 16_384 },
        compat: { supportsReasoningEffort: false } },
      // o-series reasoning
      { id: 'o1', name: 'OpenAI o1', capabilities: REASONING,
        cost: { input: 15, cachedInput: 7.5, output: 60 },
        limit: { maxContext: 200_000, maxOutput: 100_000 } },
      { id: 'o1-mini', name: 'OpenAI o1 Mini', capabilities: REASONING_TEXT_ONLY,
        cost: { input: 1.1, cachedInput: 0.55, output: 4.4 },
        limit: { maxContext: 128_000, maxOutput: 65_536 } },
      { id: 'o3-mini', name: 'OpenAI o3 Mini', capabilities: REASONING_TEXT_ONLY,
        cost: { input: 1.1, cachedInput: 0.55, output: 4.4 },
        limit: { maxContext: 200_000, maxOutput: 100_000 } },
      { id: 'o4-mini', name: 'OpenAI o4 Mini', capabilities: REASONING,
        cost: { input: 1.1, cachedInput: 0.275, output: 4.4 },
        limit: { maxContext: 200_000, maxOutput: 100_000 } },
    ]
  },

  {
    id: 'anthropic',
    name: 'Anthropic',
    apiProtocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    compat: { supportsCaching: true },
    models: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6',
        capabilities: { temperature: true, reasoning: true, toolcall: true, input: ['text', 'image'], output: ['text'] },
        cost: { input: 5, cachedInput: 0.5, output: 25 },
        limit: { maxContext: 200_000, maxOutput: 128_000 } },
      { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5',
        capabilities: { temperature: true, reasoning: true, toolcall: true, input: ['text', 'image'], output: ['text'] },
        cost: { input: 5, cachedInput: 0.5, output: 25 },
        limit: { maxContext: 200_000, maxOutput: 64_000 } },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5',
        capabilities: { temperature: true, reasoning: true, toolcall: true, input: ['text', 'image'], output: ['text'] },
        cost: { input: 3, cachedInput: 0.3, output: 15 },
        limit: { maxContext: 200_000, maxOutput: 64_000 } },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5',
        capabilities: { temperature: true, reasoning: true, toolcall: true, input: ['text', 'image'], output: ['text'] },
        cost: { input: 1, cachedInput: 0.1, output: 5 },
        limit: { maxContext: 200_000, maxOutput: 64_000 } },
    ]
  },

  {
    id: 'google',
    name: 'Google AI',
    apiProtocol: 'google-generative',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GOOGLE_API_KEY',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', capabilities: TEXT_VISION_TOOL,
        cost: { input: 0.1, cachedInput: 0.025, output: 0.4 },
        limit: { maxContext: 1_000_000, maxOutput: 8_192 } },
      { id: 'gemini-2.0-flash-thinking', name: 'Gemini 2.0 Flash Thinking',
        capabilities: { temperature: false, reasoning: true, toolcall: false, input: ['text', 'image'], output: ['text'] },
        cost: { input: 0.1, cachedInput: 0.025, output: 0.4 },
        limit: { maxContext: 1_000_000, maxOutput: 8_192 } },
    ]
  },

  {
    id: 'deepseek',
    name: 'DeepSeek',
    apiProtocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    compat: {
      maxTokensField: 'max_tokens',
      supportsDeveloperRole: false,
      supportsStrictMode: false,
    },
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', capabilities: TEXT_TOOL,
        cost: { input: 0.28, cachedInput: 0.028, output: 0.42 },
        limit: { maxContext: 64_000, maxOutput: 8_192 } },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', capabilities: REASONING_NO_TOOLS,
        cost: { input: 0.28, cachedInput: 0.028, output: 0.42 },
        limit: { maxContext: 64_000, maxOutput: 8_192 },
        compat: { thinkingFormat: 'deepseek' } },
    ]
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Tier 2 — OpenAI-compatible providers (zero new SDK code)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'groq',
    name: 'Groq',
    apiProtocol: 'openai-chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    compat: {
      maxTokensField: 'max_tokens',
      supportsDeveloperRole: false,
      supportsStrictMode: false,
      supportsStreamOptions: false,
    },
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Groq)',
        capabilities: TEXT_TOOL,
        cost: { input: 0.59, output: 0.79 },
        limit: { maxContext: 128_000, maxOutput: 32_768 } },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B (Groq)',
        capabilities: TEXT_TOOL,
        cost: { input: 0.05, output: 0.08 },
        limit: { maxContext: 128_000, maxOutput: 8_192 } },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B (Groq)',
        capabilities: TEXT_TOOL,
        cost: { input: 0.24, output: 0.24 },
        limit: { maxContext: 32_768, maxOutput: 32_768 } },
      { id: 'gemma2-9b-it', name: 'Gemma 2 9B (Groq)',
        capabilities: TEXT_TOOL,
        cost: { input: 0.20, output: 0.20 },
        limit: { maxContext: 8_192, maxOutput: 8_192 } },
    ]
  },

  {
    id: 'xai',
    name: 'xAI',
    apiProtocol: 'openai-chat',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    compat: {
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
    },
    models: [
      { id: 'grok-3', name: 'Grok 3',
        capabilities: TEXT_VISION_TOOL,
        cost: { input: 3.0, output: 15.0 },
        limit: { maxContext: 131_072, maxOutput: 131_072 } },
      { id: 'grok-3-mini', name: 'Grok 3 Mini',
        capabilities: { temperature: true, reasoning: true, toolcall: true, input: ['text', 'image'], output: ['text'] },
        cost: { input: 0.30, output: 0.50 },
        limit: { maxContext: 131_072, maxOutput: 131_072 } },
    ]
  },

  {
    id: 'cerebras',
    name: 'Cerebras',
    apiProtocol: 'openai-chat',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    compat: {
      maxTokensField: 'max_tokens',
      supportsDeveloperRole: false,
      supportsStrictMode: false,
      supportsStreamOptions: false,
    },
    models: [
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B (Cerebras)',
        capabilities: TEXT_TOOL,
        cost: { input: 0.85, output: 1.20 },
        limit: { maxContext: 128_000, maxOutput: 8_192 } },
    ]
  },

  {
    id: 'openrouter',
    name: 'OpenRouter',
    apiProtocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    compat: {
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
    },
    headers: {
      'HTTP-Referer': 'https://agentfoundry.dev',
      'X-Title': 'AgentFoundry',
    },
    models: [
      // OpenRouter is a gateway — users pass any model slug.
      // We list popular ones; users can use any slug via model override.
      { id: 'openrouter/auto', name: 'OpenRouter Auto',
        capabilities: TEXT_TOOL,
        limit: { maxContext: 128_000, maxOutput: 16_384 } },
      { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (OpenRouter)',
        capabilities: { temperature: true, reasoning: true, toolcall: true, input: ['text', 'image'], output: ['text'] },
        cost: { input: 3.0, cachedInput: 0.3, output: 15.0 },
        limit: { maxContext: 200_000, maxOutput: 64_000 } },
      { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash (OpenRouter)',
        capabilities: TEXT_VISION_TOOL,
        cost: { input: 0.1, output: 0.4 },
        limit: { maxContext: 1_000_000, maxOutput: 8_192 } },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B (OpenRouter)',
        capabilities: TEXT_TOOL,
        cost: { input: 0.39, output: 0.39 },
        limit: { maxContext: 128_000, maxOutput: 32_768 } },
    ]
  },

  {
    id: 'together',
    name: 'Together AI',
    apiProtocol: 'openai-chat',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    compat: {
      maxTokensField: 'max_tokens',
      supportsDeveloperRole: false,
      supportsStrictMode: false,
    },
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo (Together)',
        capabilities: TEXT_TOOL,
        cost: { input: 0.88, output: 0.88 },
        limit: { maxContext: 128_000, maxOutput: 8_192 } },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', name: 'Qwen 2.5 72B (Together)',
        capabilities: TEXT_TOOL,
        cost: { input: 1.20, output: 1.20 },
        limit: { maxContext: 128_000, maxOutput: 8_192 } },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1 (Together)',
        capabilities: REASONING_NO_TOOLS,
        cost: { input: 3.0, output: 7.0 },
        limit: { maxContext: 64_000, maxOutput: 8_192 },
        compat: { thinkingFormat: 'deepseek' } },
    ]
  },

  {
    id: 'fireworks',
    name: 'Fireworks AI',
    apiProtocol: 'openai-chat',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    compat: {
      maxTokensField: 'max_tokens',
      supportsDeveloperRole: false,
      supportsStrictMode: false,
    },
    models: [
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', name: 'Llama 3.3 70B (Fireworks)',
        capabilities: TEXT_TOOL,
        cost: { input: 0.90, output: 0.90 },
        limit: { maxContext: 128_000, maxOutput: 16_384 } },
      { id: 'accounts/fireworks/models/qwen2p5-72b-instruct', name: 'Qwen 2.5 72B (Fireworks)',
        capabilities: TEXT_TOOL,
        cost: { input: 0.90, output: 0.90 },
        limit: { maxContext: 128_000, maxOutput: 16_384 } },
    ]
  },

  {
    id: 'mistral',
    name: 'Mistral AI',
    apiProtocol: 'openai-chat',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    compat: {
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
    },
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large',
        capabilities: TEXT_TOOL,
        cost: { input: 2.0, output: 6.0 },
        limit: { maxContext: 128_000, maxOutput: 8_192 } },
      { id: 'mistral-small-latest', name: 'Mistral Small',
        capabilities: TEXT_TOOL,
        cost: { input: 0.1, output: 0.3 },
        limit: { maxContext: 128_000, maxOutput: 8_192 } },
      { id: 'codestral-latest', name: 'Codestral',
        capabilities: TEXT_TOOL,
        cost: { input: 0.3, output: 0.9 },
        limit: { maxContext: 256_000, maxOutput: 8_192 } },
    ]
  },
]

// ---------------------------------------------------------------------------
// Registry API
// ---------------------------------------------------------------------------

/** Mutable provider registry. Starts with BUILTIN_PROVIDERS. */
const providerMap = new Map<string, ProviderDefinition>()

// Initialize from built-in list
for (const p of BUILTIN_PROVIDERS) {
  providerMap.set(p.id, p)
}

/**
 * Register a custom provider at runtime.
 * Overwrites any existing provider with the same `id`.
 */
export function registerProvider(provider: ProviderDefinition): void {
  providerMap.set(provider.id, provider)
}

/** Get a provider definition by id. */
export function getProviderDefinition(id: string): ProviderDefinition | undefined {
  return providerMap.get(id)
}

/** Get all registered provider definitions. */
export function getAllProviderDefinitions(): ProviderDefinition[] {
  return Array.from(providerMap.values())
}

/**
 * Look up which provider hosts a given model id.
 * Returns the first match (scans all providers).
 */
export function findProviderForModel(modelId: string): ProviderDefinition | undefined {
  for (const provider of providerMap.values()) {
    if (provider.models.some(m => m.id === modelId)) {
      return provider
    }
  }
  return undefined
}

/**
 * Find a model definition by id across all providers.
 */
export function findModelDefinition(modelId: string): { provider: ProviderDefinition; model: ModelDefinition } | undefined {
  for (const provider of providerMap.values()) {
    const model = provider.models.find(m => m.id === modelId)
    if (model) return { provider, model }
  }
  return undefined
}
