import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  PATHS,
  type Artifact,
  type ArtifactFactIndex,
  type ArtifactType,
  type CLIContext,
  type FocusCooldown,
  type FocusEntry,
  type FocusRefType,
  type FocusStateFile,
  type Provenance,
  type TaskAnchor
} from '../types.js'

export interface ArtifactFileRecord<T extends Artifact = Artifact> {
  artifact: T
  filePath: string
}

export type CreateArtifactInput =
  | {
      type: 'note'
      title: string
      content: string
      tags?: string[]
      summary?: string
      provenance?: Partial<Provenance>
    }
  | {
      type: 'todo'
      title: string
      content: string
      status?: 'pending' | 'completed'
      completedAt?: string
      tags?: string[]
      summary?: string
      provenance?: Partial<Provenance>
    }
  | {
      type: 'doc'
      title: string
      filePath: string
      content?: string
      mimeType?: string
      description?: string
      tags?: string[]
      summary?: string
      provenance?: Partial<Provenance>
    }
  | {
      type: 'email-message'
      title: string
      accountEmail?: string
      messageId?: string
      threadId?: string
      from?: string
      to?: string[]
      cc?: string[]
      subject?: string
      snippet?: string
      bodyText?: string
      sentAt?: string
      tags?: string[]
      summary?: string
      provenance?: Partial<Provenance>
    }
  | {
      type: 'email-thread'
      title: string
      accountEmail?: string
      threadId: string
      participants?: string[]
      latestSubject?: string
      latestSnippet?: string
      messageCount?: number
      unreadCount?: number
      tags?: string[]
      summary?: string
      provenance?: Partial<Provenance>
    }
  | {
      type: 'calendar-event'
      title: string
      eventId?: string
      calendarName?: string
      startAt?: string
      endAt?: string
      location?: string
      attendees?: string[]
      notes?: string
      tags?: string[]
      summary?: string
      provenance?: Partial<Provenance>
    }
  | {
      type: 'scheduler-run'
      title: string
      scheduledTaskId?: string
      instruction: string
      status: 'success' | 'failed'
      output?: string
      error?: string
      triggeredAt?: string
      tags?: string[]
      summary?: string
      provenance?: Partial<Provenance>
    }
  | {
      type: 'tool-output'
      title: string
      toolName: string
      outputPath?: string
      outputText?: string
      tags?: string[]
      summary?: string
      provenance?: Partial<Provenance>
    }

export interface UpdateArtifactInput {
  title?: string
  tags?: string[]
  summary?: string

  content?: string
  status?: 'pending' | 'completed'
  completedAt?: string

  filePath?: string
  mimeType?: string
  description?: string

  accountEmail?: string
  messageId?: string
  threadId?: string
  from?: string
  to?: string[]
  cc?: string[]
  subject?: string
  snippet?: string
  bodyText?: string
  sentAt?: string

  participants?: string[]
  latestSubject?: string
  latestSnippet?: string
  messageCount?: number
  unreadCount?: number

  eventId?: string
  calendarName?: string
  startAt?: string
  endAt?: string
  location?: string
  attendees?: string[]
  notes?: string

  scheduledTaskId?: string
  instruction?: string
  output?: string
  error?: string
  triggeredAt?: string

  toolName?: string
  outputPath?: string
  outputText?: string
}

export interface FocusAddInput {
  sessionId: string
  refType: FocusRefType
  refId: string
  reason: string
  score: number
  source: 'manual' | 'auto'
  ttl: string
  now?: Date
  cooldownMinutes?: number
}

function nowIso(): string {
  return new Date().toISOString()
}

function isCommunicationArtifactType(type: ArtifactType): boolean {
  return type === 'email-message' || type === 'email-thread' || type === 'calendar-event'
}

