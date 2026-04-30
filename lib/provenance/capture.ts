/**
 * Provenance capture — turns ProvenanceFacts (from per-tool adapters) into
 * graph nodes + edges, persisted to graph.jsonl.
 *
 * This module is the single boundary between the typed-ref world (adapters,
 * which never see graph-local node ids) and the graph-id world (edges and
 * queries, which only know about node ids).
 *
 * Lifecycle:
 *   coordinator beforeToolCall  → captureBeforeTool(toolCallId, args, name, turn)
 *   coordinator afterToolCall   → captureAfterTool(toolCallId, args, result)
 *
 * We do not modify lib/tools/tool-utils.ts. Capture happens in the agent
 * lifecycle hooks where every tool call is observable uniformly.
 *
 * Per axiom A2 (record and warn, never fight user modifications):
 *   - We snapshot at capture time only for outputs (agent-creation moments).
 *   - We never write blobs for inputs the adapter doesn't ask us to.
 *   - Drift is observed and recorded; never reconciled.
 */

import type {
  GraphEvent,
  NodeKind,
  NodeRef,
  ProvenanceAdapter,
  ProvenanceFacts,
  ProvenanceEdge,
  ProvenanceNode,
  AgentTurnRecord,
  OutputFact,
  SnapshotRecord
} from './types.js'
import { ProvenanceGraph, refKey } from './graph.js'
import {
  appendEvent,
  hashOnly,
  newNodeId,
  snapshotIfFits,
  statWorkspaceFile,
  writeParams
} from './store.js'
import { PATHS, type ArtifactType } from '../types.js'

/** Relative path of a Memory V2 artifact JSON file, used by readOutputContent. */
function memoryArtifactPath(type: ArtifactType, id: string): string {
  switch (type) {
    case 'note':         return `${PATHS.notes}/${id}.json`
    case 'paper':        return `${PATHS.papers}/${id}.json`
    case 'data':         return `${PATHS.data}/${id}.json`
    case 'web-content':  return `${PATHS.webContent}/${id}.json`
    case 'tool-output':  return `${PATHS.toolOutputs}/${id}.json`
  }
}

// ---------------------------------------------------------------------------
// Capture context — wraps the per-project graph + project path
// ---------------------------------------------------------------------------

/**
 * Per-project capture state. Held by the coordinator (or a long-lived agent
 * runner) for the duration of a session. The graph is mutable in-memory and
 * stays in sync with graph.jsonl by applying each event after appending.
 */
export class CaptureContext {
  /** Pending args/turn captured in `beforeToolCall`, keyed by toolCallId. */
  private readonly pending = new Map<string, {
    name: string
    args: Record<string, unknown>
    turn: AgentTurnRecord
    /** Turn-scoped cited refs (e.g. @-mentions on the user message). */
    citedFromTurn?: NodeRef[]
  }>()

  constructor(
    public readonly projectPath: string,
    public readonly graph: ProvenanceGraph,
    public readonly adapters: Record<string, ProvenanceAdapter>
  ) {}

  static async load(
    projectPath: string,
    adapters: Record<string, ProvenanceAdapter>
  ): Promise<CaptureContext> {
    const graph = await ProvenanceGraph.load(projectPath)
    return new CaptureContext(projectPath, graph, adapters)
  }

  /** Stash args/turn before the tool runs; afterToolCall consumes them. */
  markStart(
    toolCallId: string,
    info: { name: string; args: Record<string, unknown>; turn: AgentTurnRecord; citedFromTurn?: NodeRef[] }
  ): void {
    this.pending.set(toolCallId, info)
  }

  takeStart(toolCallId: string): {
    name: string; args: Record<string, unknown>; turn: AgentTurnRecord; citedFromTurn?: NodeRef[]
  } | null {
    const info = this.pending.get(toolCallId) ?? null
    if (info) this.pending.delete(toolCallId)
    return info
  }

  /** Append + apply in lock-step so on-disk and in-memory don't diverge. */
  private async emit(event: GraphEvent): Promise<void> {
    await appendEvent(this.projectPath, event)
    this.graph.applyEvent(event)
  }

  // -------------------------------------------------------------------------
  // Public capture entrypoint
  // -------------------------------------------------------------------------

