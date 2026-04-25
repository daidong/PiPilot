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
 *
 * Robustness layer (added 2026-04 — Phase 6.1):
 *   - extractSvg returns a structured outcome (ok / fail with reason) so
 *     callers can drive a repair loop instead of just throwing.
 *   - validateSvg checks well-formedness, viewBox presence, marker
 *     reference closure, and presence of at least one <text> element.
 *     These are dependency-free and fast.
 *   - generateWithRepair runs at most ONE repair attempt with a slim
 *     system prompt and a head+tail-truncated copy of the broken raw
 *     response, so repairing does not double the input length and stays
 *     under output caps. Repair never recurses — a second failure
 *     surfaces both raw responses in the error so the agent can retry
 *     with format=png or surface the issue to the user.
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

// Slim system prompt for the repair attempt. Drops every "house style"
// rule that does not affect parseability, so the model spends its output
// budget on producing valid SVG rather than re-applying typography and
// palette guidance. The first attempt's prompt already covered all of
// that; if the model botched the response, the only thing that matters
// in the retry is "give us back something parseable".
const SVG_REPAIR_SYSTEM_PROMPT = `You are repairing a previous SVG response that failed to parse.
Return ONLY a single valid SVG document wrapped in \`\`\`svg fences — no prose, no commentary, no markdown headings.
Hard requirements:
- Start with <svg ...> and end with </svg>. No <?xml?> declaration.
- Root element MUST have a viewBox attribute.
- Every <marker id="X"> referenced via marker-end="url(#X)" must be defined inside <defs>.
- All tags must be properly nested and closed.
- No <script>, no <foreignObject>, no external href.`

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
 * Build the repair-attempt user message. We only feed back HEAD + TAIL
 * of the broken response (key signals are at the boundaries — preamble
 * prose at the head, truncation point at the tail) plus the parse error.
 * Total upper bound ~2.2k chars regardless of original size, so this
 * never doubles input length on the retry.
 */
function buildRepairUser(
  originalUserPrompt: string,
  brokenRaw: string,
  failureReason: string,
): string {
  const HEAD = 1200
  const TAIL = 400
  const head = brokenRaw.slice(0, HEAD)
  const tail = brokenRaw.length > HEAD + TAIL ? brokenRaw.slice(-TAIL) : ''
  const excerpt = tail
    ? `${head}\n\n[... ${brokenRaw.length - HEAD - TAIL} chars elided ...]\n\n${tail}`
    : head
  return `Your previous response could not be parsed as a valid SVG document.

PARSE FAILURE: ${failureReason}

ORIGINAL REQUEST (unchanged):
${originalUserPrompt}

YOUR BROKEN RESPONSE (head + tail, ${brokenRaw.length} chars total):
${excerpt}

Emit a corrected SVG now. Output ONLY the SVG inside \`\`\`svg fences — no apology, no explanation.`
}

export interface ExtractOk { ok: true; svg: string }
export interface ExtractFail { ok: false; reason: string }
export type ExtractResult = ExtractOk | ExtractFail

/**
 * Pull an <svg>…</svg> block out of arbitrary LLM output. Models often
 * wrap in ```svg fences, sometimes ```xml, occasionally return raw SVG.
 * Anything outside the <svg> element is discarded. Returns a structured
 * result so callers can decide whether to repair or surface the failure.
 */
export function extractSvg(raw: string): ExtractResult {
  const fenceMatch = raw.match(/```(?:svg|xml|html)?\s*([\s\S]*?)```/i)
  const candidate = fenceMatch ? fenceMatch[1] : raw
  const svgMatch = candidate.match(/<svg\b[\s\S]*?<\/svg>/i)
  if (!svgMatch) {
    const hasOpening = /<svg\b/i.test(candidate)
    const reason = hasOpening
      ? 'Found <svg> opening but no matching </svg> close — response likely truncated.'
      : 'No <svg>…</svg> block found in the response.'
    return { ok: false, reason }
  }
  return { ok: true, svg: svgMatch[0].trim() }
}

/**
 * Sanity-check an extracted SVG. Catches the failure modes that surface
 * downstream as silent rendering breakage:
 *   - Missing viewBox → renderer falls back to 100x100 default
 *   - Unmatched marker references → arrows render without arrowheads
 *   - No <text> elements → almost certainly the model gave up on labels
 *   - Tag imbalance → won't parse in DOMParser / cairosvg / browser
 * No XML library — uses regex + a single tag-balance walk. Cheap.
 */