function withCommunicationPrivacyTags(type: ArtifactType, tags: string[] | undefined): string[] {
  const normalized = [...new Set((tags ?? []).map(tag => String(tag).trim()).filter(Boolean))]
  if (!isCommunicationArtifactType(type)) return normalized

  const hasPrivacyTag = normalized.some(tag => tag === 'private' || tag === 'sensitive')
  if (!hasPrivacyTag) {
    normalized.push('private')
  }

  if (!normalized.includes('communication')) {
    normalized.push('communication')
  }

  return normalized
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(dirname(filePath))
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

function artifactDirForType(type: ArtifactType): string {
  switch (type) {
    case 'note':
      return PATHS.notes
    case 'todo':
      return PATHS.todos
    case 'doc':
      return PATHS.docs
    case 'email-message':
      return PATHS.emailMessages
    case 'email-thread':
      return PATHS.emailThreads
    case 'calendar-event':
      return PATHS.calendarEvents
    case 'scheduler-run':
      return PATHS.schedulerRuns
    case 'tool-output':
      return PATHS.toolOutputs
    default:
      return PATHS.notes
  }
}

function resolveArtifactDirs(projectPath: string): Array<{ type: ArtifactType; dir: string }> {
  return [
    { type: 'note', dir: join(projectPath, PATHS.notes) },
    { type: 'todo', dir: join(projectPath, PATHS.todos) },
    { type: 'doc', dir: join(projectPath, PATHS.docs) },
    { type: 'email-message', dir: join(projectPath, PATHS.emailMessages) },
    { type: 'email-thread', dir: join(projectPath, PATHS.emailThreads) },
    { type: 'calendar-event', dir: join(projectPath, PATHS.calendarEvents) },
    { type: 'scheduler-run', dir: join(projectPath, PATHS.schedulerRuns) },
    { type: 'tool-output', dir: join(projectPath, PATHS.toolOutputs) }
  ]
}

export function readArtifactFromFile(filePath: string): Artifact | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Artifact
  } catch {
    return null
  }
}

function mergeProvenance(context: CLIContext, override?: Partial<Provenance>): Provenance {
  return {
    source: override?.source ?? 'user',
    sessionId: override?.sessionId ?? context.sessionId,
    agentId: override?.agentId,
    extractedFrom: override?.extractedFrom ?? 'user-input',
    messageId: override?.messageId
  }
}

export function createArtifact(input: CreateArtifactInput, context: CLIContext): ArtifactFileRecord {
  const id = crypto.randomUUID()
  const timestamp = nowIso()

  const common = {
    id,
    title: input.title,
    tags: withCommunicationPrivacyTags(input.type, input.tags),
    summary: input.summary,
    provenance: mergeProvenance(context, input.provenance),
    createdAt: timestamp,
    updatedAt: timestamp
  }

  let artifact: Artifact
  switch (input.type) {
    case 'note':
      artifact = {
        ...common,
        type: 'note',
        content: input.content
      }
      break
    case 'todo':
      artifact = {
        ...common,
        type: 'todo',
        content: input.content,
        status: input.status ?? 'pending',
        completedAt: input.completedAt
      }
      break
    case 'doc':
      artifact = {
        ...common,
        type: 'doc',
        filePath: input.filePath,
        content: input.content,
        mimeType: input.mimeType,
        description: input.description
      }
      break
    case 'email-message':
      artifact = {
        ...common,
        type: 'email-message',
        accountEmail: input.accountEmail,
        messageId: input.messageId,
        threadId: input.threadId,
        from: input.from,
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        snippet: input.snippet,
        bodyText: input.bodyText,
        sentAt: input.sentAt
      }
      break
    case 'email-thread':
      artifact = {
        ...common,
        type: 'email-thread',
        accountEmail: input.accountEmail,
        threadId: input.threadId,
        participants: input.participants,
        latestSubject: input.latestSubject,
        latestSnippet: input.latestSnippet,
        messageCount: input.messageCount,
        unreadCount: input.unreadCount
      }
      break
    case 'calendar-event':
      artifact = {
        ...common,
        type: 'calendar-event',
        eventId: input.eventId,
        calendarName: input.calendarName,
        startAt: input.startAt,
        endAt: input.endAt,
        location: input.location,
        attendees: input.attendees,
        notes: input.notes
      }
      break
    case 'scheduler-run':
      artifact = {
        ...common,
        type: 'scheduler-run',
        scheduledTaskId: input.scheduledTaskId,
        instruction: input.instruction,
        status: input.status,
        output: input.output,
        error: input.error,
        triggeredAt: input.triggeredAt ?? timestamp
      }
      break
    default:
      artifact = {
        ...common,
        type: 'tool-output',
        toolName: input.toolName,
        outputPath: input.outputPath,
        outputText: input.outputText
      }
      break
  }

  const dir = join(context.projectPath, artifactDirForType(artifact.type))
  ensureDir(dir)
  const filePath = join(dir, `${artifact.id}.json`)
  writeFileSync(filePath, JSON.stringify(artifact, null, 2), 'utf-8')

  return { artifact, filePath }
}

