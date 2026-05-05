/**
 * Telemetry & Trace public surface (v0.10 spec).
 *
 * Single import point for the rest of the app:
 *
 *   import { PipilotTracer, tracedCompleteSimple, migrateProjectConfig } from '@research-pilot/telemetry'
 */

export { PipilotTracer, getActiveTracer } from './tracer.js'
export type { TracerInitOptions, ProjectScope } from './tracer.js'

export { TraceStore } from './trace-store.js'
export type { TraceStoreOptions } from './trace-store.js'

export { TraceDigestProcessor } from './digest.js'

export { LiveSpanProcessor } from './live-processor.js'
export type { LiveSpanSummary, LiveSpanSubscriber } from './live-processor.js'

export { loadTraceSnapshot } from './snapshot.js'
export type { TraceSnapshot } from './snapshot.js'

// Diagnostics (P3): pure-function rule engine over LiveSpanSummary[].
// Use `import { ... } from '@research-pilot/telemetry/diagnostics'` for the
// detailed surface; only the entry points are re-exported here.
export {
  runDiagnostics,
  BUILTIN_RULES,
  loadTraceForDiagnostics,
  loadTraceCorpus,
  buildBaseline
} from './diagnostics/index.js'
export type { Finding, RegisteredRule, RuleContext, TraceBaseline, Severity } from './diagnostics/index.js'

export { JsonlSpanExporter } from './exporters/jsonl.js'
export type { JsonlSpanExporterOptions } from './exporters/jsonl.js'

export { tracedCompleteSimple } from './llm-trace.js'
export type { TracedCompleteSimpleOpts } from './llm-trace.js'

export { tracedFetch, recordReviewCompletion } from './http-trace.js'
export type { TracedFetchOpts } from './http-trace.js'

export { redact, scrubString, sha256Hex, SCRUBBER_VERSION, DEFAULT_SIZE_CAP_BYTES } from './redaction.js'
export type { RedactionStats, RedactOptions } from './redaction.js'

export {
  SCHEMA_URL,
  TRACE_POLICY_VERSION,
  GEN_AI_PROVIDER_NAMES,
  GEN_AI_TOOL_TYPES,
  GEN_AI_OPERATION_NAMES,
  PIPILOT_AUTH_MODES,
  PIPILOT_TOOL_CATEGORIES,
  PIPILOT_ATTRIBUTE_KEYS,
  PIPILOT_EVENT_NAMES,
  PIPILOT_LINK_KINDS,
  validatePipilotAttribute,
  validatePipilotEventName
} from './semantic-registry.js'
export type {
  GenAiProviderName,
  GenAiToolType,
  GenAiOperationName,
  PipilotAuthMode,
  PipilotToolCategory,
  PipilotLinkKind
} from './semantic-registry.js'

export { migrateProjectConfig } from './migration.js'
export type { MigrationResult } from './migration.js'

export { createTracingStateLogger } from './tracing-state.js'
export type { TracingStateKind, TracingStateRow, TracingStateLogger } from './tracing-state.js'

export { ulid } from './ulid.js'

export { appendJsonl, appendJsonlBatch } from './jsonl-writer.js'
export type { JsonlWriterOptions } from './jsonl-writer.js'
