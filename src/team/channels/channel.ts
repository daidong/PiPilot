/**
 * Channel - Message passing between agents
 *
 * Channels provide pub/sub and request/response patterns for
 * agent-to-agent communication within a team.
 */

import { randomUUID } from 'node:crypto'

// ============================================================================
// Types
// ============================================================================

/**
 * Channel message
 */
export interface ChannelMessage<T = unknown> {
  /** Unique message ID */
  id: string
  /** Channel name */
  channel: string
  /** Sender agent ID */
  from: string
  /** Message payload */
  payload: T
  /** Timestamp */
  ts: number
  /** Optional correlation ID for request/response */
  correlationId?: string
  /** Optional reply-to channel */
  replyTo?: string
  /** Message metadata */
  metadata?: Record<string, unknown>
}

/**
 * Channel subscription
 */
export interface ChannelSubscription {
  /** Subscription ID */
  id: string
  /** Channel pattern (supports wildcards) */
  pattern: string
  /** Subscriber agent ID */
  subscriberId: string
  /** Message handler */
  handler: (message: ChannelMessage) => void | Promise<void>
  /** Filter function */
  filter?: (message: ChannelMessage) => boolean
}

/**
 * Pending request for request/response pattern
 */
interface PendingRequest {
  correlationId: string
  resolve: (response: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

/**
 * Channel trace event
 */
export interface ChannelTraceEvent {
  type: 'channel.publish' | 'channel.subscribe' | 'channel.request' | 'channel.response'
  runId: string
  ts: number
  channel: string
  messageId?: string
  from?: string
  to?: string
  correlationId?: string
}

/**
 * Trace context for channel operations
 */
export interface ChannelTraceContext {
  runId: string
  trace: {
    record: (event: ChannelTraceEvent) => void
  }
}

// ============================================================================
// Channel Hub
// ============================================================================

/**
 * Channel configuration
 */
export interface ChannelHubConfig {
  /** Default message TTL in milliseconds */
  defaultTtlMs?: number
  /** Max messages to retain per channel */
  maxRetainedMessages?: number
  /** Default request timeout in milliseconds */
  defaultRequestTimeoutMs?: number
}

/**
 * ChannelHub manages all channels for a team
 */
export class ChannelHub {
  private config: ChannelHubConfig
  private subscriptions = new Map<string, ChannelSubscription[]>()
  private messageHistory = new Map<string, ChannelMessage[]>()
  private pendingRequests = new Map<string, PendingRequest>()
  private traceCtx?: ChannelTraceContext

  constructor(config: ChannelHubConfig = {}) {
    this.config = {
      defaultTtlMs: config.defaultTtlMs ?? 60000,
      maxRetainedMessages: config.maxRetainedMessages ?? 100,
      defaultRequestTimeoutMs: config.defaultRequestTimeoutMs ?? 30000
    }
  }

  /**
   * Set trace context for recording events
   */
  setTraceContext(ctx: ChannelTraceContext): void {
    this.traceCtx = ctx
  }

  /**
   * Publish a message to a channel (pub/sub)
   */
  async publish<T>(
    channel: string,
    payload: T,
    from: string,
    options?: {
      metadata?: Record<string, unknown>
      correlationId?: string
      replyTo?: string
    }
  ): Promise<ChannelMessage<T>> {
    const message: ChannelMessage<T> = {
      id: randomUUID(),
      channel,
      from,
      payload,
      ts: Date.now(),
      correlationId: options?.correlationId,
      replyTo: options?.replyTo,
      metadata: options?.metadata
    }

    // Record trace event
    this.traceCtx?.trace.record({
      type: 'channel.publish',
      runId: this.traceCtx.runId,
      ts: Date.now(),
      channel,
      messageId: message.id,
      from
    })

    // Store in history
    this.retainMessage(message)

    // Deliver to subscribers
    await this.deliverMessage(message)

    return message
  }

  /**
   * Subscribe to a channel
   */
  subscribe(
    pattern: string,
    subscriberId: string,
    handler: (message: ChannelMessage) => void | Promise<void>,
    options?: {
      filter?: (message: ChannelMessage) => boolean
    }
  ): ChannelSubscription {
    const subscription: ChannelSubscription = {
      id: randomUUID(),
      pattern,
      subscriberId,
      handler,
      filter: options?.filter
    }

    const existing = this.subscriptions.get(pattern) ?? []
    existing.push(subscription)
    this.subscriptions.set(pattern, existing)

    // Record trace event
    this.traceCtx?.trace.record({
      type: 'channel.subscribe',
      runId: this.traceCtx?.runId ?? '',
      ts: Date.now(),
      channel: pattern,
      to: subscriberId
    })

    return subscription
  }

  /**
   * Unsubscribe from a channel
   */
  unsubscribe(subscriptionId: string): boolean {
    for (const [pattern, subs] of this.subscriptions) {
      const index = subs.findIndex(s => s.id === subscriptionId)
      if (index !== -1) {
        subs.splice(index, 1)
        if (subs.length === 0) {
          this.subscriptions.delete(pattern)
        }
        return true
      }
    }
    return false
  }

  /**
   * Request/response pattern - send a request and wait for response
   */
  async request<TReq, TRes>(
    channel: string,
    payload: TReq,
    from: string,
    options?: {
      timeoutMs?: number
      metadata?: Record<string, unknown>
    }
  ): Promise<TRes> {
    const correlationId = randomUUID()
    const replyTo = `_reply.${correlationId}`
    const timeoutMs = options?.timeoutMs ?? this.config.defaultRequestTimeoutMs ?? 30000

    // Record trace event
    this.traceCtx?.trace.record({
      type: 'channel.request',
      runId: this.traceCtx?.runId ?? '',
      ts: Date.now(),
      channel,
      from,
      correlationId
    })

    // Create promise for response
    const responsePromise = new Promise<TRes>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(correlationId)
        reject(new Error(`Request timeout after ${timeoutMs}ms on channel: ${channel}`))
      }, timeoutMs)

      this.pendingRequests.set(correlationId, {
        correlationId,
        resolve: resolve as (response: unknown) => void,
        reject,
        timeout
      })
    })

    // Subscribe to reply channel
    const replySub = this.subscribe(replyTo, from, (msg) => {
      const pending = this.pendingRequests.get(msg.correlationId ?? '')
      if (pending) {
        clearTimeout(pending.timeout)
        this.pendingRequests.delete(msg.correlationId ?? '')
        pending.resolve(msg.payload)

        // Record trace event
        this.traceCtx?.trace.record({
          type: 'channel.response',
          runId: this.traceCtx?.runId ?? '',
          ts: Date.now(),
          channel: replyTo,
          correlationId: msg.correlationId
        })
      }
      // Unsubscribe after receiving response
      this.unsubscribe(replySub.id)
    })

    // Publish request
    await this.publish(channel, payload, from, {
      correlationId,
      replyTo,
      metadata: options?.metadata
    })

    return responsePromise
  }

  /**
   * Reply to a request message
   */
  async reply<T>(
    originalMessage: ChannelMessage,
    payload: T,
    from: string
  ): Promise<ChannelMessage<T> | null> {
    if (!originalMessage.replyTo || !originalMessage.correlationId) {
      return null
    }

    return this.publish(originalMessage.replyTo, payload, from, {
      correlationId: originalMessage.correlationId
    })
  }

  /**
   * Get message history for a channel
   */
  getHistory(channel: string, limit?: number): ChannelMessage[] {
    const history = this.messageHistory.get(channel) ?? []
    if (limit) {
      return history.slice(-limit)
    }
    return [...history]
  }

  /**
   * Clear all subscriptions and history
   */
  clear(): void {
    this.subscriptions.clear()
    this.messageHistory.clear()
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Channel hub cleared'))
    }
    this.pendingRequests.clear()
  }

  /**
   * Get all active subscription patterns
   */
  getSubscriptionPatterns(): string[] {
    return Array.from(this.subscriptions.keys())
  }

  /**
   * Get subscriber count for a pattern
   */
  getSubscriberCount(pattern: string): number {
    return this.subscriptions.get(pattern)?.length ?? 0
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async deliverMessage(message: ChannelMessage): Promise<void> {
    const matchingSubscriptions: ChannelSubscription[] = []

    // Find all matching subscriptions
    for (const [pattern, subs] of this.subscriptions) {
      if (this.matchesPattern(message.channel, pattern)) {
        matchingSubscriptions.push(...subs)
      }
    }

    // Deliver to each subscriber
    const deliveryPromises = matchingSubscriptions
      .filter(sub => {
        // Skip if filter returns false
        if (sub.filter && !sub.filter(message)) {
          return false
        }
        // Don't deliver to sender (unless explicitly subscribed to self)
        return true
      })
      .map(async sub => {
        try {
          await sub.handler(message)
        } catch (error) {
          console.error(`Error delivering message to ${sub.subscriberId}:`, error)
        }
      })

    await Promise.all(deliveryPromises)
  }

  private matchesPattern(channel: string, pattern: string): boolean {
    // Exact match
    if (channel === pattern) {
      return true
    }

    // Wildcard matching
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
      return regex.test(channel)
    }

    return false
  }

  private retainMessage(message: ChannelMessage): void {
    const maxRetained = this.config.maxRetainedMessages ?? 100

    let history = this.messageHistory.get(message.channel)
    if (!history) {
      history = []
      this.messageHistory.set(message.channel, history)
    }

    history.push(message)

    // Trim to max retained
    if (history.length > maxRetained) {
      history.splice(0, history.length - maxRetained)
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a channel hub
 */
export function createChannelHub(config?: ChannelHubConfig): ChannelHub {
  return new ChannelHub(config)
}
