import type { AuditGraph } from '../../../../../../lib/audit-graph/index'

/**
 * Derive a suspicion score from signals already recorded in every trace,
 * requiring no user input. We deliberately keep ONLY signals that correlate
 * with "this step's result may be wrong / worth re-checking":
 *
 *  1. Tool error      — isError (the tool explicitly failed)
 *  2. Tool retry      — retryCount > 0 (hit a transient fault, even if it
 *                       eventually succeeded — worth a glance)
 *  3. Artifact churn  — versions.length > 1 (a produced artifact was rewritten
 *                       multiple times: could be normal iteration, could be an
 *                       unstable upstream being corrected over and over)
 *
 * Explicitly NOT signals (they answer "how big / how slow", not "is it wrong"):
 *  - result truncated / redactionLevel "size-cap": this only means the tool
 *    result exceeded telemetry's 4KB span cap and was spilled to the blob
 *    store. The agent still received the FULL result — it's a recording-layer
 *    storage policy, not a correctness problem. (See telemetry-adapter.ts:240.)
 *  - duration outlier: a slow bash / web_fetch / convert_document is almost
 *    always just doing heavy work. "Slow" is a performance/cost question, not
 *    a correctness one — and any genuine stall is already captured by isError
 *    or retryCount above, making duration both noisy and redundant.
 *
 * Returns a Map from node-id → non-empty array of human-readable reason strings.
 * Nodes absent from the map are clean.
 */
export function computeAutoSuspect(graph: AuditGraph): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const flag = (id: string, reason: string) => {
    const existing = result.get(id)
    if (existing) existing.push(reason)
    else result.set(id, [reason])
  }

  for (const n of graph.nodes) {
    if (n.kind === 'tool') {
      // Signal 1: error
      if (n.isError) flag(n.id, 'tool error')
      // Signal 2: retry
      if (n.retryCount && n.retryCount > 0) flag(n.id, `retried ${n.retryCount}×`)
    }

    // Signal 3: artifact rewritten multiple times
    if (n.kind === 'artifact' && Array.isArray(n.versions) && n.versions.length > 1) {
      flag(n.id, `rewritten ${n.versions.length}×`)
    }
  }

  return result
}
