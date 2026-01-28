/**
 * MCP Client
 *
 * 管理与单个 MCP server 的连接和通信
 */

import { EventEmitter } from 'node:events'
import type {
  MCPServerConfig,
  MCPToolDefinition,
  MCPToolResult,
  MCPClientState,
  MCPInitializeParams,
  MCPInitializeResult,
  MCPServerCapabilities
} from './types.js'
import { MCPError, MCPErrorCode } from './types.js'
import { MCPTransport } from './transport/base.js'
import { StdioTransport } from './transport/stdio.js'
import { HttpTransport } from './transport/http.js'

/**
 * MCP 客户端配置
 */
export interface MCPClientConfig extends MCPServerConfig {
  /** 调试模式 */
  debug?: boolean
}

/**
 * MCP 协议版本
 */
const PROTOCOL_VERSION = '2024-11-05'

/**
 * 客户端信息
 */
const CLIENT_INFO = {
  name: 'AgentFoundry',
  version: '0.1.0'
}

/**
 * MCP 客户端
 *
 * 管理与 MCP server 的连接、工具发现和调用
 */
export class MCPClient extends EventEmitter {
  private config: MCPClientConfig
  private transport: MCPTransport | null = null
  private state: MCPClientState = 'disconnected'
  private tools: MCPToolDefinition[] = []
  private serverCapabilities: MCPServerCapabilities | null = null
  private serverInfo: { name: string; version: string } | null = null

  constructor(config: MCPClientConfig) {
    super()
    this.config = {
      connectTimeout: 10000,
      autoReconnect: false,
      ...config
    }
  }

  /**
   * 连接到 MCP server
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return
    }

    this.setState('connecting')

    try {
      // 创建传输层
      this.transport = this.createTransport()

      // 监听传输层事件
      this.transport.on('message', (message) => {
        this.handleNotification(message)
      })

      this.transport.on('error', (error) => {
        this.handleError(error)
      })

      this.transport.on('close', () => {
        this.handleClose()
      })

      // 启动传输
      await this.transport.start()

      // 初始化 MCP 协议
      this.setState('initializing')
      await this.initialize()

      // 获取工具列表
      await this.refreshTools()

      this.setState('connected')
    } catch (error) {
      this.setState('error')
      throw error
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.state === 'disconnected' || this.state === 'closing') {
      return
    }

    this.setState('closing')

    try {
      if (this.transport) {
        await this.transport.stop()
        this.transport = null
      }
    } finally {
      this.setState('disconnected')
    }
  }

  /**
   * 获取可用工具列表
   */
  async listTools(): Promise<MCPToolDefinition[]> {
    await this.ensureConnected()
    return this.tools
  }

  /**
   * 刷新工具列表
   */
  async refreshTools(): Promise<MCPToolDefinition[]> {
    // Allow refreshTools during initialization (called from connect())
    // or when already connected
    if (this.state !== 'connected' && this.state !== 'initializing') {
      await this.ensureConnected()
    }

    const response = await this.transport!.request<{ tools: MCPToolDefinition[] }>(
      'tools/list'
    )

    this.tools = response.tools ?? []
    this.emit('tools:updated', { tools: this.tools })

    return this.tools
  }

  /**
   * 调用工具
   */
  async callTool(name: string, input: unknown): Promise<MCPToolResult> {
    await this.ensureConnected()

    // 检查工具是否存在
    const tool = this.tools.find((t) => t.name === name)
    if (!tool) {
      throw new MCPError(
        MCPErrorCode.ToolNotFound,
        `Tool not found: ${name}`
      )
    }

    try {
      const result = await this.transport!.request<MCPToolResult>('tools/call', {
        name,
        arguments: input
      })

      return result
    } catch (error) {
      throw new MCPError(
        MCPErrorCode.ToolExecutionFailed,
        `Tool execution failed: ${name}`,
        error
      )
    }
  }

  /**
   * 获取当前状态
   */
  getState(): MCPClientState {
    return this.state
  }