export function listArtifacts(projectPath: string, types?: ArtifactType[]): Artifact[] {
  const dirs = resolveArtifactDirs(projectPath)
  const typeSet = types ? new Set(types) : null
  const out: Artifact[] = []

  for (const { type, dir } of dirs) {
    if (typeSet && !typeSet.has(type)) continue
    if (!existsSync(dir)) continue

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const artifact = readArtifactFromFile(join(dir, file))
      if (!artifact) continue
      out.push(artifact)
    }
  }

  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export function findArtifactById(projectPath: string, artifactId: string): ArtifactFileRecord | null {
  const dirs = resolveArtifactDirs(projectPath)
  for (const { dir } of dirs) {
    if (!existsSync(dir)) continue

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const fullPath = join(dir, file)
      const artifact = readArtifactFromFile(fullPath)
      if (!artifact) continue
      if (artifact.id === artifactId || artifact.id.startsWith(artifactId) || file.includes(artifactId)) {
        return { artifact, filePath: fullPath }
      }
    }
  }
  return null
}

export function updateArtifact(projectPath: string, artifactId: string, patch: UpdateArtifactInput): ArtifactFileRecord | null {
  const found = findArtifactById(projectPath, artifactId)
  if (!found) return null

  const updated: Artifact = {
    ...found.artifact,
    ...patch,
    tags: withCommunicationPrivacyTags(found.artifact.type, patch.tags ?? found.artifact.tags),
    updatedAt: nowIso()
  } as Artifact

  writeFileSync(found.filePath, JSON.stringify(updated, null, 2), 'utf-8')
  return { artifact: updated, filePath: found.filePath }
}

export function deleteArtifact(projectPath: string, artifactId: string): ArtifactFileRecord | null {
  const found = findArtifactById(projectPath, artifactId)
  if (!found) return null
  rmSync(found.filePath)
  return found
}

function artifactSearchText(artifact: Artifact): string {
  if (artifact.type === 'note' || artifact.type === 'todo') {
    return `${artifact.title} ${artifact.summary ?? ''} ${artifact.content} ${(artifact.tags ?? []).join(' ')}`
  }
  if (artifact.type === 'doc') {
    return `${artifact.title} ${artifact.summary ?? ''} ${artifact.filePath} ${artifact.description ?? ''} ${artifact.content ?? ''} ${(artifact.tags ?? []).join(' ')}`
  }
  if (artifact.type === 'email-message') {
    return [
      artifact.title,
      artifact.subject ?? '',
      artifact.from ?? '',
      (artifact.to ?? []).join(' '),
      (artifact.cc ?? []).join(' '),
      artifact.snippet ?? '',
      artifact.summary ?? '',
      (artifact.tags ?? []).join(' ')
    ].join(' ')
  }
  if (artifact.type === 'email-thread') {
    return [
      artifact.title,
      artifact.threadId,
      artifact.latestSubject ?? '',
      artifact.latestSnippet ?? '',
      (artifact.participants ?? []).join(' '),
      artifact.summary ?? '',
      (artifact.tags ?? []).join(' ')
    ].join(' ')
  }
  if (artifact.type === 'calendar-event') {
    return [
      artifact.title,
      artifact.calendarName ?? '',
      artifact.location ?? '',
      (artifact.attendees ?? []).join(' '),
      artifact.notes ?? '',
      artifact.summary ?? '',
      (artifact.tags ?? []).join(' ')
    ].join(' ')
  }
  if (artifact.type === 'scheduler-run') {
    return [
      artifact.title,
      artifact.instruction,
      artifact.status,
      artifact.output ?? '',
      artifact.error ?? '',
      artifact.summary ?? '',
      (artifact.tags ?? []).join(' ')
    ].join(' ')
  }
  return `${artifact.title} ${artifact.summary ?? ''} ${artifact.toolName} ${artifact.outputPath ?? ''} ${artifact.outputText ?? ''} ${(artifact.tags ?? []).join(' ')}`
}

export interface ArtifactSearchHit {
  artifact: Artifact
  score: number
  match: string
}

