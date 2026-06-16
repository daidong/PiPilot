import type { GraphEdge, NodeKind } from '../types.js'

export type ClaimType = 'provenance' | 'computation' | 'action' | 'citation' | 'synthesis'
export type Verdict = 'supported' | 'contradicted' | 'ungrounded' | 'not_checkable'

export interface ClaimAnchor {
  token: string
  nodeId: string
  side: 'input' | 'product'
}

export interface Claim {
  id: string
  text: string
  blockKind: 'heading' | 'paragraph' | 'bullet' | 'table-row' | 'caption'
  anchors: ClaimAnchor[]
}

export interface EvidenceNode {
  id: string
  kind: NodeKind
  label: string
  excerpt: string
  truncated: boolean
  blobHash?: string
  path?: string
}

export interface EvidencePacket {
  claimId: string
  nodes: EvidenceNode[]
  edges: GraphEdge[]
  expandable: string[]
}

export interface ClaimVerdict {
  claimId: string
  claimText?: string
  claimType?: ClaimType
  verdict: Verdict
  usedEvidenceIds: string[]
  groundedInSession: boolean
  quotedContradiction?: string
  explanation: string
  valid: boolean
  invalidReason?: string
}

export interface AuditReport {
  deliverableId: string
  claims: ClaimVerdict[]
  coverage: {
    total: number
    checkable: number
    supported: number
    contradicted: number
    ungrounded: number
    notCheckable: number
  }
  contradictions: ClaimVerdict[]
}

export interface AuditRunResult {
  report: AuditReport
  claims: Claim[]
  packets: EvidencePacket[]
  logPath?: string
}

// Process-faithfulness audit (docs/spec/audit-pipeline.md). These types are
// the deterministic primary path; the older ClaimVerdict/AuditReport shape
// above is retained for the demoted optional escalation judge.

export type ClaimScope = 'ALL' | 'EACH' | 'SOME' | null
export type FaithfulnessVerdict = 'match' | 'mismatch' | 'unverifiable'
export type FaithfulnessDimension = 'scope' | 'result' | 'action'

export interface ExtractedClaim {
  id: string
  sourceNodeId: string
  text: string
  quantities: { value: number; unit?: string }[]
  entities: string[]
  scope: ClaimScope
}

export interface FaithfulnessFinding {
  claimId: string
  claimText: string
  anchorNodeIds: string[]
  verdict: FaithfulnessVerdict
  dimension?: FaithfulnessDimension
  claimed: string
  actual: string
  evidence: { nodeId: string; detail: string }[]
  /**
   * Set when this finding came from an audit-flag targeted check (§5.3) or the
   * A1 citation check rather than from an extracted claim. The UI routes these
   * to the "Graph flags" section instead of "Mismatches". Absent on
   * claim-derived findings.
   */
  flag?: string
}

export interface NodeAuditResult {
  cacheVersion?: number
  nodeId: string
  nodeKind: NodeKind
  findings: FaithfulnessFinding[]
  triggeredFlags: string[]
}

// Deterministic roll-up across a whole focused trace (the "Audit trace" batch).
// `coverage` makes the audit's blind spot honest (§10 "never claim 100%"): tool
// operations the agent never narrated AND that tripped no flag are "silent" —
// genuinely unexamined, because faithfulness needs a claim to check against.
export interface TraceAuditSummary {
  nodesAudited: number
  claims: number
  mismatch: number
  unverifiable: number
  match: number
  flags: number
  /**
   * EVERY finding across the trace (claim + flag), each tagged with the node it
   * came from, so the UI can list them all grouped by verdict with their
   * claimed/actual reason — not just counts. `nodeId` is the source node (where
   * the claim was made / the flagged node) for click-to-focus.
   */
  findings: { nodeId: string; finding: FaithfulnessFinding }[]
  coverage: {
    /** Tool operations in the focused trace (the denominator). */
    focusedTools: number
    /** Tools a claim anchored to → checked against narrative. */
    coveredByClaim: number
    /** Uncovered by any claim, but caught by an audit-flag. */
    flaggedOnly: number
    /** Uncovered AND unflagged — truly unexamined (no narrative to check). */
    silent: number
  }
}
