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
const ASPECT_VIEWBOX: Record<Aspect, string> = {
  auto:      '0 0 1200 900',   // 4:3 lands moderate info density
  square:    '0 0 900 900',
  landscape: '0 0 1400 900',
  portrait:  '0 0 900 1400',
}

const SVG_SYSTEM_PROMPT = `You are a diagram artist producing publication-quality SVG for scientific writing.
Return ONLY a single valid SVG document wrapped in \`\`\`svg fences — no prose, no explanation.

Requirements:
- Root element has an explicit viewBox and no width/height attributes (so it scales).
- Use only standard SVG 1.1 elements (rect, circle, ellipse, line, path, polyline, polygon, text, g).
- No <script>, no <foreignObject>, no external references, no embedded base64.
- Use sans-serif font-family (Arial, Helvetica, or sans-serif keyword). Minimum font size 12.
- Colour palette: Okabe-Ito or comparable colourblind-safe; avoid pure saturated red/green for distinction.
- Every labelled element gets a <text> child with readable contents (no lorem ipsum).
- Arrows use <marker> definitions and <line>/<path> refs — no emoji arrows, no unicode replacement characters.
- Do NOT include figure numbers, titles, or captions inside the SVG ("Figure 1: …"). Those are added in-document.
- Do NOT include <?xml?> declarations; start directly with <svg ...>.`

function buildGenerationUser(prompt: string, aspect: Aspect): string {
  const viewBox = ASPECT_VIEWBOX[aspect]
  return `Produce an SVG diagram for the request below.

VIEWBOX: ${viewBox}  (use exactly this viewBox; design within it)

REQUEST:
${prompt}

Emit the SVG now.`
}

function buildEditUser(prompt: string, previousSvg: string): string {
  return `Revise the SVG below by applying the changes in REQUEST. Preserve everything that is already correct — do not redraw the whole diagram from scratch.

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
