/**
 * MCP HTTP Transport
 *
 * Communicates with a remote MCP server via HTTP/SSE
 */

import type {
  MCPHttpConfig,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse
} from '../types.js'
import { MCPTransport, type TransportConfig } from './base.js'

/**
 * HTTP transport configuration
 */
export interface HttpTransportConfig extends TransportConfig {
  /** HTTP configuration */
  http: MCPHttpConfig
  /** Whether to use SSE for receiving notifications */
  useSSE?: boolean
}

/**
 * HTTP transport implementation
 *
 * Uses HTTP POST to send requests, optionally SSE for receiving notifications
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
   * Start the HTTP transport
   */
  async start(): Promise<void> {
    if (this.ready) {
      return
    }

    // Verify the server is reachable
    try {
      const response = await fetch(this.baseUrl, {
        method: 'HEAD',
        headers: this.httpConfig.headers,
        signal: AbortSignal.timeout(this.httpConfig.timeout ?? 5000)
      })

      if (!response.ok && response.status !== 405) {
        // 405 is expected (HEAD not supported)
        throw new Error(`Server not reachable: ${response.status}`)
      }
    } catch (error) {
      // If HEAD fails, try OPTIONS
      try {
        const response = await fetch(this.baseUrl, {
          method: 'OPTIONS',
          headers: this.httpConfig.headers,
          signal: AbortSignal.timeout(this.httpConfig.timeout ?? 5000)
        })
        // OPTIONS typically returns 200 or 204
        if (!response.ok && response.status !== 204) {
          throw error
        }
      } catch {
        // If both fail, assume the server may only accept POST
        // Continue trying
      }
    }

    // If SSE is needed, start the SSE connection
    if (this.useSSE) {
      this.startSSE()
    }

    this.ready = true
  }

  /**
   * Stop the HTTP transport
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
   * Send an HTTP request
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

    // If it's a request (has an id), handle the response
    if ('id' in message) {
      const contentType = response.headers.get('content-type')
      if (contentType?.includes('application/json')) {
        const result = await response.json() as JsonRpcResponse
        this.handleMessage(result)
      }
    }
  }

  /**
   * Start an SSE connection to receive notifications
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

          // Process SSE messages
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          let data = ''
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              data += line.slice(6)
            } else if (line === '' && data) {
              // Empty line indicates end of message
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

        // If still running, attempt to reconnect
        if (this.ready && this.sseController && !this.sseController.signal.aborted) {
          setTimeout(() => connect(), 5000)
        }
      }
    }

    connect()
  }

  /**
   * Get the base URL
   */
  getBaseUrl(): string {
    return this.baseUrl
  }
}

/**
 * Create an HTTP transport
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
