import type { AuditGraph, GraphNode } from './types.js'
import { buildGraphIndex } from './graph-utils.js'
import { edgeCausalClass } from './prune.js'

// §3.2 — LLM adjudication of flagged-but-ambiguous nodes. Topology can't tell
// whether a non-errored flagged node was *abandoned* (the agent rejected it) or
// *used* (it fed the answer): the `returns` edge records that a result entered
// the next prompt, not whether the LLM acted on it. The one place that
// distinction lives is the reasoning text. This stage reads it and decides.
//
// Safety bias (§3.2): greying removes a node from audit scope, so a false prune
// HIDES a real problem. We grey ONLY on explicit rejection evidence quoted from
// the reasoning; everything else — ambiguity, parse failure, no quote — KEEPS.
// This layer is additive: the deterministic §3.1 result is always the baseline,
// and every decision here is logged so the scope stays re-inspectable (§8).

export type AdjudicationCallLlm = (systemPrompt: string, userContent: string) => Promise<string>

export interface AdjudicationDecision {
  nodeId: string
  decision: 'abandoned' | 'used'
  reason: string
  quotedReasoning: string
}

export interface AdjudicationCandidate {
  nodeId: string
  flags: string[]
  /** Reasoning text of the step that owns/consumes this node (the evidence). */
  reasoning: string
  /** One-line structural summary (errored / redone / divergent result). */
  context: string
}

const SYSTEM_PROMPT = `You adjudicate whether an AI agent ABANDONED or USED a flagged intermediate result, for a provenance-pruning step.

You are given a flagged node (a tool call or its product), a one-line structural context, and the agent's reasoning text from the surrounding step. The execution graph already knows the result entered the next prompt; it does NOT know whether the agent acted on it. That is what you decide, from the reasoning ONLY.

Decide:
- "abandoned": the reasoning shows the agent REJECTED, discarded, redid, superseded, or RECOVERED FROM this result (e.g. "that failed, let me try again", "ignore the previous output", "the command errored, so I switched to...", "this is wrong, redoing with..."). For a FAILED operation, recovering from the error — noticing it failed and working around it — counts as abandoned: the failed output never reached the answer.
- "used": anything else — the agent adopted it, built on it, or the reasoning is silent/ambiguous about rejection or recovery.

CRITICAL SAFETY RULE: default to "used". Only answer "abandoned" when you can quote the explicit rejection verbatim from the reasoning. If there is no such quote, answer "used".

Return STRICT JSON only:
{"decision":"abandoned"|"used","reason":"short explanation","quotedReasoning":"verbatim rejection quote, or empty string"}`

function parseJsonObject(text: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const p = JSON.parse(s)
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const direct = tryParse(text)
  if (direct) return direct
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return tryParse(text.slice(start, end + 1))
}

function responseText(node: GraphNode | undefined): string {
  const raw = node?.rawEvents?.find(e => e.name === 'pipilot.chat.response_text')?.body
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      // Read both `text` and `thinking` blocks — the agent's reasoning (where a
      // rejection/recovery quote lives) is in `thinking`, not `text`.
      return parsed.map(b => {
        if (!b || typeof b !== 'object') return ''
        const o = b as Record<string, unknown>
        if (typeof o.text === 'string') return o.text
        if (typeof o.thinking === 'string') return o.thinking
        return ''
      }).filter(Boolean).join('\n\n')
    }
    if (typeof parsed === 'string') return parsed
  } catch {
    return raw
  }
  return raw
}

// The step whose reasoning is the evidence for a flagged node: for a tool, the
// step that consumed it (`returns` → step); for a product, the step that
// consumed the producing tool. Falls back to the causally-nearest step.
function evidenceStep(node: GraphNode, graph: AuditGraph): GraphNode | undefined {
  const { nodeById, outgoing, incoming } = buildGraphIndex(graph)
  if (node.kind === 'tool') {
    const ret = (outgoing.get(node.id) ?? []).find(e => e.rel === 'returns')
    const step = ret && nodeById.get(ret.target)
    if (step?.kind === 'step') return step
  }
  // walk forward over causal edges to the first step
  const queue = [node.id]
  const seen = new Set<string>([node.id])
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const e of outgoing.get(id) ?? []) {
      if (edgeCausalClass(e.rel) !== 'causal') continue
      const next = nodeById.get(e.target)
      if (next?.kind === 'step') return next
      if (next && !seen.has(next.id)) { seen.add(next.id); queue.push(next.id) }
    }
  }
  // last resort: the producing tool's consuming step
  for (const e of incoming.get(node.id) ?? []) {
    const src = nodeById.get(e.source)
    if (src?.kind === 'step') return src
  }
  return undefined
}

