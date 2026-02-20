import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'

import { runExploreTurn } from './agent-runner.js'
import { MemoryStore } from './memory.js'
import {
  appendDecision,
  appendEvent,
  ensureProjectLayout,
  ensureSeedArtifacts,
  formatDecisionId,
  formatEvidenceId,
  formatPacketId,
  loadEvidenceRegistry,
  listReviewPackets,
  loadReviewPacket,
  loadReviewQueue,
  loadRuntimeState,
  loadTaskBoard,
  resolveProjectPaths,
  saveEvidenceRegistry,
  saveReviewPacket,
  saveReviewQueue,
  saveRuntimeState,
  saveTaskBoard
} from './store.js'
import type {
  DecisionRecord,
  EvidenceRecord,
  InboxEntry,
  MemoryDigest,
  MemoryEntry,
  PreflightCheck,
  ProjectRuntimeState,
  RamEventType,
  ReviewAction,
  ReviewPacket,
  RiskLevel,
  RuntimeLedgerState,
  TaskBoard,
  TaskItem,
  ToolEvent
} from './types.js'

interface PersistedArtifacts {
  toolEventsPath: string
  rawOutputPath: string
}

export interface InitResult {
  projectRoot: string
}

export interface RunResult {
  packet_id: string
  event_type: RamEventType
  state: ProjectRuntimeState
  task_id: string
  title: string
}

export interface ReviewResult {
  decision_id: string
  packet_id: string
  action: ReviewAction
  state: ProjectRuntimeState
}

function nowIso(): string {
  return new Date().toISOString()
}

function clipText(value: string, max = 120): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

function relPath(root: string, absolutePath: string): string {
  return toPosix(path.relative(root, absolutePath))
}

function ensureWithinProject(projectRoot: string, target: string): string {
  const resolved = path.resolve(projectRoot, target)
  const root = path.resolve(projectRoot)
  if (resolved === root) return resolved
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes project root: ${target}`)
  }
  return resolved
}

function hasSatisfiedDependencies(board: TaskBoard, task: TaskItem): boolean {
  if (task.depends_on.length === 0) return true
  const statusById = new Map(board.tasks.map((item) => [item.id, item.status]))
  return task.depends_on.every((dep) => statusById.get(dep) === 'DONE')
}

function pickActiveTask(board: TaskBoard): TaskItem | null {
  const doing = board.tasks.find((task) => task.status === 'DOING')
  if (doing) return doing

  const todo = board.tasks.find((task) => task.status === 'TODO' && hasSatisfiedDependencies(board, task))
  return todo ?? null
}

function nextTaskId(board: TaskBoard): string {
  let maxId = 0
  for (const task of board.tasks) {
    const match = task.id.match(/^T-(\d+)$/i)
    if (!match) continue
    const numeric = Number.parseInt(match[1], 10)
    if (Number.isFinite(numeric)) {
      maxId = Math.max(maxId, numeric)
    }
  }
  return `T-${String(maxId + 1).padStart(3, '0')}`
}

function createFollowupTask(board: TaskBoard, text: string): TaskItem {
  const task: TaskItem = {
    id: nextTaskId(board),
    title: clipText(text.trim() || 'Follow-up user request'),
    status: 'TODO',
    owner: 'agent',
    priority: 'P1',
    estimate: { time_hours: 1, risk: 'medium' },
    depends_on: [],
    accept_criteria: ['Review Packet approved by user via UI decision bar'],
    outputs: [],
    blockers: [],
    notes: `[${nowIso()}] Created from user message.`
  }
  board.tasks.push(task)
  return task
}

function eventNeedsReviewQueue(eventType: RamEventType): boolean {
  void eventType
  return true
}

function stateFromEvent(eventType: RamEventType): ProjectRuntimeState {
  if (eventType === 'decision_required') return 'AWAITING_DECISION'
  if (eventType === 'blocked') return 'BLOCKED'
  return 'AWAITING_REVIEW'
}

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  const content = records.map((item) => JSON.stringify(item)).join('\n')
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content ? `${content}\n` : '', 'utf-8')
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

async function persistTurnArtifacts(input: {
  projectRoot: string
  packetId: string
  toolEvents: ToolEvent[]
  rawOutput: string
}): Promise<PersistedArtifacts> {
  const toolEventsPath = path.join(input.projectRoot, 'evidence', 'tool-events', `${input.packetId}.jsonl`)
  const rawOutputPath = path.join(input.projectRoot, 'notes', `${input.packetId.toLowerCase()}-agent-output.txt`)

  await Promise.all([
    writeJsonl(toolEventsPath, input.toolEvents),
    writeText(rawOutputPath, `${input.rawOutput}\n`)
  ])

  return {
    toolEventsPath,
    rawOutputPath
  }
}

async function ensureDeliverables(projectRoot: string, packetId: string, deliverables: ReviewPacket['deliverables']): Promise<string[]> {
  const created: string[] = []
  for (const item of deliverables) {
    const absolutePath = ensureWithinProject(projectRoot, item.path)
    let exists = true
    try {
      await fs.access(absolutePath)
    } catch {
      exists = false
    }
    if (exists) continue

    const placeholder = [
      `# Placeholder for ${packetId}`,
      '',
      `Kind: ${item.kind}`,
      `Path: ${item.path}`,
      '',
      'This file was auto-created by RAM runtime to ensure reviewable artifact continuity.',
      ''
    ].join('\n')

    await writeText(absolutePath, placeholder)
    created.push(item.path)
  }
  return created
}

