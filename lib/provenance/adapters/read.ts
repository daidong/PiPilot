/**
 * `read` (pi-coding-agent) provenance adapter — wasInformedBy semantics.
 *
 * `read` produces no node of its own: the file content flows into the LLM's
 * context window and transitively informs whatever the agent does next in
 * the same turn. We surface that via the `consumed` channel — capture pools
 * the ref per agent turn (see ProvenanceFacts.consumed) and any subsequent
 * producer call in the same turn picks it up as an additional input.
 *
 * grep / find / ls are deliberately NOT captured: they reveal paths and
 * match snippets, not document content. Treating them as inputs would
 * over-count navigation as evidence (RFC §3.5 / "data product" axiom A1).
 *
 * Tool name in pi-coding-agent's registry is `read`; args field is `path`,
 * but we also accept `file_path` defensively in case forks rename it.
 */

import type { ProvenanceAdapter, ProvenanceFacts, NodeRef } from '../types.js'

export const readAdapter: ProvenanceAdapter = (args, _result, _ctx): ProvenanceFacts | null => {
  const path = typeof args.path === 'string' ? args.path
             : typeof args.file_path === 'string' ? args.file_path
             : null
  if (!path) return null
  const ref: NodeRef = { kind: 'workspace-file', path }
  return { outputs: [], inputs: [], consumed: [ref] }
}
