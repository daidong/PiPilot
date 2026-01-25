/**
 * MCP (Model Context Protocol) Module
 *
 * 提供 MCP 适配器，让 AgentFoundry 可以接入 MCP 生态。
 *
 * ## 使用指南
 *
 * MCP 用于连接外部工具服务器，而不是自己实现。
 * - 使用现有 MCP server 获得通用能力（文件系统、GitHub、数据库等）
 * - 自己的业务逻辑请使用 defineTool() 创建本地工具
 *
 * ## 快速开始
 *
 * ```typescript
 * import { createStdioMCPProvider, createHttpMCPProvider } from 'agent-foundry'
 *
 * // 本地 MCP server（推荐大多数场景）
 * const localMCP = createStdioMCPProvider({
 *   id: 'github',
 *   name: 'GitHub',
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-github']
 * })
 *
 * // 远程 MCP server
 * const remoteMCP = createHttpMCPProvider({
 *   id: 'service',
 *   name: 'My Service',
 *   url: 'https://mcp.example.com'
 * })
 * ```
 *
 * 详见 docs/MCP-GUIDE.md
 */

// ============================================================================
// 公共 API（推荐使用）
// ============================================================================

/**
 * 创建 MCP Provider 的便捷函数
 */
export {
  // 最常用：快速创建本地/远程 MCP Provider
  createStdioMCPProvider,
  createHttpMCPProvider,
  // 完整配置：多 server 场景
  createMCPProvider,
  // 单 server 场景
  createSingleServerProvider,
  // Provider 类（高级用法）
  MCPProvider
} from './mcp-provider.js'

/**
 * 配置类型（TypeScript 用户需要）
 */
export type {
  // Server 配置
  MCPServerConfig,
  MCPProviderConfig,
  // 传输配置
  MCPStdioConfig,
  MCPHttpConfig,
  MCPTransportConfig
} from './types.js'

/**
 * 错误处理
 */
export { MCPError, MCPErrorCode } from './types.js'

// ============================================================================
// 高级 API（特殊场景使用）
// ============================================================================

/**
 * MCP 客户端（直接与 MCP server 通信）
 *
 * 大多数用户应使用 createStdioMCPProvider/createHttpMCPProvider，
 * 而不是直接使用 MCPClient。
 */
export {
  MCPClient,
  createMCPClient,
  type MCPClientConfig
} from './client.js'

/**
 * 工具适配器（将 MCP 工具转为 AgentFoundry 工具）
 *
 * MCPProvider 内部使用，通常不需要直接调用。
 */
export {
  adaptMCPTool,
  adaptMCPTools,
  convertJsonSchemaToParameters,
  validateToolInput,
  type ToolAdapterOptions,
  type MCPToolResultData
} from './tool-adapter.js'

// ============================================================================
// 内部实现（一般不需要直接使用）
// ============================================================================

/**
 * 传输层实现
 *
 * @internal 这些是底层实现，普通用户不需要直接使用。
 * 如果你需要自定义传输层，可以使用这些类。
 */
export {
  MCPTransport,
  type TransportConfig,
  type TransportEvents
} from './transport/base.js'

export {
  StdioTransport,
  createStdioTransport,
  type StdioTransportConfig
} from './transport/stdio.js'

export {
  HttpTransport,
  createHttpTransport,
  type HttpTransportConfig
} from './transport/http.js'

/**
 * 协议类型
 *
 * @internal MCP 协议相关的底层类型
 */
export type {
  // 工具定义
  MCPToolDefinition,
  MCPToolResult,
  MCPContent,
  MCPTextContent,
  MCPImageContent,
  MCPResourceContent,
  MCPInputSchema,
  MCPPropertySchema,
  // 客户端状态
  MCPClientState,
  MCPClientEvents,
  // 生命周期
  MCPInitializeParams,
  MCPInitializeResult,
  MCPServerCapabilities,
  MCPClientCapabilities,
  // JSON-RPC
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcNotification
} from './types.js'
