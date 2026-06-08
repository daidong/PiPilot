import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PATHS } from '../../types.js'
import type { Claim, ClaimType, ClaimVerdict, EvidencePacket, Verdict } from './types.js'

export interface AuditImage { data: string; mimeType: string }
export type AuditCallLlm = (
  systemPrompt: string,
  userContent: string,
  images?: AuditImage[],
) => Promise<string>

const CLAIM_TYPES: ClaimType[] = ['provenance', 'computation', 'action', 'citation', 'synthesis']

interface JudgeRaw {
  verdict?: Verdict | 'insufficient'
  claimType?: unknown
  usedEvidenceIds?: unknown
  groundedInSession?: unknown
  quotedContradiction?: unknown
  explanation?: unknown
}

const SYSTEM_PROMPT = `You perform a faithfulness audit.
Judge only whether the supplied evidence supports the claim. Do not judge whether the evidence itself is correct.
You may cite only evidence ids present in the packet.
If figure images are attached, they are the recorded evidence the agent saw. Verify visual claims (axis ranges, values read off a plot, what a figure shows) against those images, and cite the image evidence id.
Return strict JSON only:
{
  "verdict": "supported" | "contradicted" | "ungrounded" | "not_checkable" | "insufficient",
  "claimType": "provenance" | "computation" | "action" | "citation" | "synthesis",
  "usedEvidenceIds": ["node-id"],
  "groundedInSession": true,
  "quotedContradiction": "required verbatim quote when contradicted",
  "explanation": "short reason"
}
Rules:
- claimType labels the claim; it is metadata only and does not affect the verdict.
- contradicted MUST quote the contradicting text verbatim.
- supported MUST cite at least one evidence id.
- If packet excerpts are insufficient to decide, use verdict "insufficient".`

function parseJsonObject(text: string): JudgeRaw | null {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed as JudgeRaw : null
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      return parsed && typeof parsed === 'object' ? parsed as JudgeRaw : null
    } catch {
      return null
    }
  }
}

function buildUserPrompt(claim: Claim, packet: EvidencePacket): string {
  return JSON.stringify({
    claim: {
      id: claim.id,
      text: claim.text,
      anchors: claim.anchors,
    },
    evidence: {
      nodes: packet.nodes.map(n => ({
        id: n.id,
        kind: n.kind,
        label: n.label,
        excerpt: n.excerpt,
        truncated: n.truncated,
      })),
      edges: packet.edges,
    },
  }, null, 2)
}

function quotedTextAppears(quote: string | undefined, packet: EvidencePacket): boolean {
  if (!quote) return false
  return packet.nodes.some(n => n.excerpt.includes(quote))
}

export function validateJudgeOutput(
  claim: Claim,
  packet: EvidencePacket,
  raw: JudgeRaw | null,
): ClaimVerdict {
  if (!raw) {
    return {
      claimId: claim.id,
      claimText: claim.text,
      verdict: 'ungrounded',
      usedEvidenceIds: [],
      groundedInSession: false,
      explanation: 'Judge returned invalid JSON.',
      valid: false,
      invalidReason: 'invalid_judge_output',
    }
  }

  const claimType = CLAIM_TYPES.includes(raw.claimType as ClaimType)
    ? (raw.claimType as ClaimType)
    : undefined

  let verdict: Verdict = raw.verdict === 'insufficient'
    ? 'ungrounded'
    : raw.verdict && ['supported', 'contradicted', 'ungrounded', 'not_checkable'].includes(raw.verdict)
      ? raw.verdict
      : 'ungrounded'

  const packetIds = new Set(packet.nodes.map(n => n.id))
  const usedEvidenceIds = Array.isArray(raw.usedEvidenceIds)
    ? raw.usedEvidenceIds.filter((id): id is string => typeof id === 'string')
    : []
  const invalidIds = usedEvidenceIds.filter(id => !packetIds.has(id))
  const explanation = typeof raw.explanation === 'string' ? raw.explanation : ''
  const quotedContradiction = typeof raw.quotedContradiction === 'string' ? raw.quotedContradiction : undefined

  if (verdict === 'supported' && usedEvidenceIds.length === 0) {
    verdict = 'ungrounded'
  }

  const invalidContradiction =
    verdict === 'contradicted' && !quotedTextAppears(quotedContradiction, packet)
  const valid = invalidIds.length === 0 && !invalidContradiction && (
    raw.verdict === 'supported' ||
    raw.verdict === 'contradicted' ||
    raw.verdict === 'ungrounded' ||
    raw.verdict === 'not_checkable' ||
    raw.verdict === 'insufficient'
  )

  return {
    claimId: claim.id,
    claimText: claim.text,
    ...(claimType && { claimType }),
    verdict,
    usedEvidenceIds,
    groundedInSession: typeof raw.groundedInSession === 'boolean' ? raw.groundedInSession : usedEvidenceIds.length > 0,
    ...(quotedContradiction && { quotedContradiction }),
    explanation,
    valid,
    ...(valid ? {} : { invalidReason: 'invalid_judge_output' }),
  }
}

