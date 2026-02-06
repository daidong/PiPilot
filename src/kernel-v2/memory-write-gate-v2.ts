import type {
  MemoryItem,
  MemoryListOptions,
  MemoryNamespace,
  MemorySearchOptions,
  MemorySearchResult,
  MemorySensitivity,
  MemoryStatus,
  MemoryUpdateOptions,
  MemoryPutOptions
} from '../types/memory.js'
import type {
  KernelV2TelemetryEvent,
  V2MemoryWriteCandidate,
  V2WriteResult,
  V2WriteAction
} from './types.js'
import { KernelV2Storage } from './storage.js'

function randomId(): string {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) return []
  return [...new Set(tags.map(t => t.trim()).filter(Boolean))]
}

function toItemShape(params: {
  id: string
  namespace: MemoryNamespace
  key: string
  value: unknown
  valueText?: string
  tags: string[]
  sensitivity: MemorySensitivity
  status: MemoryStatus
  createdBy: 'user' | 'model' | 'system'
  traceId: string
  sessionId?: string
  createdAt: string
  updatedAt: string
}): MemoryItem {
  return {
    id: params.id,
    namespace: params.namespace,
    key: params.key,
    value: params.value,
    valueText: params.valueText,
    tags: params.tags,
    sensitivity: params.sensitivity,
    status: params.status,
    provenance: {
      traceId: params.traceId,
      createdBy: params.createdBy,
      sessionId: params.sessionId
    },
    createdAt: params.createdAt,
    updatedAt: params.updatedAt
  }
}

function equivalent(existing: MemoryItem, candidate: V2MemoryWriteCandidate): boolean {
  const sameValue = JSON.stringify(existing.value) === JSON.stringify(candidate.value)
  const sameValueText = (existing.valueText ?? '') === (candidate.valueText ?? '')
  const sameSensitivity = existing.sensitivity === (candidate.sensitivity ?? 'internal')
  const sameTags = JSON.stringify([...existing.tags].sort()) === JSON.stringify(normalizeTags(candidate.tags).sort())
  return sameValue && sameValueText && sameSensitivity && sameTags
}

export class MemoryWriteGateV2 {
  private currentTurnWrites = 0
  private preFlushWrites = 0
  private readonly sessionAcceptedWrites = new Map<string, number>()

  constructor(
    private readonly storage: KernelV2Storage,
    private readonly limits: {
      maxWritesPerTurn: number
      maxWritesPerSession: number
      preFlushReserve: number
    },
    private readonly telemetry?: (event: KernelV2TelemetryEvent) => void
  ) {}

  beginTurn(): void {
    this.currentTurnWrites = 0
    this.preFlushWrites = 0
  }

  private emit(event: string, payload: Record<string, unknown>, message: string): void {
    this.telemetry?.({ event, payload, message })
  }

  private emitRateLimited(params: {
    sessionId: string
    mode: 'normal' | 'preflush'
    namespace: MemoryNamespace
    key: string
    reason: string
  }): void {
    this.emit(
      'memory.writegate.rate_limited',
      { reason: params.reason, sessionId: params.sessionId, mode: params.mode, namespace: params.namespace, key: params.key },
      `rate-limited ${params.namespace}:${params.key} reason=${params.reason}`
    )

    if (params.reason === 'rate_limited_preflush') {
      this.emit(
        'memory.writegate.rate_limited_preflush',
        { sessionId: params.sessionId, mode: params.mode, namespace: params.namespace, key: params.key },
        `rate-limited-preflush ${params.namespace}:${params.key}`
      )
    }
  }

  private canAcceptWrite(sessionId: string, mode: 'normal' | 'preflush'): { ok: boolean; reason?: string } {
    const accepted = this.sessionAcceptedWrites.get(sessionId) ?? 0
    if (accepted >= this.limits.maxWritesPerSession) {
      return { ok: false, reason: mode === 'preflush' ? 'rate_limited_preflush' : 'rate_limited' }
    }

    if (mode === 'normal' && this.currentTurnWrites >= this.limits.maxWritesPerTurn) {
      return { ok: false, reason: 'rate_limited' }
    }

    if (mode === 'preflush' && this.preFlushWrites >= this.limits.preFlushReserve) {
      return { ok: false, reason: 'rate_limited_preflush' }
    }

    return { ok: true }
  }

