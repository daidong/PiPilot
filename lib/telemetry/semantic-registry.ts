/**
 * Semantic registry — pinned OTel schema_url + PiPilot extension whitelist (§6.3, §6.4).
 *
 * Acts as a runtime guard: in dev mode, any `pipilot.*` attribute key not in the
 * whitelist throws. This prevents schema drift via casual span instrumentation.
 *
 * Pinning policy: GenAI semantic conventions are currently marked Development /
 * Experimental. We pin to a specific schema_url at P0; bumping requires:
 *   1. Update SCHEMA_URL constant.
 *   2. Re-run `__tests__/semantic-registry.test.ts` (conformance) — must stay green.
 *   3. Update §6.3 of telemetry-trace.md.
 * Treat as a quarterly review.
 */

/**
 * Pinned OTel GenAI semconv schema URL.
 *
 * As of 2026-Q2, GenAI conventions are still labeled Development. We pin to
 * v1.40.0 (matches the @opentelemetry/semantic-conventions package version
 * available at install time). The pin is set on:
 *   - the OTLP `ResourceSpans` envelope at export time (§5.1)
 *   - the OTel `Tracer` (instrumentation scope) at acquisition time (§3.2)
 *
 * It is NOT a per-span attribute.
 */
export const SCHEMA_URL = 'https://opentelemetry.io/schemas/1.40.0' as const

/** Bump when this file's content materially changes. Recorded on every span. */
export const TRACE_POLICY_VERSION = 'pipilot-trace-v0.10' as const

/** Standard OTel GenAI provider enum (cross-backend readable). */
export const GEN_AI_PROVIDER_NAMES = ['anthropic', 'openai', 'gcp.gemini', 'deepseek'] as const
export type GenAiProviderName = (typeof GEN_AI_PROVIDER_NAMES)[number]

/** OTel GenAI tool type — `retrieval` is an operation, not a type. */
export const GEN_AI_TOOL_TYPES = ['function', 'extension', 'datastore'] as const
export type GenAiToolType = (typeof GEN_AI_TOOL_TYPES)[number]

/** OTel GenAI operation enum we use. */
export const GEN_AI_OPERATION_NAMES = ['chat', 'embeddings', 'execute_tool', 'invoke_agent', 'create_agent'] as const
export type GenAiOperationName = (typeof GEN_AI_OPERATION_NAMES)[number]

/**
 * PiPilot auth-mode enum — single field carrying provider, billing source, and
 * subscription/Codex distinction (§6.3, v0.8 collapsed to one).
 */
export const PIPILOT_AUTH_MODES = ['api-key', 'anthropic-subscription', 'openai-codex'] as const
export type PipilotAuthMode = (typeof PIPILOT_AUTH_MODES)[number]

/**
 * PiPilot tool category enum (§6.4).
 */
export const PIPILOT_TOOL_CATEGORIES = [
  'file',
  'shell',
  'code',
  'data-analysis',
  'literature',
  'web',
  'memory',
  'artifact',
  'document',
  'diagram',
  'wiki',
  'citation',
  'compute'
] as const
export type PipilotToolCategory = (typeof PIPILOT_TOOL_CATEGORIES)[number]

/**
 * Whitelist of PiPilot extension attribute keys (§6.4).
 *
 * Use `validatePipilotAttribute(key)` in dev mode; in prod the validator is a no-op.
 *
 * Keep this list canonical with §6.4 of the spec. Adding a new key requires:
 *   1. Update spec §6.4.
 *   2. Add the key here.
 *   3. Bump TRACE_POLICY_VERSION above.
 */
export const PIPILOT_ATTRIBUTE_KEYS = new Set<string>([
  // Identity / context
  'pipilot.project.id',
  'pipilot.project.tag',
  'pipilot.runtime.agent_profile',
  'pipilot.runtime.workspace_commit',
  'pipilot.runtime.memory_index_version',
  'pipilot.runtime.full_prompt_hash',
  'pipilot.runtime.app_build_commit',

  // Auth
  'pipilot.auth.mode',

  // Turn / session linking
  'pipilot.turn.id',
  'pipilot.turn.followsId',

  // Tools
  'pipilot.tool.category',
  'pipilot.tool.error_class',
  'pipilot.tool.retry_count',

  // Compaction
  'pipilot.compaction.discarded_messages',
  'pipilot.compaction.kept_tokens',
  'pipilot.compaction.input_tokens',
  'pipilot.compaction.output_tokens',

  // Resumption (§6.4 — kept the two cheap booleans only)
  'pipilot.resumption.bootstrap_orphans',
  'pipilot.resumption.summary_loaded',

  // Redaction audit trail
  'pipilot.redaction.fields_redacted_count',
  'pipilot.redaction.scrubber_version',

  // Skills
  'pipilot.matched_skills',
  'pipilot.active_skills',

  // Explain reconciliation (§6.6)
  'pipilot.context.mention_selections',
  'pipilot.context.approx_tokens',
  'pipilot.session_summary.included',
  'pipilot.session_summary.turn_start',
  'pipilot.session_summary.turn_end',
  'pipilot.session_summary.approx_tokens',

  // Trace store / TraceStore degraded
  'pipilot.trace.dropped_traces',
  'pipilot.trace.degraded',

  // Local compute / linked traces (§6.5)
  'pipilot.link.kind'
])

/**
 * Whitelist of PiPilot custom event names (used on span events).
 */
export const PIPILOT_EVENT_NAMES = new Set<string>([
  'pipilot.skill.load',
  'pipilot.compaction.discarded',
  'pipilot.artifact.op',
  'pipilot.memory.op',
  'pipilot.detector.flag',
  // Tool I/O captured on execute_tool spans (§6.9 — PiPilot extension):
  // gen_ai.client.inference.operation.details is for chat I/O; tool I/O is
  // PiPilot-specific because no GenAI semconv covers it.
  'pipilot.tool.args',
  'pipilot.tool.result'
])

/** Whitelist of PiPilot link.kind values (§6.5). */
export const PIPILOT_LINK_KINDS = ['follows_from', 'spawned_from'] as const
export type PipilotLinkKind = (typeof PIPILOT_LINK_KINDS)[number]

const IS_DEV =
  typeof process !== 'undefined' &&
  (process.env.NODE_ENV === 'development' || process.env.RESEARCH_COPILOT_DEBUG === '1')

/**
 * Validate a PiPilot-namespaced attribute key.
 *
 * In dev mode: throws on unknown keys (catches typos, drift).
 * In prod: no-op (must never crash the agent path).
 */
export function validatePipilotAttribute(key: string): void {
  if (!key.startsWith('pipilot.')) return
  if (PIPILOT_ATTRIBUTE_KEYS.has(key)) return
  if (IS_DEV) {
    throw new Error(
      `Unknown pipilot.* attribute "${key}". Add it to PIPILOT_ATTRIBUTE_KEYS in lib/telemetry/semantic-registry.ts and update spec §6.4.`
    )
  }
}

/**
 * Validate a span event name.
 */
export function validatePipilotEventName(name: string): void {
  if (!name.startsWith('pipilot.')) return
  if (PIPILOT_EVENT_NAMES.has(name)) return
  if (IS_DEV) {
    throw new Error(
      `Unknown pipilot.* event name "${name}". Add it to PIPILOT_EVENT_NAMES in lib/telemetry/semantic-registry.ts and update spec §6.9.`
    )
  }
}
