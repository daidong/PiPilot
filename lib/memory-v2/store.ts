import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  PATHS,
  AGENT_MD_ID,
  AGENT_MD_MAX_CHARS,
  type Artifact,
  type ArtifactType,
  type CLIContext,
  type NoteArtifact,
  type PaperArtifact,
  type Provenance,
  type DataSchema,
  type SessionSummary
} from '../types.js'

export interface ArtifactFileRecord<T extends Artifact = Artifact> {
  artifact: T
  filePath: string
}

export interface LegacyMigrationResult {
  updatedFiles: number
  convertedLiteratureType: number
  removedDataNameField: number
}

export type CreateArtifactInput =
  | {
      type: 'note'
      title: string
      content: string
      filePath?: string
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
  const artifact: NoteArtifact = {
    id: AGENT_MD_ID,
    type: 'note',
    title: 'agent.md',
    content: '## User Instructions\n\n\n\n## Agent Memory\n',
    tags: ['pinned'],
    summary: 'User instructions and agent long-term memory. Injected into agent context every turn.',
    provenance: {
      source: 'user',
      sessionId: 'init',
      extractedFrom: 'user-input'
    },
    createdAt: now,
    updatedAt: now
  }
  writeFileSync(filePath, JSON.stringify(artifact, null, 2), 'utf-8')
}

/**
 * Migrate legacy artifact shapes in place.
 * - type: "literature" -> "paper"
 * - data.name -> title (if title missing), then remove data.name
 */
export function migrateLegacyArtifacts(projectPath: string): LegacyMigrationResult {
  const dirs = resolveArtifactDirs(projectPath)
  let updatedFiles = 0
  let convertedLiteratureType = 0
  let removedDataNameField = 0

  for (const { dir } of dirs) {
    if (!existsSync(dir)) continue

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const filePath = join(dir, file)
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
      } catch {
        continue
      }

      let changed = false

      if (raw.type === 'literature') {
        raw.type = 'paper'
        convertedLiteratureType++
        changed = true
      }

      if (raw.type === 'data' && typeof raw.name === 'string') {
        if (typeof raw.title !== 'string' || raw.title.trim().length === 0) {
          raw.title = raw.name
        }
        delete raw.name
        removedDataNameField++
        changed = true
      }

      if (!changed) continue
      writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf-8')
      updatedFiles++
    }
  }

  return { updatedFiles, convertedLiteratureType, removedDataNameField }
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
      content: input.content,
      ...(input.filePath ? { filePath: input.filePath } : {})
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

  // Enforce character limit on agent.md
  if (found.artifact.id === AGENT_MD_ID && patch.content && patch.content.length > AGENT_MD_MAX_CHARS) {
    return null
  }

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

// ============================================================================
// Session Summary
// ============================================================================

export function writeSessionSummary(projectPath: string, summary: SessionSummary): void {
  const dir = join(projectPath, PATHS.sessionSummaries, summary.sessionId)
  ensureDir(dir)
  const filePath = join(dir, `${Date.now()}.json`)
  writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf-8')
}

export function readLatestSessionSummary(projectPath: string, sessionId: string): SessionSummary | null {
  const dir = join(projectPath, PATHS.sessionSummaries, sessionId)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  if (files.length === 0) return null
  // Sort by numeric filename descending (ms epoch)
  files.sort((a, b) => {
    const na = parseInt(a, 10)
    const nb = parseInt(b, 10)
    return nb - na
  })
  return readJson<SessionSummary | null>(join(dir, files[0]), null)
}
