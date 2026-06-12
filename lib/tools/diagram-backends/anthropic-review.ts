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
import { tracedFetch, recordReviewCompletion } from '../../telemetry/http-trace.js'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
// Keep in sync with lib/models.ts:MODEL_TIERS.anthropic.flagship
const DEFAULT_MODEL = 'claude-opus-4-8'
const ANTHROPIC_VERSION = '2023-06-01'
const REQUEST_TIMEOUT_MS = 180_000
// Five structured dimensions + an enumerated blockingIssues array can
// blow past 2 048 output tokens once the model emits more than 2-3
// non-trivial issues. Truncation manifested as an empty tool_use.input,
// which the old fallback path silently coerced into a fake "needs_edit"
// verdict with score 0/0/0 and empty blockingIssues — the exact garbage
// payload that wasted two image-edit iterations per figure.
const MAX_TOKENS = 4096

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
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string; type?: string }
}

const REQUIRED_REVIEW_FIELDS = [
  'score',
  'requestAlignment',
  'legibility',
  'blockingIssues',
  'summary',
  'verdict',
] as const

// Strict verdict coercion. Rejects unknown / missing values so the caller
// sees a real parse error instead of inheriting a default verdict — the
// previous default-to-`needs_edit` behaviour silently turned every empty
// tool_use.input into a fake review and burned a second image-edit
// iteration with no actionable feedback.
function strictVerdict(raw: unknown): Verdict {
  if (raw === 'acceptable' || raw === 'needs_edit' || raw === 'needs_regen') return raw
  throw new Error(
    `Claude review returned an invalid verdict (${JSON.stringify(raw)}). ` +
    `Expected one of acceptable | needs_edit | needs_regen.`
  )
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
    const requestModel = String(body.model ?? DEFAULT_MODEL)
    const res = await tracedFetch(
      MESSAGES_URL,
      {
        method: 'POST',
        headers: buildHeaders(token, isOAuth),
        body: JSON.stringify(body),
        signal: ctl.signal,
      },
      {
        spanName: `chat ${requestModel} (diagram-review)`,
        genAi: { operation: 'chat', provider: 'anthropic', requestModel },
        authMode: isOAuth ? 'anthropic-subscription' : 'api-key',
        purpose: 'diagram-review'
      }
    )
    const json = (await res.json()) as AnthropicMessagesResponse
    // Stamp usage onto the parent execute_tool span (the chat span has
    // already ended by the time we parse the body — the active span at this
    // point is the surrounding diagram tool's execute_tool span).
    if (json.usage) {
      recordReviewCompletion({
        inputTokens: json.usage.input_tokens,
        outputTokens: json.usage.output_tokens,
        finishReason: json.stop_reason,
        responseModel: requestModel
      })
    }
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

    // The endpoint can return 200 OK with a truncated response when the
    // model hits max_tokens mid-tool-call. tool_use exists but its input
    // is empty / partial. Surface this as a hard error so the caller
    // doesn't run another image-edit loop on an empty review.
    if (json.stop_reason === 'max_tokens') {
      const out = json.usage?.output_tokens ?? 'unknown'
      throw new Error(
        `Claude review hit max_tokens before emitting a complete tool call ` +
        `(output_tokens=${out}, MAX_TOKENS=${MAX_TOKENS}). The tool_use payload is incomplete.`
      )
    }

    const toolUse = json.content?.find(
      (c): c is Extract<typeof c, { type: 'tool_use' }> =>
        c.type === 'tool_use' && c.name === 'emit_review'
    )
    if (!toolUse) {
      throw new Error('Claude review did not emit the expected tool_use block')
    }

    const input = toolUse.input ?? {}
    const missing = REQUIRED_REVIEW_FIELDS.filter(
      (k) => !(k in input)
    )
    if (missing.length > 0) {
      // Empty / partial tool_use.input. Most commonly caused by max_tokens
      // truncation that didn't get caught by the stop_reason check (e.g.
      // when the API doesn't emit stop_reason on the older beta), or by
      // the model emitting a malformed tool call. Either way, treat as
      // a real failure rather than fabricating a default review.
      throw new Error(
        `Claude review tool_use payload is missing required fields: ${missing.join(', ')}. ` +
        `Received keys: ${Object.keys(input).join(', ') || '(none)'}. stop_reason=${json.stop_reason ?? 'unknown'}.`
      )
    }

    const result: ReviewResult = {
      score: clampScore(input.score),
      requestAlignment: clampScore(input.requestAlignment),
      legibility: clampScore(input.legibility),
      blockingIssues: Array.isArray(input.blockingIssues)
        ? (input.blockingIssues as ReviewResult['blockingIssues'])
        : [],
      summary: typeof input.summary === 'string' ? input.summary : '',
      verdict: strictVerdict(input.verdict),
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
