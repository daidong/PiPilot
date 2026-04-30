/**
 * Provenance module public surface.
 *
 * See docs/spec/trust-audit.md (current: v0.8) for design.
 *
 * Layering:
 *   types.ts      — pure types, no I/O
 *   store.ts      — JSONL append-only + blob CAS, pure I/O
 *   graph.ts      — in-memory graph + queries, pure logic
 *   capture.ts    — hooks adapter facts → graph nodes/edges (single resolver boundary)
 *   adapters/*    — one per artifact-producing tool; speak NodeRef, never see node ids
 */

export * from './types.js'
export { ProvenanceGraph, refKey } from './graph.js'
export type { Subgraph } from './graph.js'
export { CaptureContext } from './capture.js'
export { defaultAdapters, parseResultJson, resultText } from './adapters/index.js'
export {
  provenancePaths,
  sha256,
  newNodeId,
  appendEvent,
  readAllEvents,
  snapshotIfFits,
  hashOnly,
  readBlob
} from './store.js'
export { recordDraftDrift, isDraftPath } from './draft.js'
