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

const STYLE_NORMALIZATION: Partial<Record<ProviderID, string>> = {
  openai: STYLE_TEXT,
  deepseek: STYLE_TEXT,
  google: STYLE_TEXT
}

/**
 * Return provider-specific style normalization text, or `undefined` for
 * providers that don't need it (e.g. Anthropic).
 */
export function getProviderStyleNormalization(provider: ProviderID): string | undefined {
  return STYLE_NORMALIZATION[provider]
}