/**
 * Select the ambiguous flagged nodes worth adjudicating. We target the flags
 * topology can't settle — that are NOT already deterministically pruned:
 *   - `repeated_intent` (a do-over that may or may not have been abandoned),
 *   - `reread` (re-read of the same file),
 *   - `error` — a tool that FAILED but whose result still flowed onward
 *     (`returns`). Topology can't tell whether the agent *recovered* from the
 *     failure (read the error, worked around it → the failed result never
 *     reached the answer → abandoned) or actually *built on* the failed output
 *     (→ used; the "answer depends on a failed operation" finding stands). Only
 *     the reasoning text exposes which, so the LLM reads it and gives a reason.
 * Errored-AND-unconsumed branches are handled deterministically in §3.1 and
 * never reach here. Each candidate carries its evidence reasoning.
 */
export function selectAdjudicationCandidates(
  graph: AuditGraph,
  prune: { flags: Record<string, string[]>; prunedNodes: string[] },
  ambiguousFlags: string[] = ['repeated_intent', 'reread', 'error'],
): AdjudicationCandidate[] {
  const { nodeById } = buildGraphIndex(graph)
  const prunedIds = new Set(prune.prunedNodes)
  const out: AdjudicationCandidate[] = []
  for (const [nodeId, flags] of Object.entries(prune.flags)) {
    if (prunedIds.has(nodeId)) continue
    const hit = flags.filter(f => ambiguousFlags.includes(f))
    if (hit.length === 0) continue
    const node = nodeById.get(nodeId)
    if (!node) continue
    const step = evidenceStep(node, graph)
    out.push({
      nodeId,
      flags: hit,
      reasoning: responseText(step),
      context: `${node.kind}${node.toolName ? ` ${node.toolName}` : ''} flagged ${hit.join(', ')}${node.isError ? ' (errored)' : ''}`,
    })
  }
  return out.sort((a, b) => a.nodeId.localeCompare(b.nodeId))
}

function keep(nodeId: string, reason: string): AdjudicationDecision {
  return { nodeId, decision: 'used', reason, quotedReasoning: '' }
}

/** Adjudicate one candidate. Enforces the safety bias deterministically: an
 * "abandoned" verdict survives only if its quote actually appears in the
 * reasoning; otherwise it is downgraded to "used" (KEEP). */
export async function adjudicateCandidate(
  candidate: AdjudicationCandidate,
  callLlm: AdjudicationCallLlm,
): Promise<AdjudicationDecision> {
  if (!candidate.reasoning.trim()) {
    return keep(candidate.nodeId, 'no reasoning text available — keeping (safety bias)')
  }
  const user = JSON.stringify({
    flaggedNode: candidate.nodeId,
    flags: candidate.flags,
    structuralContext: candidate.context,
    reasoning: candidate.reasoning,
  }, null, 2)
  const raw = parseJsonObject(await callLlm(SYSTEM_PROMPT, user))
  if (!raw) return keep(candidate.nodeId, 'unparseable adjudication — keeping (safety bias)')

  const decision = raw.decision === 'abandoned' ? 'abandoned' : 'used'
  const reason = typeof raw.reason === 'string' ? raw.reason : ''
  const quoted = typeof raw.quotedReasoning === 'string' ? raw.quotedReasoning.trim() : ''

  if (decision === 'abandoned' && quoted && candidate.reasoning.includes(quoted)) {
    return { nodeId: candidate.nodeId, decision: 'abandoned', reason, quotedReasoning: quoted }
  }
  return keep(candidate.nodeId, reason || 'no verbatim rejection quote — keeping (safety bias)')
}

/** Batch-adjudicate; returns only the nodes greyed as abandoned plus every
 * decision for the run log. The deterministic prune set stays the baseline. */
export async function adjudicateFlaggedNodes(opts: {
  candidates: AdjudicationCandidate[]
  callLlm: AdjudicationCallLlm
}): Promise<{ decisions: AdjudicationDecision[]; greyed: string[] }> {
  const decisions: AdjudicationDecision[] = []
  for (const c of opts.candidates) decisions.push(await adjudicateCandidate(c, opts.callLlm))
  return { decisions, greyed: decisions.filter(d => d.decision === 'abandoned').map(d => d.nodeId) }
}
