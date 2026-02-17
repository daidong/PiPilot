import * as path from 'node:path'

import type { ClaimEvidence, EvidenceLine, ProjectControlPanel, ProjectUpdate } from './types.js'
import { clamp, fileExists, readTextOrEmpty, writeText } from './utils.js'

const MAX_TOTAL_LINES = 150
const MAX_FACTS = 20
const MAX_KEY_ARTIFACTS = 20
const MAX_DONE = 20
const MAX_CONSTRAINTS = 10
const MAX_CLAIMS = 15
const MIN_FACTS_TO_KEEP_DURING_COMPRESSION = 5
const DEFAULT_FACTS_TO_KEEP_DURING_COMPRESSION = 10
const MAX_PLAN_ITEMS = 5
const EVIDENCE_PATH_RE = /^runs\/turn-\d{4}\/.+/
const BOOTSTRAP_PLAN_PLACEHOLDER = 'Bootstrap pending: replace with 3-5 goal-specific next actions in the next turn.'

function defaultPanel(goal: string, successCriteria: string[], defaultRuntime: string): ProjectControlPanel {
  return {
    title: 'YOLO Research Project',
    goal,
    successCriteria: successCriteria.length > 0 ? successCriteria : ['Define measurable success criteria.'],
    currentPlan: [BOOTSTRAP_PLAN_PLACEHOLDER],
    facts: [],
    archivedFacts: [],
    done: [],
    constraints: [],
    hypotheses: [],
    keyArtifacts: [],
    defaultRuntime,
    claims: []
  }
}

function parseEvidenceLine(line: string): EvidenceLine | null {
  const match = /^[-*]\s+(.*?)\s*\(evidence:\s*(runs\/turn-\d{4}\/[^)]+)\)\s*$/.exec(line.trim())
  if (!match) return null
  return {
    text: match[1]?.trim() ?? '',
    evidencePath: match[2]?.trim() ?? ''
  }
}