function splitCommandTokens(command: string): string[] {
  const raw = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return raw
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        return token.slice(1, -1)
      }
      return token
    })
}

function looksLikeScriptPath(token: string): boolean {
  const normalized = token.trim().toLowerCase()
  if (!normalized || normalized.startsWith('-')) return false
  return (
    normalized.endsWith('.py')
    || normalized.endsWith('.sh')
    || normalized.endsWith('.bash')
    || normalized.endsWith('.zsh')
    || normalized.endsWith('.js')
    || normalized.endsWith('.mjs')
    || normalized.endsWith('.cjs')
    || normalized.endsWith('.ts')
  )
}

function guessCommandBinary(tokens: string[]): string {
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) continue
    return token
  }
  return ''
}

async function checkBinaryExists(projectRoot: string, binary: string): Promise<boolean> {
  const trimmed = binary.trim()
  if (!trimmed) return false

  if (trimmed.includes(path.sep) || trimmed.includes('/')) {
    const absolute = path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(projectRoot, trimmed)
    try {
      const stat = await fs.stat(absolute)
      return stat.isFile()
    } catch {
      return false
    }
  }

  const pathValue = process.env.PATH ?? ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const extensions = process.platform === 'win32'
    ? ['.exe', '.cmd', '.bat', '.ps1', '']
    : ['']

  for (const dir of pathValue.split(sep).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${trimmed}${ext}`)
      try {
        const stat = await fs.stat(candidate)
        if (stat.isFile()) return true
      } catch {
        // continue
      }
    }
  }

  return false
}

function extensionOf(filePath: string): string {
  return path.extname(filePath).toLowerCase()
}

function parseCsvColumns(line: string): string[] {
  return line.split(',').map((part) => part.trim())
}

async function runPreflight(input: {
  projectRoot: string
  packetId: string
  deliverables: ReviewPacket['deliverables']
  reproduceCommands: string[]
  incomingChecks: PreflightCheck[]
}): Promise<{
  status: 'pass' | 'fail' | 'not_run'
  checks: PreflightCheck[]
}> {
  const checks: PreflightCheck[] = [...input.incomingChecks]
  const preflightDir = path.join(input.projectRoot, 'evidence', 'preflight')
  await fs.mkdir(preflightDir, { recursive: true })

  const deliverableStates: Array<{
    rel: string
    abs: string
    exists: boolean
    isFile: boolean
    size: number
  }> = []

  const existenceLogPath = path.join(preflightDir, `${input.packetId}_deliverables.log`)
  const existenceLines: string[] = []
  let allDeliverablesPresent = true
  for (const item of input.deliverables) {
    const absolutePath = ensureWithinProject(input.projectRoot, item.path)
    let exists = true
    let isFile = false
    let size = 0
    try {
      const stat = await fs.stat(absolutePath)
      isFile = stat.isFile()
      size = stat.size
      existenceLines.push(`[ok] ${item.path} (${isFile ? `file ${size} bytes` : 'non-file'})`)
    } catch {
      existenceLines.push(`[missing] ${item.path}`)
      allDeliverablesPresent = false
      exists = false
    }
    deliverableStates.push({
      rel: item.path,
      abs: absolutePath,
      exists,
      isFile,
      size
    })
  }
  await writeText(existenceLogPath, `${existenceLines.join('\n')}\n`)
  checks.push({
    name: 'deliverables_exist',
    status: allDeliverablesPresent ? 'pass' : 'fail',
    log: relPath(input.projectRoot, existenceLogPath)
  })

  const nonEmptyLogPath = path.join(preflightDir, `${input.packetId}_deliverables_non_empty.log`)
  const nonEmptyLines: string[] = []
  let allNonEmpty = true
  for (const row of deliverableStates) {
    if (!row.exists) {
      nonEmptyLines.push(`[fail] ${row.rel}: missing`)
      allNonEmpty = false
      continue
    }
    if (!row.isFile) {
      nonEmptyLines.push(`[skip] ${row.rel}: not a file`)
      continue
    }
    if (row.size <= 0) {
      nonEmptyLines.push(`[fail] ${row.rel}: empty file`)
      allNonEmpty = false
      continue
    }
    nonEmptyLines.push(`[ok] ${row.rel}: ${row.size} bytes`)
  }
  await writeText(nonEmptyLogPath, `${nonEmptyLines.join('\n')}\n`)
  checks.push({
    name: 'deliverables_non_empty',
    status: allNonEmpty ? 'pass' : 'fail',
    log: relPath(input.projectRoot, nonEmptyLogPath)
  })

  const schemaLogPath = path.join(preflightDir, `${input.packetId}_deliverables_schema.log`)
  const schemaLines: string[] = []
  let schemaValid = true
  let schemaTargets = 0
  for (const row of deliverableStates) {
    if (!row.exists || !row.isFile) continue
    const ext = extensionOf(row.rel)
    if (!['.json', '.yaml', '.yml', '.csv'].includes(ext)) continue
    schemaTargets += 1
    try {
      const text = await fs.readFile(row.abs, 'utf-8')
      if (ext === '.json') {
        JSON.parse(text)
        schemaLines.push(`[ok] ${row.rel}: json parsed`)
        continue
      }
      if (ext === '.yaml' || ext === '.yml') {
        parseYaml(text)
        schemaLines.push(`[ok] ${row.rel}: yaml parsed`)
        continue
      }
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
      if (lines.length < 2) {
        schemaValid = false
        schemaLines.push(`[fail] ${row.rel}: csv needs at least header + 1 row`)
        continue
      }
      const expectedColumns = parseCsvColumns(lines[0]).length
      let consistent = true
      for (let i = 1; i < lines.length; i += 1) {
        const count = parseCsvColumns(lines[i]).length
        if (count !== expectedColumns) {
          consistent = false
          schemaLines.push(`[fail] ${row.rel}: row ${i + 1} has ${count} columns, expected ${expectedColumns}`)
          break
        }
      }
      if (!consistent) {
        schemaValid = false
        continue
      }
      schemaLines.push(`[ok] ${row.rel}: csv shape consistent (${expectedColumns} columns)`)
    } catch (error) {
      schemaValid = false
      const message = error instanceof Error ? error.message : String(error)
      schemaLines.push(`[fail] ${row.rel}: ${message}`)
    }
  }
  if (schemaTargets === 0) {
    schemaLines.push('No schema-typed deliverables (.json/.yaml/.yml/.csv) found.')
  }
  await writeText(schemaLogPath, `${schemaLines.join('\n')}\n`)
  checks.push({
    name: 'deliverables_schema_valid',
    status: schemaValid ? 'pass' : 'fail',
    log: relPath(input.projectRoot, schemaLogPath)
  })

  const hashLogPath = path.join(preflightDir, `${input.packetId}_deliverables_hash.log`)
  const hashLines: string[] = []
  let hashReady = true
  for (const row of deliverableStates) {
    if (!row.exists) {
      hashLines.push(`[fail] ${row.rel}: missing`)
      hashReady = false
      continue
    }
    if (!row.isFile) {
      hashLines.push(`[skip] ${row.rel}: not a file`)
      continue
    }
    try {
      const raw = await fs.readFile(row.abs)
      const hash = createHash('sha256').update(raw).digest('hex')
      hashLines.push(`[ok] ${row.rel}: sha256=${hash} bytes=${raw.length}`)
    } catch (error) {
      hashReady = false
      const message = error instanceof Error ? error.message : String(error)
      hashLines.push(`[fail] ${row.rel}: ${message}`)
    }
  }
  await writeText(hashLogPath, `${hashLines.join('\n')}\n`)
  checks.push({
    name: 'deliverables_hashed',
    status: hashReady ? 'pass' : 'fail',
    log: relPath(input.projectRoot, hashLogPath)
  })

  const reproduceLogPath = path.join(preflightDir, `${input.packetId}_reproduce.log`)
  const hasReproduce = input.reproduceCommands.length > 0
  await writeText(
    reproduceLogPath,
    hasReproduce
      ? `${input.reproduceCommands.join('\n')}\n`
      : 'No reproduction commands provided.\n'
  )
  checks.push({
    name: 'reproduce_commands_present',
    status: hasReproduce ? 'pass' : 'fail',
    log: relPath(input.projectRoot, reproduceLogPath)
  })

  const reproduceValidateLogPath = path.join(preflightDir, `${input.packetId}_reproduce_validate.log`)
  const reproduceValidateLines: string[] = []
  let reproduceResolvable = hasReproduce
  if (!hasReproduce) {
    reproduceValidateLines.push('No reproduction commands provided.')
  } else {
    for (let i = 0; i < input.reproduceCommands.length; i += 1) {
      const command = input.reproduceCommands[i]
      const tokens = splitCommandTokens(command)
      if (tokens.length === 0) {
        reproduceResolvable = false
        reproduceValidateLines.push(`[fail] cmd#${i + 1}: empty command`)
        continue
      }

      const binary = guessCommandBinary(tokens)
      if (!binary) {
        reproduceResolvable = false
        reproduceValidateLines.push(`[fail] cmd#${i + 1}: cannot determine command binary`)
        continue
      }

      const binaryExists = await checkBinaryExists(input.projectRoot, binary)
      if (!binaryExists) {
        reproduceResolvable = false
        reproduceValidateLines.push(`[fail] cmd#${i + 1}: binary not found -> ${binary}`)
      } else {
        reproduceValidateLines.push(`[ok] cmd#${i + 1}: binary resolved -> ${binary}`)
      }

      const scriptTokens = tokens.filter((token) => looksLikeScriptPath(token))
      if (scriptTokens.length === 0) {
        reproduceValidateLines.push(`[ok] cmd#${i + 1}: no local script token detected`)
        continue
      }

      for (const scriptToken of scriptTokens) {
        if (scriptToken.startsWith('http://') || scriptToken.startsWith('https://')) {
          reproduceValidateLines.push(`[skip] cmd#${i + 1}: remote script token -> ${scriptToken}`)
          continue
        }

        let absolute = ''
        try {
          absolute = path.isAbsolute(scriptToken)
            ? scriptToken
            : ensureWithinProject(input.projectRoot, scriptToken)
        } catch {
          reproduceResolvable = false
          reproduceValidateLines.push(`[fail] cmd#${i + 1}: script path escapes project root -> ${scriptToken}`)
          continue
        }

        try {
          const stat = await fs.stat(absolute)
          if (!stat.isFile()) {
            reproduceResolvable = false
            reproduceValidateLines.push(`[fail] cmd#${i + 1}: script is not file -> ${scriptToken}`)
            continue
          }
          reproduceValidateLines.push(`[ok] cmd#${i + 1}: script exists -> ${scriptToken}`)
        } catch {
          reproduceResolvable = false
          reproduceValidateLines.push(`[fail] cmd#${i + 1}: missing script -> ${scriptToken}`)
        }
      }
    }
  }
  await writeText(reproduceValidateLogPath, `${reproduceValidateLines.join('\n')}\n`)
  checks.push({
    name: 'reproduce_commands_resolvable',
    status: reproduceResolvable ? 'pass' : 'fail',
    log: relPath(input.projectRoot, reproduceValidateLogPath)
  })

  const hasFail = checks.some((check) => check.status === 'fail')
  const status = checks.length === 0 ? 'not_run' : hasFail ? 'fail' : 'pass'
  return { status, checks }
}

