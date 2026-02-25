import { randomUUID } from 'node:crypto'
import type { SessionEvent, StateStore } from './types.js'

export function createEvent(type: string, source?: string, data?: Record<string, unknown>): SessionEvent {
  return {
    id: randomUUID(),
    ts: Date.now(),
    type,
    source,
    data
  }
}

export class InMemoryStateStore implements StateStore {
  private events: SessionEvent[] = []
  private memory = new Map<string, unknown>()

  async append(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }

  async list(filter?: { type?: string; source?: string; limit?: number }): Promise<SessionEvent[]> {
    let items = this.events
    if (filter?.type) {
      items = items.filter(item => item.type === filter.type)
    }
    if (filter?.source) {
      items = items.filter(item => item.source === filter.source)
    }
    if (filter?.limit && filter.limit > 0) {
      items = items.slice(-filter.limit)
    }
    return [...items]
  }

  async getMemory<T = unknown>(key: string): Promise<T | undefined> {
    return this.memory.get(key) as T | undefined
  }

  async setMemory<T = unknown>(key: string, value: T): Promise<void> {
    this.memory.set(key, value)
  }

  async deleteMemory(key: string): Promise<void> {
    this.memory.delete(key)
  }

  async listMemory(prefix?: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of this.memory.entries()) {
      if (!prefix || k.startsWith(prefix)) {
        out[k] = v
      }
    }
    return out
  }
}