  private onAcceptedWrite(sessionId: string, mode: 'normal' | 'preflush'): void {
    if (mode === 'normal') {
      this.currentTurnWrites += 1
    } else {
      this.preFlushWrites += 1
    }
    this.sessionAcceptedWrites.set(sessionId, (this.sessionAcceptedWrites.get(sessionId) ?? 0) + 1)
  }

  async writeCandidate(candidate: V2MemoryWriteCandidate, sessionId: string, mode: 'normal' | 'preflush' = 'normal'): Promise<V2WriteResult> {
    const allow = this.canAcceptWrite(sessionId, mode)
    if (!allow.ok) {
      const reason = allow.reason ?? 'rate_limited'
      this.emitRateLimited({
        reason,
        sessionId,
        mode,
        namespace: candidate.namespace,
        key: candidate.key
      })
      return { action: 'RATE_LIMITED', item: null, reason }
    }

    const existing = await this.storage.getLatestMemoryFact(candidate.namespace, candidate.key)
    if (existing) {
      const existingItem = toItemShape({
        id: existing.id,
        namespace: existing.namespace,
        key: existing.key,
        value: existing.value,
        valueText: existing.valueText,
        tags: existing.tags,
        sensitivity: existing.sensitivity,
        status: existing.status === 'deprecated' ? 'deprecated' : 'active',
        createdBy: existing.provenance.createdBy,
        traceId: existing.provenance.traceId,
        sessionId: existing.provenance.sessionId,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt
      })

      if (equivalent(existingItem, candidate)) {
        this.emit('memory.writegate.action.ignore', { sessionId, namespace: candidate.namespace, key: candidate.key }, `ignore ${candidate.namespace}:${candidate.key}`)
        return { action: 'IGNORE', item: existingItem }
      }

      await this.storage.supersedeMemoryFact(existing)
    }

    const status = (candidate.createdBy === 'model' && candidate.sourceType === 'turn') ? 'proposed' : 'active'
    const inserted = await this.storage.putMemoryFact({
      namespace: candidate.namespace,
      key: candidate.key,
      value: candidate.value,
      valueText: candidate.valueText,
      tags: normalizeTags(candidate.tags),
      sensitivity: candidate.sensitivity ?? 'internal',
      status,
      confidence: candidate.confidence,
      provenance: {
        sourceType: candidate.sourceType,
        sourceRef: candidate.sourceRef,
        traceId: randomId(),
        sessionId,
        createdBy: candidate.createdBy
      }
    })

    this.onAcceptedWrite(sessionId, mode)

    const action: V2WriteAction = existing ? 'SUPERSEDE' : 'PUT'
    this.emit(`memory.writegate.action.${action.toLowerCase()}`, {
      sessionId,
      namespace: inserted.namespace,
      key: inserted.key,
      mode,
      status
    }, `${action.toLowerCase()} ${inserted.namespace}:${inserted.key}`)

    return {
      action,
      item: toItemShape({
        id: inserted.id,
        namespace: inserted.namespace,
        key: inserted.key,
        value: inserted.value,
        valueText: inserted.valueText,
        tags: inserted.tags,
        sensitivity: inserted.sensitivity,
        status: inserted.status === 'deprecated' ? 'deprecated' : 'active',
        createdBy: inserted.provenance.createdBy,
        traceId: inserted.provenance.traceId,
        sessionId: inserted.provenance.sessionId,
        createdAt: inserted.createdAt,
        updatedAt: inserted.updatedAt
      })
    }
  }

