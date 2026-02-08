/**
 * EventBus - Event Bus
 */

import type { FrameworkEvent } from '../types/trace.js'

export type EventHandler<T = unknown> = (data: T) => void | Promise<void>

/**
 * Event Bus
 */
export class EventBus {
  private listeners = new Map<string, Set<EventHandler>>()

  /**
   * Subscribe to an event
   * @returns Unsubscribe function
   */
  on<T = unknown>(event: FrameworkEvent | string, handler: EventHandler<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }

    const handlers = this.listeners.get(event)!
    handlers.add(handler as EventHandler)

    return () => {
      handlers.delete(handler as EventHandler)
      if (handlers.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  /**
   * Subscribe to a one-time event
   */
  once<T = unknown>(event: FrameworkEvent | string, handler: EventHandler<T>): () => void {
    const wrappedHandler: EventHandler<T> = (data) => {
      unsubscribe()
      return handler(data)
    }

    const unsubscribe = this.on(event, wrappedHandler)
    return unsubscribe
  }

  /**
   * Emit an event
   */
  emit<T = unknown>(event: FrameworkEvent | string, data: T): void {
    const handlers = this.listeners.get(event)
    if (!handlers) {
      return
    }

    for (const handler of handlers) {
      try {
        const result = handler(data)
        // Handle async handler
        if (result instanceof Promise) {
          result.catch((error) => {
            console.error(`Error in event handler for ${event}:`, error)
          })
        }
      } catch (error) {
        console.error(`Error in event handler for ${event}:`, error)
      }
    }
  }

  /**
   * Emit an event asynchronously, waiting for all handlers to complete
   */
  async emitAsync<T = unknown>(event: FrameworkEvent | string, data: T): Promise<void> {
    const handlers = this.listeners.get(event)
    if (!handlers) {
      return
    }

    const promises: Promise<void>[] = []

    for (const handler of handlers) {
      try {
        const result = handler(data)
        if (result instanceof Promise) {
          promises.push(result)
        }
      } catch (error) {
        console.error(`Error in event handler for ${event}:`, error)
      }
    }

    await Promise.all(promises)
  }

  /**
   * Remove all handlers for an event
   */
  off(event: FrameworkEvent | string): void {
    this.listeners.delete(event)
  }

  /**
   * Clear all event listeners
   */
  clear(): void {
    this.listeners.clear()
  }

  /**
   * Get the number of listeners for an event
   */
  listenerCount(event: FrameworkEvent | string): number {
    return this.listeners.get(event)?.size ?? 0
  }

  /**
   * Get all registered event names
   */
  eventNames(): string[] {
    return Array.from(this.listeners.keys())
  }
}

// Create default event bus instance
export const defaultEventBus = new EventBus()
