import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { InMemoryStateStore } from './state-store.js'
import type { SessionEvent, StateStore } from './types.js'

interface FileStoreConfig {
  dir: string
}

const EVENTS_FILE = 'session.events.jsonl'
const MEMORY_FILE = 'memory.json'

export class FileStateStore implements StateStore {
  private readonly dir: string
  private readonly eventsFile: string
  private readonly memoryFile: string
  private readonly fallback = new InMemoryStateStore()
  private initialized = false

  constructor(config: FileStoreConfig) {
    this.dir = config.dir
    this.eventsFile = join(this.dir, EVENTS_FILE)
    this.memoryFile = join(this.dir, MEMORY_FILE)
  }

  private async init(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.dir, { recursive: true })
    await mkdir(dirname(this.eventsFile), { recursive: true })
    await mkdir(dirname(this.memoryFile), { recursive: true })

    try {
      const raw = await readFile(this.eventsFile, 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          await this.fallback.append(JSON.parse(trimmed) as SessionEvent)
        } catch {
          // Skip corrupt lines; keep store available
        }
      }
    } catch {
      // first boot
    }

    try {
      const raw = await readFile(this.memoryFile, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [k, v] of Object.entries(parsed)) {
        await this.fallback.setMemory(k, v)
      }
    } catch {
      // first boot
    }

    this.initialized = true
  }

  async append(event: SessionEvent): Promise<void> {
    await this.init()
    await this.fallback.append(event)
    await appendFile(this.eventsFile, `${JSON.stringify(event)}\n`, 'utf8')
  }

  async list(filter?: { type?: string; source?: string; limit?: number }): Promise<SessionEvent[]> {
    await this.init()
    return this.fallback.list(filter)
  }

  async getMemory<T = unknown>(key: string): Promise<T | undefined> {
    await this.init()
    return this.fallback.getMemory<T>(key)
  }

  async setMemory<T = unknown>(key: string, value: T): Promise<void> {
    await this.init()
    await this.fallback.setMemory(key, value)
    await this.flushMemory()
  }

  async deleteMemory(key: string): Promise<void> {
    await this.init()
    await this.fallback.deleteMemory(key)
    await this.flushMemory()
  }

  async listMemory(prefix?: string): Promise<Record<string, unknown>> {
    await this.init()
    return this.fallback.listMemory(prefix)
  }

  private async flushMemory(): Promise<void> {
    const current = await this.fallback.listMemory()
    await writeFile(this.memoryFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  }
}

export function fileStore(dir: string): StateStore {
  return new FileStateStore({ dir })
}
