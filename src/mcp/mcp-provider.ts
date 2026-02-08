/**
 * MCP Provider
 *
 * Wraps MCP servers as an AgentFoundry Provider
 */

import type { ToolProvider, ToolProviderManifest, ProviderCreateOptions } from '../types/provider.js'
import type { Pack } from '../types/pack.js'
import type { Tool } from '../types/tool.js'
import type { Runtime } from '../types/runtime.js'
import type { MCPProviderConfig, MCPServerConfig } from './types.js'
import { MCPClient } from './client.js'
import { adaptMCPTools } from './tool-adapter.js'
import { definePack } from '../factories/define-pack.js'

/**
 * MCP Provider class
 *
 * Manages the lifecycle of multiple MCP clients and exposes their tools as Packs
 */
export class MCPProvider implements ToolProvider {
  readonly manifest: ToolProviderManifest
  private config: MCPProviderConfig
  private clients: Map<string, MCPClient> = new Map()
  private connected = false

  constructor(config: MCPProviderConfig) {
    this.config = config

    // Build manifest
    this.manifest = {
      id: config.id,
      name: config.name,
      version: config.version ?? '1.0.0',
      description: config.description ?? `MCP Provider: ${config.name}`,
      permissions: config.permissions,
      budgets: config.budgets,
      packs: config.servers.map((server) => ({
        id: `${config.id}.${server.id}`,
        description: `MCP tools from ${server.name}`,
        tools: [], // Will be populated after connection
        permissions: server.permissions,
        budgets: server.budgets
      }))
    }
  }

  /**
   * Create Packs
   */
  async createPacks(_options?: ProviderCreateOptions): Promise<Pack[]> {
    // If not yet connected, connect all clients
    if (!this.connected) {
      await this.connectAll()
    }

    const packs: Pack[] = []

    for (const [serverId, client] of this.clients) {
      const serverConfig = this.config.servers.find((s) => s.id === serverId)
      if (!serverConfig) continue

      // Get tool list
      const mcpTools = await client.listTools()

      // Convert to AgentFoundry tools
      const tools = adaptMCPTools(mcpTools, client, {
        prefix: serverConfig.toolPrefix ?? '',
        timeout: serverConfig.budgets?.timeoutMs,
        includeSource: true,
        sourceName: serverConfig.name
      })

      // Create Pack
      const pack = this.createServerPack(serverId, serverConfig, tools)
      packs.push(pack)
    }

    return packs
  }

  /**
   * Connect to all MCP servers
   */
  async connectAll(): Promise<void> {
    const connectPromises = this.config.servers.map(async (serverConfig) => {
      const client = new MCPClient({
        ...serverConfig,
        debug: false
      })

      try {
        await client.connect()
        this.clients.set(serverConfig.id, client)
      } catch (error) {
        console.error(`[MCPProvider] Failed to connect to ${serverConfig.name}:`, error)
        throw error
      }
    })

    await Promise.all(connectPromises)
    this.connected = true
  }

  /**
   * Disconnect all connections
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.clients.values()).map((client) =>
      client.disconnect().catch((error) => {
        console.error('[MCPProvider] Disconnect error:', error)
      })
    )

    await Promise.all(disconnectPromises)
    this.clients.clear()
    this.connected = false
  }

  /**
   * Destroy the Provider
   */
  async destroy(): Promise<void> {
    await this.disconnectAll()
  }

  /**
   * Get a client
   */
  getClient(serverId: string): MCPClient | undefined {
    return this.clients.get(serverId)
  }

  /**
   * Get all clients
   */
  getAllClients(): Map<string, MCPClient> {
    return new Map(this.clients)
  }

  /**
   * Whether the provider is connected
   */
  isConnected(): boolean {
    return this.connected
  }

  /**
   * Create a server Pack
   */
  private createServerPack(
    serverId: string,
    serverConfig: MCPServerConfig,
    tools: Tool[]
  ): Pack {
    const packId = `mcp.${this.config.id}.${serverId}`

    return definePack({
      id: packId,
      description: `MCP tools from ${serverConfig.name}`,
      tools,
      // Lifecycle hooks
      onInit: async (_runtime: Runtime) => {
        // Ensure the client is connected
        const client = this.clients.get(serverId)
        if (client && client.getState() !== 'connected') {
          await client.connect()
        }
      },
      onDestroy: async (_runtime: Runtime) => {
        // Disconnect the corresponding client when the Pack is destroyed
        const client = this.clients.get(serverId)
        if (client) {
          await client.disconnect()
          this.clients.delete(serverId)
        }
      },
      // Add prompt fragment
      promptFragment: this.generatePromptFragment(serverConfig, tools)
    })
  }

  /**
   * Generate prompt fragment
   */
  private generatePromptFragment(
    serverConfig: MCPServerConfig,
    tools: Tool[]
  ): string {
    if (tools.length === 0) {
      return ''
    }

    const toolNames = tools.map((t) => t.name).join(', ')

    return `
## MCP Tools: ${serverConfig.name}

The following tools are provided by the external MCP server "${serverConfig.name}":
- ${toolNames}

These tools are invoked via the MCP protocol and may have additional latency.
`
  }
}

/**
 * Create an MCP Provider
 */
export function createMCPProvider(config: MCPProviderConfig): MCPProvider {
  return new MCPProvider(config)
}

/**
 * Create a Provider from a single MCP server
 */
export function createSingleServerProvider(
  serverConfig: MCPServerConfig & { providerId?: string; providerName?: string }
): MCPProvider {
  return new MCPProvider({
    id: serverConfig.providerId ?? `mcp.${serverConfig.id}`,
    name: serverConfig.providerName ?? serverConfig.name,
    servers: [serverConfig]
  })
}

/**
 * Quickly create a STDIO MCP Provider
 */
export function createStdioMCPProvider(options: {
  id: string
  name: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  toolPrefix?: string
  /** Request timeout in ms. Default: 30000. Increase for slow-starting servers like MarkItDown. */
  timeout?: number
  /** Server startup timeout in ms. Default: 10000. Increase for servers that need time to initialize (e.g., MarkItDown Python venv). */
  startTimeout?: number
}): MCPProvider {
  return new MCPProvider({
    id: options.id,
    name: options.name,
    servers: [
      {
        id: 'default',
        name: options.name,
        transport: {
          type: 'stdio',
          command: options.command,
          args: options.args,
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeout,
          startTimeout: options.startTimeout
        },
        toolPrefix: options.toolPrefix
      }
    ]
  })
}

/**
 * Quickly create an HTTP MCP Provider
 */
export function createHttpMCPProvider(options: {
  id: string
  name: string
  url: string
  headers?: Record<string, string>
  toolPrefix?: string
}): MCPProvider {
  return new MCPProvider({
    id: options.id,
    name: options.name,
    servers: [
      {
        id: 'default',
        name: options.name,
        transport: {
          type: 'http',
          url: options.url,
          headers: options.headers
        },
        toolPrefix: options.toolPrefix
      }
    ]
  })
}
