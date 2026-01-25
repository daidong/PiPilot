/**
 * EventBus - 事件总线
 */

import type { FrameworkEvent } from '../types/trace.js'

export type EventHandler<T = unknown> = (data: T) => void | Promise<void>

/**
 * 事件总线
 */
export class EventBus {
  private listeners = new Map<string, Set<EventHandler>>()

  /**
   * 订阅事件
   * @returns 取消订阅函数
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
   * 订阅一次性事件
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
   * 发送事件
   */
  emit<T = unknown>(event: FrameworkEvent | string, data: T): void {
    const handlers = this.listeners.get(event)
    if (!handlers) {
      return
    }

    for (const handler of handlers) {
      try {
        const result = handler(data)
        // 处理异步 handler
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
   * 异步发送事件，等待所有 handler 完成
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
   * 移除事件的所有 handler
   */
  off(event: FrameworkEvent | string): void {
    this.listeners.delete(event)
  }

  /**
   * 清空所有事件监听
   */
  clear(): void {
    this.listeners.clear()
  }

  /**
   * 获取事件的监听器数量
   */
  listenerCount(event: FrameworkEvent | string): number {
    return this.listeners.get(event)?.size ?? 0
  }

  /**
   * 获取所有已注册的事件
   */
  eventNames(): string[] {
    return Array.from(this.listeners.keys())
  }
}

// 创建默认事件总线实例
export const defaultEventBus = new EventBus()
