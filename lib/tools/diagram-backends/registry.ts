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
import { createRasterizeThenReviewProvider, type RasterizerFn } from './rasterize-review.js'
import { transcribePngToSvg } from './png-to-svg-transcriber.js'
import type { DiagramProviderSet, ImageCapability, ImageProvider, Quality, ReviewProvider } from './types.js'
import type { DiagramAuth } from '../types.js'

export type CallLlmFn = (systemPrompt: string, userContent: string) => Promise<string>

export type CallLlmVisionFn = (
  systemPrompt: string,
  userContent: string,
  images: Array<{ base64: string; mimeType: string }>,
) => Promise<string>

export interface FallbackContext {
  callLlm: CallLlmFn
  /** Short model label for logs and provider.id. Typically the chat model name. */
  modelLabel?: string
  /**
   * When present, SVG-fallback review is rasterised first and handed to
   * a real vision reviewer (OpenAI / Anthropic) — catches layout and
   * overflow issues that reading SVG source misses. Populated only when
   * the host provides an offscreen renderer (Electron main process).
   */
  rasterizeSvg?: RasterizerFn
  /**
   * Vision-capable variant of callLlm. Required by the PNG-anchored SVG
   * path (Path A): a finalized PNG is fed to the model which re-emits it
   * as editable SVG. Absent when the active chat model does not accept
   * image input — the SVG path then degrades to chat-model-only (Path C)
   * or hard-fails when the user has an OpenAI key but no vision model
   * (Path B), depending on which is present.
   */
  callLlmVision?: CallLlmVisionFn
  /**
   * Mirrors `pi-ai Model.input.includes('image')`. Treated as authoritative
   * when present; gates Path A vs Path B selection.
   */
  visionCapable?: boolean
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
  /** Default rendering quality; per-call options can still override. */
  imageQuality?: Quality
  /** Aspect hint for the SVG fallback (ignored by the OpenAI image provider — it reads imageSize directly). */
  svgAspect?: Aspect
  /**
   * Force the SVG-via-LLM path even when an OpenAI API key is available.
   * Set this when the caller wants SVG output specifically (e.g. user
   * asked for a .svg file) — routing such requests through gpt-image-2
   * would produce PNG bytes mislabelled as .svg.
   */
  forceSvg?: boolean
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

// viewBox hints handed to the transcriber per requested aspect. Mirrors
// svg-fallback-image.ts so the two SVG paths emit congruent canvases.
const ASPECT_TO_VIEWBOX: Record<Aspect, string> = {
  auto:      '0 0 1200 900',
  square:    '0 0 900 900',
  landscape: '0 0 1400 900',
  portrait:  '0 0 900 1400',
}

/**
 * Path A transcription action: take the final PNG out of the verdict
 * loop and convert it to editable SVG. Returned alongside the image
 * provider so generate-diagram.ts can short-circuit the SVG output:
 *   1. The image provider IS the regular OpenAI provider — verdict loop
 *      runs entirely on PNGs (which the vision reviewer can score).
 *   2. After the loop accepts (or runs out of iterations), the tool
 *      writes the .svg by feeding the final PNG through this transcriber.
 *   3. SVG never enters the review/edit loop — see png-to-svg-transcriber.ts
 *      header for why self-review on transcribed SVG is a dead-weight pass.
 */
export type PngToSvgTranscriber = (png: Buffer, originalPromptHint: string) => Promise<{
  svg: string
  /** True if the first transcription pass needed a repair retry. */
  repaired: boolean
  /** First-attempt failure reason when `repaired` is true. */
  firstAttemptFailure?: string
  visionModelLabel: string
}>

function buildPngToSvgTranscriber(
  callLlmVision: CallLlmVisionFn,
  visionModelLabel: string,
  viewBoxHint: string,
): PngToSvgTranscriber {
  return async (png, originalPromptHint) => {
    const result = await transcribePngToSvg(
      { callLlmVision, modelLabel: visionModelLabel },
      { png, viewBoxHint, originalPromptHint },
    )
    return {
      svg: result.svg,
      repaired: result.repaired,
      firstAttemptFailure: result.firstAttemptFailure,
      visionModelLabel,
    }
  }
}

interface PickImageResult {
  provider: ImageProvider
  /** Set when Path A is active — generate-diagram.ts runs this on the final PNG. */
  pngToSvgTranscriber?: PngToSvgTranscriber
  /** Path classification for logging. */
  svgPath?: 'png_anchored' | 'chat_model_only' | null
}

function pickImageProvider(
  prefs: DiagramProviderPrefs,
  auth: ResolvedAuth,
  fallback?: FallbackContext
): PickImageResult {
  const choice: GenProviderChoice = prefs.generation ?? 'openai'

  // Forced-SVG path. Three sub-paths:
  //   A. openaiKey + visionCapable callLlm → PNG verdict loop, then
  //      transcribe final PNG to editable SVG (best quality).
  //   B. openaiKey + non-vision chat model → hard fail with an actionable
  //      error. Honest "not supported" beats producing a 6/10 fallback
  //      result that misleads the user about the system's capabilities.
  //   C. no openaiKey + callLlm available → chat-model-only SVG (legacy
  //      safety-net path; quality ceiling ~6/10 but better than nothing).
  if (prefs.forceSvg) {
    if (auth.openaiKey) {
      // Subpath A: vision LLM available → run PNG path through verdict
      // loop, then transcribe. The image provider here is the standard
      // OpenAI provider (returns PNG bytes); the transcriber is invoked
      // by generate-diagram.ts after the loop terminates.
      if (fallback?.callLlmVision && fallback.visionCapable !== false) {
        const provider = createOpenAIImageProvider({
          apiKey: auth.openaiKey,
          model: prefs.imageModel,
          size: prefs.imageSize,
          quality: prefs.imageQuality,
        })
        const transcriber = buildPngToSvgTranscriber(
          fallback.callLlmVision,
          fallback.modelLabel || 'chat-model',
          ASPECT_TO_VIEWBOX[prefs.svgAspect ?? 'auto'],
        )
        return { provider, pngToSvgTranscriber: transcriber, svgPath: 'png_anchored' }
      }
      // Subpath B: openaiKey but no vision model.
      throw new Error(
        'SVG_REQUIRES_VISION_MODEL: Editable SVG output requires a vision-capable chat model ' +
        '(e.g. GPT-4o, Claude Opus, Gemini 2.5) to transcribe the rendered PNG into SVG markup. ' +
        'Either switch to a vision-capable model in Settings, or request a raster output (.png).'
      )
    }
    // Subpath C: no OpenAI key — chat-model-only safety net.
    if (fallback) {
      const provider = createSvgFallbackImageProvider({
        callLlm: fallback.callLlm,
        modelLabel: fallback.modelLabel,
        aspect: prefs.svgAspect,
      })
      return { provider, svgPath: 'chat_model_only' }
    }
    throw new Error(
      'SVG output requested but neither an OpenAI API key (for the PNG-anchored path) ' +
      'nor a chat model (for the safety-net path) is configured.'
    )
  }

  if (choice === 'openai') {
    if (auth.openaiKey) {
      return {
        provider: createOpenAIImageProvider({
          apiKey: auth.openaiKey,
          model: prefs.imageModel,
          size: prefs.imageSize,
          quality: prefs.imageQuality,
        }),
        svgPath: null,
      }
    }
    // No OpenAI key → fall back to SVG-via-LLM if the host gave us a callLlm.
    // This keeps the tool producing usable output instead of hard-failing.
    if (fallback) {
      return {
        provider: createSvgFallbackImageProvider({
          callLlm: fallback.callLlm,
          modelLabel: fallback.modelLabel,
          aspect: prefs.svgAspect,
        }),
        svgPath: 'chat_model_only',
      }
    }
    throw new Error(
      'Diagram generation requires either OPENAI_API_KEY or a callLlm fallback ' +
      '(which the coordinator supplies from the current chat model). Neither is available here.'
    )
  }
  throw new Error(`Unknown generation provider: ${choice}`)
}

/**
 * Build a "real" (vision-model) review provider from the currently
 * configured auth, honouring the user's `review` preference. Returns
 * null when no vision reviewer can be constructed; callers then pick a
 * text-only or SVG-source fallback.
 */
function buildRealReviewProvider(
  choice: ReviewProviderChoice,
  auth: ResolvedAuth,
  reviewModel?: string
): ReviewProvider | null {
  if (choice === 'openai') {
    if (!auth.openaiKey) return null
    return createOpenAIReviewProvider({ apiKey: auth.openaiKey, model: reviewModel })
  }
  if (choice === 'anthropic') {
    if (!auth.anthropic) return null
    return createAnthropicReviewProvider({
      token: auth.anthropic.token,
      isOAuth: auth.anthropic.isOAuth,
      refreshToken: auth.anthropic.refresh,
      model: reviewModel,
    })
  }
  // 'auto' — prefer heterogeneous for the PNG path; for SVG this helper
  // may be called with either preference, so honour whichever is present.
  if (auth.anthropic) {
    return createAnthropicReviewProvider({
      token: auth.anthropic.token,
      isOAuth: auth.anthropic.isOAuth,
      refreshToken: auth.anthropic.refresh,
      model: reviewModel,
    })
  }
  if (auth.openaiKey) {
    return createOpenAIReviewProvider({ apiKey: auth.openaiKey, model: reviewModel })
  }
  return null
}

function pickReviewProvider(
  prefs: DiagramProviderPrefs,
  auth: ResolvedAuth,
  fallback?: FallbackContext,
  usingSvgGen = false
): ReviewProvider {
  const choice: ReviewProviderChoice = prefs.review ?? 'auto'

  // SVG generation path. Preference order:
  //   1. Rasterize SVG → PNG and send to a real vision reviewer. This
  //      catches text overflow, overlap, and other post-render problems
  //      that reading SVG source cannot see.
  //   2. If no rasterizer is available, or no vision auth is configured,
  //      fall back to source-level review via ctx.callLlm.
  if (usingSvgGen) {
    if (!fallback) {
      throw new Error('SVG review fallback requires a callLlm fallback.')
    }
    if (fallback.rasterizeSvg) {
      const visionReviewer = buildRealReviewProvider(choice, auth, prefs.reviewModel)
      if (visionReviewer) {
        return createRasterizeThenReviewProvider({
          rasterizer: fallback.rasterizeSvg,
          inner: visionReviewer,
        })
      }
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
  /**
   * True when the image provider is the chat-model-only SVG safety net
   * (Path C). False for both PNG-only mode and PNG-anchored SVG (Path A) —
   * those run the vision reviewer loop on PNGs.
   */
  svgFallback: boolean
  /**
   * Set when Path A is active. After the verdict-driven PNG loop in
   * generate-diagram.ts terminates, the tool invokes this on the final
   * PNG to produce the editable .svg output. Absent for non-SVG runs
   * and for Path C (which produces SVG directly via the image provider).
   */
  pngToSvgTranscriber?: PngToSvgTranscriber
  /** Path classification: 'png_anchored' (A), 'chat_model_only' (C), or null (PNG-only). */
  svgPath: 'png_anchored' | 'chat_model_only' | null
}

export function resolveProviders(
  prefs: DiagramProviderPrefs = {},
  auth?: DiagramAuth,
  fallback?: FallbackContext
): DiagramProviderResolution {
  const resolved = resolveAuth(auth)
  const picked = pickImageProvider(prefs, resolved, fallback)
  // Path C only: the image provider is itself an SVG-from-LLM synthesizer,
  // so the review path must use the SVG-source reviewer (or rasterize-then-
  // vision when a renderer is present). Path A returns PNG bytes from its
  // image provider, so the regular PNG review path is correct.
  const usingSvgGen = picked.svgPath === 'chat_model_only'
  const review = pickReviewProvider(prefs, resolved, fallback, usingSvgGen)
  return {
    image: picked.provider,
    review,
    svgFallback: usingSvgGen,
    pngToSvgTranscriber: picked.pngToSvgTranscriber,
    svgPath: picked.svgPath ?? null,
  }
}
