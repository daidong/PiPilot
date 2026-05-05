/**
 * `tracedCompleteSimple` — wraps pi-ai's `completeSimple` with an OTel `chat` span,
 * standard GenAI semconv attributes, the `gen_ai.client.inference.operation.details`
 * event, and PiPilot redaction (§5, §6.2, §6.3, §6.9).
 *
 * Single helper covers all 8 sub-LLM blind spots enumerated in §2.2. P0 ships the
 * signature + pass-through implementation; P1 wires it into:
 *   - `lib/agents/coordinator.ts:410` (callLlm)
 *   - `lib/agents/coordinator.ts:425` (callLlmVision)
 *   - `lib/agents/coordinator.ts:100` (matchSkillsWithLLM)
 *   - `lib/agents/coordinator.ts:687` (intent router)
 *   - `lib/agents/coordinator.ts:580` (transformContext / generateSummary)
 *   - `lib/memory/extractor.ts:148` (maybeExtractMemories)
 *   - `app/src/main/ipc.ts:917` (wiki background agent)
 *   - diagram backend direct fetch
 */

import { context, trace, SpanKind, SpanStatusCode, type Context, type Span, type Attributes } from '@opentelemetry/api'
import type { AssistantMessage, Context as PiContext, Model, SimpleStreamOptions } from '@mariozechner/pi-ai'
import { completeSimple } from '@mariozechner/pi-ai'
import type { PipilotTracer } from './tracer.js'
import { redact, SCRUBBER_VERSION } from './redaction.js'
import {
  GEN_AI_PROVIDER_NAMES,
  type GenAiProviderName,
  type PipilotAuthMode
} from './semantic-registry.js'

export interface TracedCompleteSimpleOpts {
  /** Required: tracer to emit spans on. */
  tracer: PipilotTracer
  /** Optional: explicit parent context override (e.g., wiki bg with no async parent). */
  parent?: Context
  /**
   * PiPilot auth mode (`pipilot.auth.mode`). P0 leaves this caller-supplied; P1 will
   * pull it from the coordinator's resolved auth mode automatically.
   */
  authMode?: PipilotAuthMode
  /**
   * Span purpose label (e.g., 'router', 'extractor', 'summarizer'). Used as a
   * `pipilot.span.purpose` hint in P1; P0 just records it as a span name suffix.
   */
  purpose?: string
}

/**
 * Map a pi-ai Provider value to a valid `gen_ai.provider.name` enum value.
 *
 * Spec §6.3: emit `gen_ai.provider.name` ONLY when the provider is in the OTel
 * well-known list. Otherwise leave the standard field unset and rely on
 * `pipilot.auth.mode` for cross-backend distinction.
 */
function toGenAiProvider(provider: string): GenAiProviderName | undefined {
  // pi-ai providers like 'anthropic-sub' / 'google-vertex' need normalization.
  const lower = provider.toLowerCase()
  if (lower.startsWith('anthropic')) return 'anthropic'
  if (lower.startsWith('openai') && !lower.includes('codex')) return 'openai'
  if (lower.startsWith('google') || lower.startsWith('vertex')) return 'gcp.gemini'
  if (lower === 'deepseek') return 'deepseek'
  return GEN_AI_PROVIDER_NAMES.includes(lower as GenAiProviderName)
    ? (lower as GenAiProviderName)
    : undefined
}

/**
 * Wrap `completeSimple` with a `chat {model}` span. Records request/response token
 * counts, finish reasons, errors, and the consolidated GenAI inference event.
 *
 * Identity-preserving: returns the same AssistantMessage as `completeSimple` would.
 */
