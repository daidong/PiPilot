/**
 * MCP Client
 *
 * Manages the connection and communication with a single MCP server
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
 * MCP client configuration
 */
export interface MCPClientConfig extends MCPServerConfig {
  /** Debug mode */
  debug?: boolean
}

/**
 * MCP protocol version
 */
const PROTOCOL_VERSION = '2024-11-05'

/**
 * Client information
 */
const CLIENT_INFO = {
  name: 'AgentFoundry',
  version: '0.1.0'
}

/**
 * MCP Client
 *
 * Manages connection, tool discovery, and invocation with an MCP server
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
   * Connect to the MCP server
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return
    }

    this.setState('connecting')

    try {
      // Create transport layer
      this.transport = this.createTransport()

      // Listen for transport layer events
      this.transport.on('message', (message) => {
        this.handleNotification(message)
      })

      this.transport.on('error', (error) => {
        this.handleError(error)
      })

      this.transport.on('close', () => {
        this.handleClose()
      })

      // Start transport
      await this.transport.start()

      // Initialize MCP protocol
      this.setState('initializing')
      await this.initialize()

      // Fetch tool list
      await this.refreshTools()

      this.setState('connected')
    } catch (error) {
      this.setState('error')
      throw error
    }
  }

  /**
   * Disconnect
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
   * Get the list of available tools
   */
  async listTools(): Promise<MCPToolDefinition[]> {
    await this.ensureConnected()
    return this.tools
  }

  /**
   * Refresh the tool list
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
   * Call a tool
   */
  async callTool(name: string, input: unknown): Promise<MCPToolResult> {
    await this.ensureConnected()

    // Check if the tool exists
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
   * Get the current state
   */
  getState(): MCPClientState {
    return this.state
  }

  /**
   * Get the cached tool list
   */
  getCachedTools(): MCPToolDefinition[] {
    return [...this.tools]
  }

  /**
   * Get server capabilities
   */
  getServerCapabilities(): MCPServerCapabilities | null {
    return this.serverCapabilities
  }

  /**
   * Get server information
   */
  getServerInfo(): { name: string; version: string } | null {
    return this.serverInfo
  }

  /**
   * Get configuration
   */
  getConfig(): MCPClientConfig {
    return { ...this.config }
  }

  /**
   * Create the transport layer
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
   * Initialize the MCP protocol
   */
  private async initialize(): Promise<void> {
    const params: MCPInitializeParams = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        // Capabilities supported by the client
      },
      clientInfo: CLIENT_INFO
    }

    const result = await this.transport!.request<MCPInitializeResult>(
      'initialize',
      params
    )

    this.serverCapabilities = result.capabilities
    this.serverInfo = result.serverInfo

    // Send the initialized notification
    await this.transport!.notify('notifications/initialized')

    if (this.config.debug) {
      console.debug('[MCP] Initialized with server:', this.serverInfo)
      console.debug('[MCP] Server capabilities:', this.serverCapabilities)
    }
  }

  /**
   * Ensure the client is connected
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
   * Set state
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
   * Handle notifications
   */
  private handleNotification(message: unknown): void {
    const notification = message as { method?: string; params?: unknown }

    if (!notification.method) return

    // Handle tool list change notification
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
   * Handle errors
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
   * Handle connection close
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
 * Create an MCP client
 */
export function createMCPClient(config: MCPClientConfig): MCPClient {
  return new MCPClient(config)
}
