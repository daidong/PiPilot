/**
 * MCP Transport Base
 *
 * Abstract base class for the transport layer, defining the fundamental interface for MCP communication
 */

import { EventEmitter } from 'node:events'
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification
} from '../types.js'

/**
 * Transport layer event types
 */
export interface TransportEvents {
  'message': JsonRpcResponse | JsonRpcNotification
  'error': Error
  'close': void
}

/**
 * Transport layer configuration
 */
export interface TransportConfig {
  /** Request timeout (ms) */
  timeout?: number
  /** Debug mode */
  debug?: boolean
}

/**
 * Transport layer abstract base class
 */
export abstract class MCPTransport extends EventEmitter {
  protected ready = false
  protected requestId = 0
  protected pendingRequests = new Map<
    string | number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  protected config: TransportConfig

  constructor(config: TransportConfig = {}) {
    super()
    this.config = {
      timeout: config.timeout ?? 30000,
      debug: config.debug ?? false
    }
  }

  /**
   * Start the transport connection
   */
  abstract start(): Promise<void>

  /**
   * Stop the transport connection
   */
  abstract stop(): Promise<void>

  /**
   * Send a raw message
   */
  protected abstract send(message: JsonRpcRequest | JsonRpcNotification): Promise<void>

  /**
   * Check if the transport is ready
   */
  isReady(): boolean {
    return this.ready
  }

  /**
   * Send a JSON-RPC request and wait for the response
   */
  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.ready) {
      throw new Error('Transport is not ready')
    }

    const id = ++this.requestId
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    }

    if (this.config.debug) {
      console.debug('[MCP] Request:', JSON.stringify(request))
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, this.config.timeout)

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })

      this.send(request).catch((error) => {
        clearTimeout(timer)
        this.pendingRequests.delete(id)
        reject(error)
      })
    })
  }

  /**
   * Send a notification (does not wait for a response)
   */
  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.ready) {
      throw new Error('Transport is not ready')
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params
    }

    if (this.config.debug) {
      console.debug('[MCP] Notification:', JSON.stringify(notification))
    }

    await this.send(notification)
  }

  /**
   * Handle a received message
   */
  protected handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    if (this.config.debug) {
      console.debug('[MCP] Received:', JSON.stringify(message))
    }

    // Check if it's a response (has an id)
    if ('id' in message && message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(message.id)

        if ('error' in message && message.error) {
          pending.reject(new Error(message.error.message))
        } else {
          pending.resolve(message.result)
        }
      }
    } else {
      // It's a notification, emit an event
      this.emit('message', message)
    }
  }

  /**
   * Handle an error
   */
  protected handleError(error: Error): void {
    if (this.config.debug) {
      console.error('[MCP] Error:', error)
    }
    this.emit('error', error)
  }

  /**
   * Handle connection close
   */
  protected handleClose(): void {
    this.ready = false

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Transport closed'))
      this.pendingRequests.delete(id)
    }

    this.emit('close')
  }

  /**
   * Generate the next request ID
   */
  protected nextRequestId(): number {
    return ++this.requestId
  }
}
