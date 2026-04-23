/**
 * Provider resolution from user preferences + injected credentials.
 *
 * Selection rules:
 *   - Generation provider is currently OpenAI only (gpt-image-2). Claude
 *     has no image-generation API, so no review-provider choice changes
 *     this. When no OpenAI credential is available, generation fails
 *     loudly.
 *   - Review provider defaults to 'auto', which prefers heterogeneous
 *     review (use Anthropic if its credentials are present, so the
 *     generator is not grading its own family). Explicit 'openai' or
 *     'anthropic' overrides.
 *
 * Credentials are passed in via `DiagramAuth` rather than read from env
 * directly so the coordinator can surface anthropic-sub OAuth tokens
 * alongside static API keys (the diagram tool cannot import from
 * shared-electron without breaking the lib/ ↔ app/ layer boundary).
 * When `auth` is omitted, falls back to reading `process.env` directly
 * so the provider set is still usable from unit tests.
 */

import { createOpenAIImageProvider } from './openai-image.js'
import { createOpenAIReviewProvider } from './openai-review.js'
import { createAnthropicReviewProvider } from './anthropic-review.js'
import type { DiagramProviderSet, ImageProvider, ReviewProvider } from './types.js'
import type { DiagramAuth } from '../types.js'

export type ReviewProviderChoice = 'openai' | 'anthropic' | 'auto'
export type GenProviderChoice = 'openai'

export interface DiagramProviderPrefs {
  generation?: GenProviderChoice
  review?: ReviewProviderChoice
  imageModel?: string
  reviewModel?: string
}

interface ResolvedAuth {
  openaiKey: string | null
  anthropic: { token: string; isOAuth: boolean; refresh?: () => Promise<string> } | null
}

function resolveAuth(auth?: DiagramAuth): ResolvedAuth {
  if (auth) {
    return {
      openaiKey: auth.openaiKey ?? null,
      anthropic: auth.anthropic ?? null,
    }
  }
  // Fallback for contexts without injected auth (tests, CLI).
  const envOpenAI = process.env.OPENAI_API_KEY?.trim() || null
  const envAnthropic = process.env.ANTHROPIC_API_KEY?.trim()
  return {
    openaiKey: envOpenAI,
    anthropic: envAnthropic ? { token: envAnthropic, isOAuth: false } : null,
  }
}

function pickImageProvider(prefs: DiagramProviderPrefs, auth: ResolvedAuth): ImageProvider {
  const choice: GenProviderChoice = prefs.generation ?? 'openai'
  if (choice === 'openai') {
    if (!auth.openaiKey) {
      throw new Error(
        'Diagram generation requires an OpenAI API key. Add OPENAI_API_KEY under Settings → API Keys. ' +
        'Claude does not expose an image-generation API, so subscription login alone is not sufficient.'
      )
    }
    return createOpenAIImageProvider({ apiKey: auth.openaiKey, model: prefs.imageModel })
  }
  throw new Error(`Unknown generation provider: ${choice}`)
}

function pickReviewProvider(prefs: DiagramProviderPrefs, auth: ResolvedAuth): ReviewProvider {
  const choice: ReviewProviderChoice = prefs.review ?? 'auto'

  if (choice === 'openai') {
    if (!auth.openaiKey) {
      throw new Error('Review provider set to OpenAI but no OpenAI API key is configured.')
    }
    return createOpenAIReviewProvider({ apiKey: auth.openaiKey, model: prefs.reviewModel })
  }

  if (choice === 'anthropic') {
    if (!auth.anthropic) {
      throw new Error(
        'Review provider set to Anthropic but no Claude credentials are available. ' +
        'Either set ANTHROPIC_API_KEY under Settings → API Keys, or sign in via Claude subscription login.'
      )
    }
    return createAnthropicReviewProvider({
      token: auth.anthropic.token,
      isOAuth: auth.anthropic.isOAuth,
      refreshToken: auth.anthropic.refresh,
      model: prefs.reviewModel,
    })
  }

  // 'auto': prefer heterogeneous (Anthropic when available, since gen is OpenAI).
  if (auth.anthropic) {
    return createAnthropicReviewProvider({
      token: auth.anthropic.token,
      isOAuth: auth.anthropic.isOAuth,
      refreshToken: auth.anthropic.refresh,
      model: prefs.reviewModel,
    })
  }
  if (auth.openaiKey) {
    return createOpenAIReviewProvider({ apiKey: auth.openaiKey, model: prefs.reviewModel })
  }
  throw new Error('No review provider is configured. Add OPENAI_API_KEY or sign in to Claude.')
}

export function resolveProviders(
  prefs: DiagramProviderPrefs = {},
  auth?: DiagramAuth
): DiagramProviderSet {
  const resolved = resolveAuth(auth)
  return {
    image: pickImageProvider(prefs, resolved),
    review: pickReviewProvider(prefs, resolved),
  }
}