function upsertTaskNote(task: TaskItem, note: string): void {
  const trimmed = note.trim()
  if (!trimmed) return
  task.notes = task.notes ? `${task.notes}\n${trimmed}` : trimmed
}

function addAcceptCriteria(task: TaskItem, criteria: string[]): void {
  for (const item of criteria) {
    const trimmed = item.trim()
    if (!trimmed) continue
    if (!task.accept_criteria.includes(trimmed)) {
      task.accept_criteria.push(trimmed)
    }
  }
}

function collectTaskMap(board: TaskBoard): Map<string, TaskItem> {
  return new Map(board.tasks.map((task) => [task.id, task]))
}

function determineTaskRisk(packet: ReviewPacket): RiskLevel {
  if (packet.preflight.status === 'fail') return 'high'
  if (packet.risks.length >= 2) return 'medium'
  return 'low'
}

function buildInboxEntry(packet: ReviewPacket): InboxEntry {
  const risk = determineTaskRisk(packet)
  const scopeSummary = `repo_changes=${packet.scope.repo_changes}, deliverables=${packet.deliverables.length}, cpu_h=${packet.scope.cost.cpu_hours}`
  const askSummary = packet.ask.length > 0
    ? packet.ask.map((item) => item.question).slice(0, 2).join(' | ')
    : 'No explicit ask'
  return {
    packet_id: packet.packet_id,
    title: packet.title,
    type: packet.type,
    risk,
    scope_summary: scopeSummary,
    ask_summary: askSummary
  }
}

