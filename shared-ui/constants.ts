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
 * Verified against pi-ai 0.70.2 (2026-05-02). NOTE: `claude-opus-4-8` and
 * `claude-fable-5` are not in pi-ai yet — they resolve through the synthetic
 * shim in `lib/models.ts:getSyntheticPiModel`. Their vision badge comes from the
 * VISION_FALLBACK path in `lib/model-capabilities.ts` (pi-ai lookup misses).
 * TODO: add `openai:gpt-5.5-pro` once pi-ai picks up the new model entry.
 */
export const SUPPORTED_MODELS: ModelOption[] = [
  // OpenAI (API key)
  { id: 'openai:gpt-5.5', label: 'GPT-5.5', provider: 'OpenAI' },
  { id: 'openai:gpt-5.4', label: 'GPT-5.4', provider: 'OpenAI' },
  // ChatGPT Subscription (OAuth)
  { id: 'openai-codex:gpt-5.5', label: 'GPT-5.5', provider: 'ChatGPT Subscription' },
  { id: 'openai-codex:gpt-5.4', label: 'GPT-5.4', provider: 'ChatGPT Subscription' },
  // Anthropic (API key) — Fable 5 is the premium top model (2× price, time-limited);
  // Opus 4.8 is the default flagship. Both are served via the synthetic-model shim
  // in lib/models.ts (pi-ai doesn't ship them yet).
  { id: 'anthropic:claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'Anthropic' },
  { id: 'anthropic:claude-fable-5', label: 'Claude Fable 5', provider: 'Anthropic' },
  // Claude Subscription (OAuth)
  { id: 'anthropic-sub:claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'Claude Subscription' },
  { id: 'anthropic-sub:claude-fable-5', label: 'Claude Fable 5', provider: 'Claude Subscription' },
  // DeepSeek (API key) — text-only, no image input
  { id: 'deepseek:deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'DeepSeek' },
  { id: 'deepseek:deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'DeepSeek' },
]

/**
 * Models that support extended reasoning / thinking mode.
 * Keep in sync with the flagship + previous tier in SUPPORTED_MODELS.
 */
export const REASONING_MODELS = [
  'openai:gpt-5.5', 'openai:gpt-5.4',
  'openai-codex:gpt-5.5', 'openai-codex:gpt-5.4',
  'anthropic:claude-opus-4-8', 'anthropic:claude-fable-5',
  'anthropic-sub:claude-opus-4-8', 'anthropic-sub:claude-fable-5',
  'deepseek:deepseek-v4-pro', 'deepseek:deepseek-v4-flash',
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
  // Anthropic Opus 4.6/4.7 + Sonnet 4.6 dropped from the picker → migrate to the 4.8 flagship
  'anthropic:claude-opus-4-7': 'anthropic:claude-opus-4-8',
  'anthropic:claude-opus-4-6': 'anthropic:claude-opus-4-8',
  'anthropic:claude-sonnet-4-6': 'anthropic:claude-opus-4-8',
  'anthropic-sub:claude-opus-4-7': 'anthropic-sub:claude-opus-4-8',
  'anthropic-sub:claude-opus-4-6': 'anthropic-sub:claude-opus-4-8',
  'anthropic-sub:claude-sonnet-4-6': 'anthropic-sub:claude-opus-4-8',
  // Anthropic 4.5 generation no longer user-visible
  'anthropic:claude-opus-4-5-20251101': 'anthropic:claude-opus-4-8',
  'anthropic:claude-sonnet-4-5-20250929': 'anthropic:claude-opus-4-8',
  'anthropic:claude-haiku-4-5-20251001': 'anthropic:claude-opus-4-8',
  'anthropic-sub:claude-opus-4-5-20251101': 'anthropic-sub:claude-opus-4-8',
  'anthropic-sub:claude-sonnet-4-5-20250929': 'anthropic-sub:claude-opus-4-8',
  'anthropic-sub:claude-haiku-4-5-20251001': 'anthropic-sub:claude-opus-4-8',
}
