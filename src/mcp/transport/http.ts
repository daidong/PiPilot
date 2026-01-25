/**
 * MCP HTTP Transport
 *
 * 通过 HTTP/SSE 与远程 MCP server 通信
 */

import type {
  MCPHttpConfig,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse
} from '../types.js'
import { MCPTransport, type TransportConfig } from './base.js'

/**
 * HTTP 传输配置
 */
export interface HttpTransportConfig extends TransportConfig {
  /** HTTP 配置 */
  http: MCPHttpConfig
  /** 是否使用 SSE 接收通知 */
  useSSE?: boolean
}

/**
 * HTTP 传输实现
 *
 * 使用 HTTP POST 发送请求，可选 SSE 接收通知
 */
export class HttpTransport extends MCPTransport {
  private httpConfig: MCPHttpConfig
  private useSSE: boolean
  private sseController: AbortController | null = null
  private baseUrl: string

  constructor(config: HttpTransportConfig) {
    super(config)
    this.httpConfig = config.http
    this.useSSE = config.useSSE ?? false
    this.baseUrl = this.httpConfig.url.replace(/\/$/, '')
  }

  /**
   * 启动 HTTP 传输
   */
  async start(): Promise<void> {
    if (this.ready) {
      return
    }

    // 验证服务器可达
    try {
      const response = await fetch(this.baseUrl, {
        method: 'HEAD',
        headers: this.httpConfig.headers,
        signal: AbortSignal.timeout(this.httpConfig.timeout ?? 5000)
      })

      if (!response.ok && response.status !== 405) {
        // 405 是预期的（不支持 HEAD）
        throw new Error(`Server not reachable: ${response.status}`)
      }
    } catch (error) {
      // 如果 HEAD 失败，尝试 OPTIONS
      try {
        const response = await fetch(this.baseUrl, {
          method: 'OPTIONS',
          headers: this.httpConfig.headers,
          signal: AbortSignal.timeout(this.httpConfig.timeout ?? 5000)
        })
        // OPTIONS 通常返回 200 或 204
        if (!response.ok && response.status !== 204) {
          throw error
        }
      } catch {
        // 如果都失败了，假设服务器可能只接受 POST
        // 继续尝试
      }
    }

    // 如果需要 SSE，启动 SSE 连接
    if (this.useSSE) {
      this.startSSE()
    }

    this.ready = true
  }

  /**
   * 停止 HTTP 传输
   */
  async stop(): Promise<void> {
    this.ready = false

    if (this.sseController) {
      this.sseController.abort()
      this.sseController = null
    }

    this.handleClose()
  }

  /**
   * 发送 HTTP 请求
   */
  protected async send(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.httpConfig.headers
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.httpConfig.timeout ?? 30000)
    })

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`)
    }

    // 如果是请求（有 id），处理响应
    if ('id' in message) {
      const contentType = response.headers.get('content-type')
      if (contentType?.includes('application/json')) {
        const result = await response.json() as JsonRpcResponse
        this.handleMessage(result)
      }
    }
  }

  /**
   * 启动 SSE 连接接收通知
   */
  private startSSE(): void {
    this.sseController = new AbortController()

    const sseUrl = `${this.baseUrl}/sse`

    const connect = async () => {
      try {
        const response = await fetch(sseUrl, {
          headers: {
            'Accept': 'text/event-stream',
            ...this.httpConfig.headers
          },
          signal: this.sseController!.signal
        })

        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: ${response.status}`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // 处理 SSE 消息
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          let data = ''
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              data += line.slice(6)
            } else if (line === '' && data) {
              // 空行表示消息结束
              try {
                const message = JSON.parse(data) as JsonRpcResponse | JsonRpcNotification
                this.handleMessage(message)
              } catch {
                if (this.config.debug) {
                  console.debug('[MCP] Failed to parse SSE data:', data)
                }
              }
              data = ''
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        this.handleError(error as Error)

        // 如果还在运行，尝试重连
        if (this.ready && this.sseController && !this.sseController.signal.aborted) {
          setTimeout(() => connect(), 5000)
        }
      }
    }

    connect()
  }

  /**
   * 获取基础 URL
   */
  getBaseUrl(): string {
    return this.baseUrl
  }
}

/**
 * 创建 HTTP 传输
 */
export function createHttpTransport(
  config: MCPHttpConfig,
  options?: Omit<HttpTransportConfig, 'http'>
): HttpTransport {
  return new HttpTransport({
    ...options,
    http: config
  })
}
