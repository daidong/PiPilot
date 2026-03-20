import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  AGENT_MD_ID,
  PATHS,
  type Artifact,
  type ArtifactType,
  type CLIContext,
  type Provenance,
  type SessionSummary
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

/**
 * Ensure the special agent-md note exists. Auto-creates it if missing.
 * Called during project initialization so the user always has agent.md available.
 */
export function ensureAgentMd(projectPath: string): void {
  const notesDir = join(projectPath, PATHS.notes)
  const filePath = join(notesDir, `${AGENT_MD_ID}.json`)
  if (existsSync(filePath)) return

  ensureDir(notesDir)
  const now = nowIso()
  const artifact = {
    id: AGENT_MD_ID,
    type: 'note' as const,
    title: 'agent.md',
    content: '',
    tags: ['pinned'],
    summary: 'User instructions always injected into agent context.',
    provenance: {
      source: 'user' as const,
      sessionId: 'init',
      extractedFrom: 'user-input' as const
    },
    createdAt: now,
    updatedAt: now
  }
  writeFileSync(filePath, JSON.stringify(artifact, null, 2), 'utf-8')
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

export function writeSessionSummary(projectPath: string, summary: SessionSummary): void {
  const dir = join(projectPath, PATHS.sessionSummaries, summary.sessionId)
  ensureDir(dir)
  const key = `${summary.turnRange[0]}-${summary.turnRange[1]}`
  const filePath = join(dir, `${key}.json`)
  writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf-8')
}

export function readLatestSessionSummary(projectPath: string, sessionId: string): SessionSummary | null {
  const dir = join(projectPath, PATHS.sessionSummaries, sessionId)
  if (!existsSync(dir)) return null

  const files = readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .sort((a, b) => (a < b ? 1 : -1))

  if (files.length === 0) return null
  return readJson<SessionSummary | null>(join(dir, files[0]), null)
}