export async function tracedCompleteSimple<TApi extends string>(
  model: Model<TApi>,
  pi: PiContext,
  llmOpts: SimpleStreamOptions | undefined,
  traceOpts: TracedCompleteSimpleOpts
): Promise<AssistantMessage> {
  const { tracer, parent, authMode, purpose } = traceOpts
  const spanName = purpose ? `chat ${model.id} (${purpose})` : `chat ${model.id}`
  const parentCtx = parent ?? context.active()

  const span: Span = tracer.startSpan(spanName, SpanKind.CLIENT, parentCtx)
  const ctxWithSpan = trace.setSpan(parentCtx, span)

  // Request-side attributes (§6.3).
  const reqAttrs: Attributes = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': model.id
  }
  const providerName = toGenAiProvider(model.provider)
  if (providerName) reqAttrs['gen_ai.provider.name'] = providerName
  if (authMode) reqAttrs['pipilot.auth.mode'] = authMode
  span.setAttributes(reqAttrs)

  // Redact + attach the consolidated input messages event (§6.9).
  // Pre-flight: if the input is large, redaction caps it via the blob-ref shortcut.
  const { value: redactedInput, stats: inputStats } = redact(
    {
      'gen_ai.input.messages': pi.messages,
      'gen_ai.system_instructions': pi.systemPrompt
    },
    { sizeCapBytes: 4096, blobStore: tracer.blobs }
  )
  span.addEvent('gen_ai.client.inference.operation.details', {
    body: JSON.stringify(redactedInput)
  } as Attributes)

  // Wire-level capture via pi-ai's existing onPayload + onResponse hooks
  // (`StreamOptions` in `node_modules/@mariozechner/pi-ai/dist/types.d.ts`).
  // onPayload fires right before the HTTP request goes out with the final
  // provider-format payload (post-`convertMessages`, post-`cache_control`
  // markers, post-system-prompt augmentation). onResponse fires after HTTP
  // headers are received but before the body stream is consumed. Together
  // they give us 100% wire-faithful capture without reconstruction.
  //
  // Both must NEVER throw or modify the payload — return undefined to keep
  // it unchanged. Caller-supplied hooks are chained: if `llmOpts.onPayload`
  // already exists, we invoke ours after recording the wire payload.
  const userOnPayload = llmOpts?.onPayload
  const userOnResponse = llmOpts?.onResponse
  const wiredOpts: SimpleStreamOptions = {
    ...llmOpts,
    onPayload: async (payload, m) => {
      try {
        const { value: redactedPayload } = redact(payload, {
          sizeCapBytes: 4096,
          blobStore: tracer.blobs
        })
        span.addEvent('pipilot.chat.request_payload', {
          body: JSON.stringify(redactedPayload)
        } as Attributes)
      } catch {
        // Telemetry must never affect the LLM call.
      }
      // Honor user-supplied hook chained after our observation.
      return userOnPayload ? userOnPayload(payload, m) : undefined
    },
    onResponse: async (resp, m) => {
      try {
        span.setAttributes({
          'http.response.status_code': resp.status
        })
        // Forward a few well-known rate-limit / id headers when present —
        // they're useful for cost / quota analysis. Provider-specific keys.
        const wanted = [
          'request-id',
          'x-request-id',
          'anthropic-request-id',
          'anthropic-ratelimit-input-tokens-remaining',
          'anthropic-ratelimit-output-tokens-remaining',
          'x-ratelimit-remaining-requests',
          'x-ratelimit-remaining-tokens'
        ]
        for (const k of wanted) {
          const v = resp.headers?.[k] ?? resp.headers?.[k.toLowerCase()]
          if (typeof v === 'string') span.setAttribute(`http.response.header.${k}`, v)
        }
      } catch {
        // ignore
      }
      if (userOnResponse) await userOnResponse(resp, m)
    }
  }

  try {
    const result = await context.with(ctxWithSpan, () => completeSimple(model, pi, wiredOpts))

    // Response-side attributes (§6.3).
    const respAttrs: Attributes = {
      'gen_ai.response.model': result.model,
      'gen_ai.usage.input_tokens': result.usage.input,
      'gen_ai.usage.output_tokens': result.usage.output,
      'gen_ai.usage.cache_read.input_tokens': result.usage.cacheRead,
      'gen_ai.usage.cache_creation.input_tokens': result.usage.cacheWrite,
      'gen_ai.response.finish_reasons': [result.stopReason]
    }
    span.setAttributes(respAttrs)

    // Output messages event (redacted).
    const { value: redactedOutput, stats: outputStats } = redact(
      { 'gen_ai.output.messages': result.content },
      { sizeCapBytes: 4096, blobStore: tracer.blobs }
    )
    span.addEvent('gen_ai.client.inference.operation.details', {
      body: JSON.stringify(redactedOutput)
    } as Attributes)

    span.setAttribute(
      'pipilot.redaction.fields_redacted_count',
      inputStats.fieldsRedactedCount + outputStats.fieldsRedactedCount
    )
    span.setAttribute('pipilot.redaction.scrubber_version', SCRUBBER_VERSION)

    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: result.errorMessage })
    } else {
      span.setStatus({ code: SpanStatusCode.OK })
    }

    span.end()
    return result
  } catch (err) {
    const e = err as Error
    span.recordException(e)
    span.setAttribute('error.type', e.name || 'Error')
    span.setStatus({ code: SpanStatusCode.ERROR, message: e.message })
    span.end()
    throw err
  }
}
