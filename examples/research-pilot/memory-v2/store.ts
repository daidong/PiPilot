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
  type PaperArtifact,
  type Provenance,
  type TaskAnchor,
  type DataSchema
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
      type: 'paper'
      title: string
      authors: string[]
      abstract: string
      citeKey: string
      doi: string
      bibtex: string
      year?: number
      venue?: string
      url?: string
      pdfUrl?: string
      tags?: string[]
      summary?: string
      provenance?: Partial<Provenance>
      searchKeywords?: string[]
      externalSource?: string
      relevanceScore?: number
      citationCount?: number
      enrichmentSource?: string
      enrichedAt?: string
    }
  | {
      type: 'data'
      title: string
      filePath: string
      mimeType?: string
      schema?: DataSchema
      runId?: string
      runLabel?: string
      tags?: string[]
      summary?: string
      provenance?: Partial<Provenance>
    }
  | {
      type: 'web-content'
      title: string
      url: string
      content: string
      fetchedAt?: string
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
  filePath?: string
  mimeType?: string
  schema?: unknown
  runId?: string
  runLabel?: string
  url?: string
  fetchedAt?: string
  toolName?: string
  outputPath?: string
  outputText?: string
  authors?: string[]
  abstract?: string
  citeKey?: string
  doi?: string
  bibtex?: string
  year?: number
  venue?: string
  pdfUrl?: string
  searchKeywords?: string[]
  externalSource?: string
  relevanceScore?: number
  citationCount?: number
  enrichmentSource?: string
  enrichedAt?: string
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

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
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
    case 'paper':
      return PATHS.papers
    case 'data':
      return PATHS.data
    case 'web-content':
      return PATHS.webContent
    case 'tool-output':
      return PATHS.toolOutputs
    default:
      return PATHS.notes
  }
}

function resolveArtifactDirs(projectPath: string): Array<{ type: ArtifactType; dir: string }> {
  return [
    { type: 'note', dir: join(projectPath, PATHS.notes) },
    { type: 'paper', dir: join(projectPath, PATHS.papers) },
    { type: 'data', dir: join(projectPath, PATHS.data) },
    { type: 'web-content', dir: join(projectPath, PATHS.webContent) },
    { type: 'tool-output', dir: join(projectPath, PATHS.toolOutputs) }
  ]
}

function normalizeArtifactType(type: string): ArtifactType {
  if (type === 'literature') return 'paper'
  if (type === 'note' || type === 'paper' || type === 'data' || type === 'web-content' || type === 'tool-output') {
    return type
  }
  return 'note'
}

function normalizeArtifact(raw: Artifact): Artifact {
  const normalizedType = normalizeArtifactType(raw.type)
  if (normalizedType === raw.type) return raw
  return {
    ...raw,
    type: normalizedType
  } as Artifact
}

export function readArtifactFromFile(filePath: string): Artifact | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Artifact
    return normalizeArtifact(raw)
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
    tags: input.tags ?? [],
    summary: input.summary,
    provenance: mergeProvenance(context, input.provenance),
    createdAt: timestamp,
    updatedAt: timestamp
  }

  let artifact: Artifact
  if (input.type === 'note') {
    artifact = {
      ...common,
      type: 'note',
      content: input.content
    }
  } else if (input.type === 'paper') {
    artifact = {
      ...common,
      type: 'paper',
      authors: input.authors,
      abstract: input.abstract,
      citeKey: input.citeKey,
      doi: input.doi,
      bibtex: input.bibtex,
      year: input.year,
      venue: input.venue,
      url: input.url,
      pdfUrl: input.pdfUrl,
      searchKeywords: input.searchKeywords,
      externalSource: input.externalSource,
      relevanceScore: input.relevanceScore,
      citationCount: input.citationCount,
      enrichmentSource: input.enrichmentSource,
      enrichedAt: input.enrichedAt
    }
  } else if (input.type === 'data') {
    artifact = {
      ...common,
      type: 'data',
      name: input.title,
      filePath: input.filePath,
      mimeType: input.mimeType,
      schema: input.schema,
      runId: input.runId,
      runLabel: input.runLabel
    }
  } else if (input.type === 'web-content') {
    artifact = {
      ...common,
      type: 'web-content',
      url: input.url,
      content: input.content,
      fetchedAt: input.fetchedAt
    }
  } else {
    artifact = {
      ...common,
      type: 'tool-output',
      toolName: input.toolName,
      outputPath: input.outputPath,
      outputText: input.outputText
    }
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
  if (artifact.type === 'note') {
    return `${artifact.title} ${artifact.summary ?? ''} ${artifact.content} ${(artifact.tags ?? []).join(' ')}`
  }
  if (artifact.type === 'paper') {
    return [
      artifact.title,
      artifact.summary ?? '',
      artifact.abstract,
      artifact.citeKey,
      artifact.doi,
      artifact.authors.join(' '),
      artifact.venue ?? '',
      artifact.url ?? '',
      (artifact.tags ?? []).join(' ')
    ].join(' ')
  }
  if (artifact.type === 'data') {
    return `${artifact.title} ${artifact.summary ?? ''} ${artifact.filePath} ${(artifact.tags ?? []).join(' ')}`
  }
  if (artifact.type === 'web-content') {
    return `${artifact.title} ${artifact.summary ?? ''} ${artifact.url} ${artifact.content} ${(artifact.tags ?? []).join(' ')}`
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

export function normalizeDoi(doi: string): string {
  return doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, '').trim()
}

export function findExistingPaperArtifact(
  projectPath: string,
  identity: { doi?: string | null; citeKey?: string | null; title: string; year?: number | null }
): PaperArtifact | null {
  const papers = listArtifacts(projectPath, ['paper'])
    .filter((item): item is PaperArtifact => item.type === 'paper')

  if (identity.doi) {
    const normalized = normalizeDoi(identity.doi)
    const byDoi = papers.find(p => p.doi && normalizeDoi(p.doi) === normalized)
    if (byDoi) return byDoi
  }

  if (identity.citeKey) {
    const key = identity.citeKey.trim().toLowerCase()
    const byCiteKey = papers.find(p => p.citeKey.trim().toLowerCase() === key)
    if (byCiteKey) return byCiteKey
  }

  const normalizedTitle = identity.title.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  const byTitleYear = papers.find(p => {
    const title = p.title.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
    if (title !== normalizedTitle) return false
    if (!identity.year || !p.year) return true
    return p.year === identity.year
  })

  return byTitleYear ?? null
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
  if (ttl === '30m') {
    return new Date(now.getTime() + 30 * 60_000)
  }
  if (ttl === '2h') {
    return new Date(now.getTime() + 2 * 60 * 60_000)
  }
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
  const filePath = join(projectPath, PATHS.taskAnchor)
  return readJson<TaskAnchor>(filePath, {
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
