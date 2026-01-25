/**
 * FileMemoryStorage - File-based implementation of MemoryStorage
 *
 * Stores memory items in JSON files under .agent-foundry/memory/
 * - items.json: All memory items
 * - index.json: Inverted index for search
 * - history.jsonl: Append-only audit log
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type {
  MemoryStorage,
  MemoryItem,
  MemoryData,
  MemoryIndex,
  MemoryHistoryEntry,
  MemoryPutOptions,
  MemoryUpdateOptions,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryListOptions,
  MemoryNamespace,
  MemorySensitivity
} from '../types/memory.js'
import {
  buildFullKey,
  isValidMemoryKey,
  MEMORY_MAX_VALUE_SIZE
} from '../types/memory.js'

/**
 * Generate a random ID
 */
function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = 'mem_'
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

/**
 * Tokenize text into keywords for indexing
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_.,;:!?'"()[\]{}]+/)
    .filter(word => word.length > 2)
    .filter((word, index, self) => self.indexOf(word) === index) // unique
}

/**
 * Calculate similarity between query and text
 */
function calculateScore(query: string, item: MemoryItem, matchedKeywords: string[]): number {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return 0

  let score = matchedKeywords.length / queryTokens.length

  // Boost for exact key match
  if (item.key.toLowerCase().includes(query.toLowerCase())) {
    score += 0.3
  }

  // Boost for valueText match
  if (item.valueText && item.valueText.toLowerCase().includes(query.toLowerCase())) {
    score += 0.2
  }

  return Math.min(score, 1.0)
}

/**
 * File-based memory storage implementation
 */
export class FileMemoryStorage implements MemoryStorage {
  private basePath: string
  private itemsPath: string
  private indexPath: string
  private historyPath: string
  private data: MemoryData | null = null
  private index: MemoryIndex | null = null
  private initialized = false

  constructor(projectPath: string) {
    this.basePath = path.join(projectPath, '.agent-foundry', 'memory')
    this.itemsPath = path.join(this.basePath, 'items.json')
    this.indexPath = path.join(this.basePath, 'index.json')
    this.historyPath = path.join(this.basePath, 'history.jsonl')
  }

  /**
   * Initialize storage - create directories and load data
   */
  async init(): Promise<void> {
    if (this.initialized) return

    // Ensure directory exists
    await fs.mkdir(this.basePath, { recursive: true })

    // Load or create items
    try {
      const content = await fs.readFile(this.itemsPath, 'utf-8')
      this.data = JSON.parse(content) as MemoryData
    } catch {
      // Create empty data
      this.data = this.createEmptyData()
      await this.saveData()
    }

    // Load or create index
    try {
      const content = await fs.readFile(this.indexPath, 'utf-8')
      this.index = JSON.parse(content) as MemoryIndex
    } catch {
      // Rebuild index from data
      await this.rebuildIndex()
    }

    this.initialized = true
  }

  /**
   * Close storage (no-op for file-based)
   */
  async close(): Promise<void> {
    // Save any pending changes
    if (this.data) {
      await this.saveData()
    }
  }

  /**
   * Get a memory item by namespace and key
   */
  async get(namespace: MemoryNamespace, key: string): Promise<MemoryItem | null> {
    this.ensureInitialized()
    const fullKey = buildFullKey(namespace, key)
    return this.data!.items[fullKey] ?? null
  }

  /**
   * Check if a memory item exists
   */
  async has(namespace: MemoryNamespace, key: string): Promise<boolean> {
    const item = await this.get(namespace, key)
    return item !== null
  }