function blobPath(projectPath: string, hash: string): string {
  const h = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash
  return join(projectPath, PATHS.blobs, h.slice(0, 2), h)
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
function mimeForPath(p: string): string {
  const ext = p.toLowerCase().split('.').pop()
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}
function resolveEvidencePath(projectPath: string | undefined, p: string): string {
  if (p.startsWith('~')) return join(homedir(), p.slice(1))
  if (p.startsWith('/')) return p
  return projectPath ? join(projectPath, p) : p
}

/**
 * Pull figure images out of the packet so a vision judge can verify visual
 * claims (axis ranges, plot readings). Image evidence is read from the file
 * node's recorded path, falling back to the blob store. Capped in count and
 * per-image size to keep the request bounded.
 */
export async function collectAuditImages(
  packet: EvidencePacket,
  projectPath: string | undefined,
  max = 4,
  maxBytes = 3_500_000,
): Promise<AuditImage[]> {
  const out: AuditImage[] = []
  for (const node of packet.nodes) {
    if (out.length >= max) break
    if (node.kind !== 'file' || !node.path || !IMAGE_EXT.test(node.path)) continue
    let buf: Buffer | null = null
    try {
      buf = await fs.readFile(resolveEvidencePath(projectPath, node.path))
    } catch {
      if (projectPath && node.blobHash) {
        try { buf = await fs.readFile(blobPath(projectPath, node.blobHash)) } catch { buf = null }
      }
    }
    if (!buf || buf.length === 0 || buf.length > maxBytes) continue
    out.push({ data: buf.toString('base64'), mimeType: mimeForPath(node.path) })
  }
  return out
}

async function expandPacketFromBlobs(projectPath: string, packet: EvidencePacket): Promise<EvidencePacket> {
  const expanded = await Promise.all(packet.nodes.map(async node => {
    if (!node.truncated || !node.blobHash) return node
    try {
      const full = await fs.readFile(blobPath(projectPath, node.blobHash), 'utf8')
      return { ...node, excerpt: full, truncated: false }
    } catch {
      return node
    }
  }))
  return {
    ...packet,
    nodes: expanded,
    expandable: expanded.filter(n => n.truncated && n.blobHash).map(n => n.id),
  }
}

export async function judgeClaim(
  claim: Claim,
  packet: EvidencePacket,
  opts: { callLlm: AuditCallLlm; projectPath?: string },
): Promise<ClaimVerdict> {
  // P4: the skip gate is anchor-presence, not a guessed type. A claim that
  // names nothing in the graph has no evidence to check it against, so it is
  // not_checkable without spending an LLM call. Anchored-but-interpretive
  // claims still go to the judge, which may itself return not_checkable.
  if (claim.anchors.length === 0) {
    return {
      claimId: claim.id,
      claimText: claim.text,
      verdict: 'not_checkable',
      usedEvidenceIds: [],
      groundedInSession: false,
      explanation: 'No graph anchor — nothing to check this claim against.',
      valid: true,
    }
  }

  const images = await collectAuditImages(packet, opts.projectPath)
  const first = parseJsonObject(await opts.callLlm(SYSTEM_PROMPT, buildUserPrompt(claim, packet), images))
  if (first?.verdict === 'insufficient' && opts.projectPath && packet.expandable.length > 0) {
    const expanded = await expandPacketFromBlobs(opts.projectPath, packet)
    const second = parseJsonObject(await opts.callLlm(SYSTEM_PROMPT, buildUserPrompt(claim, expanded), images))
    return validateJudgeOutput(claim, expanded, second)
  }
  return validateJudgeOutput(claim, packet, first)
}