  /**
   * Capture a completed tool call. Called from coordinator's afterToolCall hook.
   *
   * Returns the ids of newly created output nodes (rarely needed by callers,
   * but useful for debugging and tests).
   */
  async recordToolCall(
    toolCallId: string,
    args: Record<string, unknown>,
    result: unknown,
    info: { name: string; turn: AgentTurnRecord; isError: boolean; citedFromTurn?: NodeRef[] }
  ): Promise<string[]> {
    if (info.isError) return [] // failed tool calls do not get captured
    const adapter = this.adapters[info.name]
    if (!adapter) return [] // tool isn't artifact-producing; silently skip

    const factsOrPromise = adapter(args, result, info.turn)
    const facts = (await factsOrPromise) as ProvenanceFacts | null
    if (!facts) return []

    // Merge turn-scoped cited refs (e.g. @-mentions on the chat message that
    // triggered this tool call) into the adapter's own cited list. Adapters
    // see only tool-specific args; turn-level context comes from the coordinator.
    if (info.citedFromTurn?.length) {
      facts.cited = [...(facts.cited ?? []), ...info.citedFromTurn]
    }

    // 1. Persist canonical params (used by every output node's toolCall block).
    const { parametersHash, parametersRef } = await writeParams(this.projectPath, toolCallId, args)
    const toolCallRecord = { name: info.name, parametersHash, parametersRef }

    // 2. Resolve inputs to node ids (find-or-create — discovers existing nodes
    //    when the same artifact has been seen before, creates them otherwise).
    const inputIds: string[] = []
    for (const ref of facts.inputs) {
      const id = await this.resolveRef(ref)
      inputIds.push(id)
    }

    // 3. Resolve cited refs the same way.
    const citedIds: string[] = []
    for (const ref of facts.cited ?? []) {
      const id = await this.resolveRef(ref)
      citedIds.push(id)
    }

    // 4. Create output nodes + their edges. Outputs are deduplicated by
    //    (ref + contentHash) the same way inputs are: if an `edit` re-emits
    //    a file with byte-identical content, we do not pollute the version
    //    history with a phantom "no-op" version. Tool-call still recorded
    //    via the computation node (the *act* of running edit) — input/cited
    //    edges still point at the existing version.
    const outputIds: string[] = []
    const computationIds: string[] = []
    const nonComputationIds: string[] = []
    for (const out of facts.outputs) {
      const outId = await this.createOrReuseOutputNode(out, toolCallRecord, info.turn)
      outputIds.push(outId)
      if (out.kind === 'computation') computationIds.push(outId)
      else nonComputationIds.push(outId)
      for (const inputId of inputIds) {
        await this.emit({ type: 'edge', edge: { from: inputId, to: outId, role: 'input' } })
      }
      for (const citedId of citedIds) {
        await this.emit({ type: 'edge', edge: { from: citedId, to: outId, role: 'cited-by' } })
      }
    }

    // 5. When the same call produces a `computation` node alongside other
    //    outputs (e.g. data_analyze emits a computation + script + figures),
    //    link each non-computation output back to the computation with a
    //    `derived-from` edge. Without this, those outputs would look like
    //    orphan workspace-files (RFC §3.5) even though their producer is
    //    explicitly tracked in this same call.
    for (const compId of computationIds) {
      for (const outId of nonComputationIds) {
        await this.emit({ type: 'edge', edge: { from: compId, to: outId, role: 'derived-from' } })
      }
    }

    return outputIds
  }

  // -------------------------------------------------------------------------
  // Find-or-create resolver — the only place ref → nodeId translation lives.
  // -------------------------------------------------------------------------

  /**
   * Resolve a NodeRef to a graph-local node id, creating a new node if no
   * existing one matches. Identity rule:
   *   - same refKey + same contentHash (when both present) → existing node
   *   - same refKey + neither has contentHash → existing node (computation, audit-report)
   *   - same refKey + different contentHash → distinct node (a new version)
   *
   * For workspace-files, we read the live file to compute contentHash. If the
   * file is missing, we create a node with no snapshot and label "(missing)" —
   * the auditor will surface this as a missing-input finding.
   */
  async resolveRef(ref: NodeRef): Promise<string> {
    // 1. Try to find an existing node. For refs that carry no content
    //    (computation, audit-report), refKey alone is identity.
    if (ref.kind === 'computation' || ref.kind === 'audit-report') {
      const existing = this.graph.findByRef(ref)
      if (existing.length > 0) return existing[0]!.id
      return this.createMinimalNode(ref)
    }

    // 2. Content-bearing refs: compute current hash, then look up by (ref, hash).
    const snapshot = await this.computeInputSnapshot(ref)
    const hash = snapshot?.contentHash
    const matches = hash !== undefined
      ? this.graph.findByRef(ref, hash)
      : this.graph.findByRef(ref)

    if (matches.length > 0) {
      // Touch lastSeenAt so audit UI knows when we last saw the input alive.
      const id = matches[matches.length - 1]!.id
      await this.emit({ type: 'node-update', id, patch: { lastSeenAt: nowIso() } })
      return id
    }

    // 3. No match → create. Inputs are typically *not* snapshotted by capture
    //    (datasets can be huge); we record hash-only by default.
    return this.createInputNode(ref, snapshot)
  }