function findTaskById(board: TaskBoard, taskId: string): TaskItem | null {
  return board.tasks.find((task) => task.id === taskId) ?? null
}

function resolveNextStateAfterDecision(input: {
  action: ReviewAction
  queueLength: number
  board: TaskBoard
}): ProjectRuntimeState {
  if (input.action === 'request_changes') return 'EXECUTING'
  if (input.action === 'reject') return 'SCOPING'
  if (input.queueLength > 0) return 'AWAITING_REVIEW'
  const remaining = input.board.tasks.some((task) => task.status === 'TODO' || task.status === 'DOING')
  return remaining ? 'EXECUTING' : 'IDLE'
}

function nextEvidenceRecord(input: {
  runtime: RuntimeLedgerState
  packetId: string
  path: string
  type: EvidenceRecord['type']
  title: string
  source: EvidenceRecord['provenance']['source']
  tool?: string
  cmd?: string
}): EvidenceRecord {
  const timestamp = nowIso()
  const record: EvidenceRecord = {
    eid: formatEvidenceId(input.runtime.next_evidence_seq, timestamp),
    type: input.type,
    title: input.title,
    path: input.path,
    packet_id: input.packetId,
    timestamp,
    provenance: {
      source: input.source,
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.cmd ? { cmd: input.cmd } : {})
    }
  }
  input.runtime.next_evidence_seq += 1
  return record
}

