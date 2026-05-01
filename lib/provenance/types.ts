/**
 * Provenance graph — type definitions.
 *
 * The graph is an *index* over content that lives in fit-for-purpose stores
 * (Memory V2, workspace files, audit-reports). The graph itself never stores
 * content payloads — each node carries a typed `ref` plus an optional
 * `snapshot` record that points into the content-addressed blob store.
 *
 * See docs/spec/trust-audit.md (current: v0.8) for the design rationale,
 * including axioms A1 (minimum-discipline review) and A2 (record-and-warn,
 * never fight user modifications).
 */

import type { ArtifactType } from '../types.js'

// ---------------------------------------------------------------------------
// Node identity
// ---------------------------------------------------------------------------

/** Discriminator for the kind of thing a node points at. */
export type NodeKind =
  | 'memory-artifact'   // pointer into Memory V2 (note | paper | data | web-content | tool-output)
  | 'workspace-file'    // raw file in the user's workspace (data, write/edit output)
  | 'computation'       // the *act* of running a tool — no content payload
  | 'draft'             // workspace markdown file the user is editing
  | 'audit-report'      // pointer into .research-pilot/audit-reports/

/** Discriminated reference: identifies *what* a node points at, not its content. */
export type NodeRef =
  | { kind: 'memory-artifact'; artifactType: ArtifactType; artifactId: string }
  | { kind: 'workspace-file';  path: string }
  | { kind: 'computation';     toolCallId: string }
  | { kind: 'draft';           path: string }
  | { kind: 'audit-report';    path: string }

// ---------------------------------------------------------------------------
// Snapshot + drift (axiom A2 — record at boundaries, warn on drift, never fight)
// ---------------------------------------------------------------------------

/** Per-node record of whether content was captured and at what hash. */
export interface SnapshotRecord {
  /** sha256 hex of the captured content. Always recorded, even when not snapshotted. */
  contentHash: string
  /** Byte size of the content at capture. */
  sizeBytes: number
  /** True if a blob was written at provenance/blobs/{contentHash}. */
  snapshotted: boolean
  /** True if content exceeded the system snapshot cap (10 MB) and was therefore not blob-stored. */
  oversizeSkipped: boolean
}

/** Most-recent drift observation: live store hash differed from snapshot. */
export interface DriftRecord {
  /** sha256 hex observed at the live store at `observedAt`. */
  observedHash: string
  observedAt: string
}

// ---------------------------------------------------------------------------
// Tool call + agent turn metadata
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  /** Tool name as registered in the agent (e.g. 'literature-search', 'write', 'bash'). */
  name: string
  /** sha256 hex of canonicalized params JSON. */
  parametersHash: string
  /** Path (relative to project root) of the params blob, e.g. provenance/params/{toolCallId}.json. */
  parametersRef: string
}

export interface AgentTurnRecord {
  sessionId: string
  /** Zero-based index of the assistant turn that issued this tool call. */
  turnIndex: number
  /** Provider+model id used by the coordinator, e.g. 'anthropic:claude-opus-4-7'. */
  model: string
}

// ---------------------------------------------------------------------------
// Graph node + edge
// ---------------------------------------------------------------------------

/**
 * A node in the provenance graph. The graph stores metadata only — content is
 * resolved through the appropriate store using `ref` (and `snapshot` when present).
 */
export interface ProvenanceNode {
  /** Graph-local id, e.g. 'pn_<uuid>'. NOT the same as Memory V2 artifact id. */
  id: string
  kind: NodeKind
  ref: NodeRef
  /** Human-readable label (filename, artifact title, "audit 2026-04-29"). */
  label: string
  /** ISO timestamp of node creation. */
  createdAt: string
  /** Most-recent timestamp the node was observed alive. Updated on dedup hit. */
  lastSeenAt?: string
  /** Content snapshot record. Absent for `computation` nodes (no payload). */
  snapshot?: SnapshotRecord
  /** Most-recent drift observation. Absent until first drift is detected. */
  drift?: DriftRecord
  /** Populated when this node was produced by a tracked tool call. */
  toolCall?: ToolCallRecord
  /** Populated when this node was produced during an agent session. */
  agentTurn?: AgentTurnRecord
}