  // -------------------------------------------------------------------------
  // Node creation helpers
  // -------------------------------------------------------------------------

  /**
   * Create a new output node — UNLESS a prior node with the same ref AND the
   * same contentHash already exists, in which case we reuse it (touching
   * lastSeenAt). This makes capture symmetric with input resolution and
   * keeps "edit produced the same bytes again" from polluting the version
   * timeline.
   *
   * For computation outputs (no contentHash) we always create — each tool
   * call deserves its own computation record even if it was a no-op write.
   */
  private async createOrReuseOutputNode(
    out: OutputFact,
    toolCall: { name: string; parametersHash: string; parametersRef: string },
    turn: AgentTurnRecord
  ): Promise<string> {
    const snapshot = await this.snapshotForOutput(out)

    // Content-bearing outputs: dedup by (ref, contentHash).
    if (snapshot && out.kind !== 'computation') {
      const existing = this.graph.findByRef(out.ref, snapshot.contentHash)
      if (existing.length > 0) {
        const id = existing[existing.length - 1]!.id
        await this.emit({ type: 'node-update', id, patch: { lastSeenAt: nowIso() } })
        return id
      }
    }

    const node: ProvenanceNode = {
      id: newNodeId(),
      kind: out.kind,
      ref: out.ref,
      label: out.label,
      createdAt: nowIso(),
      snapshot,
      toolCall,
      agentTurn: turn
    }
    await this.emitNodeWithVersionLink(node)
    return node.id
  }

  private async createInputNode(ref: NodeRef, snapshot: SnapshotRecord | undefined): Promise<string> {
    const node: ProvenanceNode = {
      id: newNodeId(),
      kind: refToKind(ref),
      ref,
      label: defaultLabel(ref),
      createdAt: nowIso(),
      snapshot
    }
    await this.emitNodeWithVersionLink(node)
    return node.id
  }

  /** Minimal node for refs with no content payload (computation, audit-report). */
  private async createMinimalNode(ref: NodeRef): Promise<string> {
    const node: ProvenanceNode = {
      id: newNodeId(),
      kind: refToKind(ref),
      ref,
      label: defaultLabel(ref),
      createdAt: nowIso()
    }
    await this.emit({ type: 'node', node })
    return node.id
  }

  /**
   * Emit a node and, if a prior node with the same refKey but different
   * contentHash already exists, also emit a `derived-from` edge from the
   * most-recent prior node to this one. This gives us free version chains
   * for artifact-update, write/edit, and any tool that re-emits the same
   * ref with new content.
   *
   * No-op when:
   *   - the new node has no snapshot (no content to compare against)
   *   - no prior node exists for this refKey
   *   - the most-recent prior node has the same contentHash (handled upstream as dedup)
   */
  private async emitNodeWithVersionLink(node: ProvenanceNode): Promise<void> {
    // Find prior nodes with the same identity (refKey) regardless of hash.
    const priors = this.graph.findByRef(node.ref)
    await this.emit({ type: 'node', node })

    if (!node.snapshot) return
    if (priors.length === 0) return

    // Pick the most-recent prior node by createdAt (excluding the node we just added).
    const newestPrior = priors
      .filter(p => p.id !== node.id)
      .reduce<ProvenanceNode | null>(
        (best, p) => (best === null || p.createdAt > best.createdAt) ? p : best,
        null
      )
    if (!newestPrior) return
    if (newestPrior.snapshot?.contentHash === node.snapshot.contentHash) return // identical content

    await this.emit({
      type: 'edge',
      edge: { from: newestPrior.id, to: node.id, role: 'derived-from' }
    })
  }