export async function initProject(projectRoot: string): Promise<InitResult> {
  const paths = resolveProjectPaths(projectRoot)
  await ensureProjectLayout(paths)
  await ensureSeedArtifacts(paths)
  await appendEvent(paths, {
    timestamp: nowIso(),
    type: 'review_action',
    message: 'Initialized RAM project layout.'
  })
  return { projectRoot: paths.root }
}

export async function runTurn(input: {
  projectRoot: string
  topic?: string
  userMessage?: string
}): Promise<RunResult> {
  const paths = resolveProjectPaths(input.projectRoot)
  await ensureProjectLayout(paths)
  await ensureSeedArtifacts(paths)

  const [board, runtime, queue, registry] = await Promise.all([
    loadTaskBoard(paths),
    loadRuntimeState(paths),
    loadReviewQueue(paths),
    loadEvidenceRegistry(paths)
  ])
  const memoryStore = await MemoryStore.create({ paths })
  const memoryDigest = await memoryStore.getDigest(8)

  if (input.topic?.trim()) {
    const topic = input.topic.trim()
    board.project.topic = topic
    if (!board.project.title || board.project.title === 'PhD Research Assistant Demo') {
      board.project.title = clipText(topic, 80)
    }
  }

  let active = pickActiveTask(board)
  if (!active && input.userMessage?.trim()) {
    active = createFollowupTask(board, input.userMessage.trim())
  }

  if (!active) {
    runtime.project_state = queue.length > 0 ? 'AWAITING_REVIEW' : 'IDLE'
    runtime.last_run_mode = 'llm'
    await saveRuntimeState(paths, runtime)
    throw new Error('No runnable task found. Resolve queue or add TODO tasks.')
  }

  if (active.status === 'TODO') {
    active.status = 'DOING'
    upsertTaskNote(active, `[${nowIso()}] Auto-transition TODO -> DOING for explore turn.`)
  }
  if (input.userMessage?.trim()) {
    upsertTaskNote(active, `[${nowIso()}] User input: ${input.userMessage.trim()}`)
  }

  runtime.project_state = runtime.project_state === 'IDLE' ? 'SCOPING' : 'EXECUTING'
  runtime.last_run_mode = 'llm'

  const packetId = formatPacketId(runtime.next_packet_seq)
  runtime.next_packet_seq += 1

  const turn = await runExploreTurn({
    projectRoot: paths.root,
    packetId,
    taskBoard: board,
    activeTask: active,
    memoryDigest
  })

  const persisted = await persistTurnArtifacts({
    projectRoot: paths.root,
    packetId,
    toolEvents: turn.toolEvents,
    rawOutput: turn.rawOutput
  })

  const packetTaskIds = new Set<string>()
  if (turn.draft.task_updates && turn.draft.task_updates.length > 0) {
    for (const update of turn.draft.task_updates) {
      packetTaskIds.add(update.task_id)
    }
  } else {
    packetTaskIds.add(active.id)
  }

  const taskMap = collectTaskMap(board)
  for (const update of turn.draft.task_updates ?? [{ task_id: active.id, status: turn.draft.event_type === 'blocked' ? 'BLOCKED' : 'IN_REVIEW' }]) {
    const task = taskMap.get(update.task_id)
    if (!task) continue
    task.status = update.status
    if (update.note) upsertTaskNote(task, `[${nowIso()}] ${update.note}`)
    if (update.accept_criteria_add && update.accept_criteria_add.length > 0) {
      addAcceptCriteria(task, update.accept_criteria_add)
    }
  }

  if (turn.draft.event_type === 'blocked') {
    for (const taskId of packetTaskIds) {
      const task = taskMap.get(taskId)
      if (task) task.status = 'BLOCKED'
    }
  } else {
    for (const taskId of packetTaskIds) {
      const task = taskMap.get(taskId)
      if (!task) continue
      if (task.status !== 'BLOCKED') {
        task.status = 'IN_REVIEW'
      }
    }
  }

  const packetDeliverables = turn.draft.deliverables
  const autoCreatedDeliverables = await ensureDeliverables(paths.root, packetId, packetDeliverables)
  if (autoCreatedDeliverables.length > 0) {
    turn.draft.what_changed.push(`Auto-created ${autoCreatedDeliverables.length} placeholder deliverables for review continuity.`)
  }

  const preflight = await runPreflight({
    projectRoot: paths.root,
    packetId,
    deliverables: packetDeliverables,
    reproduceCommands: turn.draft.reproduce_commands,
    incomingChecks: turn.draft.preflight?.checks ?? []
  })

  if (preflight.status === 'fail') {
    const hasPreflightRisk = turn.draft.risks.some((risk) => risk.toLowerCase().includes('preflight'))
    if (!hasPreflightRisk) {
      turn.draft.risks.push('Preflight checks failed; review preflight logs before approval.')
    }
  }

  const packetRecommendation = turn.draft.recommendation
    ?? (preflight.status === 'fail'
      ? {
        suggested_user_action: 'request_changes' as const,
        rationale: 'One or more preflight checks failed. Request fixes before approval.'
      }
      : undefined)

  const additionalEvidencePaths = new Set<string>(turn.draft.evidence_paths ?? [])
  additionalEvidencePaths.add(relPath(paths.root, persisted.toolEventsPath))
  additionalEvidencePaths.add(relPath(paths.root, persisted.rawOutputPath))
  for (const check of preflight.checks) {
    if (check.log) additionalEvidencePaths.add(check.log)
  }
  for (const deliverable of packetDeliverables) {
    additionalEvidencePaths.add(deliverable.path)
  }

  const evidenceRefs: string[] = []
  for (const itemPath of additionalEvidencePaths) {
    const normalizedPath = toPosix(itemPath)
    if (!normalizedPath) continue
    const type: EvidenceRecord['type'] =
      normalizedPath.includes('/preflight/')
        ? 'preflight_log'
        : normalizedPath.includes('/tool-events/')
          ? 'tool_event'
          : normalizedPath.startsWith('notes/')
            ? 'analysis_note'
            : 'artifact'

    const evidence = nextEvidenceRecord({
      runtime,
      packetId,
      path: normalizedPath,
      type,
      title: `${packetId} evidence: ${path.basename(normalizedPath)}`,
      source: normalizedPath.includes('/tool-events/') ? 'tool' : 'agent'
    })
    registry.push(evidence)
    evidenceRefs.push(evidence.eid)
  }

  const packet: ReviewPacket = {
    packet_id: packetId,
    type: turn.draft.type,
    title: turn.draft.title,
    event_type: turn.draft.event_type,
    created_at: nowIso(),
    task_ids: Array.from(packetTaskIds),
    summary: turn.draft.summary,
    what_changed: turn.draft.what_changed,
    scope: turn.draft.scope,
    deliverables: packetDeliverables,
    evidence_refs: evidenceRefs,
    reproduce: {
      commands: turn.draft.reproduce_commands
    },
    preflight,
    risks: turn.draft.risks,
    ask: turn.draft.ask,
    ...(packetRecommendation ? { recommendation: packetRecommendation } : {}),
    rollback_plan: turn.draft.rollback_plan,
    status: 'pending'
  }

  await saveReviewPacket(paths, packet)
  if (eventNeedsReviewQueue(packet.event_type)) {
    queue.push(packet.packet_id)
  }
  runtime.project_state = stateFromEvent(packet.event_type)
  runtime.last_event = packet.event_type

  await Promise.all([
    saveReviewQueue(paths, queue),
    saveTaskBoard(paths, board),
    saveRuntimeState(paths, runtime),
    saveEvidenceRegistry(paths, registry),
    memoryStore.recordPacket(packet),
    appendEvent(paths, {
      timestamp: nowIso(),
      type: packet.event_type,
      packet_id: packet.packet_id,
      task_ids: packet.task_ids,
      message: `Packet ${packet.packet_id} queued for user decision.`
    })
  ])

  return {
    packet_id: packet.packet_id,
    event_type: packet.event_type,
    state: runtime.project_state,
    task_id: active.id,
    title: packet.title
  }
}

