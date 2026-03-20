/**
 * Cache - Caching utilities
 */

export interface CacheEntry<T> {
  value: T
  timestamp: number
  ttlMs?: number
}

/**
 * Simple in-memory cache
 */
export class Cache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>()
  private defaultTtlMs: number

  constructor(defaultTtlMs: number = 5 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs
  }

  /**
   * Get a cached value
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
   * Set a cached value
   */
  set(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, {
      value,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs
    })
  }

  /**
   * Check if a cache entry exists and is valid
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
   * Delete a cache entry
   */
  delete(key: string): boolean {
    return this.store.delete(key)
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.store.clear()
  }

  /**
   * Invalidate cache entries by pattern
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
   * Get cache size
   */
  get size(): number {
    return this.store.size
  }

  /**
   * Clean up expired cache entries
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
 * Build a cache key
 */
export function buildCacheKey(prefix: string, params?: unknown): string {
  if (!params) {
    return prefix
  }
  const hash = JSON.stringify(params)
  return `${prefix}:${hash}`
}