function renderEvidenceLine(line: EvidenceLine): string {
  return `- ${line.text} (evidence: ${line.evidencePath})`
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function dedupeEvidenceLines(lines: EvidenceLine[]): EvidenceLine[] {
  const seen = new Set<string>()
  const result: EvidenceLine[] = []
  for (const line of lines) {
    const text = line.text.trim()
    const evidencePath = line.evidencePath.trim()
    if (!text || !evidencePath) continue
    const key = `${text}::${evidencePath}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ text, evidencePath })
  }
  return result
}

function parseClaimLine(line: string): ClaimEvidence | null {
  // Format: - [COVERED] Claim text (evidence: path1, path2)
  // or: - [UNCOVERED] Claim text
  // or: - [PARTIAL] Claim text (evidence: path1)
  const match = /^[-*]\s+\[(COVERED|UNCOVERED|PARTIAL)\]\s+(.*?)(?:\s*\(evidence:\s*([^)]+)\))?\s*$/.exec(line.trim())
  if (!match) return null
  const statusRaw = match[1]?.toLowerCase() ?? 'uncovered'
  const claim = match[2]?.trim() ?? ''
  const evidenceRaw = match[3]?.trim() ?? ''
  if (!claim) return null

  const status: ClaimEvidence['status'] = statusRaw === 'covered' ? 'covered' : statusRaw === 'partial' ? 'partial' : 'uncovered'
  const evidencePaths = evidenceRaw ? evidenceRaw.split(',').map(p => p.trim()).filter(Boolean) : []
  return { claim, evidencePaths, status }
}

function renderClaimLine(claim: ClaimEvidence): string {
  const tag = claim.status.toUpperCase()
  if (claim.evidencePaths.length > 0) {
    return `- [${tag}] ${claim.claim} (evidence: ${claim.evidencePaths.join(', ')})`
  }
  return `- [${tag}] ${claim.claim}`
}

function dedupeClaimsByText(claims: ClaimEvidence[]): ClaimEvidence[] {
  const seen = new Map<string, ClaimEvidence>()
  for (const claim of claims) {
    const key = claim.claim.toLowerCase().replace(/\s+/g, ' ').trim()
    const existing = seen.get(key)
    if (existing) {
      // Merge evidence paths, upgrade status
      existing.evidencePaths = [...new Set([...existing.evidencePaths, ...claim.evidencePaths])]
      if (claim.status === 'covered') existing.status = 'covered'
      else if (claim.status === 'partial' && existing.status === 'uncovered') existing.status = 'partial'
    } else {
      seen.set(key, { ...claim })
    }
  }
  return [...seen.values()]
}

function parseProject(raw: string, fallbackGoal: string, fallbackSuccessCriteria: string[], defaultRuntime: string): ProjectControlPanel {
  const panel = defaultPanel(fallbackGoal, fallbackSuccessCriteria, defaultRuntime)
  if (!raw.trim()) return panel

  let section = ''
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('# Project:')) {
      panel.title = line.slice('# Project:'.length).trim() || panel.title
      continue
    }

    if (line.startsWith('## ')) {
      section = line.slice(3).trim().toLowerCase()
      continue
    }

    if (section.startsWith('goal & success criteria')) {
      if (line.startsWith('- Goal:')) {
        panel.goal = line.slice('- Goal:'.length).trim() || panel.goal
      } else if (line.startsWith('- Success criteria')) {
        const value = line.split(':').slice(1).join(':').trim()
        if (value) panel.successCriteria = dedupePreserveOrder([...panel.successCriteria, value])
      }
      continue
    }

    if (section.startsWith('current plan')) {
      const planItem = line.replace(/^\d+\.\s+/, '').trim()
      if (planItem) panel.currentPlan.push(planItem)
      continue
    }

    if (section === 'facts (must include evidence pointers)' || section === 'facts (with evidence pointers)') {
      const parsed = parseEvidenceLine(line)
      if (parsed) panel.facts.push(parsed)
      continue
    }

    if (section === 'facts (archived)') {
      const parsed = parseEvidenceLine(line)
      if (parsed) panel.archivedFacts.push(parsed)
      continue
    }

    if (section.startsWith('done (do-not-repeat)')) {
      const parsed = parseEvidenceLine(line)
      if (parsed) panel.done.push(parsed)
      continue
    }

    if (section.startsWith('constraints / environment')) {
      if (line.startsWith('- default_runtime:')) {
        const runtime = line.slice('- default_runtime:'.length).trim()
        if (runtime) panel.defaultRuntime = runtime
        continue
      }
      const parsed = parseEvidenceLine(line)
      if (parsed) panel.constraints.push(parsed)
      continue
    }

    if (section.startsWith('hypotheses')) {
      const hypothesis = line.replace(/^[-*]\s+/, '').trim()
      if (hypothesis) panel.hypotheses.push(hypothesis)
      continue
    }

    if (section === 'claims & evidence') {
      const parsed = parseClaimLine(line)
      if (parsed) panel.claims.push(parsed)
      continue
    }

    if (section === 'key artifacts') {
      const artifact = line.replace(/^[-*]\s+/, '').trim()
      if (artifact) panel.keyArtifacts.push(artifact)
      continue
    }
  }

  panel.currentPlan = dedupePreserveOrder(panel.currentPlan).slice(0, MAX_PLAN_ITEMS)
  panel.done = dedupeEvidenceLines(panel.done).slice(-MAX_DONE)
  panel.hypotheses = dedupePreserveOrder(panel.hypotheses)
  panel.keyArtifacts = dedupePreserveOrder(panel.keyArtifacts).slice(-MAX_KEY_ARTIFACTS)
  panel.successCriteria = dedupePreserveOrder(panel.successCriteria)
  panel.claims = dedupeClaimsByText(panel.claims).slice(-MAX_CLAIMS)

  if (!panel.goal.trim()) panel.goal = fallbackGoal
  if (panel.successCriteria.length === 0) panel.successCriteria = fallbackSuccessCriteria.length > 0
    ? [...fallbackSuccessCriteria]
    : ['Define measurable success criteria.']

  return panel
}

function ensureEvidenceLines(lines: EvidenceLine[], label: string): EvidenceLine[] {
  return lines.map((line, idx) => {
    const text = line.text.trim()
    const evidencePath = line.evidencePath.trim()
    if (!text) {
      throw new Error(`${label}[${idx}] must have non-empty text`)
    }
    if (!EVIDENCE_PATH_RE.test(evidencePath)) {
      throw new Error(`${label}[${idx}] evidence path must start with runs/turn-xxxx/`)
    }
    return { text, evidencePath }
  })
}

function compressPanel(panel: ProjectControlPanel): ProjectControlPanel {
  const next: ProjectControlPanel = {
    ...panel,
    currentPlan: panel.currentPlan.slice(0, MAX_PLAN_ITEMS),
    facts: [...panel.facts],
    archivedFacts: [...panel.archivedFacts],
    done: panel.done.slice(-MAX_DONE),
    keyArtifacts: panel.keyArtifacts.slice(-MAX_KEY_ARTIFACTS),
    claims: dedupeClaimsByText(panel.claims).slice(-MAX_CLAIMS)
  }

  while (next.facts.length > MAX_FACTS) {
    const moved = next.facts.shift()
    if (!moved) break
    next.archivedFacts.push(moved)
  }

  // Constraints compression: keep last MAX_CONSTRAINTS
  while (next.constraints.length > MAX_CONSTRAINTS) {
    next.constraints.shift() // remove oldest
  }

  let rendered = renderProject(next)
  let lines = rendered.split(/\r?\n/).length
  while (lines > MAX_TOTAL_LINES && next.facts.length > MIN_FACTS_TO_KEEP_DURING_COMPRESSION) {
    const keepCount = clamp(DEFAULT_FACTS_TO_KEEP_DURING_COMPRESSION, MIN_FACTS_TO_KEEP_DURING_COMPRESSION, next.facts.length)
    if (next.facts.length <= keepCount) break
    const moved = next.facts.shift()
    if (moved) next.archivedFacts.push(moved)
    rendered = renderProject(next)
    lines = rendered.split(/\r?\n/).length
  }

  return next
}

function renderProject(panel: ProjectControlPanel): string {
  const successLines = panel.successCriteria.map((criterion) => `- Success criteria (measurable): ${criterion}`)
  const planLines = panel.currentPlan.length > 0
    ? panel.currentPlan.map((item, index) => `${index + 1}. ${item}`)
    : ['1. Define next concrete action.']

  const lines: string[] = [
    `# Project: ${panel.title}`,
    '',
    '## Goal & Success Criteria',
    `- Goal: ${panel.goal}`,
    ...successLines,
    '',
    '## Current Plan (Next 3-5 actions)',
    ...planLines,
    '',
    '## Facts (must include evidence pointers)',
    ...(panel.facts.length > 0 ? panel.facts.map(renderEvidenceLine) : ['- None yet.']),
    '',
    '## Facts (Archived)',
    ...(panel.archivedFacts.length > 0 ? panel.archivedFacts.map(renderEvidenceLine) : ['- None.']),
    '',
    '## Done (Do-not-repeat)',
    ...(panel.done.length > 0 ? panel.done.map(renderEvidenceLine) : ['- None yet.']),
    '',
    '## Constraints / Environment (must include evidence pointers)',
    `- default_runtime: ${panel.defaultRuntime}`,
    ...(panel.constraints.length > 0 ? panel.constraints.map(renderEvidenceLine) : ['- None recorded yet.']),
    '',
    '## Hypotheses [HYP] (unverified)',
    ...(panel.hypotheses.length > 0 ? panel.hypotheses.map((line) => `- ${line.startsWith('[HYP]') ? line : `[HYP] ${line}`}`) : ['- [HYP] None yet.']),
    '',
    '## Claims & Evidence',
    ...(panel.claims.length > 0 ? panel.claims.map(renderClaimLine) : ['- None yet.']),
    '',
    '## Key Artifacts',
    ...(panel.keyArtifacts.length > 0 ? panel.keyArtifacts.map((artifact) => `- ${artifact}`) : ['- None yet.']),
    ''
  ]

  return `${lines.join('\n')}\n`
}

export class ProjectStore {
  readonly filePath: string

  constructor(
    yoloRoot: string,
    private readonly fallbackGoal: string,
    private readonly fallbackSuccessCriteria: string[],
    private readonly fallbackRuntime: string
  ) {
    this.filePath = path.join(yoloRoot, 'PROJECT.md')
  }

  async init(): Promise<ProjectControlPanel> {
    if (!(await fileExists(this.filePath))) {
      const initial = defaultPanel(this.fallbackGoal, this.fallbackSuccessCriteria, this.fallbackRuntime)
      await writeText(this.filePath, renderProject(initial))
      return initial
    }
    const panel = await this.load()
    await this.save(panel)
    return panel
  }

  async load(): Promise<ProjectControlPanel> {
    const raw = await readTextOrEmpty(this.filePath)
    const panel = parseProject(raw, this.fallbackGoal, this.fallbackSuccessCriteria, this.fallbackRuntime)
    return compressPanel(panel)
  }

  async save(panel: ProjectControlPanel): Promise<void> {
    const normalized = compressPanel({
      ...panel,
      facts: dedupeEvidenceLines(ensureEvidenceLines(panel.facts, 'Facts')),
      constraints: dedupeEvidenceLines(ensureEvidenceLines(panel.constraints, 'Constraints')).slice(-MAX_CONSTRAINTS),
      archivedFacts: dedupeEvidenceLines(ensureEvidenceLines(panel.archivedFacts, 'Facts (Archived)')),
      done: dedupeEvidenceLines(ensureEvidenceLines(panel.done, 'Done')).slice(-MAX_DONE),
      keyArtifacts: dedupePreserveOrder(panel.keyArtifacts).slice(-MAX_KEY_ARTIFACTS),
      hypotheses: dedupePreserveOrder(panel.hypotheses),
      currentPlan: dedupePreserveOrder(panel.currentPlan).slice(0, MAX_PLAN_ITEMS),
      successCriteria: dedupePreserveOrder(panel.successCriteria),
      claims: dedupeClaimsByText(panel.claims).slice(-MAX_CLAIMS)
    })

    await writeText(this.filePath, renderProject(normalized))
  }

  async applyUpdate(update: ProjectUpdate): Promise<ProjectControlPanel> {
    const current = await this.load()

    // Claims evidence validation
    if (update.claims) {
      for (const claim of update.claims) {
        for (const ep of claim.evidencePaths) {
          if (!EVIDENCE_PATH_RE.test(ep.trim())) {
            throw new Error(`Claim "${claim.claim}" evidence path must start with runs/turn-xxxx/`)
          }
        }
      }
    }

    const next: ProjectControlPanel = {
      ...current,
      goal: update.goal?.trim() ? update.goal.trim() : current.goal,
      successCriteria: update.successCriteria
        ? dedupePreserveOrder(update.successCriteria)
        : current.successCriteria,
      currentPlan: update.currentPlan
        ? dedupePreserveOrder(update.currentPlan).slice(0, MAX_PLAN_ITEMS)
        : current.currentPlan,
      defaultRuntime: update.defaultRuntime?.trim() ? update.defaultRuntime.trim() : current.defaultRuntime,
      facts: update.facts
        ? dedupeEvidenceLines([...current.facts, ...ensureEvidenceLines(update.facts, 'Facts')])
        : current.facts,
      done: update.done
        ? dedupeEvidenceLines([...current.done, ...ensureEvidenceLines(update.done, 'Done')]).slice(-MAX_DONE)
        : current.done,
      constraints: update.constraints
        ? dedupeEvidenceLines([...current.constraints, ...ensureEvidenceLines(update.constraints, 'Constraints')])
        : current.constraints,
      hypotheses: update.hypotheses
        ? [...current.hypotheses, ...dedupePreserveOrder(update.hypotheses)]
        : current.hypotheses,
      keyArtifacts: update.keyArtifacts
        ? [...current.keyArtifacts, ...dedupePreserveOrder(update.keyArtifacts)]
        : current.keyArtifacts,
      archivedFacts: current.archivedFacts,
      claims: update.claims
        ? dedupeClaimsByText([...current.claims, ...update.claims]).slice(-MAX_CLAIMS)
        : current.claims
    }

    await this.save(next)
    return this.load()
  }
}
