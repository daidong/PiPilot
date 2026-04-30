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

export interface ModelTier {
  /** Latest user-facing flagship. Bare model ID (no provider prefix). */
  flagship: string
  /** Previous-gen flagship kept around to ease user transitions. `null` when n/a. */
  previous: string | null
  /** Cheap/fast model for internal use (intent routing, enrichment). `null` if provider doesn't have one. */
  light: string | null
  /**
   * Adversarial review tier — capable enough to mount a credible critique,
   * distinct enough from `flagship` to add cross-tier disagreement value.
   * Used by the trust-audit auditor agent (RFC: docs/spec/trust-audit.md §4.1).
   * NOT the same as `light` (routing tier is too weak for adversarial review).
   */
  auditor: string | null
}

/**
 * Pi-ai 0.70.2 verified IDs (2026-04-27):
 *   openai: gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.4-pro
 *   openai-codex: gpt-5.5, gpt-5.4, gpt-5.4-mini
 *   anthropic: claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001
 *
 * TODO: gpt-5.5-pro was released 2026-04-23 but is not yet in pi-ai 0.70.2.
 * Add it to the openai tier (as a separate flagship-pro entry) once pi-ai picks it up.
 */
export const MODEL_TIERS: Record<ModelTierKey, ModelTier> = {
  openai: {
    flagship: 'gpt-5.5',
    previous: 'gpt-5.4',
    light: 'gpt-5.4-nano',
    auditor: 'gpt-5.4-mini',  // mini, NOT nano (light tier is too weak for adversarial review)
  },
  'openai-codex': {
    flagship: 'gpt-5.5',
    previous: 'gpt-5.4',
    light: 'gpt-5.4-mini', // nano not available in openai-codex provider
    auditor: 'gpt-5.4-mini',
  },
  anthropic: {
    flagship: 'claude-opus-4-7',
    previous: 'claude-opus-4-6',
    light: 'claude-haiku-4-5-20251001',
    auditor: 'claude-sonnet-4-6',  // Sonnet, not Haiku
  },
  'anthropic-sub': {
    flagship: 'claude-opus-4-7',
    previous: 'claude-opus-4-6',
    light: 'claude-haiku-4-5-20251001',
    auditor: 'claude-sonnet-4-6',  // sub mode reaches the same model IDs
  },
  google: {
    flagship: '', // not exposed in UI; google is router-only for now
    previous: null,
    light: 'gemini-2.0-flash-lite',
    auditor: null,  // no audit-tier choice yet for google
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
}

/** Pi-ai provider name → light model ID for intent routing. */
export const ROUTER_MODELS: Record<string, string> = {
  anthropic: MODEL_TIERS.anthropic.light!,
  openai: MODEL_TIERS.openai.light!,
  'openai-codex': MODEL_TIERS['openai-codex'].light!,
  google: MODEL_TIERS.google.light!,
}

/** Sonnet stays separate — current at 4.6 and not on the flagship/previous ladder. */
export const ANTHROPIC_SONNET = 'claude-sonnet-4-6'

/**
 * Resolve the auditor model for a given coordinator provider.
 *
 * Pairing rule (RFC §4.1):
 *   - `anthropic` / `anthropic-sub` → Sonnet 4.6
 *   - `openai` / `openai-codex`     → gpt-5.4-mini
 *   - `google` (no auditor tier)    → null
 *
 * Returns the bare model id (no provider prefix). Caller composes the
 * provider:model string for `getModel()`.
 *
 * Fallback chain when `auditor` is missing: `previous` → null. A null result
 * means the audit run must use `audit.modelOverride` from settings, otherwise
 * it errors out with a clear message.
 */
export function getAuditorModel(provider: ModelTierKey): string | null {
  const tier = MODEL_TIERS[provider]
  if (!tier) return null
  return tier.auditor ?? tier.previous ?? null
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
