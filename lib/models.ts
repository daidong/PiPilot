/**
 * Centralized model tier registry.
 *
 * Single source of truth for which models the UI exposes and which lightweight
 * models the coordinator uses for intent routing. Pairs flagship and "light"
 * models per provider so they cannot drift independently when we bump generations.
 *
 * UI rule: only `flagship` and `previous` are user-selectable. Mini/Nano/Haiku
 * tier IDs live in `light` and are used internally (intent router, enrichment,
 * etc.) — never shown in the model picker.
 *
 * When updating: also verify the IDs exist in the pinned `@mariozechner/pi-ai`
 * version (`node_modules/@mariozechner/pi-ai/dist/models.generated.js`). Stale
 * IDs cause silent router failures (see RFC-002).
 */

export type ModelTierKey =
  | 'openai'
  | 'openai-codex'
  | 'anthropic'
  | 'anthropic-sub'
  | 'google'
  | 'deepseek'

export interface ModelTier {
  /** Latest user-facing flagship. Bare model ID (no provider prefix). */
  flagship: string
  /** Previous-gen flagship kept around to ease user transitions. `null` when n/a. */
  previous: string | null
  /** Cheap/fast model for internal use (intent routing, enrichment). `null` if provider doesn't have one. */
  light: string | null
}

/**
 * Pi-ai 0.70.2 verified IDs (2026-05-02):
 *   openai: gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.4-pro
 *   openai-codex: gpt-5.5, gpt-5.4, gpt-5.4-mini
 *   anthropic: claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001
 *   deepseek: deepseek-v4-pro, deepseek-v4-flash (text-only — no image input)
 *
 * TODO: gpt-5.5-pro was released 2026-04-23 but is not yet in pi-ai 0.70.2.
 * Add it to the openai tier (as a separate flagship-pro entry) once pi-ai picks it up.
 */
export const MODEL_TIERS: Record<ModelTierKey, ModelTier> = {
  openai: {
    flagship: 'gpt-5.5',
    previous: 'gpt-5.4',
    light: 'gpt-5.4-nano',
  },
  'openai-codex': {
    flagship: 'gpt-5.5',
    previous: 'gpt-5.4',
    light: 'gpt-5.4-mini', // nano not available in openai-codex provider
  },
  anthropic: {
    flagship: 'claude-opus-4-7',
    previous: 'claude-opus-4-6',
    light: 'claude-haiku-4-5-20251001',
  },
  'anthropic-sub': {
    flagship: 'claude-opus-4-7',
    previous: 'claude-opus-4-6',
    light: 'claude-haiku-4-5-20251001',
  },
  google: {
    flagship: '', // not exposed in UI; google is router-only for now
    previous: null,
    light: 'gemini-2.0-flash-lite',
  },
  deepseek: {
    flagship: 'deepseek-v4-pro',
    previous: null,
    light: 'deepseek-v4-flash',
  },
}

/**
 * Provider keys used for intent routing inside the coordinator.
 * Maps to pi-ai's underlying provider name (anthropic-sub uses anthropic API).
 */
export const ROUTER_PROVIDER_TO_PI: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-codex': 'openai-codex',
  google: 'google',
  deepseek: 'deepseek',
}

/** Pi-ai provider name → light model ID for intent routing. */
export const ROUTER_MODELS: Record<string, string> = {
  anthropic: MODEL_TIERS.anthropic.light!,
  openai: MODEL_TIERS.openai.light!,
  'openai-codex': MODEL_TIERS['openai-codex'].light!,
  google: MODEL_TIERS.google.light!,
  deepseek: MODEL_TIERS.deepseek.light!,
}

/** Sonnet stays separate — current at 4.6 and not on the flagship/previous ladder. */
export const ANTHROPIC_SONNET = 'claude-sonnet-4-6'

/**
 * Bare-model-id prefix → pi-ai provider.
 * Subscription variants (`openai-codex`, `anthropic-sub`) are intentionally
 * NOT inferred — they share bare ids with their API counterparts and must be
 * given as explicit `provider:model` composite keys.
 *
 * When adding a new provider to MODEL_TIERS, add its bare-id prefix here.
 */
const BARE_MODEL_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['claude-', 'anthropic'],
  ['gpt-', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
  ['gemini-', 'google'],
  ['deepseek-', 'deepseek'],
]

/**
 * Infer the pi-ai provider from a bare model id (no `provider:` prefix).
 * Returns null for unknown ids — caller decides the default policy.
 */
export function inferProviderFromModelId(modelId: string): string | null {
  for (const [prefix, provider] of BARE_MODEL_PREFIXES) {
    if (modelId.startsWith(prefix)) return provider
  }
  return null
}

/** Default model on first launch / store reset. */
export const DEFAULT_MODEL_ID = `openai:${MODEL_TIERS.openai.flagship}`

/**
 * Map of legacy/retired model IDs → current replacement.
 * Used by the renderer store to silently migrate users on app upgrade.
 */
export const RETIRED_MODEL_MIGRATIONS: Record<string, string> = {
  // OpenAI low-tier models that are no longer user-visible
  'openai:gpt-5.4-mini': `openai:${MODEL_TIERS.openai.flagship}`,
  'openai:gpt-5.4-nano': `openai:${MODEL_TIERS.openai.flagship}`,
  'openai:gpt-4o': `openai:${MODEL_TIERS.openai.flagship}`,
  'openai-codex:gpt-5.4-mini': `openai-codex:${MODEL_TIERS['openai-codex'].flagship}`,
  // Anthropic 4.5 generation no longer user-visible (Sonnet 4.6 is still current; Haiku stays internal)
  'anthropic:claude-opus-4-5-20251101': `anthropic:${MODEL_TIERS.anthropic.flagship}`,
  'anthropic:claude-sonnet-4-5-20250929': `anthropic:${ANTHROPIC_SONNET}`,
  'anthropic:claude-haiku-4-5-20251001': `anthropic:${MODEL_TIERS.anthropic.flagship}`,
  'anthropic-sub:claude-opus-4-5-20251101': `anthropic-sub:${MODEL_TIERS['anthropic-sub'].flagship}`,
  'anthropic-sub:claude-sonnet-4-5-20250929': `anthropic-sub:${ANTHROPIC_SONNET}`,
  'anthropic-sub:claude-haiku-4-5-20251001': `anthropic-sub:${MODEL_TIERS['anthropic-sub'].flagship}`,
}
