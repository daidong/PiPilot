/**
 * MCP Provider
 *
 * 将 MCP servers 包装为 AgentFoundry Provider
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
 * MCP Provider 类
 *
 * 管理多个 MCP 客户端的生命周期，并将它们的工具暴露为 Packs
 */
export class MCPProvider implements ToolProvider {
  readonly manifest: ToolProviderManifest
  private config: MCPProviderConfig
  private clients: Map<string, MCPClient> = new Map()
  private connected = false

  constructor(config: MCPProviderConfig) {
    this.config = config

    // 构建 manifest
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
        tools: [], // 将在连接后填充
        permissions: server.permissions,
        budgets: server.budgets
      }))
    }
  }

  /**
   * 创建 Packs
   */
  async createPacks(_options?: ProviderCreateOptions): Promise<Pack[]> {
    // 如果尚未连接，连接所有客户端
    if (!this.connected) {
      await this.connectAll()
    }

    const packs: Pack[] = []

    for (const [serverId, client] of this.clients) {
      const serverConfig = this.config.servers.find((s) => s.id === serverId)
      if (!serverConfig) continue

      // 获取工具列表
      const mcpTools = await client.listTools()

      // 转换为 AgentFoundry 工具
      const tools = adaptMCPTools(mcpTools, client, {
        prefix: serverConfig.toolPrefix ?? serverId,
        timeout: serverConfig.budgets?.timeoutMs,
        includeSource: true,
        sourceName: serverConfig.name
      })

      // 创建 Pack
      const pack = this.createServerPack(serverId, serverConfig, tools)
      packs.push(pack)
    }

    return packs
  }

  /**
   * 连接所有 MCP 服务器
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
   * 断开所有连接
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
   * 销毁 Provider
   */
  async destroy(): Promise<void> {
    await this.disconnectAll()
  }

  /**
   * 获取客户端
   */
  getClient(serverId: string): MCPClient | undefined {
    return this.clients.get(serverId)
  }

  /**
   * 获取所有客户端
   */
  getAllClients(): Map<string, MCPClient> {
    return new Map(this.clients)
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.connected
  }

  /**
   * 创建服务器 Pack
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
      // 生命周期钩子
      onInit: async (_runtime: Runtime) => {
        // 确保客户端已连接
        const client = this.clients.get(serverId)
        if (client && client.getState() !== 'connected') {
          await client.connect()
        }
      },
      onDestroy: async (_runtime: Runtime) => {
        // Pack 销毁时断开对应的客户端
        const client = this.clients.get(serverId)
        if (client) {
          await client.disconnect()
          this.clients.delete(serverId)
        }
      },
      // 添加 prompt fragment
      promptFragment: this.generatePromptFragment(serverConfig, tools)
    })
  }

  /**
   * 生成 prompt fragment
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

以下工具来自外部 MCP 服务器 "${serverConfig.name}"：
- ${toolNames}

这些工具通过 MCP 协议调用，可能有额外的延迟。
`
  }
}

/**
 * 创建 MCP Provider
 */
export function createMCPProvider(config: MCPProviderConfig): MCPProvider {
  return new MCPProvider(config)
}

/**
 * 从单个 MCP 服务器创建 Provider
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
 * 快速创建 STDIO MCP Provider
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
 * 快速创建 HTTP MCP Provider
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
