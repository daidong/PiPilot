/**
 * Recommendation Schemas - Zod schemas for catalog validation
 */

// MCP Catalog Schema exports
export {
  MCPCategorySchema,
  type MCPCategory,
  PopularitySchema,
  type Popularity,
  PlatformSchema,
  type Platform,
  RequirementsSchema,
  type Requirements,
  PermissionTypeSchema,
  PermissionAccessSchema,
  PermissionSchema,
  type Permission,
  StdioTransportSchema,
  HttpTransportSchema,
  TransportConfigSchema,
  type TransportConfig,
  TemplateParameterTypeSchema,
  PathValidationSchema,
  RegexValidationSchema,
  ParameterValidationSchema,
  TemplateParameterSchema,
  type TemplateParameter,
  SimpleConfigTemplateSchema,
  ParameterizedConfigTemplateSchema,
  ConfigTemplateSchema,
  type ConfigTemplate,
  MCPServerEntrySchema,
  type MCPServerEntry,
  MCPCatalogSchema,
  type MCPCatalog,
  CATEGORY_ORDER
} from './mcp-catalog.schema.js'

// Use MCP's RiskLevelSchema as the canonical one
export {
  RiskLevelSchema,
  type RiskLevel
} from './mcp-catalog.schema.js'

// Tool Catalog Schema exports (excluding RiskLevel to avoid conflict)
export {
  ToolCategorySchema,
  type ToolCategory,
  ToolCatalogEntrySchema,
  type ToolCatalogEntry,
  PackCatalogEntrySchema,
  type PackCatalogEntry,
  ToolCatalogSchema,
  type ToolCatalog,
  PACK_ORDER
} from './tool-catalog.schema.js'
