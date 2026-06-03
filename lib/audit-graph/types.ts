/**
 * Audit Graph — provenance projection derived from telemetry.
 *
 * The graph is NOT a separate store. It's a read-only view materialized on
 * demand from:
 *   - .research-pilot/traces/spans.*.jsonl       (OTLP/JSON spans)
 *   - .research-pilot/artifacts/ledger.jsonl     (artifact lifecycle events)
 *   - .research-pilot/trace-digest.jsonl         (per-trace aggregates)
 *   - .research-pilot/artifacts/*.json           (artifact title lookup)
 *
 * Used by the Audit tab to visualize support slices and preview taint /
 * invalidate / replay scope. See docs/spec/telemetry-trace.md for the
 * source-of-truth schema this projection reads from.
 */

export type NodeKind =
  | 'session'
  | 'trace'
  | 'step'
  | 'tool'
  | 'chat'
  | 'artifact'
  | 'file'
  | 'dir'
  | 'span'

export type EdgeRel =
  | 'contains'    // session → trace, trace → span (OTel parent/child)
  | 'precedes'    // step i → step i+1 within a trace
  | 'invokes'     // step → tool (LLM issued this tool call)
  | 'returns'     // tool → next step (tool result was consumed in the next prompt)
  | 'sub-llm'     // step → sub-LLM chat (router, memory extractor, etc.)
  | 'reads'       // file → tool (tool consumed file contents)
  | 'writes'      // tool → file (tool produced file contents)
  | 'creates'     // tool → artifact (artifact-create produced this artifact)
  | 'retrieved'   // artifact → tool (artifact-search returned this artifact)
  | 'mentions'    // file → tool (file path referenced but not read)
  | 'listed'      // dir → tool (tool observed this directory's listing)

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string

  // Span-derived
  traceId?: string
  spanId?: string
  parentSpanId?: string | null
  startNs?: string
  endNs?: string
  durationMs?: number

  // Step / tool / chat
  turnId?: string | null
  stepIndex?: number | null
  toolName?: string | null
  toolCallId?: string | null
  toolCategory?: string | null
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  isError?: boolean
  eventNames?: string[]
  rawEvents?: { name: string; body: string }[]

  // Trace
  sessionId?: string
  rootSpanId?: string | null
  digest?: unknown

  // Artifact
  artifactId?: string
  type?: string
  title?: string | null
  path?: string
  versions?: unknown[]

  // Citation resolvability (A1) — present only on citing text artifacts
  // (note / web-content / tool-output) that carry scannable content.
  // `citationResolutionRate` is null when the artifact cites nothing.
  citationsTotal?: number
  citationsResolved?: number
  citationResolutionRate?: number | null
  /** Canonical ids cited but never retrieved — the fabrication watchlist. */
  unresolvedCitations?: string[]
}

export interface GraphEdge {
  source: string
  target: string
  rel: EdgeRel
}

export interface AuditGraph {
  builtAt: string
  source: string
  counts: {
    nodes: number
    edges: number
    spans: number
    traces: number
    artifacts: number
  }
  nodes: GraphNode[]
  edges: GraphEdge[]
}
