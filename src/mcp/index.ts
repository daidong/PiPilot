/**
 * MCP (Model Context Protocol) Module
 *
 * Provides MCP adapters so that AgentFoundry can integrate with the MCP ecosystem.
 *
 * ## Usage Guide
 *
 * MCP is used to connect to external tool servers, not to implement your own.
 * - Use existing MCP servers for common capabilities (filesystem, GitHub, databases, etc.)
 * - For your own business logic, use defineTool() to create local tools
 *
 * ## Quick Start
 *
 * ```typescript
 * import { createStdioMCPProvider, createHttpMCPProvider } from 'agent-foundry'
 *
 * // Local MCP server (recommended for most scenarios)
 * const localMCP = createStdioMCPProvider({
 *   id: 'github',
 *   name: 'GitHub',
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-github']
 * })
 *
 * // Remote MCP server
 * const remoteMCP = createHttpMCPProvider({
 *   id: 'service',
 *   name: 'My Service',
 *   url: 'https://mcp.example.com'
 * })
 * ```
 *
 * See docs/MCP-GUIDE.md for details
 */

// ============================================================================
// Public API (recommended)
// ============================================================================

/**
 * Convenience functions for creating MCP Providers
 */
export {
  // Most common: quickly create local/remote MCP Providers
  createStdioMCPProvider,
  createHttpMCPProvider,
  // Full configuration: multi-server scenarios
  createMCPProvider,
  // Single server scenario
  createSingleServerProvider,
  // Provider class (advanced usage)
  MCPProvider
} from './mcp-provider.js'

/**
 * Configuration types (needed by TypeScript users)
 */
export type {
  // Server configuration
  MCPServerConfig,
  MCPProviderConfig,
  // Transport configuration
  MCPStdioConfig,
  MCPHttpConfig,
  MCPTransportConfig
} from './types.js'

/**
 * Error handling
 */
export { MCPError, MCPErrorCode } from './types.js'

// ============================================================================
// Advanced API (for special scenarios)
// ============================================================================

/**
 * MCP Client (communicates directly with MCP servers)
 *
 * Most users should use createStdioMCPProvider/createHttpMCPProvider
 * instead of using MCPClient directly.
 */
export {
  MCPClient,
  createMCPClient,
  type MCPClientConfig
} from './client.js'

/**
 * Tool adapter (converts MCP tools to AgentFoundry tools)
 *
 * Used internally by MCPProvider; typically does not need to be called directly.
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
// Internal implementation (generally not needed directly)
// ============================================================================

/**
 * Transport layer implementations
 *
 * @internal These are low-level implementations that most users do not need to use directly.
 * Use these classes if you need to implement a custom transport layer.
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
 * Protocol types
 *
 * @internal Low-level types related to the MCP protocol
 */
export type {
  // Tool definitions
  MCPToolDefinition,
  MCPToolResult,
  MCPContent,
  MCPTextContent,
  MCPImageContent,
  MCPResourceContent,
  MCPInputSchema,
  MCPPropertySchema,
  // Client state
  MCPClientState,
  MCPClientEvents,
  // Lifecycle
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
