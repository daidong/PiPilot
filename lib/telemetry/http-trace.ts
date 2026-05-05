/**
 * HTTP-level tracing for direct fetch() calls (e.g., diagram backends).
 *
 * Spec coverage: §6.2 — every LLM call gets a `chat {model}` span. The
 * diagram-review backends use direct `fetch()` against provider endpoints
 * rather than pi-ai's `completeSimple`, so `tracedCompleteSimple` doesn't
 * apply. This helper wraps a fetch call in an OTel span carrying the same
 * standard GenAI attributes.
 *
 * Usage:
 *   const res = await tracedFetch(url, init, {
 *     spanName: 'chat claude-opus-4-7 (diagram-review)',
 *     genAi: { provider: 'anthropic', requestModel: 'claude-opus-4-7' },
 *     authMode: isOAuth ? 'anthropic-subscription' : 'api-key',
 *   })
 *
 * The span attaches under whatever parent is active (e.g., `execute_tool
 * generate_diagram`), so the call chain reconstructs naturally.
 *
 * When no PipilotTracer has been bootstrapped (CLI, tests, telemetry
 * disabled), this falls through to plain `fetch()` — zero overhead.
 */

import { context, trace, SpanKind, SpanStatusCode, type Attributes } from '@opentelemetry/api'
import { getActiveTracer } from './tracer.js'
import type { GenAiProviderName, PipilotAuthMode } from './semantic-registry.js'

export interface TracedFetchOpts {
  /** Span name. Convention: `chat {model}` or `chat {model} ({purpose})`. */
  spanName: string
  /**
   * GenAI semconv attributes (§6.3). Set what you can; missing fields are
   * skipped rather than emitting empty values.
   */
  genAi?: {
    operation?: 'chat' | 'embeddings' | 'execute_tool'
    provider?: GenAiProviderName
    requestModel?: string
  }
  authMode?: PipilotAuthMode
  /** Optional purpose label echoed in pipilot.span.purpose for filtering. */
  purpose?: string
}

/**
 * Wrap a `fetch` call in a `chat`-kind span. Returns the same Response the
 * underlying fetch returned. Errors propagate; the span records them and
 * sets ERROR status before rethrowing.
 */
export async function tracedFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  opts: TracedFetchOpts
): Promise<Response> {
  const tracer = getActiveTracer()
  if (!tracer) {
    return fetch(input, init)
  }

  const span = tracer.startSpan(opts.spanName, SpanKind.CLIENT, context.active())
  const attrs: Attributes = {
    'gen_ai.operation.name': opts.genAi?.operation ?? 'chat'
  }
  if (opts.genAi?.provider) attrs['gen_ai.provider.name'] = opts.genAi.provider
  if (opts.genAi?.requestModel) attrs['gen_ai.request.model'] = opts.genAi.requestModel
  if (opts.authMode) attrs['pipilot.auth.mode'] = opts.authMode
  span.setAttributes(attrs)

  const ctxWithSpan = trace.setSpan(context.active(), span)
  try {
    const res = await context.with(ctxWithSpan, () => fetch(input, init))
    // HTTP-level outcome → span status. The body may still encode an
    // application-level error; callers can call span events from the wrapper
    // to record those if needed (we don't have access to the parsed body
    // here without consuming the stream).
    if (res.status < 200 || res.status >= 300) {
      span.setAttribute('error.type', `http_${res.status}`)
      span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.status} ${res.statusText}` })
    } else {
      span.setStatus({ code: SpanStatusCode.OK })
    }
    span.end()
    return res
  } catch (err) {
    const e = err as Error
    span.recordException(e)
    span.setAttribute('error.type', e.name || 'Error')
    span.setStatus({ code: SpanStatusCode.ERROR, message: e.message })
    span.end()
    throw err
  }
}

/**
 * Stamp completion-side attributes on the active diagram-review span.
 *
 * Call this AFTER parsing the response body (token usage / verdict / etc.)
 * to attach completion attributes onto the span the surrounding tracedFetch
 * created. Safe to call from outside the original tracedFetch scope — it
 * uses the *currently active* span, which is the parent execute_tool span
 * once tracedFetch has ended its own span.
 *
 * For now we set these via a small helper rather than holding the span
 * across the function boundary.
 */
export function recordReviewCompletion(attrs: {
  responseModel?: string
  inputTokens?: number
  outputTokens?: number
  finishReason?: string
}): void {
  const span = trace.getActiveSpan()
  if (!span) return
  if (attrs.responseModel) span.setAttribute('gen_ai.response.model', attrs.responseModel)
  if (typeof attrs.inputTokens === 'number') span.setAttribute('gen_ai.usage.input_tokens', attrs.inputTokens)
  if (typeof attrs.outputTokens === 'number') span.setAttribute('gen_ai.usage.output_tokens', attrs.outputTokens)
  if (attrs.finishReason) span.setAttribute('gen_ai.response.finish_reasons', [attrs.finishReason])
}
