/**
 * Models - Built-in model configurations
 *
 * Define supported LLM models and their capabilities
 */

import type { ModelConfig } from './provider.types.js'

/**
 * Built-in model configurations
 */
export const builtinModels: ModelConfig[] = [
  // OpenAI Models - GPT-5.x (Responses API)
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    providerID: 'openai',
    api: 'chat',
    capabilities: {
      temperature: false,  // GPT-5.2 does not support temperature
      reasoning: true,     // Uses Responses API
      toolcall: true,
      input: ['text', 'image'],
      output: ['text']
    },
    cost: { input: 1.75, cachedInput: 0.175, output: 14 },
    limit: { maxContext: 128000, maxOutput: 16384 }
  },
  {
    id: 'gpt-5.1',
    name: 'GPT-5.1',
    providerID: 'openai',
    api: 'chat',
    capabilities: {
      temperature: false,  // GPT-5.1 does not support temperature
      reasoning: true,     // Uses Responses API
      toolcall: true,
      input: ['text', 'image'],
      output: ['text']
    },
    cost: { input: 1.25, cachedInput: 0.125, output: 10 },
    limit: { maxContext: 128000, maxOutput: 16384 }
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    providerID: 'openai',
    api: 'chat',
    capabilities: {
      temperature: false,
      reasoning: true,     // Uses Responses API
      toolcall: true,
      input: ['text', 'image'],
      output: ['text']
    },
    cost: { input: 0.25, cachedInput: 0.025, output: 2 },
    limit: { maxContext: 128000, maxOutput: 16384 }
  },
  {
    id: 'gpt-5-nano',
    name: 'GPT-5 Nano',
    providerID: 'openai',
    api: 'chat',
    capabilities: {
      temperature: false,
      reasoning: true,     // Uses Responses API
      toolcall: true,
      input: ['text', 'image'],
      output: ['text']
    },
    cost: { input: 0.05, cachedInput: 0.005, output: 0.4 },
    limit: { maxContext: 128000, maxOutput: 16384 }
  },

  // OpenAI Models - GPT-4 (Chat Completions API)
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    providerID: 'openai',
    api: 'chat',
    capabilities: {
      temperature: true,
      reasoning: false,    // Uses Chat Completions API
      toolcall: true,
      input: ['text', 'image'],
      output: ['text']
    },
    cost: { input: 2.5, cachedInput: 1.25, output: 10 },
    limit: { maxContext: 128000, maxOutput: 16384 }
  },

  // OpenAI Models - Reasoning (Responses API)
  {
    id: 'o1',
    name: 'OpenAI o1',
    providerID: 'openai',
    api: 'chat',
    capabilities: {
      temperature: false,
      reasoning: true,     // Uses Responses API
      toolcall: true,
      input: ['text', 'image'],
      output: ['text']
    },
    cost: { input: 15, cachedInput: 7.5, output: 60 },
    limit: { maxContext: 200000, maxOutput: 100000 }
  },
  {
    id: 'o1-mini',
    name: 'OpenAI o1 Mini',
    providerID: 'openai',
    api: 'chat',
    capabilities: {
      temperature: false,
      reasoning: true,     // Uses Responses API
      toolcall: true,
      input: ['text'],
      output: ['text']
    },
    cost: { input: 1.1, cachedInput: 0.55, output: 4.4 },
    limit: { maxContext: 128000, maxOutput: 65536 }
  },
  {
    id: 'o3-mini',
    name: 'OpenAI o3 Mini',
    providerID: 'openai',
    api: 'chat',
    capabilities: {
      temperature: false,
      reasoning: true,     // Uses Responses API
      toolcall: true,
      input: ['text'],
      output: ['text']
    },
    cost: { input: 1.1, cachedInput: 0.55, output: 4.4 },
    limit: { maxContext: 200000, maxOutput: 100000 }
  },
  {
    id: 'o4-mini',
    name: 'OpenAI o4 Mini',
    providerID: 'openai',
    api: 'chat',
    capabilities: {
      temperature: false,
      reasoning: true,     // Uses Responses API
      toolcall: true,
      input: ['text', 'image'],
      output: ['text']
    },
    cost: { input: 1.1, cachedInput: 0.275, output: 4.4 },
    limit: { maxContext: 200000, maxOutput: 100000 }
  },

  // Anthropic Models — Claude 4.6
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    providerID: 'anthropic',
    api: 'chat',
    capabilities: {
      temperature: true,
      reasoning: true,
      toolcall: true,
      input: ['text', 'image'],
      output: ['text']
    },
    cost: { input: 5, cachedInput: 0.5, output: 25 },
    limit: { maxContext: 200000, maxOutput: 128000 }
  },

  // Anthropic Models — Claude 4.5
  {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    providerID: 'anthropic',
    api: 'chat',
    capabilities: {
      temperature: true,
      reasoning: true,
      toolcall: true,
      input: ['text', 'image'],
      output: ['text']
    },
    cost: { input: 5, cachedInput: 0.5, output: 25 },
    limit: { maxContext: 200000, maxOutput: 64000 }
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    providerID: 'anthropic',
    api: 'chat',
    capabilities: {
      temperature: true,
      reasoning: true,
      toolcall: true,
      input: ['text', 'image'],
      output: ['text']
    },
    cost: { input: 3, cachedInput: 0.3, output: 15 },
    limit: { maxContext: 200000, maxOutput: 64000 }
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    providerID: 'anthropic',
    api: 'chat',
    capabilities: {
      temperature: true,
      reasoning: true,
      toolcall: true,
      input: ['text', 'image'],
      output: ['text']
    },
    cost: { input: 1, cachedInput: 0.1, output: 5 },
    limit: { maxContext: 200000, maxOutput: 64000 }
  },

  // DeepSeek Models
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    providerID: 'deepseek',
    api: 'chat',
    capabilities: {
      temperature: true,
      reasoning: false,
      toolcall: true,
      input: ['text'],
      output: ['text']
    },
    cost: { input: 0.28, cachedInput: 0.028, output: 0.42 },
    limit: { maxContext: 64000, maxOutput: 8192 }
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    providerID: 'deepseek',
    api: 'chat',
    capabilities: {
      temperature: false,
      reasoning: true,
      toolcall: false,
      input: ['text'],
      output: ['text']
    },
    cost: { input: 0.28, cachedInput: 0.028, output: 0.42 },
    limit: { maxContext: 64000, maxOutput: 8192 }
  },

  // Google Models
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    providerID: 'google',
    api: 'chat',
    capabilities: {
      temperature: true,
      reasoning: false,
      toolcall: true,
      input: ['text', 'image'],
      output: ['text']
    },
    cost: { input: 0.1, cachedInput: 0.025, output: 0.4 },
    limit: { maxContext: 1000000, maxOutput: 8192 }
  },
  {
    id: 'gemini-2.0-flash-thinking',
    name: 'Gemini 2.0 Flash Thinking',
    providerID: 'google',
    api: 'chat',
    capabilities: {
      temperature: false,
      reasoning: true,
      toolcall: false,
      input: ['text', 'image'],
      output: ['text']
    },
    // Not listed as a separate SKU on the current official pricing page.
    // Keep billing consistent by aligning with gemini-2.0-flash for now.
    cost: { input: 0.1, cachedInput: 0.025, output: 0.4 },
    limit: { maxContext: 1000000, maxOutput: 8192 }
  }
]

