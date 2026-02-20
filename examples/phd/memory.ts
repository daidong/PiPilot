import type {
  DecisionRecord,
  MemoryDigest,
  MemoryEntry,
  MemoryEntryType,
  ReviewPacket
} from './types.js'
import type { ProjectPaths } from './store.js'
import {
  loadMemoryEntries,
  loadMemoryState,
  saveMemoryEntries,
  saveMemoryMarkdown,
  saveMemoryState
} from './store.js'

interface MemoryStoreInit {
  paths: ProjectPaths
}

const MAX_MEMORY_ENTRIES = 600

function nowIso(): string {
  return new Date().toISOString()
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function clipText(value: string, max = 180): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 3)}...`
}

function normalizeType(type: MemoryEntryType): MemoryEntryType {
  return type
}

function memorySignature(input: {
  type: MemoryEntryType
  text: string
  packet_id?: string
  decision_id?: string
}): string {
  return [
    input.type,
    input.text.trim().toLowerCase(),
    input.packet_id ?? '',
    input.decision_id ?? ''
  ].join('|')
}

function hasQuestionMark(value: string): boolean {
  return value.includes('?') || value.includes('？')
}

function section(title: string, lines: string[]): string[] {
  return [`## ${title}`, '', ...(lines.length > 0 ? lines : ['- None.']), '']
}

function renderMemoryMarkdown(entries: MemoryEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.created_at.localeCompare(b.created_at))

  const byType = (type: MemoryEntryType): MemoryEntry[] =>
    sorted.filter((entry) => entry.type === type)

  const fmt = (entry: MemoryEntry): string => {
    const evidence = entry.evidence_paths.length > 0 ? ` (evidence: ${entry.evidence_paths.join(', ')})` : ''
    const refs = [
      entry.packet_id ? `packet=${entry.packet_id}` : '',
      entry.decision_id ? `decision=${entry.decision_id}` : '',
      entry.task_ids.length > 0 ? `tasks=${entry.task_ids.join(',')}` : ''
    ].filter(Boolean).join(', ')
    const meta = refs ? ` [${refs}]` : ''
    return `- ${entry.text}${evidence}${meta}`
  }

  const lines: string[] = ['# Project Memory', '']
  lines.push(...section('Facts', byType('fact').map(fmt)))
  lines.push(...section('Constraints', byType('constraint').map(fmt)))
  lines.push(...section('Decisions', byType('decision').map(fmt)))
  lines.push(...section('Open Questions', byType('question').map(fmt)))
  lines.push(...section('Risks', byType('risk').map(fmt)))
  lines.push(...section('Key Artifacts', byType('artifact').map(fmt)))
  lines.push(...section('Notes', byType('note').map(fmt)))
  return `${lines.join('\n')}\n`
}

function takeLatest(entries: MemoryEntry[], type: MemoryEntryType, maxItems: number): string[] {
  return entries
    .filter((entry) => entry.type === type)
    .slice(-maxItems)
    .map((entry) => entry.text)
}

function inferQuestionTexts(packet: ReviewPacket): string[] {
  const fromAsk = (packet.ask ?? [])
    .map((item) => item.question.trim())
    .filter(Boolean)
  const fromWhatChanged = (packet.what_changed ?? [])
    .filter((line) => hasQuestionMark(line))
    .map((line) => line.trim())
  return dedupeStrings([...fromAsk, ...fromWhatChanged])
}

function inferFactTexts(packet: ReviewPacket): string[] {
  const facts: string[] = []
  if (packet.summary?.trim()) facts.push(packet.summary.trim())
  for (const line of packet.what_changed ?? []) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (hasQuestionMark(trimmed)) continue
    facts.push(trimmed)
  }
  return dedupeStrings(facts)
}

function inferConstraintTexts(packet: ReviewPacket): string[] {
  const constraints: string[] = []
  for (const risk of packet.risks ?? []) {
    const trimmed = risk.trim()
    if (!trimmed) continue
    constraints.push(trimmed)
  }
  return dedupeStrings(constraints)
}

export class MemoryStore {
  constructor(private readonly paths: ProjectPaths) {}

  static async create(input: MemoryStoreInit): Promise<MemoryStore> {
    return new MemoryStore(input.paths)
  }

  async load(): Promise<MemoryEntry[]> {
    return loadMemoryEntries(this.paths)
  }

  async getDigest(maxItems = 6): Promise<MemoryDigest> {
    const entries = await this.load()
    return {
      latest_facts: takeLatest(entries, 'fact', maxItems),
      latest_constraints: takeLatest(entries, 'constraint', maxItems),
      latest_decisions: takeLatest(entries, 'decision', maxItems),
      open_questions: takeLatest(entries, 'question', maxItems),
      key_artifacts: takeLatest(entries, 'artifact', maxItems)
    }
  }

