/**
 * PNG → editable-SVG transcription.
 *
 * Used by the PNG-anchored SVG path: a finalized PNG diagram (already
 * shaped by gpt-image-2 + the verdict-driven review loop) is handed to
 * a vision-capable chat model which re-emits it as semantic SVG markup —
 * <rect> for boxes, <text> for labels (verbatim), <line>/<path> with
 * markers for arrows. The PNG remains the visual ground truth; the SVG
 * is its editable copy for users who want to tweak in Inkscape / draw.io
 * or embed in LaTeX.
 *
 * Design choices:
 *   - Single LLM call + at most ONE repair attempt. SVG quality is
 *     bounded by the vision model's structural transcription accuracy,
 *     not by self-review iterations (which cannot fix layout drift the
 *     transcriber introduced because the model can't see its own SVG
 *     rendered against the PNG without an extra pass we deliberately
 *     skip in v0).
 *   - No house-style enforcement here. The PNG already encodes the
 *     palette / typography / corner radii — the transcriber's job is
 *     to mirror what is there, not to redesign.
 *   - Reuses extractSvg / validateSvg / repair scaffolding from
 *     svg-fallback-image.ts so structural sanity (well-formedness,
 *     viewBox, marker closure, label presence) is enforced on
 *     transcription output too.
 *
 * Capability gate: caller must verify the model accepts image input
 * before invoking this. The registry handles that gate.
 */

import {
  tryParseAndValidate,
  summariseRawForError,
} from './svg-fallback-image.js'

export interface PngToSvgTranscriberOptions {
  callLlmVision: (
    systemPrompt: string,
    userContent: string,
    images: Array<{ base64: string; mimeType: string }>,
  ) => Promise<string>
  /** Short label for logs / provider.id — typically the chat model name. */
  modelLabel?: string
}

export interface TranscribeRequest {
  png: Buffer
  /** Hint for the SVG viewBox; transcriber matches the PNG aspect within ±10%. */
  viewBoxHint?: string
  /**
   * Optional textual context about the original prompt. Helps the
   * transcriber resolve ambiguous text (e.g. mathematical symbols
   * vs. similar-looking glyphs in low-resolution PNGs).
   */
  originalPromptHint?: string
}

const TRANSCRIPTION_SYSTEM_PROMPT = `You transcribe a finalized scientific diagram (provided as a PNG image) into clean, editable SVG markup.

The PNG is the ground truth. Your job is to produce SVG that, when rendered, is a faithful structural copy — NOT to redesign, improve, or "polish" anything.

Output rules (strict):
- Output ONLY a single SVG document wrapped in \`\`\`svg fences. No prose, no apology, no commentary.
- Start directly with <svg viewBox="…" xmlns="http://www.w3.org/2000/svg">. No <?xml?> declaration. No width/height attributes on root.
- Use only these elements: svg, defs, marker, g, rect, circle, ellipse, line, path, polyline, polygon, text, tspan, title, desc.
- No <script>, no <foreignObject>, no external href, no embedded base64 images.
- No filters, no gradients, no blur, no drop-shadow.

Transcription requirements:
- For every box you see → emit one <rect> at approximately the same position and size (drift up to ~20px is acceptable).
- For every label you see → emit one <text> with the label VERBATIM. Never paraphrase, never abbreviate, never translate.
- For every arrow you see → emit one <line>, <polyline>, or <path> with marker-end referencing a <marker> in <defs>.
- Sample dominant colors from the PNG and use them directly as fill/stroke values (hex codes).
- Match the rough rounded-corner radius you observe (sharp = 0, slightly rounded = 6-8, very rounded = 12+).
- Preserve grouping: dashed-bordered containers in the PNG → <rect> with stroke-dasharray.

Hard prohibitions:
- Do NOT add labels, captions, legends, watermarks, or any element not visible in the PNG.
- Do NOT redesign the layout, change the topology, or "fix" perceived issues.
- Do NOT include figure numbers or titles ("Figure 1: …").
- Do NOT use placeholder text like "Lorem ipsum" or "[Label]".

Position drift up to ~20px is acceptable. Missing labels, paraphrased text, or invented elements are NOT.`

