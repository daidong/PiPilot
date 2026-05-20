/**
 * App-level retry-with-backoff for transient LLM failures.
 *
 * Why this exists: pi-agent-core does NOT throw when an LLM step fails.
 * It appends a synthetic assistant message with `stopReason: 'error'`
 * (see Agent.handleRunFailure) and resolves the prompt()/continue()
 * promise normally. The underlying Anthropic SDK already retries a 529
 * twice with its own backoff, but a sustained `overloaded_error`
 * outlasts those two attempts and kills the whole turn — which is the
 * bug this fixes (a long agent task dies mid-run on a transient API
 * overload).
 *
 * The retry resumes the turn rather than restarting it: on a transient
 * failure we pop the error placeholder and call `agent.continue()`,
 * which re-runs the loop from the surviving transcript tail (the user
 * message or the last tool-result). That means the user message is not
 * duplicated and already-completed tool calls are not re-executed.
 *
 * Only clearly transient errors are retried. Auth / invalid-request /
 * context-overflow failures fall through immediately so the caller can
 * surface them to the user.
 */

import type { ImageContent } from '@mariozechner/pi-ai'

/** The slice of the pi Agent surface this module touches. */
export interface RetryableAgent {
  prompt(input: string, images?: ImageContent[]): Promise<void>
  continue(): Promise<void>
  state: { messages: Array<{ role?: string; stopReason?: string; errorMessage?: string }> }
}

export interface TransientRetryOptions {
  /** Total attempts including the first. Default 5 (so up to 4 retries). */
  maxAttempts?: number
  /** Base backoff before the first retry, doubled each attempt. Default 2000ms. */
  baseDelayMs?: number
  /** Cap on a single backoff wait. Default 30000ms. */
  maxDelayMs?: number
  /** Override the transient-error classifier (mainly for tests). */
  isTransient?: (message: string) => boolean
  /** Called just before each backoff wait. */
  onRetry?: (info: { attempt: number; nextDelayMs: number; error: string }) => void
  /** Injectable sleep (tests). Should resolve early if isAborted() turns true. */
  sleep?: (ms: number, isAborted?: () => boolean) => Promise<void>
  /** Polled to abort between/within waits (user pressed Stop). */
  isAborted?: () => boolean
  /** Injectable RNG for deterministic jitter in tests. */
  random?: () => number
}

// Substrings/codes that mark a retryable, server- or network-transient
// failure. Matched case-insensitively against the error message.
const TRANSIENT_PATTERNS: RegExp[] = [
  /overloaded/i,
  /\b529\b/,
  /\b503\b/, /service unavailable/i,
  /\b502\b/, /bad gateway/i,
  /\b504\b/, /gateway time-?out/i,
  /\b500\b/, /internal server error/i,
  /\b429\b/, /rate.?limit/i, /too many requests/i,
  /\bECONNRESET\b/i, /\bETIMEDOUT\b/i, /\bECONNREFUSED\b/i,
  /\bEAI_AGAIN\b/i, /\bENETUNREACH\b/i, /\bEHOSTUNREACH\b/i,
  /socket hang ?up/i, /network error/i, /connection error/i,
]

// Hard exclusions — never retry these even if the message also contains
// a transient-looking token. Auth/bad-request/context errors won't fix
// themselves on a retry; retrying just wastes the user's time.
const NON_TRANSIENT_PATTERNS: RegExp[] = [
  /\b400\b/, /\b401\b/, /\b403\b/, /\b404\b/, /\b422\b/,
  /invalid.?api.?key/i, /authentication/i, /unauthorized/i, /permission/i,
  /invalid.?request/i, /not.?found/i,
  /context.?length/i, /maximum context/i, /prompt is too long/i, /max_tokens/i,
]

export function isTransientLlmError(message: string): boolean {
  if (!message) return false
  if (NON_TRANSIENT_PATTERNS.some((re) => re.test(message))) return false
  return TRANSIENT_PATTERNS.some((re) => re.test(message))
}

/**
 * Exponential backoff with equal jitter: wait in [exp/2, exp] where
 * exp = base * 2^(attempt-1), capped at maxDelayMs. `attempt` is 1-based
 * for the first retry.
 */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
  return Math.round(exp * 0.5 + exp * 0.5 * random())
}

async function defaultSleep(ms: number, isAborted?: () => boolean): Promise<void> {
  const step = 200
  let waited = 0
  while (waited < ms) {
    if (isAborted?.()) return
    const chunk = Math.min(step, ms - waited)
    await new Promise((resolve) => setTimeout(resolve, chunk))
    waited += chunk
  }
}

function lastMessage(agent: RetryableAgent) {
  const msgs = agent.state.messages
  return msgs[msgs.length - 1]
}

/**
 * Run one logical agent turn, retrying transient LLM failures with
 * exponential backoff. Resolves once the turn ends in a non-error state,
 * a non-transient error, exhausted attempts, or abort. The final
 * transcript state (success message, or the last error placeholder) is
 * left in `agent.state.messages` for the caller to inspect — exactly as
 * a single `agent.prompt()` would leave it.
 */
export async function runAgentTurnWithRetry(
  agent: RetryableAgent,
  input: string,
  images: ImageContent[] | undefined,
  opts: TransientRetryOptions = {},
): Promise<void> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5)
  const baseDelayMs = opts.baseDelayMs ?? 2_000
  const maxDelayMs = opts.maxDelayMs ?? 30_000
  const isTransient = opts.isTransient ?? isTransientLlmError
  const sleep = opts.sleep ?? defaultSleep
  const random = opts.random ?? Math.random

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt === 1) {
      await agent.prompt(input, images && images.length ? images : undefined)
    } else {
      await agent.continue()
    }

    const last = lastMessage(agent)
    if (!last || last.stopReason !== 'error') return // success or user-aborted

    const errorMessage = last.errorMessage ?? ''
    if (attempt >= maxAttempts) return // exhausted — leave the error for the caller
    if (!isTransient(errorMessage)) return // not worth retrying
    if (opts.isAborted?.()) return // stopped while erroring

    // Back off WITH the error placeholder still in the transcript, so an
    // abort during the wait leaves the real error for the caller to
    // surface (rather than an ambiguous empty tail).
    const nextDelayMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs, random)
    opts.onRetry?.({ attempt, nextDelayMs, error: errorMessage })
    await sleep(nextDelayMs, opts.isAborted)
    if (opts.isAborted?.()) return

    // Committed to retry: drop the error placeholder so the next
    // continue() resumes from the surviving user/tool-result tail.
    agent.state.messages.pop()
  }
}
