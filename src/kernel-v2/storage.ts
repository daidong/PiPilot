import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Dirent } from 'node:fs'

import type {
  MemoryNamespace,
  MemorySensitivity,
  MemoryItem,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryListOptions
} from '../types/memory.js'
import type {
  V2ArtifactRecord,
  V2CompactSegment,
  V2ContinuityRecord,
  V2MemoryFact,
  V2ProjectRecord,
  V2TaskState,
  V2TurnRecord,
  V2TurnUpsertInput
} from './types.js'
import { FRAMEWORK_DIR } from '../constants.js'

const LOCK_RETRY_LIMIT = 80
const LOCK_RETRY_DELAY_MS = 25
const LOCK_STALE_MS = 30_000

function nowIso(): string {
  return new Date().toISOString()
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error
}

function isNotFoundError(value: unknown): boolean {
  return isNodeError(value) && value.code === 'ENOENT'
}

function warnStorageError(code: string, filePath: string, error: unknown, details?: Record<string, unknown>): void {
  const message = isNodeError(error) ? error.message : String(error)
  const suffix = details
    ? ` details=${JSON.stringify(details)}`
    : ''
  console.warn(`[KernelV2Storage] ${code} path=${filePath} message=${message}${suffix}`)
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function acquireLock(lockPath: string): Promise<fs.FileHandle> {
  await ensureDir(path.dirname(lockPath))

  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowIso() }), 'utf-8')
      } catch {
        // Best effort lock metadata.
      }
      return handle
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        throw error
      }

      try {
        const stat = await fs.stat(lockPath)
        if ((Date.now() - stat.mtimeMs) > LOCK_STALE_MS) {
          await fs.unlink(lockPath)
          continue
        }
      } catch {
        // Lock file may disappear between stat/unlink attempts.
      }

      if (attempt === LOCK_RETRY_LIMIT - 1) {
        throw new Error(`KV2_E_LOCK_TIMEOUT:${lockPath}`)
      }

      await sleep(LOCK_RETRY_DELAY_MS)
    }
  }

  throw new Error(`KV2_E_LOCK_TIMEOUT:${lockPath}`)
}

async function releaseLock(lockPath: string, handle: fs.FileHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    // Ignore lock close errors.
  }
  try {
    await fs.unlink(lockPath)
  } catch {
    // Ignore lock cleanup errors.
  }
}

