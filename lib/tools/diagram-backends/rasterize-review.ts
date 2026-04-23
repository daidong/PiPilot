/**
 * Rasterize-then-review wrapper.
 *
 * Converts any `ReviewProvider` that expects raster PNG bytes (OpenAI
 * vision, Anthropic vision) into one that accepts SVG bytes by
 * rasterising them first. Lets the SVG-fallback path reuse the real
 * vision reviewers — the source-level review we had before cannot see
 * text overflow, overlap, or rendered-layout problems; a rendered PNG
 * fed to a vision model can.
 */

import type {
  ReviewProvider,
  ReviewRequest,
  ReviewResult,
} from './types.js'
import type { SvgRasterizeOptions } from '../types.js'

export type RasterizerFn = (
  svg: Buffer,
  options?: SvgRasterizeOptions
) => Promise<Buffer>

export interface RasterizeReviewOptions {
  rasterizer: RasterizerFn
  inner: ReviewProvider
  /**
   * Render dimensions. When omitted, the rasterizer derives them from
   * the SVG's viewBox (or falls back to a sensible default).
   */
  dimensions?: SvgRasterizeOptions
}

export function createRasterizeThenReviewProvider(
  opts: RasterizeReviewOptions
): ReviewProvider {
  const { rasterizer, inner, dimensions } = opts

  async function review(req: ReviewRequest): Promise<ReviewResult> {
    const png = await rasterizer(req.image, dimensions)
    // Delegate to the real vision reviewer with rasterised bytes. The
    // inner provider's prompt, thresholds, and structured output remain
    // unchanged — the wrapper only swaps the bytes that arrive at it.
    return inner.review({ ...req, image: png })
  }

  return {
    id: `rasterize+${inner.id}`,
    label: `SVG rasterised → ${inner.label}`,
    thresholds: inner.thresholds,
    review,
  }
}
