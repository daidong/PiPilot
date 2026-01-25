/**
 * Cache - 缓存工具
 */

export interface CacheEntry<T> {
  value: T
  timestamp: number
  ttlMs?: number
}

/**
 * 简单的内存缓存
 */
export class Cache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>()
  private defaultTtlMs: number

  constructor(defaultTtlMs: number = 5 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs
  }

  /**
   * 获取缓存值
   */
  get(key: string): T | undefined {
    const entry = this.store.get(key)
    if (!entry) {
      return undefined
    }

    if (this.isExpired(entry)) {
      this.store.delete(key)
      return undefined
    }

    return entry.value
  }

  /**
   * 设置缓存值
   */
  set(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, {
      value,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs
    })
  }

  /**
   * 检查缓存是否存在且有效
   */
  has(key: string): boolean {
    const entry = this.store.get(key)
    if (!entry) {
      return false
    }

    if (this.isExpired(entry)) {
      this.store.delete(key)
      return false
    }

    return true
  }

  /**
   * 删除缓存
   */
  delete(key: string): boolean {
    return this.store.delete(key)
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.store.clear()
  }

  /**
   * 按模式失效缓存
   */
  invalidateByPattern(pattern: RegExp): number {
    let count = 0
    for (const key of this.store.keys()) {
      if (pattern.test(key)) {
        this.store.delete(key)
        count++
      }
    }
    return count
  }

  /**
   * 获取缓存大小
   */
  get size(): number {
    return this.store.size
  }

  /**
   * 清理过期缓存
   */
  cleanup(): number {
    let count = 0
    for (const [key, entry] of this.store.entries()) {
      if (this.isExpired(entry)) {
        this.store.delete(key)
        count++
      }
    }
    return count
  }

  private isExpired(entry: CacheEntry<T>): boolean {
    const ttl = entry.ttlMs ?? this.defaultTtlMs
    return Date.now() - entry.timestamp > ttl
  }
}

/**
 * 构建缓存键
 */
export function buildCacheKey(prefix: string, params?: unknown): string {
  if (!params) {
    return prefix
  }
  const hash = JSON.stringify(params)
  return `${prefix}:${hash}`
}
