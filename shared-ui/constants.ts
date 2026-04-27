import type { ModelOption } from './types'

/**
 * User-facing model picker list.
 *
 * Rule: only the latest flagship + previous generation per provider is shown.
 * Mini/Nano/Haiku tiers are intentionally hidden — they're used internally for
 * intent routing (see `lib/models.ts:ROUTER_MODELS`) but are not surfaced to
 * users, who almost never pick them for research work.
 *
 * IMPORTANT: this list must stay in sync with `lib/models.ts:MODEL_TIERS`. When
 * bumping a flagship/previous, update both files. The router/light-tier IDs
 * live in `lib/models.ts` only.
 *
 * Verified against pi-ai 0.70.2 (2026-04-27).
 * TODO: add `openai:gpt-5.5-pro` once pi-ai picks up the new model entry.
 */
export const SUPPORTED_MODELS: ModelOption[] = [
  // OpenAI (API key)
  { id: 'openai:gpt-5.5', label: 'GPT-5.5', provider: 'OpenAI' },
  { id: 'openai:gpt-5.4', label: 'GPT-5.4', provider: 'OpenAI' },
  // ChatGPT Subscription (OAuth)
  { id: 'openai-codex:gpt-5.5', label: 'GPT-5.5', provider: 'ChatGPT Subscription' },
  { id: 'openai-codex:gpt-5.4', label: 'GPT-5.4', provider: 'ChatGPT Subscription' },
  // Anthropic (API key)
  { id: 'anthropic:claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'Anthropic' },
  { id: 'anthropic:claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'Anthropic' },
  { id: 'anthropic:claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'Anthropic' },
  // Claude Subscription (OAuth)
  { id: 'anthropic-sub:claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'Claude Subscription' },
  { id: 'anthropic-sub:claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'Claude Subscription' },
  { id: 'anthropic-sub:claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'Claude Subscription' },
]

/**
 * Models that support extended reasoning / thinking mode.
 * Keep in sync with the flagship + previous tier in SUPPORTED_MODELS.
 */
export const REASONING_MODELS = [
  'openai:gpt-5.5', 'openai:gpt-5.4',
  'openai-codex:gpt-5.5', 'openai-codex:gpt-5.4',
  'anthropic:claude-opus-4-7', 'anthropic:claude-opus-4-6',
  'anthropic-sub:claude-opus-4-7', 'anthropic-sub:claude-opus-4-6',
]

/** @deprecated Use REASONING_MODELS instead */
export const GPT5_REASONING_MODELS = REASONING_MODELS

export const DEFAULT_MODEL = 'openai:gpt-5.5'

/**
 * Legacy/retired model IDs → current replacement.
 * Used by the renderer store to silently migrate users when they upgrade and
 * their saved selection no longer appears in SUPPORTED_MODELS.
 *
 * Mirrors `lib/models.ts:RETIRED_MODEL_MIGRATIONS`. Update both when adding entries.
 */
export const RETIRED_MODEL_MIGRATIONS: Record<string, string> = {
  // OpenAI low-tier and retired flagship
  'openai:gpt-5.4-mini': 'openai:gpt-5.5',
  'openai:gpt-5.4-nano': 'openai:gpt-5.5',
  'openai:gpt-5.4-pro': 'openai:gpt-5.5',
  'openai:gpt-4o': 'openai:gpt-5.5',
  'openai-codex:gpt-5.4-mini': 'openai-codex:gpt-5.5',
  // Anthropic 4.5 generation no longer user-visible
  'anthropic:claude-opus-4-5-20251101': 'anthropic:claude-opus-4-7',
  'anthropic:claude-sonnet-4-5-20250929': 'anthropic:claude-sonnet-4-6',
  'anthropic:claude-haiku-4-5-20251001': 'anthropic:claude-opus-4-7',
  'anthropic-sub:claude-opus-4-5-20251101': 'anthropic-sub:claude-opus-4-7',
  'anthropic-sub:claude-sonnet-4-5-20250929': 'anthropic-sub:claude-sonnet-4-6',
  'anthropic-sub:claude-haiku-4-5-20251001': 'anthropic-sub:claude-opus-4-7',
}
