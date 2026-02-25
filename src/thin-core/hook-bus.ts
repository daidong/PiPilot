import type { HookEvent, HookHandler } from './types.js'

export class HookBus {
  private handlers = new Map<string, Set<HookHandler>>()

  on(type: string, handler: HookHandler): () => void {
    const set = this.handlers.get(type) ?? new Set<HookHandler>()
    set.add(handler)
    this.handlers.set(type, set)
    return () => {
      set.delete(handler)
      if (set.size === 0) {
        this.handlers.delete(type)
      }
    }
  }

  async emit(type: string, data?: Record<string, unknown>): Promise<void> {
    const event: HookEvent = { type, data }
    const handlers = this.handlers.get(type)
    if (!handlers || handlers.size === 0) return
    for (const handler of handlers) {
      await handler(event)
    }
  }

  clear(): void {
    this.handlers.clear()
  }
}
