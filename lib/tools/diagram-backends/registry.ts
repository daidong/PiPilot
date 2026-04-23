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
import { createSvgFallbackImageProvider, type Aspect } from './svg-fallback-image.js'
import { createSvgFallbackReviewProvider } from './svg-fallback-review.js'
import type { DiagramProviderSet, ImageProvider, ReviewProvider } from './types.js'
import type { DiagramAuth } from '../types.js'

export type CallLlmFn = (systemPrompt: string, userContent: string) => Promise<string>

export interface FallbackContext {
  callLlm: CallLlmFn
  /** Short model label for logs and provider.id. Typically the chat model name. */
  modelLabel?: string
}

export type ReviewProviderChoice = 'openai' | 'anthropic' | 'auto'
export type GenProviderChoice = 'openai'

export interface DiagramProviderPrefs {
  generation?: GenProviderChoice
  review?: ReviewProviderChoice
  imageModel?: string
  reviewModel?: string
  /** Explicit image size passed straight through to the provider (e.g. '1024x1024', '1536x1024', '1024x1536', 'auto'). */
  imageSize?: string
  /** Aspect hint for the SVG fallback (ignored by the OpenAI image provider — it reads imageSize directly). */
  svgAspect?: Aspect
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

function pickImageProvider(
  prefs: DiagramProviderPrefs,
  auth: ResolvedAuth,
  fallback?: FallbackContext
): ImageProvider {
  const choice: GenProviderChoice = prefs.generation ?? 'openai'
  if (choice === 'openai') {
    if (auth.openaiKey) {
      return createOpenAIImageProvider({
        apiKey: auth.openaiKey,
        model: prefs.imageModel,
        size: prefs.imageSize,
      })
    }
    // No OpenAI key → fall back to SVG-via-LLM if the host gave us a callLlm.
    // This keeps the tool producing usable output instead of hard-failing.
    if (fallback) {
      return createSvgFallbackImageProvider({
        callLlm: fallback.callLlm,
        modelLabel: fallback.modelLabel,
        aspect: prefs.svgAspect,
      })
    }
    throw new Error(
      'Diagram generation requires either OPENAI_API_KEY or a callLlm fallback ' +
      '(which the coordinator supplies from the current chat model). Neither is available here.'
    )
  }
  throw new Error(`Unknown generation provider: ${choice}`)
}

function pickReviewProvider(
  prefs: DiagramProviderPrefs,
  auth: ResolvedAuth,
  fallback?: FallbackContext,
  usingSvgGen = false
): ReviewProvider {
  const choice: ReviewProviderChoice = prefs.review ?? 'auto'

  // When generation is SVG-fallback we review via the same fallback channel:
  // structured reviewers like gpt-4o expect an image, not SVG source, so
  // feeding them markup would make legibility / layout judgements unreliable.
  if (usingSvgGen) {
    if (!fallback) {
      throw new Error('SVG review fallback requires a callLlm fallback.')
    }
    return createSvgFallbackReviewProvider({
      callLlm: fallback.callLlm,
      modelLabel: fallback.modelLabel,
    })
  }

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

export interface DiagramProviderResolution extends DiagramProviderSet {
  /** True when both image and review went through the SVG-via-LLM fallback path. */
  svgFallback: boolean
}

export function resolveProviders(
  prefs: DiagramProviderPrefs = {},
  auth?: DiagramAuth,
  fallback?: FallbackContext
): DiagramProviderResolution {
  const resolved = resolveAuth(auth)
  const image = pickImageProvider(prefs, resolved, fallback)
  const usingSvgGen = image.id.startsWith('svg-fallback:')
  const review = pickReviewProvider(prefs, resolved, fallback, usingSvgGen)
  return { image, review, svgFallback: usingSvgGen }
}
