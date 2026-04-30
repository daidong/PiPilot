/**
 * OpenAI review backend (vision model with structured output).
 *
 * Uses GPT-5.5 by default — supports image input, structured outputs, and
 * JSON-schema response_format. Returns a fully-structured ReviewResult so the
 * generator never has to regex natural-language.
 */

import type {
  DiagramType,
  DocType,
  ReviewProvider,
  ReviewRequest,
  ReviewResult,
  ThresholdTable,
  Verdict,
} from './types.js'

const CHAT_URL = 'https://api.openai.com/v1/chat/completions'
// Keep in sync with lib/models.ts:MODEL_TIERS.openai.flagship
const DEFAULT_MODEL = 'gpt-5.5'
const REQUEST_TIMEOUT_MS = 180_000

// OpenAI reviewers tend to be slightly harsher than Claude on layout quality,
// so thresholds are set 0.0–0.3 below canonical expectations. Values are
// initial defaults — treat them as a starting point, not calibrated truth.
const OPENAI_THRESHOLDS: ThresholdTable = {
  journal: 8.3,
  conference: 7.8,
  thesis: 7.8,
  grant: 7.8,
  preprint: 7.3,
  report: 7.3,
  poster: 6.8,
  presentation: 6.3,
  default: 7.3,
}

const REVIEW_SYSTEM = `You are a rigorous reviewer for scientific publication-grade diagrams.
Rate on a strict scale: each dimension is 0-2, the total (sum of five) is 0-10, and a total of 9+ is reserved for camera-ready figures. Return only valid JSON matching the schema. Be specific: every blocking_issue must describe exactly what is wrong AND a concrete fix another tool can act on.`

function buildUserPrompt(req: ReviewRequest, threshold: number): string {
  const houseBlock = req.houseProfileSummary
    ? `HOUSE STYLE (the figure must belong to this visual system):
${req.houseProfileSummary}

`
    : ''
  const styleDimension = req.houseProfileSummary
    ? 'style    — house-style adherence & consistency: matches the supplied palette, typography voice, geometry tokens, and motifs; feels like a sibling of other figures in the same system'
    : 'style    — professional appearance: publication-ready polish'
  return `Evaluate this diagram for "${req.docType}" publication (acceptance threshold: ${threshold}/10 total).

DIAGRAM TYPE: ${req.diagramType}
ORIGINAL REQUEST: ${req.prompt}
ITERATION: ${req.iteration}/${req.maxIterations}
${houseBlock}
Score these five dimensions independently. Each is 0, 1, or 2:
  0 = absent / wrong
  1 = present but flawed
  2 = publication-ready

  accuracy — scientific accuracy: concepts, relationships, notation correct
  clarity  — clarity & readability: hierarchy, unambiguous at a glance
  labels   — label quality: complete, legible, consistent
  layout   — layout & composition: balanced, no overlap, logical flow
  ${styleDimension}

Then set "score" to the sum of the five dimensions (an integer 0-10).

For every issue that blocks acceptance, emit an entry in blockingIssues with:
  - kind: wrong_content | illegible_text | layout_collision | missing_element | style_mismatch
  - description: what is wrong (call out house-style deviations under style_mismatch — wrong palette role, wrong corner radius, wrong typography voice, broken motif, etc.)
  - fix: precise instruction to correct it (will be fed to an image editor)

Choose verdict:
  - "acceptable" if score >= ${threshold} and no blockingIssues
  - "needs_edit" if problems are localised/cosmetic (labels, overlaps, styling) — image-to-image editing can fix them
  - "needs_regen" if content is wrong or structure is broken — the image must be redrawn`

}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
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
 * Reconcile the model-supplied total against the sum of the five
 * dimensions. If the model emitted dimensions that disagree with `score`
 * (typically because it forgot to fill `score` and left it at 0), prefer
 * the dimension sum — that is the value the prompt told the model to
 * compute, and the only one we can audit field-by-field.
 */
function resolveTotal(score: number, dims: number[]): number {
  const sum = dims.reduce((a, b) => a + b, 0)
  if (sum === 0) return Math.min(10, Math.max(0, score))
  if (score === 0 || Math.abs(score - sum) > 0.5) return Math.min(10, Math.max(0, sum))
  return Math.min(10, Math.max(0, score))
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'accuracy', 'clarity', 'labels', 'layout', 'style',
    'score', 'blockingIssues', 'summary', 'verdict',
  ],
  properties: {
    accuracy: { type: 'number' },
    clarity: { type: 'number' },
    labels: { type: 'number' },
    layout: { type: 'number' },
    style: { type: 'number' },
    score: { type: 'number' },
    blockingIssues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'description', 'fix'],
        properties: {
          kind: {
            type: 'string',
            enum: ['wrong_content', 'illegible_text', 'layout_collision', 'missing_element', 'style_mismatch'],
          },
          description: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
    verdict: {
      type: 'string',
      enum: ['acceptable', 'needs_edit', 'needs_regen'],
    },
  },
}

export interface OpenAIReviewProviderOptions {
  apiKey?: string
  model?: string
  thresholds?: ThresholdTable
}

export function createOpenAIReviewProvider(
  opts: OpenAIReviewProviderOptions = {}
): ReviewProvider {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for OpenAI-based review.')
  }
  const model = opts.model || DEFAULT_MODEL
  const thresholds: ThresholdTable = opts.thresholds ?? OPENAI_THRESHOLDS

  async function review(req: ReviewRequest): Promise<ReviewResult> {
    const threshold = thresholds[req.docType] ?? thresholds.default
    const b64 = req.image.toString('base64')
    const dataUri = `data:image/png;base64,${b64}`

    const body = {
      model,
      messages: [
        { role: 'system', content: REVIEW_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildUserPrompt(req, threshold) },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'DiagramReview', strict: true, schema: RESPONSE_SCHEMA },
      },
      temperature: 0,
    }

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
      const json = (await res.json()) as ChatCompletionResponse
      if (!res.ok) {
        throw new Error(`OpenAI review API error: ${json.error?.message || `HTTP ${res.status}`}`)
      }

      const content = json.choices?.[0]?.message?.content ?? ''
      if (!content) throw new Error('OpenAI review returned empty content')

      const parsed = JSON.parse(content) as Record<string, unknown>
      const accuracy = clampDim(parsed.accuracy)
      const clarity = clampDim(parsed.clarity)
      const labels = clampDim(parsed.labels)
      const layout = clampDim(parsed.layout)
      const style = clampDim(parsed.style)
      const result: ReviewResult = {
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
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    id: `openai:${model}`,
    label: `OpenAI ${model}`,
    thresholds,
    review,
  }
}

export function resolveOpenAIThreshold(table: ThresholdTable, docType: DocType): number {
  return table[docType] ?? table.default
}
