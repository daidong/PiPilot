/**
 * MCP Transport Base
 *
 * 传输层抽象基类，定义 MCP 通信的基础接口
 */

import { EventEmitter } from 'node:events'
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification
} from '../types.js'

/**
 * 传输层事件类型
 */
export interface TransportEvents {
  'message': JsonRpcResponse | JsonRpcNotification
  'error': Error
  'close': void
}

/**
 * 传输层配置
 */
export interface TransportConfig {
  /** 请求超时（毫秒） */
  timeout?: number
  /** 调试模式 */
  debug?: boolean
}

/**
 * 传输层抽象基类
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
   * 启动传输连接
   */
  abstract start(): Promise<void>

  /**
   * 停止传输连接
   */
  abstract stop(): Promise<void>

  /**
   * 发送原始消息
   */
  protected abstract send(message: JsonRpcRequest | JsonRpcNotification): Promise<void>

  /**
   * 检查是否就绪
   */
  isReady(): boolean {
    return this.ready
  }

  /**
   * 发送 JSON-RPC 请求并等待响应
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
   * 发送通知（不等待响应）
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
   * 处理收到的消息
   */
  protected handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    if (this.config.debug) {
      console.debug('[MCP] Received:', JSON.stringify(message))
    }

    // 检查是否是响应（有 id）
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
      // 是通知，发出事件
      this.emit('message', message)
    }
  }

  /**
   * 处理错误
   */
  protected handleError(error: Error): void {
    if (this.config.debug) {
      console.error('[MCP] Error:', error)
    }
    this.emit('error', error)
  }

  /**
   * 处理连接关闭
   */
  protected handleClose(): void {
    this.ready = false

    // 拒绝所有挂起的请求
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Transport closed'))
      this.pendingRequests.delete(id)
    }

    this.emit('close')
  }

  /**
   * 生成下一个请求 ID
   */
  protected nextRequestId(): number {
    return ++this.requestId
  }
}