export async function listInbox(projectRoot: string): Promise<InboxEntry[]> {
  const paths = resolveProjectPaths(projectRoot)
  await ensureProjectLayout(paths)
  const queue = await loadReviewQueue(paths)
  const items: InboxEntry[] = []
  for (const packetId of queue) {
    const packet = await loadReviewPacket(paths, packetId)
    if (!packet) continue
    items.push(buildInboxEntry(packet))
  }
  return items
}

export async function getPacket(projectRoot: string, packetId: string): Promise<ReviewPacket | null> {
  const paths = resolveProjectPaths(projectRoot)
  await ensureProjectLayout(paths)
  return loadReviewPacket(paths, packetId)
}

export async function reviewPacket(input: {
  projectRoot: string
  packetId: string
  action: ReviewAction
  comment?: string
}): Promise<ReviewResult> {
  const paths = resolveProjectPaths(input.projectRoot)
  await ensureProjectLayout(paths)

  const [packet, board, runtime, queue] = await Promise.all([
    loadReviewPacket(paths, input.packetId),
    loadTaskBoard(paths),
    loadRuntimeState(paths),
    loadReviewQueue(paths)
  ])
  const memoryStore = await MemoryStore.create({ paths })
  if (!packet) {
    throw new Error(`Packet not found: ${input.packetId}`)
  }
  if (packet.status !== 'pending') {
    throw new Error(`Packet ${input.packetId} is already decided (${packet.status}).`)
  }
  if ((input.action === 'request_changes' || input.action === 'reject') && !input.comment?.trim()) {
    throw new Error('Comment is required for request_changes/reject.')
  }

  const decisionId = formatDecisionId(runtime.next_decision_seq)
  runtime.next_decision_seq += 1

  const impacts: string[] = []
  for (const taskId of packet.task_ids) {
    const task = findTaskById(board, taskId)
    if (!task) continue
    if (input.action === 'approve') {
      task.status = 'DONE'
      impacts.push(`${task.id} -> DONE`)
      upsertTaskNote(task, `[${decisionId}] Approved by user.`)
      continue
    }
    if (input.action === 'request_changes') {
      task.status = 'DOING'
      const feedback = input.comment?.trim() ?? ''
      upsertTaskNote(task, `[${decisionId}] Request changes: ${feedback}`)
      addAcceptCriteria(task, [`Address decision ${decisionId}: ${feedback}`])
      impacts.push(`${task.id} -> DOING`)
      continue
    }
    task.status = 'DROPPED'
    const reason = input.comment?.trim() ?? 'Rejected by user.'
    upsertTaskNote(task, `[${decisionId}] Rejected: ${reason}`)
    impacts.push(`${task.id} -> DROPPED`)
  }

  packet.status = input.action === 'approve'
    ? 'approved'
    : input.action === 'request_changes'
      ? 'changes_requested'
      : 'rejected'
  await saveReviewPacket(paths, packet)

  const nextQueue = queue.filter((id) => id !== packet.packet_id)
  await saveReviewQueue(paths, nextQueue)

  const decision: DecisionRecord = {
    decision_id: decisionId,
    created_at: nowIso(),
    packet_id: packet.packet_id,
    action: input.action,
    comment: input.comment?.trim() ?? '',
    task_ids: packet.task_ids,
    impacts
  }

  runtime.project_state = resolveNextStateAfterDecision({
    action: input.action,
    queueLength: nextQueue.length,
    board
  })

  await Promise.all([
    saveTaskBoard(paths, board),
    saveRuntimeState(paths, runtime),
    appendDecision(paths, decision),
    memoryStore.recordDecision({ decision, packet }),
    appendEvent(paths, {
      timestamp: nowIso(),
      type: 'review_action',
      packet_id: packet.packet_id,
      task_ids: packet.task_ids,
      message: `Decision ${decisionId}: ${input.action}`
    })
  ])

  return {
    decision_id: decisionId,
    packet_id: packet.packet_id,
    action: input.action,
    state: runtime.project_state
  }
}

