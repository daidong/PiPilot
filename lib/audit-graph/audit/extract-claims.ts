import type { AuditCallLlm } from './judge.js'
import type { ClaimScope, ExtractedClaim } from './types.js'

// §5.2 C.1 — the ONE LLM call on the main audit path. It does perception only:
// read the node's natural-language output and pull each factual/operational
// assertion into the structured `ExtractedClaim` shape. It NEVER produces a
// verdict — the deterministic C.2–C.4 path (faithfulness.ts) verifies whatever
// this returns against the graph. Pure opinion / plan with no concrete
// assertion is dropped here. See docs/spec/audit-pipeline.md §5.2.

const SYSTEM_PROMPT = `You extract factual and operational claims from an AI agent's output for a process-faithfulness audit.

A downstream DETERMINISTIC checker compares each claim against a recorded execution trace. Your only job is to read the text and surface every concrete assertion. You do NOT judge truth, correctness, or faithfulness — extraction only.

The text is often the agent's REASONING (thinking), where actions are stated as
intent ("I'll read all the files", "let me analyze each CSV", "I need to check the Frozen section"). In a single execution trace the plan IS the narrative of what is being done, so treat operational intent over CONCRETE data as a claim — the deterministic checker compares it to the recorded actions either way (and returns "unverifiable", never a false mismatch, when there is nothing comparable).

Extract a claim ONLY for a sentence/clause that ASSERTS (declaratively) an OPERATION the agent performed or will perform over specific data:
- operational (any tense): "I read all the data files" / "I'll read all the data files" / "analyze each CSV" / "search arXiv"
- quantitative COUNTS: "read 10 files", "3 experiments", "across 5 datasets", "mean 4.2"
- scope-bearing: over a set ("all", "every", "each", "some", "a few")

DROP (do NOT extract):
- QUESTIONS / SPECULATION / UNCERTAINTY about the data's content — "I wonder if row 4 has a title", "is there a header?", "does table 4 contain X?", "maybe it's...", "should I check whether...". These are musings about the ANSWER, not assertions about a process step.
- contentless meta-cognition — "let me think", "this is tricky", "I should be careful", hedges, pleasantries, pure opinion.

For each claim output:
- "text": the verbatim assertion (one sentence or clause).
- "quantities": COUNTS only — "how many" of something the agent operated on. "read 10 files" -> {"value":10,"unit":"files"}; "mean 4.2" -> {"value":4.2,"unit":"mean"}.
  CRITICAL: do NOT put ORDINALS / IDENTIFIERS here. "table 4", "row 4", "Figure 2", "page 7", "step 3", "the 4th column" are LABELS that identify one item, NOT counts — their number is an identifier. Leave quantities EMPTY for those and put the label in entities instead. Empty array if no count.
- "entities": names/labels the claim is ABOUT — file/dir/dataset names, tool names, citation keys, AND ordinal references like "table 4" / "row 4" / "Figure 2". Empty array if none.
- "scope": "ALL" if it asserts over an entire set ("all/every"), "EACH" for per-item ("each/per"), "SOME" for a subset ("some/a few"), or null if not a set assertion.

Return STRICT JSON only, an array:
[{"text":"...","quantities":[{"value":10,"unit":"files"}],"entities":["data/"],"scope":"ALL"}]
Return [] if the output contains no checkable assertion.`

interface RawClaim {
  text?: unknown
  quantities?: unknown
  entities?: unknown
  scope?: unknown
}

function parseJsonArray(text: string): RawClaim[] | null {
  const tryParse = (s: string): RawClaim[] | null => {
    try {
      const parsed = JSON.parse(s)
      return Array.isArray(parsed) ? (parsed as RawClaim[]) : null
    } catch {
      return null
    }
  }
  const direct = tryParse(text)
  if (direct) return direct
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  return tryParse(text.slice(start, end + 1))
}

const SCOPES: ClaimScope[] = ['ALL', 'EACH', 'SOME']

function coerceQuantities(raw: unknown): ExtractedClaim['quantities'] {
  if (!Array.isArray(raw)) return []
  const out: ExtractedClaim['quantities'] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const value = (item as { value?: unknown }).value
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const unit = (item as { unit?: unknown }).unit
    out.push(typeof unit === 'string' && unit.trim() ? { value, unit: unit.trim() } : { value })
  }
  return out
}

function coerceEntities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((e): e is string => typeof e === 'string' && e.trim().length > 0).map(e => e.trim()))]
}

function coerceScope(raw: unknown): ClaimScope {
  return typeof raw === 'string' && SCOPES.includes(raw.toUpperCase() as ClaimScope)
    ? (raw.toUpperCase() as ClaimScope)
    : null
}

/**
 * Normalize one LLM-returned claim into the `ExtractedClaim` shape, assigning a
 * stable id and the source node. Exported for unit testing without an LLM.
 */
export function normalizeExtractedClaims(raw: RawClaim[], sourceNodeId: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = []
  for (const r of raw) {
    const text = typeof r.text === 'string' ? r.text.trim() : ''
    if (!text) continue
    out.push({
      id: `claim_${sourceNodeId}_${out.length + 1}`,
      sourceNodeId,
      text,
      quantities: coerceQuantities(r.quantities),
      entities: coerceEntities(r.entities),
      scope: coerceScope(r.scope),
    })
  }
  return out
}

/**
 * Extract claims from a single node's output text via one LLM call. Telemetry
 * isolation (§8) is the caller's responsibility — pass a `callLlm` that emits
 * no telemetry. Returns [] on empty input or unparseable output (fail-open:
 * a node with no extractable claims simply produces no findings).
 */
export async function extractClaimsLlm(opts: {
  sourceNodeId: string
  outputText: string
  callLlm: AuditCallLlm
}): Promise<ExtractedClaim[]> {
  const trimmed = opts.outputText.trim()
  if (!trimmed) return []
  const response = await opts.callLlm(SYSTEM_PROMPT, trimmed)
  const raw = parseJsonArray(response)
  // Diagnostic (main-process dev console): when a node WITH text yields no
  // claims, show whether the model output was unparseable (model/prompt issue)
  // or a genuine empty array. Decisive for "20 read, 0 claims" debugging.
  if (!raw) {
    console.warn(`[audit-extract] UNPARSEABLE response (${response.length} chars) for ${opts.sourceNodeId}: ${response.slice(0, 240)}`)
    return []
  }
  const claims = normalizeExtractedClaims(raw, opts.sourceNodeId)
  if (claims.length === 0 && process.env.RESEARCH_COPILOT_DEBUG) {
    console.warn(`[audit-extract] 0 claims from ${trimmed.length}-char input for ${opts.sourceNodeId}; model returned: ${response.slice(0, 240)}`)
  }
  return claims
}
