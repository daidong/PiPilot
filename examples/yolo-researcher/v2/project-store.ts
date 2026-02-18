import * as path from 'node:path'

import type {
  ClaimEvidence,
  EvidenceLine,
  PlanBoardItem,
  PlanItemStatus,
  ProjectControlPanel,
  ProjectUpdate
} from './types.js'
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
const MAX_PLAN_BOARD_ITEMS = 40
const MAX_PLAN_EVIDENCE_PATHS = 40
const EVIDENCE_PATH_RE = /^runs\/turn-\d{4}\/.+/
const PLAN_ID_RE = /^P\d+$/i
const BOOTSTRAP_PLAN_PLACEHOLDER = 'Bootstrap pending: replace with 3-5 goal-specific next actions in the next turn.'

function defaultPanel(goal: string, successCriteria: string[], defaultRuntime: string): ProjectControlPanel {
  const planBoard: PlanBoardItem[] = [{
    id: 'P1',
    title: BOOTSTRAP_PLAN_PLACEHOLDER,
    status: 'ACTIVE',
    doneDefinition: [],
    evidencePaths: [],
    priority: 1
  }]

  return {
    title: 'YOLO Research Project',
    goal,
    successCriteria: successCriteria.length > 0 ? successCriteria : ['Define measurable success criteria.'],
    planBoard,
    currentPlan: deriveCurrentPlanFromPlanBoard(planBoard),
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

function normalizePlanId(value: string): string {
  const trimmed = value.trim().toUpperCase()
  if (!trimmed) return ''
  if (PLAN_ID_RE.test(trimmed)) return trimmed
  const numeric = trimmed.replace(/[^0-9]/g, '')
  if (!numeric) return ''
  return `P${Number.parseInt(numeric, 10)}`
}

function parsePlanStatus(value: string): PlanItemStatus | null {
  const normalized = value.trim().toUpperCase()
  if (normalized === 'TODO') return 'TODO'
  if (normalized === 'ACTIVE') return 'ACTIVE'
  if (normalized === 'DONE') return 'DONE'
  if (normalized === 'BLOCKED') return 'BLOCKED'
  if (normalized === 'DROPPED') return 'DROPPED'
  return null
}

function comparePlanItems(a: PlanBoardItem, b: PlanBoardItem): number {
  if (a.priority !== b.priority) return a.priority - b.priority
  const aid = Number.parseInt(a.id.replace(/^P/i, ''), 10)
  const bid = Number.parseInt(b.id.replace(/^P/i, ''), 10)
  return (Number.isFinite(aid) ? aid : Number.MAX_SAFE_INTEGER) - (Number.isFinite(bid) ? bid : Number.MAX_SAFE_INTEGER)
}

function nextPlanId(planBoard: PlanBoardItem[]): string {
  let maxId = 0
  for (const item of planBoard) {
    const parsed = Number.parseInt(item.id.replace(/^P/i, ''), 10)
    if (Number.isFinite(parsed) && parsed > maxId) {
      maxId = parsed
    }
  }
  return `P${maxId + 1}`
}

function dedupePlanText(lines: string[]): string[] {
  return dedupePreserveOrder(lines.map((line) => line.trim())).filter(Boolean)
}

function normalizePlanEvidencePaths(paths: string[]): string[] {
  return dedupePreserveOrder(paths.map((entry) => entry.trim()))
    .filter((entry) => EVIDENCE_PATH_RE.test(entry))
    .slice(-MAX_PLAN_EVIDENCE_PATHS)
}

function dedupePlanBoardItems(items: PlanBoardItem[]): PlanBoardItem[] {
  const byId = new Map<string, PlanBoardItem>()
  for (const item of items) {
    const id = normalizePlanId(item.id)
    if (!id) continue

    const status = parsePlanStatus(item.status) ?? 'TODO'
    const normalized: PlanBoardItem = {
      id,
      title: item.title.trim(),
      status,
      doneDefinition: dedupePlanText(item.doneDefinition ?? []),
      evidencePaths: normalizePlanEvidencePaths(item.evidencePaths ?? []),
      nextMinStep: item.nextMinStep?.trim() || undefined,
      dropReason: item.dropReason?.trim() || undefined,
      replacedBy: typeof item.replacedBy === 'string'
        ? (normalizePlanId(item.replacedBy) || null)
        : (item.replacedBy ?? null),
      priority: Number.isFinite(item.priority) ? item.priority : 1000
    }

    if (!normalized.title) continue
    byId.set(id, normalized)
  }
  return [...byId.values()]
}

function ensureSingleActiveItem(items: PlanBoardItem[]): PlanBoardItem[] {
  const activeItems = items.filter((item) => item.status === 'ACTIVE')
  if (activeItems.length <= 1) return items

  const keeper = [...activeItems].sort(comparePlanItems)[0]
  return items.map((item) => {
    if (item.id === keeper.id) return item
    if (item.status !== 'ACTIVE') return item
    return {
      ...item,
      status: item.status === 'ACTIVE' ? 'TODO' : item.status
    }
  })
}

function deriveCurrentPlanFromPlanBoard(planBoard: PlanBoardItem[]): string[] {
  const ordered = [...planBoard]
    .filter((item) => item.status !== 'DONE' && item.status !== 'DROPPED')
    .sort(comparePlanItems)

  if (ordered.length === 0) return [BOOTSTRAP_PLAN_PLACEHOLDER]
  return ordered
    .slice(0, MAX_PLAN_ITEMS)
    .map((item) => `${item.id}: ${item.title}`)
}

function normalizePlanBoard(items: PlanBoardItem[]): PlanBoardItem[] {
  let normalized = dedupePlanBoardItems(items)
  normalized = normalized
    .filter((item) => item.title.trim().length > 0)
    .slice(0, MAX_PLAN_BOARD_ITEMS)
    .map((item, index) => ({
      ...item,
      priority: Number.isFinite(item.priority) ? item.priority : index + 1,
      evidencePaths: normalizePlanEvidencePaths(item.evidencePaths)
    }))

  normalized = ensureSingleActiveItem(normalized)

  if (normalized.length === 0) {
    normalized = [{
      id: 'P1',
      title: BOOTSTRAP_PLAN_PLACEHOLDER,
      status: 'ACTIVE',
      doneDefinition: [],
      evidencePaths: [],
      priority: 1
    }]
  }

  const hasActive = normalized.some((item) => item.status === 'ACTIVE')
  if (!hasActive) {
    const firstCandidate = [...normalized]
      .filter((item) => item.status === 'TODO' || item.status === 'BLOCKED')
      .sort(comparePlanItems)[0]
    if (firstCandidate) {
      normalized = normalized.map((item) => item.id === firstCandidate.id
        ? { ...item, status: 'ACTIVE' }
        : item)
    }
  }

  return normalized.sort(comparePlanItems)
}

function createPlanBoardFromCurrentPlan(currentPlan: string[]): PlanBoardItem[] {
  const lines = dedupePlanText(currentPlan).slice(0, MAX_PLAN_ITEMS)
  if (lines.length === 0) {
    return [{
      id: 'P1',
      title: BOOTSTRAP_PLAN_PLACEHOLDER,
      status: 'ACTIVE',
      doneDefinition: [],
      evidencePaths: [],
      priority: 1
    }]
  }

  return lines.map((line, index) => {
    const idMatch = /^(P\d+)\s*[:|-]\s*/i.exec(line)
    const id = normalizePlanId(idMatch?.[1] ?? `P${index + 1}`)
    const title = line.replace(/^(P\d+)\s*[:|-]\s*/i, '').trim() || line.trim()

    return {
      id,
      title,
      status: index === 0 ? 'ACTIVE' : 'TODO',
      doneDefinition: [],
      evidencePaths: [],
      priority: index + 1
    } satisfies PlanBoardItem
  })
}

function mergeCurrentPlanIntoPlanBoard(planBoard: PlanBoardItem[], nextPlanLines: string[]): PlanBoardItem[] {
  const normalizedLines = dedupePlanText(nextPlanLines).slice(0, MAX_PLAN_ITEMS)
  if (normalizedLines.length === 0) return planBoard

  const ordered = [...planBoard].sort(comparePlanItems)
  const openItems = ordered.filter((item) => item.status !== 'DONE' && item.status !== 'DROPPED')
  const byId = new Map<string, PlanBoardItem>(ordered.map((item) => [item.id, { ...item }]))
  let priorityCursor = 1

  for (let idx = 0; idx < normalizedLines.length; idx += 1) {
    const rawLine = normalizedLines[idx]
    const idMatch = /^(P\d+)\s*[:|-]\s*/i.exec(rawLine)
    const requestedId = normalizePlanId(idMatch?.[1] ?? '')
    const title = rawLine.replace(/^(P\d+)\s*[:|-]\s*/i, '').trim() || rawLine

    let target: PlanBoardItem | undefined
    if (requestedId && byId.has(requestedId)) {
      target = byId.get(requestedId)
    } else {
      target = openItems[idx]
    }

    if (target) {
      byId.set(target.id, {
        ...target,
        title,
        status: idx === 0 ? 'ACTIVE' : (target.status === 'ACTIVE' ? 'TODO' : target.status),
        priority: priorityCursor++
      })
      continue
    }

    const id = requestedId || nextPlanId([...byId.values()])
    byId.set(id, {
      id,
      title,
      status: idx === 0 ? 'ACTIVE' : 'TODO',
      doneDefinition: [],
      evidencePaths: [],
      priority: priorityCursor++
    })
  }

  const remaining = [...byId.values()]
    .filter((item) => !normalizedLines.some((line) => {
      const explicit = normalizePlanId((/^(P\d+)\s*[:|-]/i.exec(line)?.[1]) || '')
      return explicit ? explicit === item.id : false
    }))
    .sort(comparePlanItems)

  for (const item of remaining) {
    if (item.priority < priorityCursor) continue
    item.priority = priorityCursor++
  }

  return normalizePlanBoard([...byId.values()])
}

function mergePlanBoardWithCarryForward(currentBoard: PlanBoardItem[], incomingBoard: PlanBoardItem[]): PlanBoardItem[] {
  const currentMap = new Map<string, PlanBoardItem>(
    currentBoard.map((item) => [
      item.id,
      {
        ...item,
        doneDefinition: [...item.doneDefinition],
        evidencePaths: [...item.evidencePaths]
      }
    ])
  )

  const mergedMap = new Map<string, PlanBoardItem>(currentMap)
  for (const incoming of incomingBoard) {
    const previous = currentMap.get(incoming.id)
    mergedMap.set(incoming.id, {
      ...incoming,
      doneDefinition: incoming.doneDefinition.length > 0
        ? [...incoming.doneDefinition]
        : [...(previous?.doneDefinition ?? [])],
      evidencePaths: normalizePlanEvidencePaths([
        ...(previous?.evidencePaths ?? []),
        ...incoming.evidencePaths
      ]),
      nextMinStep: incoming.nextMinStep ?? previous?.nextMinStep,
      priority: Number.isFinite(incoming.priority)
        ? incoming.priority
        : (previous?.priority ?? incoming.priority)
    })
  }

  return normalizePlanBoard([...mergedMap.values()])
}

function parseStatusChangeTarget(statusChange: string, fallbackId: string): { id: string; toStatus: PlanItemStatus | null } {
  const trimmed = statusChange.trim()
  if (!trimmed) return { id: fallbackId, toStatus: null }

  const idMatch = /(P\d+)/i.exec(trimmed)
  const id = normalizePlanId(idMatch?.[1] ?? fallbackId) || fallbackId
  const transitionMatch = /->\s*(TODO|ACTIVE|DONE|BLOCKED|DROPPED)/i.exec(trimmed)
  const toStatus = parsePlanStatus(transitionMatch?.[1] ?? '')
  return { id, toStatus }
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
  let planSubsection = ''
  let planListField: '' | 'doneDefinition' | 'evidencePaths' = ''
  let activePlanItem: PlanBoardItem | null = null
  let priorityCounter = 1
  const parsedPlanBoard: PlanBoardItem[] = []

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      planListField = ''
      continue
    }

    if (line.startsWith('# Project:')) {
      panel.title = line.slice('# Project:'.length).trim() || panel.title
      continue
    }

    if (line.startsWith('## ')) {
      section = line.slice(3).trim().toLowerCase()
      planSubsection = ''
      planListField = ''
      activePlanItem = null
      continue
    }

    if (section.startsWith('plan board')) {
      if (line.startsWith('### ')) {
        planSubsection = line.slice(4).trim().toLowerCase()
        planListField = ''
        activePlanItem = null
        continue
      }

      const itemMatch = /^-\s*(P\d+)\s+\[(TODO|ACTIVE|DONE|BLOCKED|DROPPED)\]\s+(.+)$/.exec(line)
      if (itemMatch) {
        const id = normalizePlanId(itemMatch[1] ?? '')
        const status = parsePlanStatus(itemMatch[2] ?? '') ?? 'TODO'
        const title = (itemMatch[3] ?? '').trim()
        if (!id || !title) {
          activePlanItem = null
          planListField = ''
          continue
        }
        const basePriority = planSubsection.startsWith('active')
          ? 1_000
          : planSubsection.startsWith('top-3')
            ? 2_000
            : planSubsection.startsWith('backlog')
              ? 3_000
              : planSubsection.startsWith('closed')
                ? 4_000
                : 5_000
        const item: PlanBoardItem = {
          id,
          title,
          status,
          doneDefinition: [],
          evidencePaths: [],
          priority: basePriority + priorityCounter
        }
        priorityCounter += 1
        parsedPlanBoard.push(item)
        activePlanItem = item
        planListField = ''
        continue
      }

      if (!activePlanItem) continue

      if (line === 'done_definition:' || line.startsWith('done_definition:')) {
        planListField = 'doneDefinition'
        const inlineValue = line.split(':').slice(1).join(':').trim()
        if (inlineValue) activePlanItem.doneDefinition.push(inlineValue)
        continue
      }
      if (line === 'evidence:' || line.startsWith('evidence:')) {
        planListField = 'evidencePaths'
        const inlineValue = line.split(':').slice(1).join(':').trim()
        if (inlineValue && EVIDENCE_PATH_RE.test(inlineValue)) activePlanItem.evidencePaths.push(inlineValue)
        continue
      }
      if (line === 'next_min_step:' || line.startsWith('next_min_step:')) {
        planListField = ''
        const inlineValue = line.split(':').slice(1).join(':').trim()
        if (inlineValue) activePlanItem.nextMinStep = inlineValue
        continue
      }
      if (line.startsWith('drop_reason:')) {
        activePlanItem.dropReason = line.slice('drop_reason:'.length).trim() || undefined
        continue
      }
      if (line.startsWith('replaced_by:')) {
        const value = line.slice('replaced_by:'.length).trim()
        activePlanItem.replacedBy = value ? (normalizePlanId(value) || null) : null
        continue
      }
      if (line.startsWith('- ') && planListField) {
        const listValue = line.slice(2).trim()
        if (!listValue) continue
        if (planListField === 'doneDefinition') {
          activePlanItem.doneDefinition.push(listValue)
        } else if (EVIDENCE_PATH_RE.test(listValue)) {
          activePlanItem.evidencePaths.push(listValue)
        }
        continue
      }
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

  const normalizedParsedBoard = normalizePlanBoard(parsedPlanBoard)
  if (parsedPlanBoard.length > 0) {
    panel.planBoard = normalizedParsedBoard
  } else {
    panel.planBoard = normalizePlanBoard(createPlanBoardFromCurrentPlan(panel.currentPlan))
  }

  panel.currentPlan = deriveCurrentPlanFromPlanBoard(panel.planBoard)

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
  const normalizedPlanBoard = normalizePlanBoard(panel.planBoard)
  const next: ProjectControlPanel = {
    ...panel,
    planBoard: normalizedPlanBoard,
    currentPlan: deriveCurrentPlanFromPlanBoard(normalizedPlanBoard).slice(0, MAX_PLAN_ITEMS),
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

function renderPlanBoardItem(item: PlanBoardItem): string[] {
  const lines = [
    `- ${item.id} [${item.status}] ${item.title}`,
    '  done_definition:'
  ]

  if (item.doneDefinition.length > 0) {
    for (const row of item.doneDefinition) {
      lines.push(`  - ${row}`)
    }
  } else {
    lines.push('  - (define measurable completion criteria)')
  }

  lines.push('  evidence:')
  if (item.evidencePaths.length > 0) {
    for (const row of item.evidencePaths) {
      lines.push(`  - ${row}`)
    }
  } else {
    lines.push('  - (none)')
  }

  if (item.nextMinStep?.trim()) {
    lines.push(`  next_min_step: ${item.nextMinStep.trim()}`)
  }
  if (item.dropReason?.trim()) {
    lines.push(`  drop_reason: ${item.dropReason.trim()}`)
  }
  if (item.replacedBy !== undefined) {
    lines.push(`  replaced_by: ${item.replacedBy ?? 'null'}`)
  }

  return lines
}

function renderProject(panel: ProjectControlPanel): string {
  const normalizedPlanBoard = normalizePlanBoard(panel.planBoard)
  const orderedOpen = normalizedPlanBoard.filter((item) => item.status !== 'DONE' && item.status !== 'DROPPED').sort(comparePlanItems)
  const activeItems = orderedOpen.filter((item) => item.status === 'ACTIVE')
  const topNextItems = orderedOpen.filter((item) => item.status !== 'ACTIVE').slice(0, 3)
  const backlogItems = orderedOpen.filter((item) => item.status !== 'ACTIVE').slice(3)
  const closedItems = normalizedPlanBoard.filter((item) => item.status === 'DONE' || item.status === 'DROPPED').sort(comparePlanItems)

  const successLines = panel.successCriteria.map((criterion) => `- Success criteria (measurable): ${criterion}`)
  const derivedPlanLines = deriveCurrentPlanFromPlanBoard(normalizedPlanBoard).slice(0, MAX_PLAN_ITEMS)
  const planLines = derivedPlanLines.length > 0
    ? derivedPlanLines.map((item, index) => `${index + 1}. ${item}`)
    : ['1. Define next concrete action.']

  const lines: string[] = [
    `# Project: ${panel.title}`,
    '',
    '## Goal & Success Criteria',
    `- Goal: ${panel.goal}`,
    ...successLines,
    '',
    '## Plan Board (stable IDs)',
    '',
    '### Active (WIP limit = 1)',
    ...(activeItems.length > 0
      ? activeItems.flatMap((item) => [...renderPlanBoardItem(item), ''])
      : ['- None.', '']),
    '### Top-3 Next',
    ...(topNextItems.length > 0
      ? topNextItems.flatMap((item) => [...renderPlanBoardItem(item), ''])
      : ['- None.', '']),
    '### Backlog',
    ...(backlogItems.length > 0
      ? backlogItems.flatMap((item) => [...renderPlanBoardItem(item), ''])
      : ['- None.', '']),
    '### Closed',
    ...(closedItems.length > 0
      ? closedItems.flatMap((item) => [...renderPlanBoardItem(item), ''])
      : ['- None.', '']),
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
      planBoard: normalizePlanBoard(panel.planBoard),
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

    if (update.planBoard) {
      for (const [index, item] of update.planBoard.entries()) {
        const id = normalizePlanId(item.id)
        if (!id) {
          throw new Error(`planBoard[${index}] id must be P<number>`)
        }
        const status = parsePlanStatus(item.status)
        if (!status) {
          throw new Error(`planBoard[${index}] status must be TODO|ACTIVE|DONE|BLOCKED|DROPPED`)
        }
        for (const ep of item.evidencePaths ?? []) {
          if (!EVIDENCE_PATH_RE.test(ep.trim())) {
            throw new Error(`planBoard[${index}] evidence path must start with runs/turn-xxxx/`)
          }
        }

        if (status === 'DROPPED') {
          const dropReason = item.dropReason?.trim() || ''
          if (!dropReason) {
            throw new Error(`planBoard[${index}] DROPPED item requires dropReason`)
          }
          const hasEvidence = (item.evidencePaths ?? []).some((entry) => EVIDENCE_PATH_RE.test(entry.trim()))
          if (!hasEvidence) {
            throw new Error(`planBoard[${index}] DROPPED item requires evidencePaths`)
          }
          if (!Object.prototype.hasOwnProperty.call(item, 'replacedBy')) {
            throw new Error(`planBoard[${index}] DROPPED item requires replacedBy (P<number>|null)`)
          }
          if (item.replacedBy !== null && item.replacedBy !== undefined) {
            const replacement = normalizePlanId(String(item.replacedBy))
            if (!replacement) {
              throw new Error(`planBoard[${index}] replacedBy must be P<number> or null`)
            }
          }
        }
      }
    }

    const boardFromUpdate = update.planBoard
      ? mergePlanBoardWithCarryForward(current.planBoard, dedupePlanBoardItems(update.planBoard))
      : current.planBoard
    const mergedBoard = update.currentPlan
      ? mergeCurrentPlanIntoPlanBoard(boardFromUpdate, update.currentPlan)
      : boardFromUpdate

    const next: ProjectControlPanel = {
      ...current,
      goal: update.goal?.trim() ? update.goal.trim() : current.goal,
      successCriteria: update.successCriteria
        ? dedupePreserveOrder(update.successCriteria)
        : current.successCriteria,
      planBoard: mergedBoard,
      currentPlan: deriveCurrentPlanFromPlanBoard(mergedBoard).slice(0, MAX_PLAN_ITEMS),
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

  async applyTurnPlanDelta(input: {
    activePlanId?: string
    statusChange?: string
    delta?: string
    evidencePaths?: string[]
    turnStatus: 'success' | 'no_delta' | 'failure' | 'blocked' | 'ask_user' | 'stopped'
    dropReason?: string
    replacedBy?: string | null
    allowStructuralPlanChanges?: boolean
  }): Promise<{ panel: ProjectControlPanel; applied: boolean; warning?: string }> {
    const current = await this.load()
    const requestedId = normalizePlanId(input.activePlanId ?? '')
    if (!requestedId) {
      return { panel: current, applied: false, warning: 'active_plan_id missing' }
    }

    const parsedStatusChange = parseStatusChangeTarget(input.statusChange ?? '', requestedId)
    const targetId = parsedStatusChange.id || requestedId
    if (targetId !== requestedId) {
      return {
        panel: current,
        applied: false,
        warning: 'status_change target must match active_plan_id'
      }
    }
    const targetIndex = current.planBoard.findIndex((item) => item.id === targetId)
    if (targetIndex < 0) {
      return { panel: current, applied: false, warning: `active_plan_id not found: ${targetId}` }
    }

    const evidencePaths = normalizePlanEvidencePaths(input.evidencePaths ?? [])
    const board = current.planBoard.map((item) => ({ ...item, evidencePaths: [...item.evidencePaths], doneDefinition: [...item.doneDefinition] }))
    const target = { ...board[targetIndex]! }
    target.evidencePaths = normalizePlanEvidencePaths([...target.evidencePaths, ...evidencePaths])

    let nextStatus = parsedStatusChange.toStatus
    if (!nextStatus) {
      if (input.turnStatus === 'blocked') nextStatus = 'BLOCKED'
      else if (input.turnStatus === 'success') nextStatus = target.status === 'DONE' ? 'DONE' : 'ACTIVE'
    }

    if (nextStatus === 'DROPPED') {
      if (!input.allowStructuralPlanChanges) {
        return {
          panel: current,
          applied: false,
          warning: 'dropping plan item is only allowed during planner checkpoint turns'
        }
      }
      if (input.turnStatus !== 'success') {
        return {
          panel: current,
          applied: false,
          warning: 'non-success turn cannot drop plan item'
        }
      }
      const hasDropReason = Boolean(input.dropReason?.trim())
      const hasEvidence = evidencePaths.length > 0
      const hasReplacementBinding = input.replacedBy !== undefined
      if (!hasDropReason || !hasEvidence || !hasReplacementBinding) {
        return {
          panel: current,
          applied: false,
          warning: 'dropping plan item requires drop_reason, evidence, and replaced_by'
        }
      }
      target.dropReason = input.dropReason?.trim()
      target.replacedBy = input.replacedBy === null
        ? null
        : (normalizePlanId(input.replacedBy ?? '') || null)
    }

    if (nextStatus === 'DONE' && input.turnStatus !== 'success') {
      return {
        panel: current,
        applied: false,
        warning: 'non-success turn cannot mark plan item DONE'
      }
    }

    if (nextStatus) {
      target.status = nextStatus
    }

    if (input.delta?.trim()) {
      target.nextMinStep = input.delta.trim()
    }

    if (target.status === 'ACTIVE') {
      for (let index = 0; index < board.length; index += 1) {
        const item = board[index]
        if (!item || item.id === target.id) continue
        if (item.status === 'ACTIVE') {
          board[index] = { ...item, status: 'TODO' }
        }
      }
    }

    board[targetIndex] = target
    const normalizedBoard = normalizePlanBoard(board)
    const next: ProjectControlPanel = {
      ...current,
      planBoard: normalizedBoard,
      currentPlan: deriveCurrentPlanFromPlanBoard(normalizedBoard).slice(0, MAX_PLAN_ITEMS)
    }

    await this.save(next)
    return { panel: await this.load(), applied: true }
  }
}