  /**
   * Put a new memory item
   */
  async put(options: MemoryPutOptions): Promise<MemoryItem> {
    this.ensureInitialized()

    // Validate key
    if (!isValidMemoryKey(options.key)) {
      throw new Error(`Invalid memory key format: "${options.key}". Use lowercase letters, numbers, underscores, and dots.`)
    }

    // Validate value size
    const valueStr = JSON.stringify(options.value)
    if (valueStr.length > MEMORY_MAX_VALUE_SIZE) {
      throw new Error(`Value exceeds maximum size of ${MEMORY_MAX_VALUE_SIZE} bytes`)
    }

    const fullKey = buildFullKey(options.namespace, options.key)
    const existing = this.data!.items[fullKey]

    // Check overwrite
    if (existing && !options.overwrite) {
      throw new Error(`Memory item "${fullKey}" already exists. Use overwrite: true to replace.`)
    }

    const now = new Date().toISOString()

    // Calculate TTL expiry
    let ttlExpiresAt: string | undefined
    if (options.ttlDays) {
      const expiry = new Date()
      expiry.setDate(expiry.getDate() + options.ttlDays)
      ttlExpiresAt = expiry.toISOString()
    }

    const item: MemoryItem = {
      id: existing?.id ?? generateId(),
      namespace: options.namespace,
      key: options.key,
      value: options.value,
      valueText: options.valueText,
      tags: options.tags ?? [],
      sensitivity: options.sensitivity ?? 'public',
      status: 'active',
      ttlExpiresAt,
      provenance: {
        traceId: options.provenance?.traceId ?? generateId(),
        createdBy: options.provenance?.createdBy ?? 'model',
        messageId: options.provenance?.messageId,
        sessionId: options.provenance?.sessionId,
        confirmedAt: options.provenance?.confirmedAt
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }

    // Store item
    this.data!.items[fullKey] = item

    // Update index
    this.indexItem(fullKey, item)

    // Update stats
    this.updateStats()

    // Append to history
    await this.appendHistory({
      op: 'put',
      key: fullKey,
      timestamp: now,
      traceId: item.provenance.traceId,
      actor: item.provenance.createdBy
    })

    // Save
    await this.saveData()
    await this.saveIndex()

    return item
  }

  /**
   * Update an existing memory item
   */
  async update(
    namespace: MemoryNamespace,
    key: string,
    options: MemoryUpdateOptions
  ): Promise<MemoryItem | null> {
    this.ensureInitialized()

    const fullKey = buildFullKey(namespace, key)
    const existing = this.data!.items[fullKey]

    if (!existing) {
      return null
    }

    const now = new Date().toISOString()
    const changes: Record<string, unknown> = {}

    // Apply updates
    if (options.value !== undefined) {
      const valueStr = JSON.stringify(options.value)
      if (valueStr.length > MEMORY_MAX_VALUE_SIZE) {
        throw new Error(`Value exceeds maximum size of ${MEMORY_MAX_VALUE_SIZE} bytes`)
      }
      changes.value = { from: existing.value, to: options.value }
      existing.value = options.value
    }

    if (options.valueText !== undefined) {
      changes.valueText = { from: existing.valueText, to: options.valueText }
      existing.valueText = options.valueText
    }

    if (options.tags !== undefined) {
      changes.tags = { from: existing.tags, to: options.tags }
      existing.tags = options.tags
    }

    if (options.status !== undefined) {
      changes.status = { from: existing.status, to: options.status }
      existing.status = options.status
    }

    if (options.sensitivity !== undefined) {
      changes.sensitivity = { from: existing.sensitivity, to: options.sensitivity }
      existing.sensitivity = options.sensitivity
    }

    existing.updatedAt = now

    // Reindex
    this.indexItem(fullKey, existing)

    // Update stats
    this.updateStats()

    // Append to history
    await this.appendHistory({
      op: 'update',
      key: fullKey,
      timestamp: now,
      traceId: generateId(),
      actor: 'model',
      changes
    })

    // Save
    await this.saveData()
    await this.saveIndex()

    return existing
  }

  /**
   * Delete (soft delete by default) a memory item
   */
  async delete(namespace: MemoryNamespace, key: string, reason?: string): Promise<boolean> {
    this.ensureInitialized()

    const fullKey = buildFullKey(namespace, key)
    const existing = this.data!.items[fullKey]

    if (!existing) {
      return false
    }

    const now = new Date().toISOString()

    // Soft delete - mark as deprecated
    existing.status = 'deprecated'
    existing.updatedAt = now

    // Remove from index (but keep in data for audit)
    this.removeFromIndex(fullKey)

    // Update stats
    this.updateStats()

    // Append to history
    await this.appendHistory({
      op: 'delete',
      key: fullKey,
      timestamp: now,
      traceId: generateId(),
      actor: 'model',
      reason
    })

    // Save
    await this.saveData()
    await this.saveIndex()

    return true
  }

  /**
   * List memory items with filtering
   */
  async list(options?: MemoryListOptions): Promise<{ items: MemoryItem[]; total: number }> {
    this.ensureInitialized()

    let items = Object.values(this.data!.items)

    // Filter by namespace
    if (options?.namespace) {
      items = items.filter(item => item.namespace === options.namespace)
    }

    // Filter by status
    const status = options?.status ?? 'active'
    if (status !== 'all') {
      items = items.filter(item => item.status === status)
    }

    // Filter by tags
    if (options?.tags && options.tags.length > 0) {
      items = items.filter(item =>
        options.tags!.some(tag => item.tags.includes(tag))
      )
    }

    // Sort by updatedAt descending
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    const total = items.length

    // Apply pagination
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 50
    items = items.slice(offset, offset + limit)

    return { items, total }
  }

  /**
   * Search memory items by query
   */
  async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    this.ensureInitialized()

    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) {
      return []
    }