export async function getStatus(projectRoot: string): Promise<{
  state: ProjectRuntimeState
  pending_packets: number
  tasks: Record<string, number>
}> {
  const paths = resolveProjectPaths(projectRoot)
  await ensureProjectLayout(paths)
  const [runtime, queue, board] = await Promise.all([
    loadRuntimeState(paths),
    loadReviewQueue(paths),
    loadTaskBoard(paths)
  ])

  const tasks: Record<string, number> = {
    TODO: 0,
    DOING: 0,
    BLOCKED: 0,
    IN_REVIEW: 0,
    DONE: 0,
    DROPPED: 0
  }
  for (const task of board.tasks) {
    tasks[task.status] += 1
  }

  return {
    state: runtime.project_state,
    pending_packets: queue.length,
    tasks
  }
}

export async function getTaskboard(projectRoot: string): Promise<TaskBoard> {
  const paths = resolveProjectPaths(projectRoot)
  await ensureProjectLayout(paths)
  return loadTaskBoard(paths)
}

export async function getEvidence(projectRoot: string): Promise<EvidenceRecord[]> {
  const paths = resolveProjectPaths(projectRoot)
  await ensureProjectLayout(paths)
  return loadEvidenceRegistry(paths)
}

export async function getDecisions(projectRoot: string): Promise<DecisionRecord[]> {
  const paths = resolveProjectPaths(projectRoot)
  await ensureProjectLayout(paths)
  try {
    const raw = await fs.readFile(paths.decisionsJsonlPath, 'utf-8')
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DecisionRecord)
  } catch {
    return []
  }
}

