import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import type {
  DecisionRecord,
  EventRecord,
  EvidenceRecord,
  MemoryEntry,
  MemoryStoreState,
  ReviewPacket,
  RuntimeLedgerState,
  TaskBoard,
  TaskItem
} from './types.js'

export interface ProjectPaths {
  root: string
  taskboardPath: string
  runtimeStatePath: string
  reviewQueuePath: string
  decisionsJsonlPath: string
  decisionsMarkdownPath: string
  eventsJsonlPath: string
  reviewPacketsDir: string
  evidenceDir: string
  evidenceRegistryPath: string
  evidencePreflightDir: string
  evidenceToolEventsDir: string
  evidenceEnvDir: string
  memoryDir: string
  memoryEntriesPath: string
  memoryStatePath: string
  memoryMarkdownPath: string
  scriptsDir: string
  resultsDir: string
  notesDir: string
  uiDir: string
}

function nowIso(): string {
  return new Date().toISOString()
}

export function resolveProjectPaths(projectRoot: string): ProjectPaths {
  const root = path.resolve(projectRoot)
  return {
    root,
    taskboardPath: path.join(root, 'taskboard.yaml'),
    runtimeStatePath: path.join(root, 'state', 'runtime.json'),
    reviewQueuePath: path.join(root, 'review_queue.json'),
    decisionsJsonlPath: path.join(root, 'decisions.jsonl'),
    decisionsMarkdownPath: path.join(root, 'decisions.md'),
    eventsJsonlPath: path.join(root, 'events', 'events.jsonl'),
    reviewPacketsDir: path.join(root, 'review_packets'),
    evidenceDir: path.join(root, 'evidence'),
    evidenceRegistryPath: path.join(root, 'evidence', 'registry.json'),
    evidencePreflightDir: path.join(root, 'evidence', 'preflight'),
    evidenceToolEventsDir: path.join(root, 'evidence', 'tool-events'),
    evidenceEnvDir: path.join(root, 'evidence', 'env'),
    memoryDir: path.join(root, 'memory'),
    memoryEntriesPath: path.join(root, 'memory', 'entries.json'),
    memoryStatePath: path.join(root, 'memory', 'state.json'),
    memoryMarkdownPath: path.join(root, 'MEMORY.md'),
    scriptsDir: path.join(root, 'scripts'),
    resultsDir: path.join(root, 'results'),
    notesDir: path.join(root, 'notes'),
    uiDir: path.join(root, 'ui')
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  if (!(await exists(filePath))) return fallback
  try {
    const raw = await readText(filePath)
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function ensureTaskInvariants(task: TaskItem): TaskItem {
  const normalized = { ...task }
  if (!Array.isArray(normalized.accept_criteria) || normalized.accept_criteria.length === 0) {
    normalized.accept_criteria = ['Must be approved through a Review Packet in UI.']
  }
  if (!Array.isArray(normalized.depends_on)) normalized.depends_on = []
  if (!Array.isArray(normalized.outputs)) normalized.outputs = []
  if (!Array.isArray(normalized.blockers)) normalized.blockers = []
  if (typeof normalized.notes !== 'string') normalized.notes = ''
  return normalized
}

export function createDefaultTaskBoard(): TaskBoard {
  return {
    project: {
      title: 'PhD Research Assistant Demo',
      topic: 'event-driven review-gated research workflow',
      constraints: {
        budget: {
          max_cloud_cost_usd: 20,
          max_cpu_hours_per_batch: 8
        },
        env: {
          allowed_exec: ['local', 'vm', 'docker'],
          forbidden_ops: ['delete_raw_data']
        }
      }
    },
    tasks: [
      {
        id: 'T-001',
        title: 'Produce an initial reproducible artifact and review packet',
        status: 'TODO',
        owner: 'agent',
        priority: 'P0',
        estimate: { time_hours: 1, risk: 'medium' },
        depends_on: [],
        accept_criteria: ['Review Packet approved by user via UI decision bar'],
        outputs: ['notes/initial-hypothesis.md', 'results/baseline.csv'],
        blockers: [],
        notes: ''
      },
      {
        id: 'T-002',
        title: 'Attach preflight evidence and reproduction commands',
        status: 'TODO',
        owner: 'agent',
        priority: 'P1',
        estimate: { time_hours: 1, risk: 'low' },
        depends_on: ['T-001'],
        accept_criteria: ['Review Packet includes pass/fail preflight links'],
        outputs: ['evidence/preflight/CP-xxxx_reproduce.log'],
        blockers: [],
        notes: ''
      }
    ],
    metadata: {
      updated_at: nowIso(),
      version: 'ram-v0.2'
    }
  }
}

export function createDefaultRuntimeState(): RuntimeLedgerState {
  return {
    project_state: 'IDLE',
    next_packet_seq: 1,
    next_decision_seq: 1,
    next_evidence_seq: 1,
    last_run_mode: 'llm',
    updated_at: nowIso()
  }
}

export async function ensureProjectLayout(paths: ProjectPaths): Promise<void> {
  await fs.mkdir(paths.root, { recursive: true })
  await Promise.all([
    fs.mkdir(path.dirname(paths.runtimeStatePath), { recursive: true }),
    fs.mkdir(path.dirname(paths.eventsJsonlPath), { recursive: true }),
    fs.mkdir(paths.reviewPacketsDir, { recursive: true }),
    fs.mkdir(paths.evidenceDir, { recursive: true }),
    fs.mkdir(paths.evidencePreflightDir, { recursive: true }),
    fs.mkdir(paths.evidenceToolEventsDir, { recursive: true }),
    fs.mkdir(paths.evidenceEnvDir, { recursive: true }),
    fs.mkdir(paths.memoryDir, { recursive: true }),
    fs.mkdir(paths.scriptsDir, { recursive: true }),
    fs.mkdir(paths.resultsDir, { recursive: true }),
    fs.mkdir(paths.notesDir, { recursive: true }),
    fs.mkdir(paths.uiDir, { recursive: true })
  ])

  if (!(await exists(paths.taskboardPath))) {
    await saveTaskBoard(paths, createDefaultTaskBoard())
  }
  if (!(await exists(paths.runtimeStatePath))) {
    await saveRuntimeState(paths, createDefaultRuntimeState())
  }
  if (!(await exists(paths.reviewQueuePath))) {
    await writeJson(paths.reviewQueuePath, { pending: [] as string[] })
  }
  if (!(await exists(paths.evidenceRegistryPath))) {
    await writeJson(paths.evidenceRegistryPath, [] as EvidenceRecord[])
  }
  if (!(await exists(paths.decisionsJsonlPath))) {
    await writeText(paths.decisionsJsonlPath, '')
  }
  if (!(await exists(paths.decisionsMarkdownPath))) {
    const header = [
      '# Decisions Log',
      '',
      '| Decision ID | Time (UTC) | Packet | Action | Comment | Impacts |',
      '| --- | --- | --- | --- | --- | --- |',
      ''
    ].join('\n')
    await writeText(paths.decisionsMarkdownPath, header)
  }
  if (!(await exists(paths.eventsJsonlPath))) {
    await writeText(paths.eventsJsonlPath, '')
  }
  if (!(await exists(paths.memoryEntriesPath))) {
    await writeJson(paths.memoryEntriesPath, [] as MemoryEntry[])
  }
  if (!(await exists(paths.memoryStatePath))) {
    const memoryState: MemoryStoreState = {
      next_seq: 1,
      updated_at: nowIso()
    }
    await writeJson(paths.memoryStatePath, memoryState)
  }
  if (!(await exists(paths.memoryMarkdownPath))) {
    await writeText(paths.memoryMarkdownPath, '# Project Memory\n\n- Memory initialized.\n')
  }
}

export async function loadTaskBoard(paths: ProjectPaths): Promise<TaskBoard> {
  if (!(await exists(paths.taskboardPath))) {
    const created = createDefaultTaskBoard()
    await saveTaskBoard(paths, created)
    return created
  }
  const raw = await readText(paths.taskboardPath)
  const parsed = parseYaml(raw) as TaskBoard
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
    throw new Error(`Invalid taskboard format: ${paths.taskboardPath}`)
  }
  parsed.tasks = parsed.tasks.map(ensureTaskInvariants)
  if (!parsed.metadata) {
    parsed.metadata = { updated_at: nowIso(), version: 'ram-v0.2' }
  }
  return parsed
}

export async function saveTaskBoard(paths: ProjectPaths, board: TaskBoard): Promise<void> {
  const normalized: TaskBoard = {
    ...board,
    tasks: board.tasks.map(ensureTaskInvariants),
    metadata: {
      ...(board.metadata ?? { version: 'ram-v0.2' }),
      updated_at: nowIso()
    }
  }
  const yaml = stringifyYaml(normalized, { lineWidth: 120 })
  await writeText(paths.taskboardPath, yaml)
}

export async function loadRuntimeState(paths: ProjectPaths): Promise<RuntimeLedgerState> {
  return readJson(paths.runtimeStatePath, createDefaultRuntimeState())
}

export async function saveRuntimeState(paths: ProjectPaths, state: RuntimeLedgerState): Promise<void> {
  const normalized: RuntimeLedgerState = {
    ...state,
    updated_at: nowIso()
  }
  await writeJson(paths.runtimeStatePath, normalized)
}

export async function loadReviewQueue(paths: ProjectPaths): Promise<string[]> {
  const raw = await readJson<{ pending?: string[] }>(paths.reviewQueuePath, { pending: [] })
  return Array.isArray(raw.pending) ? raw.pending : []
}

export async function saveReviewQueue(paths: ProjectPaths, pending: string[]): Promise<void> {
  const deduped = Array.from(new Set(pending.filter(Boolean)))
  await writeJson(paths.reviewQueuePath, { pending: deduped })
}

export async function loadEvidenceRegistry(paths: ProjectPaths): Promise<EvidenceRecord[]> {
  return readJson<EvidenceRecord[]>(paths.evidenceRegistryPath, [])
}

export async function saveEvidenceRegistry(paths: ProjectPaths, records: EvidenceRecord[]): Promise<void> {
  await writeJson(paths.evidenceRegistryPath, records)
}

export async function loadMemoryEntries(paths: ProjectPaths): Promise<MemoryEntry[]> {
  return readJson<MemoryEntry[]>(paths.memoryEntriesPath, [])
}

export async function saveMemoryEntries(paths: ProjectPaths, entries: MemoryEntry[]): Promise<void> {
  await writeJson(paths.memoryEntriesPath, entries)
}

export async function loadMemoryState(paths: ProjectPaths): Promise<MemoryStoreState> {
  return readJson<MemoryStoreState>(paths.memoryStatePath, {
    next_seq: 1,
    updated_at: nowIso()
  })
}

export async function saveMemoryState(paths: ProjectPaths, state: MemoryStoreState): Promise<void> {
  await writeJson(paths.memoryStatePath, {
    ...state,
    updated_at: nowIso()
  })
}

export async function saveMemoryMarkdown(paths: ProjectPaths, markdown: string): Promise<void> {
  await writeText(paths.memoryMarkdownPath, markdown)
}

export async function appendDecision(paths: ProjectPaths, decision: DecisionRecord): Promise<void> {
  await writeText(paths.decisionsJsonlPath, `${JSON.stringify(decision)}\n`, true)
  const row = [
    '|',
    decision.decision_id,
    '|',
    decision.created_at,
    '|',
    decision.packet_id,
    '|',
    decision.action,
    '|',
    decision.comment.replace(/\|/g, '\\|'),
    '|',
    decision.impacts.join('; ').replace(/\|/g, '\\|'),
    '|',
    ''
  ].join(' ')
  await writeText(paths.decisionsMarkdownPath, `${row}\n`, true)
}

export async function appendEvent(paths: ProjectPaths, event: EventRecord): Promise<void> {
  await writeText(paths.eventsJsonlPath, `${JSON.stringify(event)}\n`, true)
}

export async function saveReviewPacket(paths: ProjectPaths, packet: ReviewPacket): Promise<string> {
  const filePath = path.join(paths.reviewPacketsDir, `${packet.packet_id}.json`)
  await writeJson(filePath, packet)
  return filePath
}

export async function loadReviewPacket(paths: ProjectPaths, packetId: string): Promise<ReviewPacket | null> {
  const filePath = path.join(paths.reviewPacketsDir, `${packetId}.json`)
  if (!(await exists(filePath))) return null
  return readJson<ReviewPacket | null>(filePath, null)
}

export async function listReviewPackets(paths: ProjectPaths): Promise<ReviewPacket[]> {
  if (!(await exists(paths.reviewPacketsDir))) return []
  const names = await fs.readdir(paths.reviewPacketsDir)
  const packets: ReviewPacket[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    const packet = await readJson<ReviewPacket | null>(path.join(paths.reviewPacketsDir, name), null)
    if (packet) packets.push(packet)
  }
  packets.sort((a, b) => a.packet_id.localeCompare(b.packet_id))
  return packets
}

export function formatPacketId(seq: number): string {
  return `CP-${String(seq).padStart(4, '0')}`
}

export function formatDecisionId(seq: number): string {
  return `D-${String(seq).padStart(4, '0')}`
}

export function formatEvidenceId(seq: number, timestampIso: string): string {
  const date = timestampIso.slice(0, 10)
  return `E-${date}-${String(seq).padStart(3, '0')}`
}

export async function ensureSeedArtifacts(paths: ProjectPaths): Promise<void> {
  const hypothesisPath = path.join(paths.notesDir, 'README.md')
  if (!(await exists(hypothesisPath))) {
    await writeText(
      hypothesisPath,
      [
        '# Notes',
        '',
        'This directory stores analysis notes generated by the RAM explore loop.',
        ''
      ].join('\n')
    )
  }

  const uiReadmePath = path.join(paths.uiDir, 'README.md')
  if (!(await exists(uiReadmePath))) {
    await writeText(
      uiReadmePath,
      [
        '# RAM CLI UI',
        '',
        'Use CLI commands as the MVP UI:',
        '- `inbox` (review queue)',
        '- `packet <id>` (packet details)',
        '- `artifact <path>` (artifact view)',
        '- `review <id> <approve|request_changes|reject>` (decision bar)',
        ''
      ].join('\n')
    )
  }
}

async function writeText(filePath: string, content: string, append = false): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  if (append) {
    await fs.appendFile(filePath, content, 'utf-8')
    return
  }
  await fs.writeFile(filePath, content, 'utf-8')
}
