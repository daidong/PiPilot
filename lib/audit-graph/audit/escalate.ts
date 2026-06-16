import type { AuditGraph } from '../types.js'
import { buildEvidencePacket } from './packet.js'
import { collectAuditImages, judgeClaim, type AuditCallLlm } from './judge.js'
import type { Claim, FaithfulnessFinding } from './types.js'

// §5.2 C.5 — optional escalation. A finding the deterministic path left
// `unverifiable` because it is VISUAL or SEMANTIC ("Figure 7 shows a shorter
// burst") is sent, with the relevant evidence images, to the DEMOTED judge for
// a best-effort verdict. This is the only place the old claim-entailment judge
// survives, and it never runs on the main path — only on this residue, only
// when the user asks, and only with a vision-capable model (§6.1 auditVisionModel).

// Heuristic for "is this worth a vision call": the claim text references a
// figure/plot/image or otherwise reads as a visual/semantic assertion. Pure
// "no comparable feature" residue with no visual cue is left alone.
const VISUAL_RX = /\b(figure|fig\.?|plot|chart|graph|image|diagram|panel|axis|curve|shows?|depicts?|illustrat|visualiz)/i

export function isEscalatable(finding: FaithfulnessFinding): boolean {
  return finding.verdict === 'unverifiable' && VISUAL_RX.test(finding.claimText)
}

function findingToClaim(finding: FaithfulnessFinding): Claim {
  return {
    id: finding.claimId,
    text: finding.claimText,
    blockKind: 'paragraph',
    anchors: finding.anchorNodeIds.map(nodeId => ({ token: nodeId, nodeId, side: 'input' as const })),
  }
}

/**
 * Escalate one unverifiable finding to the vision judge and fold the result
 * back into a FaithfulnessFinding. The judge's entailment verdict is mapped to
 * the correspondence scale: supported→match, contradicted→mismatch, everything
 * else stays unverifiable (the judge couldn't settle it either). `callLlm` must
 * be the vision-capable, telemetry-free audit channel.
 */
export async function escalateFinding(opts: {
  finding: FaithfulnessFinding
  graph: AuditGraph
  callLlm: AuditCallLlm
  projectPath?: string
}): Promise<FaithfulnessFinding> {
  const { finding } = opts
  if (finding.anchorNodeIds.length === 0) return finding

  const claim = findingToClaim(finding)
  const packet = buildEvidencePacket(claim, opts.graph)
  const images = await collectAuditImages(packet, opts.projectPath)
  // No image evidence → nothing for a vision judge to add; leave it unverifiable.
  if (images.length === 0) return finding

  const verdict = await judgeClaim(claim, packet, { callLlm: opts.callLlm, projectPath: opts.projectPath })

  const mapped: FaithfulnessFinding['verdict'] =
    verdict.verdict === 'supported' ? 'match'
    : verdict.verdict === 'contradicted' ? 'mismatch'
    : 'unverifiable'

  return {
    ...finding,
    verdict: mapped,
    actual: verdict.explanation
      ? `escalated: ${verdict.explanation}`
      : `escalated → ${verdict.verdict}`,
    evidence: [
      ...finding.evidence,
      ...verdict.usedEvidenceIds.map(id => ({ nodeId: id, detail: 'vision-judge evidence' })),
    ],
  }
}
