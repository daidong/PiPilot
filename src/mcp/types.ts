/**
 * MCP (Model Context Protocol) Types
 *
 * Defines types related to the MCP adapter
 */

import type { ProviderPermissions, ProviderBudgets } from '../types/provider.js'

// ============================================================================
// Transport Types
// ============================================================================

/**
 * STDIO transport configuration
 */
export interface MCPStdioConfig {
  type: 'stdio'
  /** Command to execute */
  command: string
  /** Command arguments */
  args?: string[]
  /** Working directory */
  cwd?: string
  /** Environment variables */
  env?: Record<string, string>
  /** Request timeout (ms). Default: 30000. Increase for slow-starting servers. */
  timeout?: number
  /** Startup timeout (ms). Default: 10000. Increase for servers that need time to initialize (e.g., MarkItDown Python venv). */
  startTimeout?: number
}

/**
 * HTTP transport configuration
 */
export interface MCPHttpConfig {
  type: 'http'
  /** MCP server URL */
  url: string
  /** Request headers */
  headers?: Record<string, string>
  /** Request timeout (ms) */
  timeout?: number
}

/**
 * Transport configuration union type
 */
export type MCPTransportConfig = MCPStdioConfig | MCPHttpConfig

// ============================================================================
// Server Configuration
// ============================================================================

/**
 * MCP Server configuration
 */
export interface MCPServerConfig {
  /** Unique identifier */
  id: string
  /** Display name */
  name: string
  /** Transport configuration */
  transport: MCPTransportConfig
  /** Permission overrides (optional) */
  permissions?: ProviderPermissions
  /** Budget overrides (optional) */
  budgets?: ProviderBudgets
  /** Tool name prefix (to avoid conflicts) */
  toolPrefix?: string
  /** Connection timeout (ms) */
  connectTimeout?: number
  /** Whether to auto-reconnect */
  autoReconnect?: boolean
}

// ============================================================================
// MCP Protocol Types (JSON-RPC 2.0)
// ============================================================================

/**
 * JSON-RPC request
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

/**
 * JSON-RPC response
 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id: string | number
  result?: T
  error?: JsonRpcError
}

/**
 * JSON-RPC error
 */
export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/**
 * JSON-RPC notification (no id)
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
 * MCP tool definition (from the MCP protocol)
 */
export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: MCPInputSchema
}

/**
 * MCP input schema (subset of JSON Schema)
 */
export interface MCPInputSchema {
  type: 'object'
  properties?: Record<string, MCPPropertySchema>
  required?: string[]
  additionalProperties?: boolean
}

/**
 * MCP property schema
 */
export interface MCPPropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  enum?: unknown[]
  default?: unknown
  items?: MCPPropertySchema
  properties?: Record<string, MCPPropertySchema>
  required?: string[]
  /** JSON Schema const (single allowed value) */
  const?: unknown
  /** JSON Schema anyOf (union types — often used for enum-like constraints) */
  anyOf?: MCPPropertySchema[]
  /** JSON Schema oneOf (exclusive union types) */
  oneOf?: MCPPropertySchema[]
}

/**
 * MCP tool call result
 */
export interface MCPToolResult {
  content: MCPContent[]
  isError?: boolean
}

/**
 * MCP content types
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
 * MCP initialization parameters
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
 * MCP client capabilities
 */
export interface MCPClientCapabilities {
  roots?: { listChanged?: boolean }
  sampling?: Record<string, never>
  experimental?: Record<string, unknown>
}

/**
 * MCP initialization result
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
 * MCP server capabilities
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
 * MCP client state
 */
export type MCPClientState =
  | 'disconnected'
  | 'connecting'
  | 'initializing'
  | 'connected'
  | 'error'
  | 'closing'

/**
 * MCP client event types
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
 * MCP Provider configuration
 */
export interface MCPProviderConfig {
  /** Provider ID */
  id: string
  /** Provider name */
  name: string
  /** Provider version */
  version?: string
  /** Provider description */
  description?: string
  /** List of MCP server configurations */
  servers: MCPServerConfig[]
  /** Whether to auto-generate permission policies */
  autoGeneratePolicies?: boolean
  /** Global permissions (applied to all servers) */
  permissions?: ProviderPermissions
  /** Global budgets (applied to all servers) */
  budgets?: ProviderBudgets
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * MCP error codes
 */
export enum MCPErrorCode {
  // JSON-RPC standard errors
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,

  // MCP-specific errors
  ConnectionFailed = -1,
  Timeout = -2,
  ProtocolError = -3,
  ToolNotFound = -4,
  ToolExecutionFailed = -5
}

/**
 * MCP error class
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
