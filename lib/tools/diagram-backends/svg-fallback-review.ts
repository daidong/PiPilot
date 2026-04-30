/**
 * SVG-via-LLM fallback review provider.
 *
 * Pairs with `svg-fallback-image.ts`. Reviews the SVG *source* as text
 * (since SVG is human-readable markup, visual review is not required
 * for structural checks: missing labels, wrong values, overlapping
 * coordinates, etc.) via the user's currently-selected chat model.
 *
 * Self-grading caveat: in fallback mode the generator and reviewer are
 * typically the same model, so the review is less independent than the
 * real OpenAI/Anthropic review providers. Thresholds are set a touch
 * higher than the API-key providers to counter the resulting leniency.
 */

import type {
  DocType,
  ReviewProvider,
  ReviewRequest,
  ReviewResult,
  ThresholdTable,
  Verdict,
} from './types.js'

// Mildly stricter than the API-key providers to counter self-grading bias.
const FALLBACK_THRESHOLDS: ThresholdTable = {
  journal: 8.7,
  conference: 8.2,
  thesis: 8.2,
  grant: 8.2,
  preprint: 7.7,
  report: 7.7,
  poster: 7.2,
  presentation: 6.7,
  default: 7.7,
}

const REVIEW_SYSTEM_PROMPT = `You are a rigorous reviewer of SVG scientific diagrams. The SVG source is provided; read it as text to evaluate structure, labels, and layout. Use a strict scale: each dimension is 0-2, the total (sum of five) is 0-10, and a total of 9+ is reserved for camera-ready figures.

Score these five dimensions independently. Each is 0, 1, or 2:
  0 = absent / wrong
  1 = present but flawed
  2 = publication-ready

  accuracy — scientific accuracy: concepts, relationships, notation correct
  clarity  — clarity & readability: hierarchy, unambiguous at a glance
  labels   — label quality: complete, legible, consistent
  layout   — layout & composition: balanced, no overlap, logical flow
  style    — house-style adherence (or generic professional appearance when no profile is supplied)

Then set "score" to the sum of the five dimensions (an integer 0-10).

Always respond with exactly one JSON object wrapped in \`\`\`json fences. No prose before or after. Schema:

{
  "accuracy": number,   // 0-2
  "clarity": number,    // 0-2
  "labels": number,     // 0-2
  "layout": number,     // 0-2
  "style": number,      // 0-2
  "score": number,      // 0-10 (sum of the five dimensions above)
  "blockingIssues": [
    {
      "kind": "wrong_content" | "illegible_text" | "layout_collision" | "missing_element" | "style_mismatch",
      "description": string,
      "fix": string             // concrete enough to feed back to the generator
    }
  ],
  "summary": string,
  "verdict": "acceptable" | "needs_edit" | "needs_regen"
}

Verdict rules:
- "acceptable"  if score >= threshold AND blockingIssues is empty
- "needs_edit"  for localised problems (labels, overlaps, styling) fixable by revising the SVG in place
- "needs_regen" for structural or content errors — the diagram must be redrawn`

function buildUser(req: ReviewRequest, threshold: number, svgSource: string): string {
  const houseBlock = req.houseProfileSummary
    ? `\nHOUSE STYLE (figure must belong to this visual system):\n${req.houseProfileSummary}\n\nUnder blockingIssues of kind style_mismatch, call out any deviation from this house style — wrong palette tokens, wrong stroke widths, wrong corner radii, wrong typography voice, broken motifs.\n`
    : ''
  return `Evaluate this diagram for "${req.docType}" publication (acceptance threshold: ${threshold}/10).

DIAGRAM TYPE: ${req.diagramType}
ORIGINAL REQUEST: ${req.prompt}
ITERATION: ${req.iteration}/${req.maxIterations}
${houseBlock}
SVG SOURCE:
\`\`\`svg
${svgSource}
\`\`\`

Respond with the JSON review object only.`
}

function coerceVerdict(raw: unknown): Verdict {
  if (raw === 'acceptable' || raw === 'needs_edit' || raw === 'needs_regen') return raw
  return 'needs_edit'
}

