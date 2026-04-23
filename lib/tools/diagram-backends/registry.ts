/**
 * Provider resolution from user preferences + environment.
 *
 * Selection rules:
 *   - Generation provider is currently OpenAI only (gpt-image-2). Additional
 *     backends can be added by extending the `genProvider` setting. When no
 *     OPENAI_API_KEY is present, generation fails loudly — Claude alone
 *     cannot produce images.
 *   - Review provider defaults to 'auto', which prefers heterogeneous review
 *     (use Anthropic if both keys are present, so the generator is not
 *     grading its own family). Explicit 'openai' or 'anthropic' overrides.
 */

import { createOpenAIImageProvider } from './openai-image.js'
import { createOpenAIReviewProvider } from './openai-review.js'
import { createAnthropicReviewProvider } from './anthropic-review.js'
import type { DiagramProviderSet, ImageProvider, ReviewProvider } from './types.js'

export type ReviewProviderChoice = 'openai' | 'anthropic' | 'auto'
export type GenProviderChoice = 'openai'

export interface DiagramProviderPrefs {
  generation?: GenProviderChoice
  review?: ReviewProviderChoice
  /** Advanced: override the image model (e.g. 'gpt-image-1' for account compatibility). */
  imageModel?: string
  /** Advanced: override the review model. */
  reviewModel?: string
}

function hasOpenAI(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim()
}

function hasAnthropic(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim()
}

function pickImageProvider(prefs: DiagramProviderPrefs): ImageProvider {
  const choice: GenProviderChoice = prefs.generation ?? 'openai'
  if (choice === 'openai') {
    if (!hasOpenAI()) {
      throw new Error(
        'Diagram generation requires OPENAI_API_KEY. Configure it in Settings → API Keys. ' +
        'Claude does not expose an image-generation API.'
      )
    }
    return createOpenAIImageProvider({ model: prefs.imageModel })
  }
  throw new Error(`Unknown generation provider: ${choice}`)
}

function pickReviewProvider(prefs: DiagramProviderPrefs): ReviewProvider {
  const choice: ReviewProviderChoice = prefs.review ?? 'auto'

  if (choice === 'openai') {
    if (!hasOpenAI()) {
      throw new Error('Review provider set to OpenAI but OPENAI_API_KEY is not configured.')
    }
    return createOpenAIReviewProvider({ model: prefs.reviewModel })
  }

  if (choice === 'anthropic') {
    if (!hasAnthropic()) {
      throw new Error('Review provider set to Anthropic but ANTHROPIC_API_KEY is not configured.')
    }
    return createAnthropicReviewProvider({ model: prefs.reviewModel })
  }

  // 'auto': prefer heterogeneous (Anthropic when available, since generation is OpenAI).
  if (hasAnthropic()) {
    return createAnthropicReviewProvider({ model: prefs.reviewModel })
  }
  if (hasOpenAI()) {
    return createOpenAIReviewProvider({ model: prefs.reviewModel })
  }
  throw new Error('No review provider is configured. Add OPENAI_API_KEY or ANTHROPIC_API_KEY.')
}

export function resolveProviders(prefs: DiagramProviderPrefs = {}): DiagramProviderSet {
  return {
    image: pickImageProvider(prefs),
    review: pickReviewProvider(prefs),
  }
}
