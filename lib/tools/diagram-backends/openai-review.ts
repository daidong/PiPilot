/**
 * OpenAI review backend (vision model with structured output).
 *
 * Uses gpt-4o by default because vision + JSON-schema response_format is
 * broadly supported on that model. Returns a fully-structured ReviewResult
 * so the generator never has to regex natural-language.
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
const DEFAULT_MODEL = 'gpt-4o'
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
Rate on a strict scale — 9+ is reserved for camera-ready figures. Return only valid JSON matching the schema. Be specific: every blocking_issue must describe exactly what is wrong AND a concrete fix another tool can act on.`

function buildUserPrompt(req: ReviewRequest, threshold: number): string {
  const houseBlock = req.houseProfileSummary
    ? `HOUSE STYLE (the figure must belong to this visual system):
${req.houseProfileSummary}

`
    : ''
  const fifthDimension = req.houseProfileSummary
    ? '5. House-style adherence & consistency — matches the supplied palette, typography voice, geometry tokens, and motifs; feels like a sibling of other figures in the same system'
    : '5. Professional appearance — publication-ready polish'
  return `Evaluate this diagram for "${req.docType}" publication (acceptance threshold: ${threshold}/10).

DIAGRAM TYPE: ${req.diagramType}
ORIGINAL REQUEST: ${req.prompt}
ITERATION: ${req.iteration}/${req.maxIterations}
${houseBlock}
Score five dimensions independently (0-2 each, total 0-10):
  1. Scientific accuracy — concepts, relationships, notation correct
  2. Clarity & readability — hierarchy, unambiguous at a glance
  3. Label quality — complete, legible, consistent
  4. Layout & composition — balanced, no overlap, logical flow
  ${fifthDimension}

For every issue that blocks acceptance, emit an entry in blocking_issues with:
  - kind: wrong_content | illegible_text | layout_collision | missing_element | style_mismatch
  - description: what is wrong (call out house-style deviations under style_mismatch — wrong palette role, wrong corner radius, wrong typography voice, broken motif, etc.)
  - fix: precise instruction to correct it (will be fed to an image editor)

Choose verdict:
  - "acceptable" if score >= ${threshold} and no blocking_issues
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

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'requestAlignment', 'legibility', 'blockingIssues', 'summary', 'verdict'],
  properties: {
    score: { type: 'number' },
    requestAlignment: { type: 'number' },
    legibility: { type: 'number' },
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
      const result: ReviewResult = {
        score: clampScore(parsed.score),
        requestAlignment: clampScore(parsed.requestAlignment),
        legibility: clampScore(parsed.legibility),
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
