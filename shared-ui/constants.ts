import type { ModelOption } from './types'

export const REASONING_MODELS = [
  'openai:gpt-5.4', 'openai:gpt-5.4-mini', 'openai:gpt-5.4-nano', 'openai:gpt-5.4-pro',
  'openai-codex:gpt-5.4', 'openai-codex:gpt-5.4-mini',
  'anthropic:claude-opus-4-6',
  'anthropic-sub:claude-opus-4-6'
]

/** @deprecated Use REASONING_MODELS instead */
export const GPT5_REASONING_MODELS = REASONING_MODELS

export const SUPPORTED_MODELS: ModelOption[] = [
  // OpenAI (API key)
  { id: 'openai:gpt-5.4', label: 'GPT-5.4', provider: 'OpenAI' },
  { id: 'openai:gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'OpenAI' },
  { id: 'openai:gpt-5.4-nano', label: 'GPT-5.4 Nano', provider: 'OpenAI' },
  { id: 'openai:gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  { id: 'openai:gpt-5.4-pro', label: 'GPT-5.4 Pro', provider: 'OpenAI' },
  // ChatGPT Subscription (OAuth) — only models registered in pi-ai's openai-codex provider
  { id: 'openai-codex:gpt-5.4', label: 'GPT-5.4', provider: 'ChatGPT Subscription' },
  { id: 'openai-codex:gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'ChatGPT Subscription' },
  // Anthropic (API key)
  { id: 'anthropic:claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'Anthropic' },
  { id: 'anthropic:claude-opus-4-5-20251101', label: 'Claude Opus 4.5', provider: 'Anthropic' },
  { id: 'anthropic:claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', provider: 'Anthropic' },
  { id: 'anthropic:claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'Anthropic' },
  // Claude Subscription (OAuth) — enabled by default alongside ChatGPT Subscription
  { id: 'anthropic-sub:claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'Claude Subscription' },
  { id: 'anthropic-sub:claude-opus-4-5-20251101', label: 'Claude Opus 4.5', provider: 'Claude Subscription' },
  { id: 'anthropic-sub:claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', provider: 'Claude Subscription' },
  { id: 'anthropic-sub:claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'Claude Subscription' },
]

export const DEFAULT_MODEL = 'openai:gpt-5.4'
