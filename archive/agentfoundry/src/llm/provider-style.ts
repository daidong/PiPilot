/**
 * Provider Style Normalization
 *
 * Injects communication-style guidance for non-Anthropic providers so that
 * model switching is seamless and all apps benefit from natural, concise output
 * regardless of vendor.  Anthropic models already produce the desired style,
 * so no normalization text is returned for the 'anthropic' provider.
 *
 * Opt-out: apps can disable with `normalizeProviderStyle: false`.
 */

import type { ProviderID } from './provider.types.js'

const STYLE_TEXT = `## Communication Style
- Write like a knowledgeable colleague, not a customer service bot.
- Never open with filler like "Certainly!", "Of course!", "Great question!", "Absolutely!", or "Sure!".
- Use prose paragraphs by default. Only use bullet lists when the content is genuinely list-shaped.
- Be direct — state your point first, then elaborate if needed.
- Don't hedge with "It's important to note..." or "It's worth mentioning...".
- Don't summarize what you just said at the end of your response.
- Vary sentence structure. Mix short and long sentences naturally.
- Respond proportionally: short questions get short answers.`

/**
 * Providers that do NOT need style normalization.
 * Anthropic models already produce the desired style natively.
 */
const SKIP_STYLE_PROVIDERS = new Set<string>(['anthropic'])

/**
 * Return provider-specific style normalization text, or `undefined` for
 * providers that don't need it (e.g. Anthropic).
 *
 * All non-Anthropic providers (including Tier 2) receive style guidance
 * since they typically host open-weight or non-Anthropic models.
 */
export function getProviderStyleNormalization(provider: ProviderID): string | undefined {
  if (SKIP_STYLE_PROVIDERS.has(provider)) return undefined
  return STYLE_TEXT
}