const REPAIR_SYSTEM_PROMPT = `You are repairing a previous SVG transcription that failed to parse.
Return ONLY a single valid SVG document wrapped in \`\`\`svg fences — no prose.
Hard requirements:
- Start with <svg ...> and end with </svg>. No <?xml?> declaration.
- Root MUST have a viewBox attribute.
- Every <marker id="X"> referenced via marker-end="url(#X)" must be defined inside <defs>.
- All tags properly nested and closed.
- Preserve every <text> element verbatim from the original PNG content — do not drop labels.`

function buildTranscriptionUser(req: TranscribeRequest): string {
  const lines: string[] = []
  lines.push('Transcribe the attached PNG diagram into editable SVG.')
  lines.push('')
  if (req.viewBoxHint) {
    lines.push(`VIEWBOX HINT: ${req.viewBoxHint}`)
    lines.push('  - Match the PNG aspect ratio within ±10%.')
    lines.push('  - Do NOT flip orientation.')
    lines.push('')
  }
  if (req.originalPromptHint) {
    lines.push('ORIGINAL DIAGRAM REQUEST (for disambiguating any unclear labels):')
    lines.push(req.originalPromptHint)
    lines.push('')
  }
  lines.push('Emit the SVG now. Output ONLY the SVG inside ```svg fences.')
  return lines.join('\n')
}

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
  return `Your previous SVG transcription could not be parsed.

PARSE FAILURE: ${failureReason}

ORIGINAL REQUEST (unchanged):
${originalUserPrompt}

YOUR BROKEN RESPONSE (head + tail, ${brokenRaw.length} chars total):
${excerpt}

Re-transcribe the attached PNG into a corrected SVG. The PNG is unchanged — produce a faithful structural copy. Output ONLY the SVG inside \`\`\`svg fences.`
}

export interface TranscriptionResult {
  svg: string
  /** True if the first attempt failed and a repair pass produced the final SVG. */
  repaired: boolean
  /** Failure reason from the first pass (only present when `repaired` is true). */
  firstAttemptFailure?: string
}

/**
 * Transcribe a PNG into editable SVG via vision LLM. Single attempt +
 * one repair retry on validation failure. Throws if both fail; the
 * error includes truncated raw responses from both attempts.
 */
export async function transcribePngToSvg(
  opts: PngToSvgTranscriberOptions,
  req: TranscribeRequest,
): Promise<TranscriptionResult> {
  const image = {
    base64: req.png.toString('base64'),
    mimeType: 'image/png',
  }
  const userPrompt = buildTranscriptionUser(req)

  const firstRaw = await opts.callLlmVision(
    TRANSCRIPTION_SYSTEM_PROMPT,
    userPrompt,
    [image],
  )
  const first = tryParseAndValidate(firstRaw)
  if (first.ok) {
    return { svg: first.svg, repaired: false }
  }

  // Single repair pass — slim system prompt + truncated broken response,
  // PNG re-attached so the model can still see ground truth.
  const repairUser = buildRepairUser(userPrompt, firstRaw, first.reason)
  let secondRaw: string
  try {
    secondRaw = await opts.callLlmVision(
      REPAIR_SYSTEM_PROMPT,
      repairUser,
      [image],
    )
  } catch (err) {
    throw new Error(
      `PNG-to-SVG transcription: parse failed and repair call errored. ` +
      `First failure: ${first.reason}. ` +
      `First response: ${summariseRawForError(firstRaw)}. ` +
      `Repair error: ${(err as Error).message}`
    )
  }

  const second = tryParseAndValidate(secondRaw)
  if (second.ok) {
    return { svg: second.svg, repaired: true, firstAttemptFailure: first.reason }
  }

  throw new Error(
    `PNG-to-SVG transcription: parse failed twice (initial + repair). ` +
    `First failure: ${first.reason}. ` +
    `Initial response: ${summariseRawForError(firstRaw)}. ` +
    `Repair failure: ${second.reason}. ` +
    `Repair response: ${summariseRawForError(secondRaw)}`
  )
}