    // Find candidate keys from index
    const candidateKeys = new Map<string, string[]>()

    for (const token of queryTokens) {
      const keys = this.index!.keywords[token] ?? []
      for (const key of keys) {
        const matched = candidateKeys.get(key) ?? []
        matched.push(token)
        candidateKeys.set(key, matched)
      }
    }

    // Build results
    const results: MemorySearchResult[] = []

    for (const [fullKey, matchedKeywords] of candidateKeys) {
      const item = this.data!.items[fullKey]
      if (!item) continue

      // Filter by namespace
      if (options?.namespace && item.namespace !== options.namespace) continue

      // Filter by status
      if (!options?.includeDeprecated && item.status === 'deprecated') continue

      // Filter by sensitivity
      if (options?.sensitivity && options.sensitivity !== 'all') {
        if (item.sensitivity !== options.sensitivity) continue
      }

      // Filter by tags
      if (options?.tags && options.tags.length > 0) {
        if (!options.tags.some(tag => item.tags.includes(tag))) continue
      }

      const score = calculateScore(query, item, matchedKeywords)
      results.push({ item, score, matchedKeywords })
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score)

    // Apply limit
    const limit = options?.limit ?? 20
    return results.slice(0, limit)
  }

  /**
   * Clean expired items
   */
  async cleanExpired(): Promise<number> {
    this.ensureInitialized()

    const now = new Date().toISOString()
    let count = 0

    for (const [fullKey, item] of Object.entries(this.data!.items)) {
      if (item.ttlExpiresAt && item.ttlExpiresAt < now && item.status === 'active') {
        item.status = 'deprecated'
        item.updatedAt = now
        this.removeFromIndex(fullKey)
        count++

        await this.appendHistory({
          op: 'delete',
          key: fullKey,
          timestamp: now,
          traceId: generateId(),
          actor: 'system',
          reason: 'TTL expired'
        })
      }
    }

    if (count > 0) {
      this.updateStats()
      await this.saveData()
      await this.saveIndex()
    }

    return count
  }

  /**
   * Rebuild the entire index from data
   */
  async rebuildIndex(): Promise<void> {
    this.ensureInitialized()

    this.index = {
      version: '1.0.0',
      updatedAt: new Date().toISOString(),
      keywords: {},
      tags: {},
      namespaces: {}
    }

    for (const [fullKey, item] of Object.entries(this.data!.items)) {
      if (item.status === 'active') {
        this.indexItem(fullKey, item)
      }
    }

    await this.saveIndex()
  }

  /**
   * Get storage stats
   */
  async getStats(): Promise<MemoryData['stats']> {
    this.ensureInitialized()
    return this.data!.stats
  }

  // ============ Private Methods ============

  private ensureInitialized(): void {
    if (!this.initialized || !this.data || !this.index) {
      throw new Error('MemoryStorage not initialized. Call init() first.')
    }
  }

  private createEmptyData(): MemoryData {
    return {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stats: {
        totalItems: 0,
        byNamespace: {},
        bySensitivity: { public: 0, internal: 0, sensitive: 0 }
      },
      items: {}
    }
  }

  private updateStats(): void {
    const items = Object.values(this.data!.items).filter(i => i.status === 'active')

    const byNamespace: Record<string, number> = {}
    const bySensitivity: Record<MemorySensitivity, number> = { public: 0, internal: 0, sensitive: 0 }

    for (const item of items) {
      byNamespace[item.namespace] = (byNamespace[item.namespace] ?? 0) + 1
      bySensitivity[item.sensitivity]++
    }

    this.data!.stats = {
      totalItems: items.length,
      byNamespace,
      bySensitivity
    }
    this.data!.updatedAt = new Date().toISOString()
  }

  private indexItem(fullKey: string, item: MemoryItem): void {
    // Remove old index entries first
    this.removeFromIndex(fullKey)

    if (item.status !== 'active') return

    // Index keywords from key, valueText, and tags
    const textToIndex = [
      item.key,
      item.valueText ?? '',
      ...item.tags
    ].join(' ')

    const keywords = tokenize(textToIndex)

    for (const keyword of keywords) {
      if (!this.index!.keywords[keyword]) {
        this.index!.keywords[keyword] = []
      }
      const kwKeys = this.index!.keywords[keyword]!
      if (!kwKeys.includes(fullKey)) {
        kwKeys.push(fullKey)
      }
    }

    // Index tags
    for (const tag of item.tags) {
      if (!this.index!.tags[tag]) {
        this.index!.tags[tag] = []
      }
      const tagKeys = this.index!.tags[tag]!
      if (!tagKeys.includes(fullKey)) {
        tagKeys.push(fullKey)
      }
    }

    // Index namespace
    if (!this.index!.namespaces[item.namespace]) {
      this.index!.namespaces[item.namespace] = []
    }
    const nsKeys = this.index!.namespaces[item.namespace]!
    if (!nsKeys.includes(fullKey)) {
      nsKeys.push(fullKey)
    }

    this.index!.updatedAt = new Date().toISOString()
  }

  private removeFromIndex(fullKey: string): void {
    // Remove from keywords
    for (const keys of Object.values(this.index!.keywords)) {
      const idx = keys.indexOf(fullKey)
      if (idx !== -1) keys.splice(idx, 1)
    }

    // Remove from tags
    for (const keys of Object.values(this.index!.tags)) {
      const idx = keys.indexOf(fullKey)
      if (idx !== -1) keys.splice(idx, 1)
    }

    // Remove from namespaces
    for (const keys of Object.values(this.index!.namespaces)) {
      const idx = keys.indexOf(fullKey)
      if (idx !== -1) keys.splice(idx, 1)
    }
  }

  private async saveData(): Promise<void> {
    await fs.writeFile(this.itemsPath, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  private async saveIndex(): Promise<void> {
    await fs.writeFile(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8')
  }

  private async appendHistory(entry: MemoryHistoryEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n'
    await fs.appendFile(this.historyPath, line, 'utf-8')
  }
}

/**
 * Create a new FileMemoryStorage instance
 */
export function createMemoryStorage(projectPath: string): MemoryStorage {
  return new FileMemoryStorage(projectPath)
}
