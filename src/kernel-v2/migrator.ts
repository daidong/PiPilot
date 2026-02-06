import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { MemoryItem } from '../types/memory.js'
import type { KernelV2ResolvedConfig, V2Role } from './types.js'
import { KernelV2Storage } from './storage.js'

interface V1MessageLine {
  role: string
  content: string
  timestamp?: string
}

interface MigrationMeta {
  version: 'v1-to-v2'
  doneAt: string
  sourceRoot: string
  targetRoot: string
  migratedSessions: number
  migratedMessages: number
  migratedMemoryItems: number
  skipped: boolean
  reason?: string
}

function safeParse<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T
  } catch {
    return null
  }
}

function toV2Role(role: string): V2Role | null {
  if (role === 'user' || role === 'assistant' || role === 'tool') return role
  return null
}

function toV2Status(status: string | undefined): 'active' | 'deprecated' {
  return status === 'deprecated' ? 'deprecated' : 'active'
}

export class KernelV2Migrator {
  private readonly v1Root: string
  private readonly markerPath: string

  constructor(
    projectPath: string,
    private readonly storage: KernelV2Storage,
    private readonly config: KernelV2ResolvedConfig,
    private readonly emit: (event: { event: string; payload: Record<string, unknown>; message: string }) => void
  ) {
    this.v1Root = path.join(projectPath, '.agent-foundry')
    this.markerPath = path.join(projectPath, '.agent-foundry-v2', 'migration', 'v1-migration.json')
  }

  private async markerExists(): Promise<boolean> {
    try {
      await fs.access(this.markerPath)
      return true
    } catch {
      return false
    }
  }

  private async writeMarker(meta: MigrationMeta): Promise<void> {
    await fs.mkdir(path.dirname(this.markerPath), { recursive: true })
    await fs.writeFile(this.markerPath, JSON.stringify(meta, null, 2), 'utf-8')
  }

  async maybeMigrate(): Promise<void> {
    if (!this.config.migration.autoFromV1) return
    if (await this.markerExists()) return

    const v1Exists = await fs.access(this.v1Root).then(() => true).catch(() => false)
    if (!v1Exists) {
      await this.writeMarker({
        version: 'v1-to-v2',
        doneAt: new Date().toISOString(),
        sourceRoot: this.v1Root,
        targetRoot: this.storage.paths.root,
        migratedSessions: 0,
        migratedMessages: 0,
        migratedMemoryItems: 0,
        skipped: true,
        reason: 'v1_not_found'
      })
      return
    }

    const hasV2Data = await this.storage.hasAnyV2Data()
    if (hasV2Data) {
      await this.writeMarker({
        version: 'v1-to-v2',
        doneAt: new Date().toISOString(),
        sourceRoot: this.v1Root,
        targetRoot: this.storage.paths.root,
        migratedSessions: 0,
        migratedMessages: 0,
        migratedMemoryItems: 0,
        skipped: true,
        reason: 'v2_not_empty'
      })
      return
    }

    this.emit({
      event: 'migration.v1_to_v2.started',
      payload: { source: this.v1Root, target: this.storage.paths.root },
      message: 'migration v1->v2 started'
    })

    const project = await this.storage.getOrCreateProject()

    let migratedSessions = 0
    let migratedMessages = 0
    let migratedMemoryItems = 0

    const sessionsDir = path.join(this.v1Root, 'sessions')
    const sessionEntries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => [])

    for (const entry of sessionEntries) {
      if (!entry.isDirectory()) continue
      const sessionId = entry.name
      if (!sessionId || sessionId.startsWith('.')) continue

      const messagesPath = path.join(sessionsDir, sessionId, 'messages.jsonl')
      const raw = await fs.readFile(messagesPath, 'utf-8').catch(() => '')
      if (!raw.trim()) continue

      const lines = raw.split(/\r?\n/).filter(Boolean)
      let accepted = 0
      for (const line of lines) {
        const msg = safeParse<V1MessageLine>(line)
        if (!msg) continue
        const role = toV2Role(msg.role)
        if (!role) continue
        if (!msg.content || !msg.content.trim()) continue
        await this.storage.appendTurn(sessionId, {
          role,
          content: msg.content,
          createdAt: msg.timestamp
        })
        accepted += 1
      }

      if (accepted > 0) {
        migratedSessions += 1
        migratedMessages += accepted
        await this.storage.bindSessionToProject(sessionId, project.projectId)
      }
    }

    const memoryItemsPath = path.join(this.v1Root, 'memory', 'items.json')
    const memoryRaw = await fs.readFile(memoryItemsPath, 'utf-8').catch(() => '')
    if (memoryRaw) {
      const parsed = safeParse<{ items?: Record<string, Partial<MemoryItem>> }>(memoryRaw)
      const items = parsed?.items ?? {}

      for (const [fullKey, item] of Object.entries(items)) {
        let namespace = item.namespace
        let key = item.key
        if (!namespace || !key) {
          const split = fullKey.indexOf(':')
          if (split < 0) continue
          namespace = fullKey.slice(0, split)
          key = fullKey.slice(split + 1)
        }

        if (!namespace || !key) continue

        await this.storage.putMemoryFact({
          namespace,
          key,
          value: item.value,
          valueText: item.valueText,
          tags: item.tags ?? [],
          sensitivity: item.sensitivity ?? 'internal',
          status: toV2Status(item.status),
          confidence: item.provenance?.createdBy === 'user' ? 0.95 : 0.85,
          provenance: {
            sourceType: 'tool',
            sourceRef: `v1-memory:${namespace}:${key}`,
            traceId: item.provenance?.traceId ?? `migrate_${Date.now().toString(36)}`,
            sessionId: item.provenance?.sessionId,
            createdBy: item.provenance?.createdBy ?? 'system'
          }
        }, {
          id: item.id,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        })

        migratedMemoryItems += 1
      }
    }

    await this.writeMarker({
      version: 'v1-to-v2',
      doneAt: new Date().toISOString(),
      sourceRoot: this.v1Root,
      targetRoot: this.storage.paths.root,
      migratedSessions,
      migratedMessages,
      migratedMemoryItems,
      skipped: false
    })

    this.emit({
      event: 'migration.v1_to_v2.completed',
      payload: {
        migratedSessions,
        migratedMessages,
        migratedMemoryItems
      },
      message: `migration v1->v2 completed sessions=${migratedSessions} messages=${migratedMessages} memory=${migratedMemoryItems}`
    })
  }
}