export function validateSvg(svg: string): ExtractResult {
  // 1. viewBox on root <svg>.
  const rootMatch = svg.match(/<svg\b([^>]*)>/i)
  if (!rootMatch) {
    return { ok: false, reason: 'No <svg> root element found after extraction (should be impossible).' }
  }
  if (!/\bviewBox\s*=/i.test(rootMatch[1])) {
    return { ok: false, reason: 'Root <svg> element is missing a viewBox attribute.' }
  }

  // 2. Marker reference closure. Every marker-end="url(#id)" must have
  //    a <marker id="id"> in scope. We don't enforce <defs> location —
  //    some models put markers loose at the top, which still renders.
  const refIds = new Set<string>()
  const refRe = /marker-(?:start|mid|end)\s*=\s*"url\(#([^)"]+)\)"/gi
  let m: RegExpExecArray | null
  while ((m = refRe.exec(svg)) !== null) refIds.add(m[1])
  if (refIds.size > 0) {
    const defIds = new Set<string>()
    const defRe = /<marker\b[^>]*\bid\s*=\s*"([^"]+)"/gi
    while ((m = defRe.exec(svg)) !== null) defIds.add(m[1])
    const missing: string[] = []
    for (const id of refIds) if (!defIds.has(id)) missing.push(id)
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `Marker reference(s) without matching <marker id="…">: ${missing.join(', ')}.`,
      }
    }
  }

  // 3. At least one <text> element. design-guide rule #5: real content,
  //    not placeholders. A label-free SVG is almost always model laziness.
  if (!/<text\b/i.test(svg)) {
    return { ok: false, reason: 'No <text> elements present — diagram has no labels.' }
  }

  // 4. Tag balance. Walk every <tag …>, </tag>, and <tag …/> and ensure
  //    the open/close stack matches. Self-closing tags don't push.
  //    Misses some XML edge cases (CDATA, comments containing "<tag>")
  //    but those are vanishingly rare in LLM-generated SVG and would be
  //    caught by a real parser later anyway.
  const tagRe = /<\s*(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g
  const stack: string[] = []
  while ((m = tagRe.exec(svg)) !== null) {
    const isClose = m[1] === '/'
    const isSelfClosing = m[3] === '/'
    const name = m[2].toLowerCase()
    if (isClose) {
      const top = stack.pop()
      if (top !== name) {
        return {
          ok: false,
          reason: `Tag imbalance: </${name}> at offset ${m.index} does not match the open stack (top=${top ?? 'empty'}).`,
        }
      }
    } else if (!isSelfClosing) {
      stack.push(name)
    }
  }
  if (stack.length > 0) {
    return { ok: false, reason: `Unclosed tag(s) at end of document: ${stack.join(' > ')}.` }
  }

  return { ok: true, svg }
}

export function summariseRawForError(raw: string): string {
  const HEAD = 600
  const TAIL = 200
  const head = raw.slice(0, HEAD).replace(/\s+/g, ' ').trim()
  if (raw.length <= HEAD + TAIL) return `${raw.length} chars: ${head}`
  const tail = raw.slice(-TAIL).replace(/\s+/g, ' ').trim()
  return `${raw.length} chars; head: ${head} … tail: ${tail}`
}

/**
 * Single-attempt extract+validate. Returns the validated SVG string on
 * success, or a structured failure with a reason the repair loop can
 * feed back to the model.
 */
export function tryParseAndValidate(raw: string): ExtractResult {
  const extracted = extractSvg(raw)
  if (!extracted.ok) return extracted
  return validateSvg(extracted.svg)
}

/**
 * Run callLlm and parse. On failure, run ONE repair attempt with the
 * slim system prompt + truncated broken response. If repair also fails,
 * throw with both raw responses summarised so generate-diagram.ts logs
 * something actionable.
 *
 * Why one attempt, not N: each retry costs a full LLM call, and the
 * failure mode "model can't produce valid SVG at all" plateaus after
 * the first repair. Beyond N=1 we are paying for noise.
 */
async function generateWithRepair(
  callLlm: (systemPrompt: string, userContent: string) => Promise<string>,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const firstRaw = await callLlm(systemPrompt, userPrompt)
  const first = tryParseAndValidate(firstRaw)
  if (first.ok) return first.svg

  // Single repair attempt with slim prompt to stay under output caps.
  const repairUser = buildRepairUser(userPrompt, firstRaw, first.reason)
  let secondRaw: string
  try {
    secondRaw = await callLlm(SVG_REPAIR_SYSTEM_PROMPT, repairUser)
  } catch (err) {
    throw new Error(
      `SVG fallback: parse failed and repair call errored. ` +
      `First failure: ${first.reason}. ` +
      `First response: ${summariseRawForError(firstRaw)}. ` +
      `Repair error: ${(err as Error).message}`
    )
  }

  const second = tryParseAndValidate(secondRaw)
  if (second.ok) return second.svg

  throw new Error(
    `SVG fallback: parse failed twice (initial + repair). ` +
    `First failure: ${first.reason}. ` +
    `Initial response: ${summariseRawForError(firstRaw)}. ` +
    `Repair failure: ${second.reason}. ` +
    `Repair response: ${summariseRawForError(secondRaw)}`
  )
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
      const userPrompt = buildGenerationUser(prompt, aspect)
      const svg = await generateWithRepair(callLlm, SVG_SYSTEM_PROMPT, userPrompt)
      return Buffer.from(svg, 'utf-8')
    },

    async imageToImage(prompt: string, image: Buffer): Promise<Buffer> {
      const previousSvg = image.toString('utf-8')
      const userPrompt = buildEditUser(prompt, previousSvg)
      const svg = await generateWithRepair(callLlm, SVG_SYSTEM_PROMPT, userPrompt)
      return Buffer.from(svg, 'utf-8')
    },
  }
}
