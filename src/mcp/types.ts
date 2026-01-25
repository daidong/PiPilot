/**
 * MCP (Model Context Protocol) Types
 *
 * 定义 MCP 适配器相关的类型
 */

import type { ProviderPermissions, ProviderBudgets } from '../types/provider.js'

// ============================================================================
// Transport Types
// ============================================================================

/**
 * STDIO 传输配置
 */
export interface MCPStdioConfig {
  type: 'stdio'
  /** 要执行的命令 */
  command: string
  /** 命令参数 */
  args?: string[]
  /** 工作目录 */
  cwd?: string
  /** 环境变量 */
  env?: Record<string, string>
}

/**
 * HTTP 传输配置
 */
export interface MCPHttpConfig {
  type: 'http'
  /** MCP server URL */
  url: string
  /** 请求头 */
  headers?: Record<string, string>
  /** 请求超时（毫秒） */
  timeout?: number
}

/**
 * 传输配置联合类型
 */
export type MCPTransportConfig = MCPStdioConfig | MCPHttpConfig

// ============================================================================
// Server Configuration
// ============================================================================

/**
 * MCP Server 配置
 */
export interface MCPServerConfig {
  /** 唯一标识符 */
  id: string
  /** 显示名称 */
  name: string
  /** 传输配置 */
  transport: MCPTransportConfig
  /** 权限覆盖（可选） */
  permissions?: ProviderPermissions
  /** 预算覆盖（可选） */
  budgets?: ProviderBudgets
  /** 工具名前缀（避免冲突） */
  toolPrefix?: string
  /** 连接超时（毫秒） */
  connectTimeout?: number
  /** 是否自动重连 */
  autoReconnect?: boolean
}

// ============================================================================
// MCP Protocol Types (JSON-RPC 2.0)
// ============================================================================

/**
 * JSON-RPC 请求
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

/**
 * JSON-RPC 响应
 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id: string | number
  result?: T
  error?: JsonRpcError
}

/**
 * JSON-RPC 错误
 */
export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/**
 * JSON-RPC 通知（无 id）
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

// ============================================================================
// MCP Tool Types
// ============================================================================

/**
 * MCP 工具定义（来自 MCP 协议）
 */
export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: MCPInputSchema
}

/**
 * MCP 输入 Schema（JSON Schema 子集）
 */
export interface MCPInputSchema {
  type: 'object'
  properties?: Record<string, MCPPropertySchema>
  required?: string[]
  additionalProperties?: boolean
}

/**
 * MCP 属性 Schema
 */
export interface MCPPropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  enum?: unknown[]
  default?: unknown
  items?: MCPPropertySchema
  properties?: Record<string, MCPPropertySchema>
  required?: string[]
}

/**
 * MCP 工具调用结果
 */
export interface MCPToolResult {
  content: MCPContent[]
  isError?: boolean
}

/**
 * MCP 内容类型
 */
export type MCPContent =
  | MCPTextContent
  | MCPImageContent
  | MCPResourceContent

export interface MCPTextContent {
  type: 'text'
  text: string
}

export interface MCPImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export interface MCPResourceContent {
  type: 'resource'
  resource: {
    uri: string
    text?: string
    blob?: string
    mimeType?: string
  }
}

// ============================================================================
// MCP Lifecycle Types
// ============================================================================

/**
 * MCP 初始化参数
 */
export interface MCPInitializeParams {
  protocolVersion: string
  capabilities: MCPClientCapabilities
  clientInfo: {
    name: string
    version: string
  }
}

/**
 * MCP 客户端能力
 */
export interface MCPClientCapabilities {
  roots?: { listChanged?: boolean }
  sampling?: Record<string, never>
  experimental?: Record<string, unknown>
}

/**
 * MCP 初始化结果
 */
export interface MCPInitializeResult {
  protocolVersion: string
  capabilities: MCPServerCapabilities
  serverInfo: {
    name: string
    version: string
  }
}

/**
 * MCP 服务器能力
 */
export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean }
  resources?: { subscribe?: boolean; listChanged?: boolean }
  prompts?: { listChanged?: boolean }
  logging?: Record<string, never>
  experimental?: Record<string, unknown>
}

// ============================================================================
// Client State Types
// ============================================================================

/**
 * MCP 客户端状态
 */
export type MCPClientState =
  | 'disconnected'
  | 'connecting'
  | 'initializing'
  | 'connected'
  | 'error'
  | 'closing'

/**
 * MCP 客户端事件类型
 */
export interface MCPClientEvents {
  'state:change': { from: MCPClientState; to: MCPClientState }
  'tools:updated': { tools: MCPToolDefinition[] }
  'error': { error: Error }
  'notification': { method: string; params: unknown }
}

// ============================================================================
// Provider Types
// ============================================================================

/**
 * MCP Provider 配置
 */
export interface MCPProviderConfig {
  /** Provider ID */
  id: string
  /** Provider 名称 */
  name: string
  /** Provider 版本 */
  version?: string
  /** Provider 描述 */
  description?: string
  /** MCP server 配置列表 */
  servers: MCPServerConfig[]
  /** 是否自动生成权限策略 */
  autoGeneratePolicies?: boolean
  /** 全局权限（应用到所有 server） */
  permissions?: ProviderPermissions
  /** 全局预算（应用到所有 server） */
  budgets?: ProviderBudgets
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * MCP 错误代码
 */
export enum MCPErrorCode {
  // JSON-RPC 标准错误
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,

  // MCP 特定错误
  ConnectionFailed = -1,
  Timeout = -2,
  ProtocolError = -3,
  ToolNotFound = -4,
  ToolExecutionFailed = -5
}

/**
 * MCP 错误类
 */
export class MCPError extends Error {
  readonly code: MCPErrorCode
  readonly data?: unknown

  constructor(code: MCPErrorCode, message: string, data?: unknown) {
    super(message)
    this.name = 'MCPError'
    this.code = code
    this.data = data
  }

  static fromJsonRpcError(error: JsonRpcError): MCPError {
    return new MCPError(error.code as MCPErrorCode, error.message, error.data)
  }
}