  // -------------------------------------------------------------------------
  // Snapshot helpers — apply per-kind policy from RFC §3.7
  // -------------------------------------------------------------------------

  /**
   * Snapshot an *output* per the per-kind defaults:
   *   - memory-artifact: always (subject to 10MB cap)
   *   - workspace-file: always (write/edit outputs are typically small)
   *   - draft: never at capture (drafts snapshot only at audit-run time, slice 1.8 +)
   *   - computation, audit-report: no content payload
   * Adapter can override with `snapshotPolicy`.
   */
  private async snapshotForOutput(out: OutputFact): Promise<SnapshotRecord | undefined> {
    if (out.kind === 'computation') return undefined

    const policy = out.snapshotPolicy ?? defaultSnapshotPolicyForOutput(out.kind)
    if (policy === 'never') {
      // Hash-only: read content if we can to record the hash; skip otherwise.
      const buf = await this.readOutputContent(out)
      return buf ? hashOnly(buf) : undefined
    }

    // policy === 'always'
    const buf = await this.readOutputContent(out)
    if (!buf) return undefined
    return snapshotIfFits(this.projectPath, buf)
  }

  /**
   * For inputs: hash-only by default (never snapshot a dataset just because
   * something read it). Adapters can pre-fill contentHash on the OutputFact
   * if they want; for inputs we just need to read the live file to hash it.
   */
  private async computeInputSnapshot(ref: NodeRef): Promise<SnapshotRecord | undefined> {
    if (ref.kind === 'workspace-file') {
      const stat = await statWorkspaceFile(this.projectPath, ref.path)
      if (!stat) return undefined // missing live; node will be created with no snapshot
      return { contentHash: stat.contentHash, sizeBytes: stat.sizeBytes, snapshotted: false, oversizeSkipped: false }
    }
    // Other ref kinds either have no live content (computation, audit-report)
    // or are addressed differently (memory-artifact resolution belongs to
    // the memory-artifact adapter, which fills contentHash on the OutputFact).
    return undefined
  }

  /**
   * Read the bytes of an output. Order of preference:
   *   1. adapter-provided readContent()
   *   2. workspace-file/draft path on disk
   *   3. memory-artifact file at .research-pilot/artifacts/{type}/{id}.json
   *   4. give up (return null) — we can't snapshot, but the node still exists
   *
   * For memory-artifacts we read the canonical JSON file directly (rather than
   * importing Memory V2's store) — this keeps the dependency surface small.
   */
  private async readOutputContent(out: OutputFact): Promise<Buffer | null> {
    if (out.readContent) {
      const v = await out.readContent()
      return v as Buffer
    }
    if (out.ref.kind === 'workspace-file' || out.ref.kind === 'draft') {
      return this.readFileAt(out.ref.path)
    }
    if (out.ref.kind === 'memory-artifact') {
      const rel = memoryArtifactPath(out.ref.artifactType, out.ref.artifactId)
      return this.readFileAt(rel)
    }
    return null
  }

  private async readFileAt(relativeOrAbs: string): Promise<Buffer | null> {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { existsSync } = await import('node:fs')
    const abs = relativeOrAbs.startsWith('/') ? relativeOrAbs : join(this.projectPath, relativeOrAbs)
    if (!existsSync(abs)) return null
    return readFile(abs)
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function refToKind(ref: NodeRef): NodeKind {
  return ref.kind
}

function defaultLabel(ref: NodeRef): string {
  switch (ref.kind) {
    case 'memory-artifact': return `${ref.artifactType}/${ref.artifactId}`
    case 'workspace-file':  return ref.path
    case 'computation':     return `tool-call ${ref.toolCallId}`
    case 'draft':           return ref.path
    case 'audit-report':    return ref.path
  }
}

function defaultSnapshotPolicyForOutput(kind: NodeKind): 'always' | 'never' {
  switch (kind) {
    case 'memory-artifact': return 'always'
    case 'workspace-file':  return 'always' // write/edit outputs default snapshot; data inputs go through computeInputSnapshot instead
    case 'draft':           return 'never'  // snapshot at audit time, not capture time (slice 1.8 +)
    case 'computation':     return 'never'
    case 'audit-report':    return 'never'  // write-once; no separate snapshot needed
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

// Re-export for adapter tests / inspection.
export { refKey } from './graph.js'