async function withFileLock<T>(filePath: string, op: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`
  const handle = await acquireLock(lockPath)
  try {
    return await op()
  } finally {
    await releaseLock(lockPath, handle)
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath))
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  await fs.writeFile(tmpPath, content, 'utf-8')
  try {
    await fs.rename(tmpPath, filePath)
  } catch (error: any) {
    if (error?.code === 'EEXIST' || error?.code === 'EPERM') {
      await fs.unlink(filePath).catch(() => {})
      await fs.rename(tmpPath, filePath)
    } else {
      throw error
    }
  } finally {
    await fs.unlink(tmpPath).catch(() => {})
  }
}

async function appendJsonlUnsafe(filePath: string, record: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath))
  await fs.appendFile(filePath, JSON.stringify(record) + '\n', 'utf-8')
}

async function appendJsonl(filePath: string, record: unknown): Promise<void> {
  await withFileLock(filePath, async () => {
    await appendJsonlUnsafe(filePath, record)
  })
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if (isNotFoundError(error)) return []
    warnStorageError('KV2_E_IO_READ', filePath, error)
    return []
  }

  const lines = raw.split(/\r?\n/).filter(Boolean)
  const out: T[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    try {
      out.push(JSON.parse(line) as T)
    } catch (error) {
      warnStorageError('KV2_E_PARSE_JSONL', filePath, error, { line: i + 1 })
    }
  }
  return out
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if (isNotFoundError(error)) return null
    warnStorageError('KV2_E_IO_READ', filePath, error)
    return null
  }

  try {
    return JSON.parse(raw) as T
  } catch (error) {
    warnStorageError('KV2_E_PARSE_JSON', filePath, error)
    return null
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await withFileLock(filePath, async () => {
    await writeFileAtomic(filePath, JSON.stringify(value, null, 2))
  })
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s.-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => w.length > 2)
}

function scoreByKeywords(queryTokens: string[], hay: string): { score: number; matched: string[] } {
  const hayTokens = new Set(tokenize(hay))
  const matched = queryTokens.filter(t => hayTokens.has(t))
  const score = queryTokens.length > 0 ? matched.length / queryTokens.length : 0
  return { score, matched }
}

function toMemoryItem(fact: V2MemoryFact): MemoryItem {
  return {
    id: fact.id,
    namespace: fact.namespace,
    key: fact.key,
    value: fact.value,
    valueText: fact.valueText,
    tags: fact.tags,
    sensitivity: fact.sensitivity,
    status: fact.status === 'deprecated' ? 'deprecated' : 'active',
    provenance: {
      traceId: fact.provenance.traceId,
      createdBy: fact.provenance.createdBy,
      sessionId: fact.provenance.sessionId
    },
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt
  }
}

interface LatestMemoryItemFilters {
  namespace?: MemoryNamespace
  tags?: string[]
  status?: 'active' | 'deprecated' | 'all'
  sensitivity?: MemorySearchOptions['sensitivity']
}

export interface KernelV2Paths {
  root: string
  turnsFile: (sessionId: string) => string
  segmentsFile: (sessionId: string) => string
  projectRegistry: string
  sessionBinding: (sessionId: string) => string
  tasksFile: (projectId: string) => string
  continuitySessionFile: (projectId: string, sessionId: string) => string
  memoryFactsFile: string
  memoryArchiveFile: string
  artifactsRefsFile: string
}

export class KernelV2Storage {
  readonly paths: KernelV2Paths
  private latestMemoryFactsByKeyCache: Map<string, V2MemoryFact> | null = null
  private latestMemoryFactsCacheDirty = true

  constructor(private readonly projectPath: string) {
    const root = path.join(projectPath, FRAMEWORK_DIR)
    this.paths = {
      root,
      turnsFile: (sessionId) => path.join(root, 'history', 'sessions', sessionId, 'turns.jsonl'),
      segmentsFile: (sessionId) => path.join(root, 'history', 'sessions', sessionId, 'segments.jsonl'),
      projectRegistry: path.join(root, 'projects', 'registry.jsonl'),
      sessionBinding: (sessionId) => path.join(root, 'projects', 'session-bindings', `${sessionId}.json`),
      tasksFile: (projectId) => path.join(root, 'tasks', 'projects', projectId, 'tasks.jsonl'),
      continuitySessionFile: (projectId, sessionId) => path.join(root, 'continuity', 'projects', projectId, 'sessions', `${sessionId}.json`),
      memoryFactsFile: path.join(root, 'memory', 'facts.jsonl'),
      memoryArchiveFile: path.join(root, 'memory', 'archive.jsonl'),
      artifactsRefsFile: path.join(root, 'artifacts', 'refs.jsonl')
    }
  }

  async init(): Promise<void> {
    await ensureDir(this.paths.root)
    await Promise.all([
      ensureDir(path.dirname(this.paths.projectRegistry)),
      ensureDir(path.dirname(this.paths.memoryFactsFile)),
      ensureDir(path.dirname(this.paths.artifactsRefsFile))
    ])
  }

  async verifyIntegrity(): Promise<{ ok: boolean; issues: Array<{ path: string; failureType: string; lastValidOffset: number }> }> {
    const files = await this.listJsonlFilesUnderRoot()
    const issues: Array<{ path: string; failureType: string; lastValidOffset: number }> = []
    for (const file of files) {
      try {
        const raw = await fs.readFile(file, 'utf-8')
        const lines = raw.split(/\r?\n/)
        let validOffset = 0
        for (const line of lines) {
          if (!line) {
            validOffset += 1
            continue
          }
          try {
            JSON.parse(line)
            validOffset += line.length + 1
          } catch {
            issues.push({ path: file, failureType: 'invalid_jsonl', lastValidOffset: validOffset })
            break
          }
        }
      } catch (error) {
        if (isNotFoundError(error)) {
          // Missing files are acceptable before first write.
          continue
        }
        warnStorageError('KV2_E_IO_READ', file, error)
      }
    }
    return { ok: issues.length === 0, issues }
  }

  async recoverIntegrity(options?: {
    autoTruncateToLastValidRecord?: boolean
    createRecoverySnapshot?: boolean
  }): Promise<{ recovered: number; failed: number; issues: Array<{ path: string; failureType: string; lastValidOffset: number }> }> {
    const issues = (await this.verifyIntegrity()).issues
    if (issues.length === 0) {
      return { recovered: 0, failed: 0, issues: [] }
    }

    const autoTruncate = options?.autoTruncateToLastValidRecord ?? true
    const createSnapshot = options?.createRecoverySnapshot ?? true
    let recovered = 0
    let failed = 0

    for (const issue of issues) {
      if (!autoTruncate) {
        failed += 1
        continue
      }

      try {
        await withFileLock(issue.path, async () => {
          if (createSnapshot) {
            const snapshotDir = path.join(this.paths.root, 'recovery', 'snapshots')
            await ensureDir(snapshotDir)
            const base = path.basename(issue.path)
            const snapshotPath = path.join(snapshotDir, `${base}.${Date.now().toString(36)}.bak`)
            await fs.copyFile(issue.path, snapshotPath)
          }

          const raw = await fs.readFile(issue.path, 'utf-8')
          const truncated = raw.slice(0, issue.lastValidOffset)
          await writeFileAtomic(issue.path, truncated)
        })
        recovered += 1
      } catch {
        failed += 1
      }
    }

    this.latestMemoryFactsCacheDirty = true

    return { recovered, failed, issues }
  }

  async getOrCreateProject(): Promise<V2ProjectRecord> {
    const rootPath = this.projectPath
    const name = path.basename(rootPath) || 'workspace'
    const projectId = `proj_${name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`

    return withFileLock(this.paths.projectRegistry, async () => {
      const all = await readJsonl<V2ProjectRecord>(this.paths.projectRegistry)
      const existing = all.find(p => p.projectId === projectId && p.status === 'registered')
      if (existing) return existing

      const record: V2ProjectRecord = {
        projectId,
        name,
        rootPath,
        detectionStrategy: 'path-based',
        status: 'registered',
        defaultForWorkspace: true,
        updatedAt: nowIso()
      }
      await appendJsonlUnsafe(this.paths.projectRegistry, record)
      return record
    })
  }

  async listProjects(): Promise<V2ProjectRecord[]> {
    const all = await readJsonl<V2ProjectRecord>(this.paths.projectRegistry)
    return all
      .filter(p => p.status === 'registered')
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  async getProject(projectId: string): Promise<V2ProjectRecord | null> {
    const projects = await this.listProjects()
    return projects.find(p => p.projectId === projectId) ?? null
  }

  async bindSessionToProject(sessionId: string, projectId: string): Promise<void> {
    await writeJsonFile(this.paths.sessionBinding(sessionId), {
      sessionId,
      projectId,
      updatedAt: nowIso()
    })
  }

  async getBoundProjectId(sessionId: string): Promise<string | null> {
    const binding = await readJsonFile<{ sessionId: string; projectId: string }>(this.paths.sessionBinding(sessionId))
    return binding?.projectId ?? null
  }

  async appendTurn(sessionId: string, input: V2TurnUpsertInput): Promise<V2TurnRecord> {
    const turnsFile = this.paths.turnsFile(sessionId)
    return withFileLock(turnsFile, async () => {
      const turns = await readJsonl<V2TurnRecord>(turnsFile)
      const nextIndex = turns.length > 0 ? turns[turns.length - 1]!.index + 1 : 1

      const turn: V2TurnRecord = {
        id: generateId('turn'),
        sessionId,
        index: nextIndex,
        role: input.role,
        content: input.content,
        createdAt: input.createdAt ?? nowIso()
      }

      await appendJsonlUnsafe(turnsFile, turn)
      return turn
    })
  }

  async getSessionTurns(sessionId: string): Promise<V2TurnRecord[]> {
    const turns = await readJsonl<V2TurnRecord>(this.paths.turnsFile(sessionId))
    turns.sort((a, b) => a.index - b.index)
    return turns
  }

  async appendCompactSegment(segment: V2CompactSegment): Promise<void> {
    await appendJsonl(this.paths.segmentsFile(segment.sessionId), segment)
  }

  async listCompactSegments(sessionId: string): Promise<V2CompactSegment[]> {
    const segments = await readJsonl<V2CompactSegment>(this.paths.segmentsFile(sessionId))
    segments.sort((a, b) => a.turnRange[0] - b.turnRange[0])
    return segments
  }

  async upsertTask(task: V2TaskState): Promise<void> {
    const file = this.paths.tasksFile(task.projectId)
    await withFileLock(file, async () => {
      const tasks = await readJsonl<V2TaskState>(file)
      const idx = tasks.findIndex(t => t.taskId === task.taskId)
      if (idx >= 0) {
        tasks[idx] = task
      } else {
        tasks.push(task)
      }
      const serialized = tasks.map(t => JSON.stringify(t)).join('\n') + (tasks.length > 0 ? '\n' : '')
      await writeFileAtomic(file, serialized)
    })
  }

  async listTasks(projectId: string): Promise<V2TaskState[]> {
    const tasks = await readJsonl<V2TaskState>(this.paths.tasksFile(projectId))
    tasks.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    return tasks
  }

  async getTask(projectId: string, taskId: string): Promise<V2TaskState | null> {
    const tasks = await this.listTasks(projectId)
    return tasks.find(t => t.taskId === taskId) ?? null
  }

  async writeContinuity(record: V2ContinuityRecord): Promise<void> {
    await writeJsonFile(this.paths.continuitySessionFile(record.projectId, record.sessionId), record)
  }

  async getContinuity(projectId: string, sessionId: string): Promise<V2ContinuityRecord | null> {
    return readJsonFile<V2ContinuityRecord>(this.paths.continuitySessionFile(projectId, sessionId))
  }

  async listRecentContinuity(projectId: string, excludeSessionId: string, maxCount: number): Promise<V2ContinuityRecord[]> {
    const folder = path.join(this.paths.root, 'continuity', 'projects', projectId, 'sessions')
    try {
      const files = await fs.readdir(folder)
      const records: V2ContinuityRecord[] = []
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        if (file === `${excludeSessionId}.json`) continue
        const rec = await readJsonFile<V2ContinuityRecord>(path.join(folder, file))
        if (rec) records.push(rec)
      }
      records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      return records.slice(0, maxCount)
    } catch (error) {
      if (!isNotFoundError(error)) {
        warnStorageError('KV2_E_IO_READ', folder, error)
      }
      return []
    }
  }

  async listMemoryFacts(): Promise<V2MemoryFact[]> {
    const facts = await readJsonl<V2MemoryFact>(this.paths.memoryFactsFile)
    facts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    return facts
  }

  async getLatestMemoryFact(namespace: MemoryNamespace, key: string): Promise<V2MemoryFact | null> {
    const latestByKey = await this.getLatestMemoryFactsByKeyMap()
    const found = latestByKey.get(`${namespace}:${key}`)
    if (!found || found.status === 'superseded') return null
    return found
  }

  async putMemoryFact(
    fact: Omit<V2MemoryFact, 'id' | 'createdAt' | 'updatedAt'>,
    options?: { id?: string; createdAt?: string; updatedAt?: string }
  ): Promise<V2MemoryFact> {
    const now = nowIso()
    const full: V2MemoryFact = {
      ...fact,
      id: options?.id ?? generateId('mem'),
      createdAt: options?.createdAt ?? now,
      updatedAt: options?.updatedAt ?? now
    }
    await appendJsonl(this.paths.memoryFactsFile, full)
    this.latestMemoryFactsCacheDirty = true
    return full
  }

  async supersedeMemoryFact(existing: V2MemoryFact): Promise<V2MemoryFact> {
    const superseded: V2MemoryFact = {
      ...existing,
      status: 'superseded',
      updatedAt: nowIso()
    }
    await appendJsonl(this.paths.memoryFactsFile, superseded)
    this.latestMemoryFactsCacheDirty = true
    return superseded
  }

  async deprecateMemoryFact(existing: V2MemoryFact): Promise<V2MemoryFact> {
    const deprecated: V2MemoryFact = {
      ...existing,
      status: 'deprecated',
      updatedAt: nowIso()
    }
    await appendJsonl(this.paths.memoryFactsFile, deprecated)
    this.latestMemoryFactsCacheDirty = true
    return deprecated
  }

  async addArtifact(record: Omit<V2ArtifactRecord, 'id' | 'createdAt'>): Promise<V2ArtifactRecord> {
    const full: V2ArtifactRecord = {
      ...record,
      id: generateId('art'),
      createdAt: nowIso()
    }
    await appendJsonl(this.paths.artifactsRefsFile, full)
    return full
  }

  async listArtifacts(projectId: string): Promise<V2ArtifactRecord[]> {
    const all = await readJsonl<V2ArtifactRecord>(this.paths.artifactsRefsFile)
    const filtered = all.filter(a => a.projectId === projectId)
    filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return filtered
  }

  async searchArtifacts(projectId: string, query: string, limit = 20): Promise<Array<{ artifact: V2ArtifactRecord; score: number; matchedKeywords: string[] }>> {
    const artifacts = await this.listArtifacts(projectId)
    const queryTokens = tokenize(query)
    const scored = artifacts
      .map((artifact) => {
        const hay = `${artifact.summary} ${artifact.sourceRef} ${artifact.path} ${artifact.type}`
        const { score, matched } = scoreByKeywords(queryTokens, hay)
        return {
          artifact,
          score,
          matchedKeywords: matched
        }
      })
      .filter(entry => entry.score > 0 || queryTokens.length === 0)
      .sort((a, b) => b.score - a.score)

    return scored.slice(0, limit)
  }

  async appendMemoryArchive(fact: V2MemoryFact): Promise<void> {
    await appendJsonl(this.paths.memoryArchiveFile, fact)
  }

  async listLatestMemoryFactsByKey(): Promise<V2MemoryFact[]> {
    const latest = await this.getLatestMemoryFactsByKeyMap()
    const values = [...latest.values()]
    values.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    return values
  }

  private async listLatestMemoryItems(filters?: LatestMemoryItemFilters): Promise<MemoryItem[]> {
    const latestByKey = await this.getLatestMemoryFactsByKeyMap()
    let items = [...latestByKey.values()]
      .filter(f => f.status !== 'superseded')
      .map(toMemoryItem)

    if (filters?.namespace) {
      items = items.filter(i => i.namespace === filters.namespace)
    }

    if (filters?.tags && filters.tags.length > 0) {
      const tagSet = new Set(filters.tags)
      items = items.filter(i => i.tags.some(t => tagSet.has(t)))
    }

    if (filters?.status && filters.status !== 'all') {
      items = items.filter(i => i.status === filters.status)
    }

    if (filters?.sensitivity && filters.sensitivity !== 'all') {
      items = items.filter(i => i.sensitivity === filters.sensitivity)
    }

    return items
  }

  private async getLatestMemoryFactsByKeyMap(): Promise<Map<string, V2MemoryFact>> {
    if (this.latestMemoryFactsByKeyCache && !this.latestMemoryFactsCacheDirty) {
      return this.latestMemoryFactsByKeyCache
    }

    const facts = await readJsonl<V2MemoryFact>(this.paths.memoryFactsFile)
    facts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))

    const latestByKey = new Map<string, V2MemoryFact>()
    for (const fact of facts) {
      const fk = `${fact.namespace}:${fact.key}`
      if (!latestByKey.has(fk)) {
        latestByKey.set(fk, fact)
      }
    }

    this.latestMemoryFactsByKeyCache = latestByKey
    this.latestMemoryFactsCacheDirty = false
    return latestByKey
  }

  async listActiveMemoryItems(options?: MemoryListOptions): Promise<{ items: MemoryItem[]; total: number }> {
    let items = await this.listLatestMemoryItems({
      namespace: options?.namespace,
      tags: options?.tags,
      status: options?.status
    })

    const total = items.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 100
    items = items.slice(offset, offset + limit)

    return { items, total }
  }

  async searchMemoryItems(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const listed = await this.listLatestMemoryItems({
      namespace: options?.namespace,
      tags: options?.tags,
      status: options?.includeDeprecated ? 'all' : 'active',
      sensitivity: options?.sensitivity
    })

    const queryTokens = tokenize(query)
    const filtered = listed.filter(item => {
      if (!options?.sensitivity) return item.sensitivity !== 'sensitive'
      return true
    })

    const scored = filtered
      .map((item) => {
        const hay = `${item.namespace}:${item.key} ${item.valueText ?? ''} ${JSON.stringify(item.value)}`
        const { score, matched } = scoreByKeywords(queryTokens, hay)
        return {
          item,
          score,
          matchedKeywords: matched
        }
      })
      .filter(r => r.score > 0 || queryTokens.length === 0)
      .sort((a, b) => b.score - a.score)

    return scored.slice(0, options?.limit ?? 20)
  }

  async getMemoryStats(): Promise<{ totalItems: number; byNamespace: Record<string, number>; bySensitivity: Record<MemorySensitivity, number> }> {
    const listed = await this.listLatestMemoryItems({ status: 'all' })
    const byNamespace: Record<string, number> = {}
    const bySensitivity: Record<MemorySensitivity, number> = {
      public: 0,
      internal: 0,
      sensitive: 0
    }

    for (const item of listed) {
      byNamespace[item.namespace] = (byNamespace[item.namespace] ?? 0) + 1
      bySensitivity[item.sensitivity] = (bySensitivity[item.sensitivity] ?? 0) + 1
    }

    return {
      totalItems: listed.length,
      byNamespace,
      bySensitivity
    }
  }

  async hasAnyV2Data(): Promise<boolean> {
    const [facts, projects] = await Promise.all([
      this.listMemoryFacts(),
      readJsonl<V2ProjectRecord>(this.paths.projectRegistry)
    ])
    if (facts.length > 0 || projects.length > 0) return true

    try {
      const sessionsDir = path.join(this.paths.root, 'history', 'sessions')
      const dirs = await fs.readdir(sessionsDir)
      return dirs.length > 0
    } catch (error) {
      if (!isNotFoundError(error)) {
        warnStorageError('KV2_E_IO_READ', path.join(this.paths.root, 'history', 'sessions'), error)
      }
      return false
    }
  }

  async listJsonlFilesUnderRoot(): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (!isNotFoundError(error)) {
          warnStorageError('KV2_E_IO_READ', dir, error)
        }
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile() && full.endsWith('.jsonl')) {
          out.push(full)
        }
      }
    }

    await walk(this.paths.root)
    return out
  }

  async listSessionIds(): Promise<string[]> {
    const sessionsRoot = path.join(this.paths.root, 'history', 'sessions')
    try {
      const entries = await fs.readdir(sessionsRoot, { withFileTypes: true })
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
    } catch (error) {
      if (!isNotFoundError(error)) {
        warnStorageError('KV2_E_IO_READ', sessionsRoot, error)
      }
      return []
    }
  }
}
