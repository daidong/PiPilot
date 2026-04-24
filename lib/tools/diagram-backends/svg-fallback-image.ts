/**
 * SVG-via-LLM fallback image provider.
 *
 * Engaged when the user has no OpenAI API key but still wants a diagram.
 * Rather than failing the tool call, we ask the user's currently-selected
 * chat model (via ctx.callLlm) to emit an SVG document matching the
 * scientific-diagram guidelines. The output lands as a .svg file instead
 * of a .png — it embeds cleanly in Markdown and LaTeX and scales to any
 * resolution at zero quality loss.
 *
 * Quality caveats vs. gpt-image-2:
 *   - Layout quality depends on the chat model's spatial reasoning. Good
 *     models (Claude Opus / GPT-4o / GPT-5) produce usable diagrams for
 *     flowcharts, simple architecture, and box-and-arrow schemas.
 *   - Free-form "artistic" renderings (pathway illustrations, complex
 *     circuits) are noticeably weaker than native image generation.
 *   - Typography and colour follow whatever the SVG contains; there is no
 *     post-render aesthetic pass.
 *
 * Capability parity with the OpenAI image provider: text→image and
 * image→image both work, because "editing" an SVG is the same as asking
 * the LLM to revise the previous source. The verdict-driven iteration
 * loop in generate-diagram.ts therefore runs unchanged.
 */

import type { ImageCapability, ImageProvider } from './types.js'

export type Aspect = 'auto' | 'square' | 'landscape' | 'portrait'

export interface SvgFallbackImageOptions {
  callLlm: (systemPrompt: string, userContent: string) => Promise<string>
  /** Short label for logs / provider.id — typically the chat model name. */
  modelLabel?: string
  /** Hint the LLM toward a shape; maps to a viewBox. Default 'auto'. */
  aspect?: Aspect
}

// viewBox aspect ratios — chosen to match gpt-image-2's three canonical
// sizes so the downstream look lines up whether or not fallback is used.
// These are HINTS, not hard constraints — the generation prompt tells
// the model it may shrink either dimension by up to 30% to avoid empty
// gutters (see buildGenerationUser). Edit-path preserves the existing
// viewBox verbatim (see buildEditUser).
const ASPECT_VIEWBOX: Record<Aspect, string> = {
  auto:      '0 0 1200 900',   // 4:3 lands moderate info density
  square:    '0 0 900 900',
  landscape: '0 0 1400 900',
  portrait:  '0 0 900 1400',
}

const SVG_SYSTEM_PROMPT = `You are a diagram artist producing publication-quality SVG in the house visual system.
Return ONLY a single valid SVG document wrapped in \`\`\`svg fences — no prose, no explanation.

Allowed SVG 1.1 elements:
  svg, defs, marker, g, rect, circle, ellipse, line, path, polyline, polygon, text, tspan, title, desc, clipPath, pattern

Hard requirements:
- Root element has an explicit viewBox and no width/height attributes (so it scales).
- No <script>, no <foreignObject>, no external href references, no embedded base64.
- Font-family: use the house font stack supplied in the REQUEST; fall back to sans-serif when no listed font is available. Minimum font size 10px.
- Every labelled element gets a <text> child with readable contents (no lorem ipsum, no placeholder text).
- Arrows use <marker> definitions inside <defs>, referenced from <line>/<path> via marker-end — no emoji arrows, no unicode replacement characters.
- Use the colour tokens supplied in the REQUEST — do not invent a new palette.
- No gradients, filters, blur, or glow anywhere. No drop-shadow, bevel, or emboss effects.
- Do NOT include figure numbers, titles, or captions inside the SVG ("Figure 1: …"). Those are added in-document.
- Do NOT include <?xml?> declarations; start directly with <svg ...>.`

function buildGenerationUser(prompt: string, aspect: Aspect): string {
  const viewBox = ASPECT_VIEWBOX[aspect]
  return `Produce an SVG diagram for the request below.

VIEWBOX HINT: ${viewBox}
  - Use this as a starting hint. If your content fits compactly in a
    smaller area, SHRINK either dimension (by up to 30%) to eliminate
    empty gutters. A figure with visible empty regions at the bottom
    or side looks unfinished.
  - Keep the overall aspect (landscape / portrait / square) close to
    the hint. Do NOT flip orientation.
  - Do NOT grow either dimension beyond the hint — that pushes the
    figure past canonical paper-column widths.

REQUEST:
${prompt}

Emit the SVG now.`
}

function buildEditUser(prompt: string, previousSvg: string): string {
  return `Revise the SVG below by applying the changes in REQUEST. Preserve everything that is already correct — do not redraw the whole diagram from scratch.

VIEWBOX: preserve the viewBox attribute from the PREVIOUS SVG exactly. Do NOT change its dimensions, origin, or aspect.

REQUEST:
${prompt}

PREVIOUS SVG:
\`\`\`svg
${previousSvg}
\`\`\`

Emit the revised SVG now, as a single complete <svg>…</svg> document.`
}

/**
 * Pull an <svg>…</svg> block out of arbitrary LLM output. Models often
 * wrap in ```svg fences, sometimes ```xml, occasionally return raw SVG.
 * Anything outside the <svg> element is discarded.
 */
function extractSvg(raw: string): string {
  const fenceMatch = raw.match(/```(?:svg|xml)?\s*([\s\S]*?)```/i)
  const candidate = fenceMatch ? fenceMatch[1] : raw
  const svgMatch = candidate.match(/<svg\b[\s\S]*?<\/svg>/i)
  if (!svgMatch) {
    throw new Error('LLM did not return a recognisable <svg>…</svg> document.')
  }
  return svgMatch[0].trim()
}

export function createSvgFallbackImageProvider(
  opts: SvgFallbackImageOptions
): ImageProvider {
  const { callLlm } = opts
  const aspect: Aspect = opts.aspect ?? 'auto'
  const modelLabel = opts.modelLabel || 'chat-model'
  const capabilities = new Set<ImageCapability>(['text_to_image', 'image_to_image'])

  return {
    id: `svg-fallback:${modelLabel}`,
    label: `SVG fallback (${modelLabel})`,
    capabilities,

    async textToImage(prompt: string): Promise<Buffer> {
      const text = await callLlm(SVG_SYSTEM_PROMPT, buildGenerationUser(prompt, aspect))
      const svg = extractSvg(text)
      return Buffer.from(svg, 'utf-8')
    },

    async imageToImage(prompt: string, image: Buffer): Promise<Buffer> {
      const previousSvg = image.toString('utf-8')
      const text = await callLlm(SVG_SYSTEM_PROMPT, buildEditUser(prompt, previousSvg))
      const svg = extractSvg(text)
      return Buffer.from(svg, 'utf-8')
    },
  }
}