export async function getAllPackets(projectRoot: string): Promise<ReviewPacket[]> {
  const paths = resolveProjectPaths(projectRoot)
  await ensureProjectLayout(paths)
  return listReviewPackets(paths)
}

export async function getMemoryEntries(projectRoot: string, maxEntries = 120): Promise<MemoryEntry[]> {
  const paths = resolveProjectPaths(projectRoot)
  await ensureProjectLayout(paths)
  const memoryStore = await MemoryStore.create({ paths })
  const entries = await memoryStore.load()
  return [...entries]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, Math.max(1, maxEntries))
}

export async function getMemoryDigest(projectRoot: string, maxItems = 8): Promise<MemoryDigest> {
  const paths = resolveProjectPaths(projectRoot)
  await ensureProjectLayout(paths)
  const memoryStore = await MemoryStore.create({ paths })
  return memoryStore.getDigest(Math.max(1, maxItems))
}

function isLikelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 512))
  for (const value of sample) {
    if (value === 0) return true
  }
  return false
}

export async function viewArtifact(input: {
  projectRoot: string
  artifactPath: string
}): Promise<string> {
  const paths = resolveProjectPaths(input.projectRoot)
  await ensureProjectLayout(paths)
  const absolutePath = ensureWithinProject(paths.root, input.artifactPath)
  const stat = await fs.stat(absolutePath)

  if (stat.isDirectory()) {
    const entries = await fs.readdir(absolutePath)
    return [
      `Directory: ${relPath(paths.root, absolutePath)}`,
      ...entries.slice(0, 100).map((name) => `- ${name}`)
    ].join('\n')
  }

  const data = await fs.readFile(absolutePath)
  if (isLikelyBinary(data)) {
    return `Binary file: ${relPath(paths.root, absolutePath)} (${data.length} bytes)`
  }

  const content = data.toString('utf-8')
  const lines = content.split(/\r?\n/)
  const head = lines.slice(0, 120).join('\n')
  return [
    `File: ${relPath(paths.root, absolutePath)}`,
    `Lines: ${lines.length}`,
    '',
    head
  ].join('\n')
}

export async function smokeTest(projectRoot: string): Promise<{
  projectRoot: string
  packet_id: string
  decision_id: string
  memory_entries: number
  status: Awaited<ReturnType<typeof getStatus>>
}> {
  const target = path.resolve(projectRoot, `smoke-${Date.now()}`)
  await initProject(target)
  const run = await runTurn({ projectRoot: target })
  const inbox = await listInbox(target)
  if (inbox.length === 0) {
    throw new Error('Smoke test failed: inbox is empty after run.')
  }
  const review = await reviewPacket({
    projectRoot: target,
    packetId: run.packet_id,
    action: 'approve',
    comment: 'smoke test approval'
  })
  const status = await getStatus(target)
  const memory = await getMemoryEntries(target)
  if ((status.tasks.DONE ?? 0) === 0) {
    throw new Error('Smoke test failed: no DONE task after approval.')
  }
  if (memory.length === 0) {
    throw new Error('Smoke test failed: memory ledger is empty.')
  }
  return {
    projectRoot: target,
    packet_id: run.packet_id,
    decision_id: review.decision_id,
    memory_entries: memory.length,
    status
  }
}
