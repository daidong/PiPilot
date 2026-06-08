import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { AuditGraph, GraphNode } from '../types.js'
import { buildGraphIndex, classifyEdge } from '../graph-utils.js'
import { extractClaims, extractResponseTextFromStep, type Deliverable } from './claims.js'
import { buildEvidencePacket } from './packet.js'
import { judgeClaim, type AuditCallLlm } from './judge.js'
import type { AuditReport, AuditRunResult, ClaimVerdict } from './types.js'

const AUDIT_DIR = '.research-pilot/audit'

function timeOf(n: GraphNode): number {
  const start = Number(n.startNs)
  if (Number.isFinite(start) && start > 0) return start
  return n.stepIndex ?? 0
}

function chooseLatestStep(graph: AuditGraph): GraphNode | undefined {
  return graph.nodes
    .filter(n => n.kind === 'step')
    .sort((a, b) =>
      timeOf(b) - timeOf(a) ||
      (b.stepIndex ?? -1) - (a.stepIndex ?? -1) ||
      b.id.localeCompare(a.id),
    )[0]
}

function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120)
}

export function identifyDeliverable(
  graph: AuditGraph,
  opts: { targetStepId?: string | null; textOverride?: string } = {},
): { deliverable: Deliverable; inputNodes: Set<string>; productNodes: Set<string> } {
  const { nodeById, incoming, outgoing } = buildGraphIndex(graph)
  const target = opts.targetStepId ? nodeById.get(opts.targetStepId) : chooseLatestStep(graph)
  const claimsSource = target?.id ?? null
  const productNodes = new Set<string>()
  const inputNodes = new Set<string>()

  if (target) {
    for (const ret of incoming.get(target.id) ?? []) {
      if (ret.rel !== 'returns') continue
      const toolId = ret.source as string
      for (const out of outgoing.get(toolId) ?? []) {
        const cls = classifyEdge(out.rel)
        if (cls === 'data-out') productNodes.add(out.target as string)
      }
      for (const into of incoming.get(toolId) ?? []) {
        const cls = classifyEdge(into.rel)
        if (cls === 'data-in') inputNodes.add(into.source as string)
      }
    }
  }

  const text = opts.textOverride ?? extractResponseTextFromStep(target)
  const deliverableId = claimsSource
    ? safeSegment(claimsSource)
    : `deliverable-${Date.now()}`
  return {
    deliverable: {
      id: deliverableId,
      claimsSource,
      products: [...productNodes],
      text,
    },
    inputNodes,
    productNodes,
  }
}

function coverage(deliverableId: string, claims: ClaimVerdict[]): AuditReport {
  const supported = claims.filter(c => c.verdict === 'supported').length
  const contradicted = claims.filter(c => c.verdict === 'contradicted').length
  const ungrounded = claims.filter(c => c.verdict === 'ungrounded').length
  const notCheckable = claims.filter(c => c.verdict === 'not_checkable').length
  return {
    deliverableId,
    claims,
    coverage: {
      total: claims.length,
      checkable: claims.length - notCheckable,
      supported,
      contradicted,
      ungrounded,
      notCheckable,
    },
    contradictions: claims.filter(c => c.verdict === 'contradicted'),
  }
}

async function persistReport(projectPath: string, report: AuditReport): Promise<string> {
  const dir = join(projectPath, AUDIT_DIR, safeSegment(report.deliverableId))
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${stamp}.json`)
  await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf8')
  return file
}

export async function runAuditPipeline(opts: {
  projectPath: string
  graph: AuditGraph
  callLlm: AuditCallLlm
  targetStepId?: string | null
  textOverride?: string
  persist?: boolean
}): Promise<AuditRunResult> {
  const { deliverable, inputNodes, productNodes } = identifyDeliverable(opts.graph, {
    targetStepId: opts.targetStepId,
    textOverride: opts.textOverride,
  })
  const claims = extractClaims(deliverable.text, opts.graph, { inputNodes, productNodes })
  const packets = claims.map(claim => buildEvidencePacket(claim, opts.graph))
  const verdicts: ClaimVerdict[] = []

  for (let i = 0; i < claims.length; i++) {
    verdicts.push(await judgeClaim(claims[i], packets[i], {
      callLlm: opts.callLlm,
      projectPath: opts.projectPath,
    }))
  }

  const report = coverage(deliverable.id, verdicts)
  const logPath = opts.persist === false ? undefined : await persistReport(opts.projectPath, report)
  return { report, claims, packets, ...(logPath && { logPath }) }
}