/** Edges describe the causal relationship between two nodes by graph-local ids. */
export type EdgeRole =
  | 'input'         // ancestor was consumed as input by descendant tool call
  | 'code'          // ancestor is the code that produced descendant
  | 'parameter'     // ancestor is the params blob for a computation node
  | 'cited-by'      // ancestor was cited (e.g. via @-mention) by descendant
  | 'derived-from'  // descendant is a new version of ancestor (drafts, write/edit)

export interface ProvenanceEdge {
  from: string
  to: string
  role: EdgeRole
}

/** Append-only event union persisted to graph.jsonl. */
export type GraphEvent =
  | { type: 'node'; node: ProvenanceNode }
  | { type: 'edge'; edge: ProvenanceEdge }
  | { type: 'node-update'; id: string; patch: Partial<Pick<ProvenanceNode, 'lastSeenAt' | 'drift'>> }

// ---------------------------------------------------------------------------
// Adapter facts (consumed by recordToolCall)
// ---------------------------------------------------------------------------

/**
 * What an adapter declares about a single tool call. The capture layer
 * (recordToolCall) is the only place that resolves NodeRefs to graph-local
 * node ids; adapters never see node ids.
 */
export interface ProvenanceFacts {
  /** Outputs the tool call produced. Each entry becomes (or finds) a graph node. */
  outputs: OutputFact[]
  /** Inputs the tool call consumed. Each ref is resolved to a node id; an `input` edge is added. */
  inputs: NodeRef[]
  /** Optional: things the tool call cited (e.g. @-mentions). Adds `cited-by` edges. */
  cited?: NodeRef[]
  /**
   * Refs whose content flowed into the agent's context without this tool
   * itself producing a node — e.g. `read` loads a file's bytes into the LLM
   * conversation but emits no artifact. Capture pools these per-agent-turn;
   * the next call in the same turn that has outputs picks them up as
   * additional inputs (PROV `wasInformedBy` semantics, see RFC §3.5).
   *
   * Pool is cleared at turn boundaries, NOT on each producer flush — within
   * a single turn, every producer sees every consumed ref. This matches the
   * intuition "in this turn the agent looked at A and B, then wrote X and Y;
   * X and Y are derived from A and B" without trying to track a finer
   * read-vs-write order that the agent itself doesn't reliably expose.
   */
  consumed?: NodeRef[]
}

export interface OutputFact {
  kind: NodeKind
  ref: NodeRef
  label: string
  /**
   * Optional pre-computed sha256. If absent, recordToolCall hashes the content itself
   * (when it can — e.g. workspace-file at a known path).
   */
  contentHash?: string
  /**
   * Whether the adapter wants this output snapshotted into blobs/.
   * - `'always'`: snapshot if size ≤ cap (system-level 10 MB cap still enforced)
   * - `'never'`: hash-only (datasets, large inputs)
   * - `undefined`: use the per-kind default (see §3.7 of the RFC)
   */
  snapshotPolicy?: 'always' | 'never'
  /**
   * Optional content provider for snapshotting. If absent, recordToolCall reads
   * from the live store (workspace-file: read path; memory-artifact: read via Memory V2).
   * Adapters provide this when content is in-memory and not yet on disk.
   */
  readContent?: () => Promise<Buffer> | Buffer
}

/**
 * Per-tool adapter. Returns `null` when there's nothing to capture for this call
 * (e.g. read-only operations, no-op writes).
 */
export type ProvenanceAdapter = (
  args: Record<string, unknown>,
  result: unknown,
  ctx: AgentTurnRecord
) => ProvenanceFacts | null | Promise<ProvenanceFacts | null>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Universal snapshot size cap. System-level — adapters cannot override.
 * Content above this is hash-only (oversizeSkipped: true) and surfaces a 📦 badge in UI.
 */
export const SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
