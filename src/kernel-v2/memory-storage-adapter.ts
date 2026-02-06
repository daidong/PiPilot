import type {
  MemoryStorage,
  MemoryItem,
  MemoryListOptions,
  MemoryNamespace,
  MemoryPutOptions,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryUpdateOptions,
  MemoryData
} from '../types/memory.js'
import { MemoryWriteGateV2 } from './memory-write-gate-v2.js'

export class KernelV2MemoryStorageAdapter implements MemoryStorage {
  constructor(
    private readonly gate: MemoryWriteGateV2,
    private readonly getSessionId: () => string
  ) {}

  async init(): Promise<void> {
    return
  }

  async close(): Promise<void> {
    return
  }

  async get(namespace: MemoryNamespace, key: string): Promise<MemoryItem | null> {
    return this.gate.get(namespace, key)
  }

  async has(namespace: MemoryNamespace, key: string): Promise<boolean> {
    return this.gate.has(namespace, key)
  }

  async put(options: MemoryPutOptions): Promise<MemoryItem> {
    const existing = await this.gate.get(options.namespace, options.key)
    if (existing && !options.overwrite) {
      throw new Error(`Memory item "${options.namespace}:${options.key}" already exists. Use overwrite: true to replace.`)
    }
    return this.gate.putFromTool(options, this.getSessionId())
  }

  async update(namespace: MemoryNamespace, key: string, options: MemoryUpdateOptions): Promise<MemoryItem | null> {
    return this.gate.updateFromTool(namespace, key, options, this.getSessionId())
  }

  async delete(namespace: MemoryNamespace, key: string, _reason?: string): Promise<boolean> {
    return this.gate.deleteFromTool(namespace, key, this.getSessionId())
  }

  async list(options?: MemoryListOptions): Promise<{ items: MemoryItem[]; total: number }> {
    return this.gate.list(options)
  }

  async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    return this.gate.search(query, options)
  }

  async cleanExpired(): Promise<number> {
    // V2 lifecycle jobs handle decay/archive; no TTL cleanup in online path.
    return 0
  }

  async rebuildIndex(): Promise<void> {
    // V2 index is rebuildable accelerator; adapter exposes no-op compatibility.
    return
  }

  async getStats(): Promise<MemoryData['stats']> {
    return this.gate.getStats()
  }
}
