/**
 * Turn raw LLM provider errors into actionable, human-readable messages —
 * specifically for the case the UI cannot otherwise explain: a Claude
 * *subscription* (OAuth) usage limit.
 *
 * Why this exists: the OpenAI Codex (ChatGPT subscription) provider in pi-ai
 * already detects `usage_limit_reached` / 429 and throws a friendly
 * "You have hit your ChatGPT usage limit (plus plan). Try again in ~22 min."
 * The standard Anthropic provider has NO equivalent — a Claude-subscription
 * usage cap surfaces only as a raw `"429 ... rate_limit_error ..."` SDK string.
 * Worse, that raw string matches `isTransientLlmError` (it contains "429" /
 * "rate limit"), so the coordinator retries it several times with backoff and
 * the turn appears to hang at "thinking" with no explanation.
 *
 * This module gives the coordinator two things:
 *   - `isUsageLimitError()` — so a subscription usage cap can be treated as
 *     NON-transient (surface immediately instead of retrying pointlessly).
 *   - `humanizeLlmError()` — so the surfaced message reads like the ChatGPT
 *     one instead of a raw SDK dump.
 *
 * Scope is deliberately narrow: only `anthropic-subscription` errors are
 * rewritten. API-key 429s are genuine per-minute throughput limits (worth a
 * brief retry — left to the transient-retry layer), and the Codex provider
 * already humanizes ChatGPT-subscription limits itself.
 */

import type { PipilotAuthMode } from '../telemetry/semantic-registry.js'

// Tokens that mark a *quota/usage* limit (the user is out of allowance for the
// current window) as opposed to a momentary server hiccup.
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage[ _]?limit/i,
  /\b429\b/,
  /rate[ _.-]?limit/i,
  /too many requests/i,
  /quota/i,
  /out of credits/i,
  /credit balance/i,
  /insufficient[^.]*credit/i,
]

// Server-/network-transient signals. If the error is one of these it is NOT a
// usage limit even when a stray "429"-looking token appears — retrying may fix
// it, so we leave it to the transient-retry layer.
const TRANSIENT_OVERRIDE_PATTERNS: RegExp[] = [
  /overloaded/i,
  /\b529\b/, /\b500\b/, /\b502\b/, /\b503\b/, /\b504\b/,
  /service unavailable/i, /bad gateway/i, /gateway time-?out/i,
  /internal server error/i,
  /\bECONNRESET\b/i, /\bETIMEDOUT\b/i, /socket hang ?up/i, /network error/i,
]

/**
 * True when the error message indicates the account has exhausted its
 * usage/quota for the current window (vs. a transient server failure).
 */
export function isUsageLimitError(message: string | undefined): boolean {
  if (!message) return false
  if (TRANSIENT_OVERRIDE_PATTERNS.some((re) => re.test(message))) return false
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(message))
}

/**
 * Best-effort extraction of "minutes until the limit resets" from a raw error
 * string. Handles an already-friendly "try again in ~22 min", a numeric
 * `retry-after` (seconds), and an epoch-seconds `resets_at`. Returns null when
 * no reliable hint is present — the caller then omits the "Try again in" clause
 * rather than inventing a number.
 */
export function extractResetMinutes(message: string, now: number = Date.now()): number | null {
  if (!message) return null

  const already = message.match(/try again in ~?\s*(\d+)\s*min/i)
  if (already) return Math.max(0, parseInt(already[1], 10))

  const retryAfter = message.match(/retry[-_ ]?after["'\s:=]+(\d+)/i)
  if (retryAfter) return Math.max(0, Math.round(parseInt(retryAfter[1], 10) / 60))

  const resetsAt = message.match(/resets?[-_ ]?at["'\s:=]+(\d{10})\b/i)
  if (resetsAt) {
    const mins = Math.round((parseInt(resetsAt[1], 10) * 1000 - now) / 60_000)
    return mins > 0 ? mins : null
  }

  return null
}

/**
 * Rewrite a raw provider error into a friendly, actionable message when it is a
 * Claude *subscription* usage limit. Returns null for anything else (caller
 * keeps the original message), so this is safe to call unconditionally.
 */
export function humanizeLlmError(
  message: string | undefined,
  opts: { authMode?: PipilotAuthMode; now?: number } = {},
): string | null {
  // Only Claude subscription. API-key 429s are transient throughput limits;
  // the Codex provider already humanizes ChatGPT-subscription limits.
  if (opts.authMode !== 'anthropic-subscription') return null
  if (!isUsageLimitError(message)) return null

  const mins = extractResetMinutes(message ?? '', opts.now ?? Date.now())
  const when = mins != null ? ` Try again in ~${mins} min.` : ''
  return (
    `You have hit your Claude subscription usage limit.${when} ` +
    `Claude Pro/Max limits reset on a rolling window — wait for the reset, ` +
    `or add an Anthropic API key in Settings → API Keys to keep working now.`
  )
}
