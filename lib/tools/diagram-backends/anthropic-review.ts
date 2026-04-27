/**
 * Anthropic (Claude) review backend.
 *
 * Supports two auth modes, selected by the caller:
 *   - API key     (`x-api-key` header)
 *   - OAuth token (`Authorization: Bearer …`, used for Claude Pro/Max
 *                  subscriptions — token starts with `sk-ant-oat…`)
 *
 * OAuth mode requires Anthropic's Claude Code identity envelope:
 *   - `anthropic-beta: claude-code-20250219,oauth-2025-04-20,…`
 *   - system message MUST begin with the Claude Code identity string
 * Otherwise the API responds 403. The logic mirrors what pi-ai does
 * internally for anthropic-sub sessions (see node_modules/@mariozechner/
 * pi-ai/dist/providers/anthropic.js:438-454).
 *
 * Structured output shape is identical to the OpenAI review provider so
 * downstream code never has to branch on reviewer identity.
 */

import type {
  ReviewProvider,
  ReviewRequest,
  ReviewResult,
  ThresholdTable,
  Verdict,
} from './types.js'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
// Keep in sync with lib/models.ts:MODEL_TIERS.anthropic.flagship
const DEFAULT_MODEL = 'claude-opus-4-7'
const ANTHROPIC_VERSION = '2023-06-01'
const REQUEST_TIMEOUT_MS = 180_000
const MAX_TOKENS = 2048

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const BETA_API_KEY = 'fine-grained-tool-streaming-2025-05-14'
const BETA_OAUTH = `claude-code-20250219,oauth-2025-04-20,${BETA_API_KEY}`

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
  const houseBlock = req.houseProfileSummary
    ? `\nHOUSE STYLE (figure must belong to this visual system):\n${req.houseProfileSummary}\n`
    : ''
  const fifthDimension = req.houseProfileSummary
    ? 'house-style adherence & consistency'
    : 'professional appearance'
  return `Evaluate this diagram for "${req.docType}" publication (acceptance threshold: ${threshold}/10).

DIAGRAM TYPE: ${req.diagramType}
ORIGINAL REQUEST: ${req.prompt}
ITERATION: ${req.iteration}/${req.maxIterations}
${houseBlock}
Score five dimensions (0-2 each, total 0-10): scientific accuracy, clarity & readability, label quality, layout & composition, ${fifthDimension}.

When scoring dimension 5, compare against the HOUSE STYLE block above — wrong palette roles, wrong corner radius, wrong typography voice, or broken motifs are all style_mismatch blocking issues.

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
  error?: { message?: string; type?: string }
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

function isOAuthAccessToken(token: string): boolean {
  return token.startsWith('sk-ant-oat')
}

function buildHeaders(token: string, isOAuth: boolean): Record<string, string> {
  const common: Record<string, string> = {
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
  }
  if (isOAuth) {
    return {
      ...common,
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': BETA_OAUTH,
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'claude-cli/research-copilot',
      'x-app': 'cli',
    }
  }
  return {
    ...common,
    'x-api-key': token,
    'anthropic-beta': BETA_API_KEY,
  }
}

function buildRequestBody(req: ReviewRequest, threshold: number, isOAuth: boolean): Record<string, unknown> {
  const b64 = req.image.toString('base64')

  // OAuth mode requires the Claude Code identity as the first system block.
  // Pi-ai does this unconditionally (anthropic.js:476-492); skipping it
  // yields 403 "system prompt must start with Claude Code identity".
  const systemBlocks: Array<Record<string, unknown>> = []
  if (isOAuth) {
    systemBlocks.push({ type: 'text', text: CLAUDE_CODE_IDENTITY })
  }
  systemBlocks.push({ type: 'text', text: REVIEW_SYSTEM })

  return {
    model: DEFAULT_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemBlocks,
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
}

async function doRequest(
  token: string,
  isOAuth: boolean,
  body: Record<string, unknown>
): Promise<{ status: number; json: AnthropicMessagesResponse }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: buildHeaders(token, isOAuth),
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    const json = (await res.json()) as AnthropicMessagesResponse
    return { status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

export interface AnthropicReviewProviderOptions {
  /** Either an API key or an OAuth access token (sk-ant-oat…). */
  token?: string
  /** Force OAuth handling; autodetected from token prefix when omitted. */
  isOAuth?: boolean
  /** One-shot refresh callback invoked on 401 when the token is expired. */
  refreshToken?: () => Promise<string>
  model?: string
  thresholds?: ThresholdTable
}

export function createAnthropicReviewProvider(
  opts: AnthropicReviewProviderOptions = {}
): ReviewProvider {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim()
  const initialTokenRaw = opts.token ?? envKey
  if (!initialTokenRaw) {
    throw new Error('ANTHROPIC_API_KEY or an anthropic-sub OAuth token is required for Claude-based review.')
  }
  // Mutable so a refresh can substitute a fresh token.
  let currentToken: string = initialTokenRaw
  const isOAuth = opts.isOAuth ?? isOAuthAccessToken(currentToken)
  const refreshToken = opts.refreshToken
  const model = opts.model || DEFAULT_MODEL
  const thresholds: ThresholdTable = opts.thresholds ?? ANTHROPIC_THRESHOLDS

  async function review(req: ReviewRequest): Promise<ReviewResult> {
    const threshold = thresholds[req.docType] ?? thresholds.default
    const body = buildRequestBody(req, threshold, isOAuth)
    if (model !== DEFAULT_MODEL) {
      body.model = model
    }

    let { status, json } = await doRequest(currentToken, isOAuth, body)

    // OAuth tokens expire; refresh once on 401 when we have a refresher.
    if (status === 401 && isOAuth && refreshToken) {
      try {
        currentToken = await refreshToken()
        ;({ status, json } = await doRequest(currentToken, isOAuth, body))
      } catch (err) {
        throw new Error(`Anthropic OAuth token refresh failed: ${(err as Error).message}`)
      }
    }

    if (status < 200 || status >= 300) {
      throw new Error(`Anthropic review API error (HTTP ${status}): ${json.error?.message || 'unknown'}`)
    }

    const toolUse = json.content?.find(
      (c): c is Extract<typeof c, { type: 'tool_use' }> =>
        c.type === 'tool_use' && c.name === 'emit_review'
    )
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
  }

  return {
    id: `anthropic:${model}${isOAuth ? ':oauth' : ':api-key'}`,
    label: `Anthropic ${model}${isOAuth ? ' (subscription)' : ''}`,
    thresholds,
    review,
  }
}