export function searchArtifacts(projectPath: string, query: string, types?: ArtifactType[]): ArtifactSearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const qTokens = q.split(/\s+/).filter(Boolean)
  const artifacts = listArtifacts(projectPath, types)

  const hits: ArtifactSearchHit[] = []
  for (const artifact of artifacts) {
    const hay = artifactSearchText(artifact).toLowerCase()
    const matched = qTokens.filter(token => hay.includes(token))
    if (matched.length === 0) continue
    hits.push({
      artifact,
      score: matched.length / qTokens.length,
      match: matched.slice(0, 6).join(', ')
    })
  }

  hits.sort((a, b) => b.score - a.score)
  return hits
}

function focusFilePath(projectPath: string, sessionId: string): string {
  return join(projectPath, PATHS.focusDir, `${sessionId}.json`)
}

function loadFocusState(projectPath: string, sessionId: string): FocusStateFile {
  return readJson<FocusStateFile>(focusFilePath(projectPath, sessionId), {
    entries: [],
    cooldowns: [],
    updatedAt: nowIso()
  })
}

function saveFocusState(projectPath: string, sessionId: string, state: FocusStateFile): void {
  state.updatedAt = nowIso()
  writeJson(focusFilePath(projectPath, sessionId), state)
}

function parseTtlPreset(ttl: string, now: Date): Date {
  if (ttl === '30m') return new Date(now.getTime() + 30 * 60_000)
  if (ttl === '2h') return new Date(now.getTime() + 2 * 60 * 60_000)
  if (ttl === 'today') {
    const until = new Date(now)
    until.setHours(23, 59, 59, 999)
    return until
  }

  const asDate = new Date(ttl)
  if (!Number.isNaN(asDate.getTime())) return asDate
  return new Date(now.getTime() + 30 * 60_000)
}

function focusKey(entry: Pick<FocusEntry, 'sessionId' | 'refType' | 'refId'>): string {
  return `${entry.sessionId}:${entry.refType}:${entry.refId}`
}

export function pruneExpiredFocusAtTurnBoundary(
  projectPath: string,
  sessionId: string,
  now: Date = new Date(),
  cooldownMinutes: number = 15
): { expired: number; kept: number } {
  const state = loadFocusState(projectPath, sessionId)
  const nowMs = now.getTime()
  const beforeCount = state.entries.length

  const alive: FocusEntry[] = []
  for (const entry of state.entries) {
    const expiresMs = new Date(entry.expiresAt).getTime()
    if (!Number.isNaN(expiresMs) && expiresMs <= nowMs) {
      if (entry.source === 'auto') {
        const until = new Date(nowMs + cooldownMinutes * 60_000).toISOString()
        state.cooldowns = state.cooldowns.filter(c => focusKey(c) !== focusKey(entry))
        state.cooldowns.push({
          sessionId,
          refType: entry.refType,
          refId: entry.refId,
          until,
          reason: 'expired-auto-focus'
        })
      }
      continue
    }
    alive.push(entry)
  }

  state.entries = alive
  state.cooldowns = state.cooldowns.filter(c => new Date(c.until).getTime() > nowMs)
  saveFocusState(projectPath, sessionId, state)

  return {
    expired: Math.max(0, beforeCount - alive.length),
    kept: alive.length
  }
}

export function addFocusEntry(projectPath: string, input: FocusAddInput): { ok: boolean; reason?: string; entry?: FocusEntry } {
  const now = input.now ?? new Date()
  const state = loadFocusState(projectPath, input.sessionId)
  const nowMs = now.getTime()

  state.cooldowns = state.cooldowns.filter(c => new Date(c.until).getTime() > nowMs)
  const cooldown = state.cooldowns.find(c => c.refType === input.refType && c.refId === input.refId)
  if (input.source === 'auto' && cooldown) {
    saveFocusState(projectPath, input.sessionId, state)
    return { ok: false, reason: `cooldown-active-until:${cooldown.until}` }
  }

  const expiresAt = parseTtlPreset(input.ttl, now).toISOString()
  const existing = state.entries.find(entry => entry.refType === input.refType && entry.refId === input.refId)
  if (existing) {
    existing.reason = input.reason
    existing.score = input.score
    existing.source = input.source
    existing.ttl = input.ttl
    existing.expiresAt = expiresAt
    existing.updatedAt = nowIso()
    saveFocusState(projectPath, input.sessionId, state)
    return { ok: true, entry: existing }
  }

  const entry: FocusEntry = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    refType: input.refType,
    refId: input.refId,
    reason: input.reason,
    score: input.score,
    source: input.source,
    ttl: input.ttl,
    expiresAt,
    createdAt: nowIso(),
    updatedAt: nowIso()
  }

  state.entries.push(entry)
  saveFocusState(projectPath, input.sessionId, state)
  return { ok: true, entry }
}