  /**
   * 获取缓存的工具列表
   */
  getCachedTools(): MCPToolDefinition[] {
    return [...this.tools]
  }

  /**
   * 获取服务器能力
   */
  getServerCapabilities(): MCPServerCapabilities | null {
    return this.serverCapabilities
  }

  /**
   * 获取服务器信息
   */
  getServerInfo(): { name: string; version: string } | null {
    return this.serverInfo
  }

  /**
   * 获取配置
   */
  getConfig(): MCPClientConfig {
    return { ...this.config }
  }

  /**
   * 创建传输层
   */
  private createTransport(): MCPTransport {
    const { transport } = this.config

    if (transport.type === 'stdio') {
      return new StdioTransport({
        stdio: transport,
        timeout: transport.timeout ?? this.config.connectTimeout,
        startTimeout: transport.startTimeout,
        debug: this.config.debug
      })
    } else if (transport.type === 'http') {
      return new HttpTransport({
        http: transport,
        timeout: transport.timeout,
        debug: this.config.debug
      })
    }

    throw new Error(`Unsupported transport type: ${(transport as { type: string }).type}`)
  }

  /**
   * 初始化 MCP 协议
   */
  private async initialize(): Promise<void> {
    const params: MCPInitializeParams = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        // 客户端支持的能力
      },
      clientInfo: CLIENT_INFO
    }

    const result = await this.transport!.request<MCPInitializeResult>(
      'initialize',
      params
    )

    this.serverCapabilities = result.capabilities
    this.serverInfo = result.serverInfo

    // 发送 initialized 通知
    await this.transport!.notify('notifications/initialized')

    if (this.config.debug) {
      console.debug('[MCP] Initialized with server:', this.serverInfo)
      console.debug('[MCP] Server capabilities:', this.serverCapabilities)
    }
  }

  /**
   * 确保已连接
   */
  private async ensureConnected(): Promise<void> {
    if (this.state !== 'connected') {
      if (this.config.autoReconnect && this.state === 'disconnected') {
        await this.connect()
      } else {
        throw new MCPError(
          MCPErrorCode.ConnectionFailed,
          `Client is not connected (state: ${this.state})`
        )
      }
    }
  }

  /**
   * 设置状态
   */
  private setState(newState: MCPClientState): void {
    const oldState = this.state
    if (oldState === newState) return

    this.state = newState
    this.emit('state:change', { from: oldState, to: newState })

    if (this.config.debug) {
      console.debug(`[MCP] State changed: ${oldState} -> ${newState}`)
    }
  }

  /**
   * 处理通知
   */
  private handleNotification(message: unknown): void {
    const notification = message as { method?: string; params?: unknown }

    if (!notification.method) return

    // 处理工具列表变更通知
    if (notification.method === 'notifications/tools/list_changed') {
      this.refreshTools().catch((error) => {
        if (this.config.debug) {
          console.error('[MCP] Failed to refresh tools:', error)
        }
      })
    }

    this.emit('notification', {
      method: notification.method,
      params: notification.params
    })
  }

  /**
   * 处理错误
   */
  private handleError(error: Error): void {
    if (this.config.debug) {
      console.error('[MCP] Client error:', error)
    }

    this.emit('error', { error })

    if (this.state === 'connected' || this.state === 'initializing') {
      this.setState('error')
    }
  }

  /**
   * 处理连接关闭
   */
  private handleClose(): void {
    if (this.state !== 'disconnected' && this.state !== 'closing') {
      if (this.config.autoReconnect) {
        if (this.config.debug) {
          console.debug('[MCP] Connection closed, attempting reconnect...')
        }
        setTimeout(() => {
          this.connect().catch((error) => {
            if (this.config.debug) {
              console.error('[MCP] Reconnect failed:', error)
            }
          })
        }, 5000)
      } else {
        this.setState('disconnected')
      }
    }
  }
}

/**
 * 创建 MCP 客户端
 */
export function createMCPClient(config: MCPClientConfig): MCPClient {
  return new MCPClient(config)
}
