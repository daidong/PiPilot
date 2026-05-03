import { getModel } from '@mariozechner/pi-ai'
import { parseModelKey } from '../utils'

export interface ModelCapabilities {
  vision: boolean
  reasoning: boolean
  contextWindow: number | null
  /** True when we successfully looked the model up in pi-ai. */
  resolved: boolean
}

const TEXT_ONLY_FALLBACK: ModelCapabilities = {
  vision: false,
  reasoning: false,
  contextWindow: null,
  resolved: false,
}

const VISION_FALLBACK: ModelCapabilities = {
  vision: true,
  reasoning: false,
  contextWindow: null,
  resolved: false,
}

const PI_PROVIDER_MAP: Record<string, string> = {
  'anthropic-sub': 'anthropic',
  'openai-codex': 'openai-codex',
}

function resolvePiProvider(provider: string): string {
  return PI_PROVIDER_MAP[provider] ?? provider
}

/**
 * Look up capabilities for a composite model key (e.g. `openai:gpt-5.5`,
 * `deepseek:deepseek-v4-pro`). Returns a conservative fallback when the model
 * can't be found in pi-ai (assumes vision-capable for known major providers,
 * text-only for unknown providers — matches historical app behavior).
 */
export function getModelCapabilities(modelKey: string): ModelCapabilities {
  if (!modelKey) return TEXT_ONLY_FALLBACK
  const { provider, modelId } = parseModelKey(modelKey)
  const piProvider = resolvePiProvider(provider)
  try {
    const model = getModel(piProvider as any, modelId as any) as any
    if (!model || !Array.isArray(model.input)) {
      return provider === 'deepseek' ? TEXT_ONLY_FALLBACK : VISION_FALLBACK
    }
    return {
      vision: model.input.includes('image'),
      reasoning: !!model.reasoning,
      contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : null,
      resolved: true,
    }
  } catch {
    return provider === 'deepseek' ? TEXT_ONLY_FALLBACK : VISION_FALLBACK
  }
}

export function modelSupportsVision(modelKey: string): boolean {
  return getModelCapabilities(modelKey).vision
}