export function removeFocusEntry(projectPath: string, sessionId: string, idOrRef: string): boolean {
  const state = loadFocusState(projectPath, sessionId)
  const before = state.entries.length
  state.entries = state.entries.filter(entry => entry.id !== idOrRef && entry.refId !== idOrRef && !entry.refId.startsWith(idOrRef))
  if (state.entries.length !== before) {
    saveFocusState(projectPath, sessionId, state)
    return true
  }
  return false
}

export function clearFocusEntries(projectPath: string, sessionId: string): number {
  const state = loadFocusState(projectPath, sessionId)
  const count = state.entries.length
  state.entries = []
  saveFocusState(projectPath, sessionId, state)
  return count
}

export function listFocusEntries(projectPath: string, sessionId: string): FocusEntry[] {
  const state = loadFocusState(projectPath, sessionId)
  return state.entries
    .slice()
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      return a.updatedAt < b.updatedAt ? 1 : -1
    })
}

export function getFocusCooldowns(projectPath: string, sessionId: string): FocusCooldown[] {
  return loadFocusState(projectPath, sessionId).cooldowns
}

export function readTaskAnchor(projectPath: string): TaskAnchor {
  return readJson<TaskAnchor>(join(projectPath, PATHS.taskAnchor), {
    currentGoal: 'Not set yet',
    nowDoing: 'Understand the latest request',
    blockedBy: [],
    nextAction: 'Identify the next concrete step',
    updatedAt: nowIso()
  })
}

export function writeTaskAnchor(projectPath: string, anchor: TaskAnchor): TaskAnchor {
  const full: TaskAnchor = {
    ...anchor,
    updatedAt: nowIso()
  }
  writeJson(join(projectPath, PATHS.taskAnchor), full)
  return full
}

export function updateTaskAnchor(projectPath: string, patch: Partial<TaskAnchor>): TaskAnchor {
  const current = readTaskAnchor(projectPath)
  return writeTaskAnchor(projectPath, {
    ...current,
    ...patch,
    blockedBy: patch.blockedBy ?? current.blockedBy
  })
}

function artifactFactIndexPath(projectPath: string): string {
  return join(projectPath, PATHS.artifactFactIndex)
}

export function readArtifactFactIndex(projectPath: string): ArtifactFactIndex {
  return readJson<ArtifactFactIndex>(artifactFactIndexPath(projectPath), {
    updatedAt: nowIso(),
    byArtifactId: {}
  })
}

export function writeArtifactFactIndex(projectPath: string, index: ArtifactFactIndex): void {
  index.updatedAt = nowIso()
  writeJson(artifactFactIndexPath(projectPath), index)
}

export function linkFactToArtifacts(projectPath: string, factId: string, artifactIds: string[]): void {
  if (artifactIds.length === 0) return
  const index = readArtifactFactIndex(projectPath)

  for (const artifactId of artifactIds) {
    const existing = new Set(index.byArtifactId[artifactId] ?? [])
    existing.add(factId)
    index.byArtifactId[artifactId] = [...existing]
  }

  writeArtifactFactIndex(projectPath, index)
}

export function unlinkFactFromArtifacts(projectPath: string, factId: string): void {
  const index = readArtifactFactIndex(projectPath)
  for (const artifactId of Object.keys(index.byArtifactId)) {
    const remaining = (index.byArtifactId[artifactId] ?? []).filter(id => id !== factId)
    if (remaining.length > 0) {
      index.byArtifactId[artifactId] = remaining
    } else {
      delete index.byArtifactId[artifactId]
    }
  }
  writeArtifactFactIndex(projectPath, index)
}

export function getFactIdsForArtifact(projectPath: string, artifactId: string): string[] {
  const index = readArtifactFactIndex(projectPath)
  return index.byArtifactId[artifactId] ?? []
}
