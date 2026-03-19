/**
 * Compat — API protocol types and OpenAI-compatible provider compat flags
 *
 * Inspired by pi-mono's two-axis model:
 *   API Protocol (how to talk) × Provider Brand (who to talk to)
 *
 * Most OpenAI-compatible providers (Groq, xAI, Cerebras, OpenRouter, Together,
 * Fireworks, etc.) share the same wire protocol but differ in quirks. The compat
 * flags capture those quirks so new providers can be added as pure configuration
 * rather than code branches.
 */

// ---------------------------------------------------------------------------
// API Protocol — the wire-level contract
// ---------------------------------------------------------------------------

/**
 * Supported API protocols.
 *
 * - `openai-chat`        — POST /v1/chat/completions  (GPT-4o, Groq, xAI, …)
 * - `openai-responses`   — POST /v1/responses         (GPT-5.x, o-series)
 * - `anthropic-messages`  — POST /v1/messages          (Claude)
 * - `google-generative`  — Google Generative Language  (Gemini)
 */
export type ApiProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative'

// ---------------------------------------------------------------------------
// OpenAI-compatible compat flags
// ---------------------------------------------------------------------------

/**
 * Compat flags for OpenAI-compatible providers.
 *
 * Each flag describes a provider/model-level behavioral difference from the
 * canonical OpenAI Chat Completions API. When a flag is omitted or undefined
 * the default (standard OpenAI) behavior is assumed.
 */
export interface OpenAICompat {
  /**
   * Whether the `developer` role is supported.
   * Some providers only accept `system`.
   * @default true
   */
  supportsDeveloperRole?: boolean

  /**
   * Field name for maximum output tokens.
   * OpenAI uses `max_completion_tokens`; many clones still use `max_tokens`.
   * @default 'max_completion_tokens'
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'

  /**
   * Whether `reasoning_effort` parameter is supported.
   * @default false
   */
  supportsReasoningEffort?: boolean

  /**
   * How the provider formats thinking/reasoning blocks in responses.
   * @default undefined (no reasoning support)
   */
  thinkingFormat?: 'openai' | 'deepseek' | 'text-delimited'

  /**
   * Whether tool definitions accept `strict: true` for strict JSON schema.
   * @default true
   */
  supportsStrictMode?: boolean

  /**
   * Whether tool results require the `name` field alongside `tool_call_id`.
   * @default false
   */
  requiresToolResultName?: boolean

  /**
   * Whether prompt caching is supported.
   * @default false
   */
  supportsCaching?: boolean

  /**
   * Whether `stream_options: { include_usage: true }` is supported.
   * @default true
   */
  supportsStreamOptions?: boolean
}

// ---------------------------------------------------------------------------
// Resolved compat — with defaults filled in
// ---------------------------------------------------------------------------

/** Compat flags with all defaults resolved (no undefineds). */
export interface ResolvedCompat {
  supportsDeveloperRole: boolean
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
  supportsReasoningEffort: boolean
  thinkingFormat: 'openai' | 'deepseek' | 'text-delimited' | null
  supportsStrictMode: boolean
  requiresToolResultName: boolean
  supportsCaching: boolean
  supportsStreamOptions: boolean
}

const COMPAT_DEFAULTS: ResolvedCompat = {
  supportsDeveloperRole: true,
  maxTokensField: 'max_completion_tokens',
  supportsReasoningEffort: false,
  thinkingFormat: null,
  supportsStrictMode: true,
  requiresToolResultName: false,
  supportsCaching: false,
  supportsStreamOptions: true,
}

/**
 * Merge optional compat flags into a fully-resolved object.
 * Model-level flags override provider-level flags.
 */
export function resolveCompat(
  providerCompat?: OpenAICompat,
  modelCompat?: OpenAICompat
): ResolvedCompat {
  return {
    ...COMPAT_DEFAULTS,
    ...providerCompat,
    ...modelCompat,
    // Ensure null sentinel for thinkingFormat when not set
    thinkingFormat:
      modelCompat?.thinkingFormat ??
      providerCompat?.thinkingFormat ??
      COMPAT_DEFAULTS.thinkingFormat,
  }
}