  private async appendMany(records: Array<Omit<MemoryEntry, 'id' | 'created_at'>>): Promise<MemoryEntry[]> {
    if (records.length === 0) return []

    const [entries, memoryState] = await Promise.all([
      loadMemoryEntries(this.paths),
      loadMemoryState(this.paths)
    ])

    const known = new Set<string>(entries.map((entry) => memorySignature(entry)))
    const created: MemoryEntry[] = []
    for (const row of records) {
      const signature = memorySignature(row)
      if (known.has(signature)) continue
      known.add(signature)

      const id = `M-${String(memoryState.next_seq).padStart(4, '0')}`
      memoryState.next_seq += 1
      created.push({
        id,
        type: normalizeType(row.type),
        text: clipText(row.text),
        packet_id: row.packet_id,
        decision_id: row.decision_id,
        task_ids: dedupeStrings(row.task_ids),
        evidence_paths: dedupeStrings(row.evidence_paths),
        created_at: nowIso()
      })
    }

    const merged = [...entries, ...created]
    const compacted = merged.length > MAX_MEMORY_ENTRIES
      ? merged.slice(merged.length - MAX_MEMORY_ENTRIES)
      : merged

    await Promise.all([
      saveMemoryEntries(this.paths, compacted),
      saveMemoryState(this.paths, memoryState),
      saveMemoryMarkdown(this.paths, renderMemoryMarkdown(compacted))
    ])
    return created
  }

  async recordPacket(packet: ReviewPacket): Promise<MemoryEntry[]> {
    const evidencePaths = dedupeStrings([
      ...packet.deliverables.map((item) => item.path),
      ...packet.preflight.checks.map((item) => item.log ?? '').filter(Boolean)
    ])

    const records: Array<Omit<MemoryEntry, 'id' | 'created_at'>> = []

    for (const fact of inferFactTexts(packet)) {
      records.push({
        type: 'fact',
        text: fact,
        packet_id: packet.packet_id,
        task_ids: packet.task_ids,
        evidence_paths: evidencePaths
      })
    }

    for (const constraint of inferConstraintTexts(packet)) {
      records.push({
        type: 'constraint',
        text: constraint,
        packet_id: packet.packet_id,
        task_ids: packet.task_ids,
        evidence_paths: evidencePaths
      })
      records.push({
        type: 'risk',
        text: constraint,
        packet_id: packet.packet_id,
        task_ids: packet.task_ids,
        evidence_paths: evidencePaths
      })
    }

    for (const question of inferQuestionTexts(packet)) {
      records.push({
        type: 'question',
        text: question,
        packet_id: packet.packet_id,
        task_ids: packet.task_ids,
        evidence_paths: evidencePaths
      })
    }

    for (const deliverable of packet.deliverables) {
      records.push({
        type: 'artifact',
        text: `${deliverable.path} (${deliverable.kind})`,
        packet_id: packet.packet_id,
        task_ids: packet.task_ids,
        evidence_paths: [deliverable.path]
      })
    }

    if (packet.recommendation?.rationale) {
      records.push({
        type: 'note',
        text: `Recommendation: ${packet.recommendation.suggested_user_action} - ${packet.recommendation.rationale}`,
        packet_id: packet.packet_id,
        task_ids: packet.task_ids,
        evidence_paths: evidencePaths
      })
    }

    return this.appendMany(records)
  }

  async recordDecision(input: {
    decision: DecisionRecord
    packet: ReviewPacket
  }): Promise<MemoryEntry[]> {
    const decisionText = [
      `User decision ${input.decision.decision_id}: ${input.decision.action} on ${input.packet.packet_id}.`,
      input.decision.comment ? `Comment: ${input.decision.comment}` : '',
      input.decision.impacts.length > 0 ? `Impacts: ${input.decision.impacts.join('; ')}` : ''
    ].filter(Boolean).join(' ')

    const evidencePaths = dedupeStrings(input.packet.deliverables.map((item) => item.path))
    const rows: Array<Omit<MemoryEntry, 'id' | 'created_at'>> = [{
      type: 'decision',
      text: decisionText,
      packet_id: input.packet.packet_id,
      decision_id: input.decision.decision_id,
      task_ids: input.packet.task_ids,
      evidence_paths: evidencePaths
    }]

    if (input.decision.action === 'request_changes' && input.decision.comment) {
      rows.push({
        type: 'constraint',
        text: `Must address user feedback: ${input.decision.comment}`,
        packet_id: input.packet.packet_id,
        decision_id: input.decision.decision_id,
        task_ids: input.packet.task_ids,
        evidence_paths: evidencePaths
      })
    }

    return this.appendMany(rows)
  }
}