/**
 * Model registry
 */
class ModelRegistry {
  private models: Map<string, ModelConfig> = new Map()

  constructor() {
    // Register built-in models
    for (const model of builtinModels) {
      this.register(model)
    }
  }

  /**
   * Register a model
   */
  register(model: ModelConfig): void {
    this.models.set(model.id, model)
  }

  /**
   * Get model configuration
   */
  get(id: string): ModelConfig | undefined {
    return this.models.get(id)
  }

  /**
   * Get all models
   */
  getAll(): ModelConfig[] {
    return Array.from(this.models.values())
  }

  /**
   * Get models by Provider
   */
  getByProvider(providerID: string): ModelConfig[] {
    return this.getAll().filter(m => m.providerID === providerID)
  }

  /**
   * Check if a model supports a given capability
   */
  hasCapability(
    id: string,
    capability: keyof ModelConfig['capabilities']
  ): boolean {
    const model = this.get(id)
    if (!model) return false
    const value = model.capabilities[capability]
    return Array.isArray(value) ? value.length > 0 : value
  }
}

/**
 * Global model registry instance
 */
export const modelRegistry = new ModelRegistry()

/**
 * Get model configuration
 */
export function getModel(id: string): ModelConfig | undefined {
  return modelRegistry.get(id)
}

/**
 * Get all models
 */
export function getAllModels(): ModelConfig[] {
  return modelRegistry.getAll()
}

/**
 * Register a custom model
 */
export function registerModel(model: ModelConfig): void {
  modelRegistry.register(model)
}
