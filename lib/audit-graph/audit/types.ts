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
