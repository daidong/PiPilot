/**
 * Rate Limiter & Circuit Breaker for Literature Search v2
 *
 * Shared between the searcher and metadata enrichment modules.
 * Provides per-source request throttling and failure-based circuit breaking.
 */

// ============================================================================
// Rate Limiter
// ============================================================================

interface RateLimitConfig {
  requestsPerMinute: number
  concurrency: number
}

/**
 * Token-bucket rate limiter with per-source tracking.
 * Each source gets its own bucket that refills at the configured rate.
 */
export class RateLimiter {
  private timestamps: Map<string, number[]> = new Map()
  private activeCounts: Map<string, number> = new Map()
  private configs: Record<string, RateLimitConfig>

  constructor(configs: Record<string, RateLimitConfig>) {
    this.configs = configs
  }

  /**
   * Wait until a request slot is available for the given source.
   * Returns immediately if within limits.
   */
  async acquire(source: string): Promise<void> {
    const config = this.configs[source]
    if (!config) return // No limit configured for this source

    // Check concurrency
    const active = this.activeCounts.get(source) || 0
    if (active >= config.concurrency) {
      // Wait for a slot (simple polling with backoff)
      await this.waitForSlot(source, config.concurrency)
    }

    // Check rate limit
    const now = Date.now()
    const windowMs = 60_000
    const timestamps = this.timestamps.get(source) || []

    // Remove timestamps outside the window
    const recent = timestamps.filter(t => now - t < windowMs)

    if (recent.length >= config.requestsPerMinute) {
      // Wait until the oldest timestamp expires
      const oldestInWindow = recent[0]
      const waitMs = windowMs - (now - oldestInWindow) + 50 // 50ms buffer
      if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs))
      }
    }

    // Record this request
    recent.push(Date.now())
    this.timestamps.set(source, recent)
    this.activeCounts.set(source, (this.activeCounts.get(source) || 0) + 1)
  }

  /**
   * Release a concurrency slot after a request completes.
   */
  release(source: string): void {
    const active = this.activeCounts.get(source) || 0
    if (active > 0) {
      this.activeCounts.set(source, active - 1)
    }
  }

  /** Total requests made across all sources */
  get totalRequests(): number {
    let total = 0
    for (const timestamps of this.timestamps.values()) {
      total += timestamps.length
    }
    return total
  }

  private async waitForSlot(source: string, maxConcurrency: number): Promise<void> {
    const maxWait = 10_000
    const start = Date.now()
    while (Date.now() - start < maxWait) {
      const active = this.activeCounts.get(source) || 0
      if (active < maxConcurrency) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

// ============================================================================
// Circuit Breaker
// ============================================================================

type CircuitState = 'closed' | 'open' | 'half-open'

interface CircuitBreakerConfig {
  failureThreshold: number
  resetTimeMs: number
}

/**
 * Per-source circuit breaker.
 * Opens after N consecutive failures, tries again after resetTimeMs.
 */
export class CircuitBreaker {
  private states: Map<string, CircuitState> = new Map()
  private failureCounts: Map<string, number> = new Map()
  private openedAt: Map<string, number> = new Map()
  private config: CircuitBreakerConfig

  constructor(config: CircuitBreakerConfig) {
    this.config = config
  }

  /**
   * Check whether requests to this source are allowed.
   */
  isAllowed(source: string): boolean {
    const state = this.states.get(source) || 'closed'

    if (state === 'closed') return true

    if (state === 'open') {
      const openTime = this.openedAt.get(source) || 0
      if (Date.now() - openTime >= this.config.resetTimeMs) {
        // Transition to half-open: allow one probe request
        this.states.set(source, 'half-open')
        return true
      }
      return false
    }

    // half-open: allow the probe
    return true
  }

  /**
   * Record a successful request — resets failure count and closes circuit.
   */
  recordSuccess(source: string): void {
    this.failureCounts.set(source, 0)
    this.states.set(source, 'closed')
  }

  /**
   * Record a failed request — increments failure count and may open circuit.
   */
  recordFailure(source: string): void {
    const count = (this.failureCounts.get(source) || 0) + 1
    this.failureCounts.set(source, count)

    if (count >= this.config.failureThreshold) {
      this.states.set(source, 'open')
      this.openedAt.set(source, Date.now())
    }
  }

  /**
   * Get the current state for a source.
   */
  getState(source: string): CircuitState {
    return this.states.get(source) || 'closed'
  }

  /** Total failures across all sources */
  get totalFailures(): number {
    let total = 0
    for (const count of this.failureCounts.values()) {
      total += count
    }
    return total
  }
}

// ============================================================================
// Searcher Configuration
// ============================================================================

export interface SearcherConfig {
  rateLimits: Record<string, RateLimitConfig>
  circuitBreaker: CircuitBreakerConfig
  maxTotalApiCalls: number
  maxTimeMs: number
}

/**
 * Default configuration for the literature searcher.
 */
export const DEFAULT_SEARCHER_CONFIG: SearcherConfig = {
  rateLimits: {
    semantic_scholar: { requestsPerMinute: 10, concurrency: 2 },
    arxiv: { requestsPerMinute: 3, concurrency: 1 },
    openalex: { requestsPerMinute: 10, concurrency: 3 },
    dblp: { requestsPerMinute: 5, concurrency: 2 },
    crossref: { requestsPerMinute: 10, concurrency: 2 }
  },
  circuitBreaker: {
    failureThreshold: 3,
    resetTimeMs: 60_000
  },
  maxTotalApiCalls: 60,
  maxTimeMs: 120_000
}