function clampScore(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (Number.isNaN(v)) return 0
  return Math.min(10, Math.max(0, v))
}

function clampDim(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (Number.isNaN(v)) return 0
  return Math.min(2, Math.max(0, v))
}

/**
 * Reconcile the model-supplied total against the sum of five dimensions.
 * If the model left `score` at 0 (or far from the dimension sum), prefer
 * the sum — that's the value the prompt told it to compute, and the only
 * one we can audit field-by-field.
 */
function resolveTotal(score: number, dims: number[]): number {
  const sum = dims.reduce((a, b) => a + b, 0)
  if (sum === 0) return Math.min(10, Math.max(0, score))
  if (score === 0 || Math.abs(score - sum) > 0.5) return Math.min(10, Math.max(0, sum))
  return Math.min(10, Math.max(0, score))
}

/**
 * Extract a JSON object from LLM text. Prefers a fenced ```json block; if
 * not present, picks the first balanced {…} it finds. Returns null when
 * parsing fails so the caller can build a conservative review.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i)
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]) as Record<string, unknown> } catch { /* fall through */ }
  }
  // Fallback: scan for a balanced {...}. Naive but adequate for single-object replies.
  const firstBrace = text.indexOf('{')
  if (firstBrace === -1) return null
  let depth = 0
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(text.slice(firstBrace, i + 1)) as Record<string, unknown> } catch { return null }
      }
    }
  }
  return null
}

export interface SvgFallbackReviewOptions {
  callLlm: (systemPrompt: string, userContent: string) => Promise<string>
  modelLabel?: string
  thresholds?: ThresholdTable
}

export function createSvgFallbackReviewProvider(
  opts: SvgFallbackReviewOptions
): ReviewProvider {
  const { callLlm } = opts
  const modelLabel = opts.modelLabel || 'chat-model'
  const thresholds: ThresholdTable = opts.thresholds ?? FALLBACK_THRESHOLDS

  async function review(req: ReviewRequest): Promise<ReviewResult> {
    const threshold = thresholds[req.docType] ?? thresholds.default
    const svgSource = req.image.toString('utf-8')
    const text = await callLlm(REVIEW_SYSTEM_PROMPT, buildUser(req, threshold, svgSource))
    const parsed = extractJsonObject(text)

    if (!parsed) {
      // Conservative stance: no usable structured output → treat as needs_edit
      // with a synthetic issue so the next iteration at least retries.
      // Synthesize dimension scores just below threshold/5 so the total
      // sits a hair under acceptance — matches the previous semantics.
      const perDim = Math.max(0, Math.min(2, (threshold - 0.5) / 5))
      return {
        score: Math.max(0, threshold - 0.5),
        accuracy: perDim,
        clarity: perDim,
        labels: perDim,
        layout: perDim,
        style: perDim,
        blockingIssues: [{
          kind: 'style_mismatch',
          description: 'Reviewer did not return a parseable structured response.',
          fix: 'Regenerate with clearer composition; ensure all labels are explicit and arrows have markers.',
        }],
        summary: 'Review parse failed — falling back to conservative needs_edit verdict.',
        verdict: 'needs_edit',
      }
    }

    const accuracy = clampDim(parsed.accuracy)
    const clarity = clampDim(parsed.clarity)
    const labels = clampDim(parsed.labels)
    const layout = clampDim(parsed.layout)
    const style = clampDim(parsed.style)
    return {
      score: resolveTotal(clampScore(parsed.score), [accuracy, clarity, labels, layout, style]),
      accuracy,
      clarity,
      labels,
      layout,
      style,
      blockingIssues: Array.isArray(parsed.blockingIssues)
        ? (parsed.blockingIssues as ReviewResult['blockingIssues'])
        : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      verdict: coerceVerdict(parsed.verdict),
    }
  }

  return {
    id: `svg-fallback:${modelLabel}`,
    label: `SVG fallback review (${modelLabel})`,
    thresholds,
    review,
  }
}

export { FALLBACK_THRESHOLDS }
