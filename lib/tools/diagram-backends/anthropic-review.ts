/**
 * Anthropic (Claude) review backend.
 *
 * Claude has no JSON-schema response_format, so we use tool_use with
 * tool_choice=required to force a structured output shaped identically
 * to the OpenAI reviewer. The consumer can therefore swap reviewers
 * without changing downstream logic.
 */

import type {
  ReviewProvider,
  ReviewRequest,
  ReviewResult,
  ThresholdTable,
  Verdict,
} from './types.js'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-opus-4-5'
const ANTHROPIC_VERSION = '2023-06-01'
const REQUEST_TIMEOUT_MS = 180_000
const MAX_TOKENS = 2048

// Claude reviewers tend to run slightly warmer than OpenAI on the same
// image; thresholds are set a touch higher to compensate. Initial values —
// calibrate from real review logs before trusting cross-reviewer comparisons.
const ANTHROPIC_THRESHOLDS: ThresholdTable = {
  journal: 8.5,
  conference: 8.0,
  thesis: 8.0,
  grant: 8.0,
  preprint: 7.5,
  report: 7.5,
  poster: 7.0,
  presentation: 6.5,
  default: 7.5,
}

const REVIEW_SYSTEM = `You are a rigorous reviewer for scientific publication-grade diagrams.
Rate on a strict scale — 9+ is reserved for camera-ready figures. Always emit your answer by calling the emit_review tool. Every blocking_issue must describe what is wrong AND a concrete fix another tool can act on.`

function buildUserText(req: ReviewRequest, threshold: number): string {
  return `Evaluate this diagram for "${req.docType}" publication (acceptance threshold: ${threshold}/10).

DIAGRAM TYPE: ${req.diagramType}
ORIGINAL REQUEST: ${req.prompt}
ITERATION: ${req.iteration}/${req.maxIterations}

Score five dimensions (0-2 each, total 0-10): scientific accuracy, clarity & readability, label quality, layout & composition, professional appearance.

Choose verdict:
  - "acceptable"  if score >= ${threshold} and no blocking_issues
  - "needs_edit"  if problems are localised (labels, overlaps, styling) — image-to-image can fix them
  - "needs_regen" if content is wrong or structure is broken — must redraw

Call emit_review once with your structured verdict.`
}

const EMIT_REVIEW_TOOL = {
  name: 'emit_review',
  description: 'Emit the structured review verdict for the diagram.',
  input_schema: {
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
  },
}

interface AnthropicMessagesResponse {
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  >
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

export interface AnthropicReviewProviderOptions {
  apiKey?: string
  model?: string
  thresholds?: ThresholdTable
}

export function createAnthropicReviewProvider(
  opts: AnthropicReviewProviderOptions = {}
): ReviewProvider {
  const apiKeyRaw = opts.apiKey ?? process.env.ANTHROPIC_API_KEY?.trim()
  if (!apiKeyRaw) {
    throw new Error('ANTHROPIC_API_KEY is required for Claude-based review.')
  }
  const apiKey: string = apiKeyRaw
  const model = opts.model || DEFAULT_MODEL
  const thresholds: ThresholdTable = opts.thresholds ?? ANTHROPIC_THRESHOLDS

  async function review(req: ReviewRequest): Promise<ReviewResult> {
    const threshold = thresholds[req.docType] ?? thresholds.default
    const b64 = req.image.toString('base64')

    const body = {
      model,
      max_tokens: MAX_TOKENS,
      system: REVIEW_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: b64 },
            },
            { type: 'text', text: buildUserText(req, threshold) },
          ],
        },
      ],
      tools: [EMIT_REVIEW_TOOL],
      tool_choice: { type: 'tool', name: 'emit_review' },
    }

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(MESSAGES_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
      const json = (await res.json()) as AnthropicMessagesResponse
      if (!res.ok) {
        throw new Error(`Anthropic review API error: ${json.error?.message || `HTTP ${res.status}`}`)
      }

      const toolUse = json.content?.find((c): c is Extract<typeof c, { type: 'tool_use' }> => c.type === 'tool_use' && c.name === 'emit_review')
      if (!toolUse) {
        throw new Error('Claude review did not emit the expected tool_use block')
      }

      const input = toolUse.input
      const result: ReviewResult = {
        score: clampScore(input.score),
        requestAlignment: clampScore(input.requestAlignment),
        legibility: clampScore(input.legibility),
        blockingIssues: Array.isArray(input.blockingIssues)
          ? (input.blockingIssues as ReviewResult['blockingIssues'])
          : [],
        summary: typeof input.summary === 'string' ? input.summary : '',
        verdict: coerceVerdict(input.verdict),
      }
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    id: `anthropic:${model}`,
    label: `Anthropic ${model}`,
    thresholds,
    review,
  }
}