  async deprecate(namespace: MemoryNamespace, key: string, sessionId: string): Promise<V2WriteResult> {
    const existing = await this.storage.getLatestMemoryFact(namespace, key)
    if (!existing) {
      return { action: 'IGNORE', item: null, reason: 'not_found' }
    }

    const allow = this.canAcceptWrite(sessionId, 'normal')
    if (!allow.ok) {
      const reason = allow.reason ?? 'rate_limited'
      this.emitRateLimited({
        reason,
        sessionId,
        mode: 'normal',
        namespace,
        key
      })
      return { action: 'RATE_LIMITED', item: null, reason }
    }

    await this.storage.deprecateMemoryFact(existing)
    this.onAcceptedWrite(sessionId, 'normal')

    const item = toItemShape({
      id: existing.id,
      namespace: existing.namespace,
      key: existing.key,
      value: existing.value,
      valueText: existing.valueText,
      tags: existing.tags,
      sensitivity: existing.sensitivity,
      status: 'deprecated',
      createdBy: existing.provenance.createdBy,
      traceId: existing.provenance.traceId,
      sessionId: existing.provenance.sessionId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString()
    })
    this.emit('memory.writegate.action.supersede', { sessionId, namespace, key, action: 'deprecate' }, `deprecate ${namespace}:${key}`)
    return { action: 'SUPERSEDE', item }
  }

  async get(namespace: MemoryNamespace, key: string): Promise<MemoryItem | null> {
    const existing = await this.storage.getLatestMemoryFact(namespace, key)
    if (!existing) return null
    return toItemShape({
      id: existing.id,
      namespace: existing.namespace,
      key: existing.key,
      value: existing.value,
      valueText: existing.valueText,
      tags: existing.tags,
      sensitivity: existing.sensitivity,
      status: existing.status === 'deprecated' ? 'deprecated' : 'active',
      createdBy: existing.provenance.createdBy,
      traceId: existing.provenance.traceId,
      sessionId: existing.provenance.sessionId,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt
    })
  }

  async putFromTool(options: MemoryPutOptions, sessionId: string): Promise<MemoryItem> {
    const result = await this.writeCandidate({
      namespace: options.namespace,
      key: options.key,
      value: options.value,
      valueText: options.valueText,
      tags: options.tags,
      sensitivity: options.sensitivity,
      sourceType: 'tool',
      sourceRef: `memory-put:${options.namespace}:${options.key}`,
      createdBy: options.provenance?.createdBy ?? 'model',
      confidence: 0.9,
      overwrite: options.overwrite
    }, sessionId, 'normal')

    if (result.action === 'RATE_LIMITED') {
      throw new Error(result.reason ?? 'rate_limited')
    }

    if (!result.item) {
      throw new Error(`Failed to write memory for ${options.namespace}:${options.key}`)
    }

    return result.item
  }

  async updateFromTool(namespace: MemoryNamespace, key: string, options: MemoryUpdateOptions, sessionId: string): Promise<MemoryItem | null> {
    const existing = await this.get(namespace, key)
    if (!existing) return null

    const mergedValue = options.value !== undefined ? options.value : existing.value
    const mergedText = options.valueText !== undefined ? options.valueText : existing.valueText
    const mergedTags = options.tags !== undefined ? options.tags : existing.tags
    const mergedSensitivity = options.sensitivity !== undefined ? options.sensitivity : existing.sensitivity

    const result = await this.writeCandidate({
      namespace,
      key,
      value: mergedValue,
      valueText: mergedText,
      tags: mergedTags,
      sensitivity: mergedSensitivity,
      sourceType: 'tool',
      sourceRef: `memory-update:${namespace}:${key}`,
      createdBy: 'model',
      confidence: 0.9,
      overwrite: true
    }, sessionId, 'normal')

    if (result.action === 'RATE_LIMITED') {
      throw new Error(result.reason ?? 'rate_limited')
    }

    if (options.status === 'deprecated') {
      const deprecated = await this.deprecate(namespace, key, sessionId)
      return deprecated.item
    }

    return result.item
  }

  async deleteFromTool(namespace: MemoryNamespace, key: string, sessionId: string): Promise<boolean> {
    const result = await this.deprecate(namespace, key, sessionId)
    return result.item !== null
  }

  async has(namespace: MemoryNamespace, key: string): Promise<boolean> {
    const item = await this.get(namespace, key)
    return item !== null
  }

  async list(options?: MemoryListOptions): Promise<{ items: MemoryItem[]; total: number }> {
    return this.storage.listActiveMemoryItems(options)
  }

  async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    return this.storage.searchMemoryItems(query, options)
  }

  async getStats(): Promise<{ totalItems: number; byNamespace: Record<string, number>; bySensitivity: Record<MemorySensitivity, number> }> {
    return this.storage.getMemoryStats()
  }
}
