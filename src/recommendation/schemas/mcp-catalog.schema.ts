/**
 * MCP Catalog Schema - Zod schemas for MCP server entries
 *
 * Defines the structure of MCP server catalog entries with full type safety
 * and runtime validation support.
 */

import { z } from 'zod'

// ============================================================================
// Category and Risk Level Enums
// ============================================================================

export const MCPCategorySchema = z.enum([
  'filesystem',
  'database',
  'search',
  'dev-tools',
  'communication',
  'documents',
  'memory',
  'other'
])

export type MCPCategory = z.infer<typeof MCPCategorySchema>

export const RiskLevelSchema = z.enum(['safe', 'elevated', 'high'])

export type RiskLevel = z.infer<typeof RiskLevelSchema>

export const PopularitySchema = z.enum(['high', 'medium', 'low'])

export type Popularity = z.infer<typeof PopularitySchema>

// ============================================================================
// Platform and Requirements
// ============================================================================

export const PlatformSchema = z.enum(['darwin', 'linux', 'win32'])

export type Platform = z.infer<typeof PlatformSchema>

export const RequirementsSchema = z.object({
  node: z.string().optional(),
  dependencies: z.array(z.string()).optional()
}).optional()

export type Requirements = z.infer<typeof RequirementsSchema>

// ============================================================================
// Structured Permissions
// ============================================================================

export const PermissionTypeSchema = z.enum([
  'filesystem',
  'network',
  'database',
  'api',
  'system',
  'memory'
])

export const PermissionAccessSchema = z.enum([
  'read',
  'write',
  'read-write',
  'execute'
])

export const PermissionSchema = z.object({
  type: PermissionTypeSchema,
  access: PermissionAccessSchema,
  scope: z.string().optional(),
  resources: z.array(z.string()).optional()
})

export type Permission = z.infer<typeof PermissionSchema>

// ============================================================================
// Transport Configuration
// ============================================================================

export const StdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional()
})

export const HttpTransportSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  timeout: z.number().positive().optional()
})

export const TransportConfigSchema = z.discriminatedUnion('type', [
  StdioTransportSchema,
  HttpTransportSchema
])

export type TransportConfig = z.infer<typeof TransportConfigSchema>

// ============================================================================
// Template Parameters (for parameterized templates)
// ============================================================================

export const TemplateParameterTypeSchema = z.enum([
  'string',
  'string[]',
  'path',
  'path[]'
])

export const PathValidationSchema = z.object({
  type: z.literal('path'),
  mustExist: z.boolean().optional()
})

export const RegexValidationSchema = z.object({
  type: z.literal('regex'),
  pattern: z.string()
})

export const ParameterValidationSchema = z.discriminatedUnion('type', [
  PathValidationSchema,
  RegexValidationSchema
])

export const TemplateParameterSchema = z.object({
  name: z.string(),
  type: TemplateParameterTypeSchema,
  required: z.boolean(),
  description: z.string(),
  default: z.union([z.string(), z.array(z.string())]).optional(),
  validation: ParameterValidationSchema.optional()
})

export type TemplateParameter = z.infer<typeof TemplateParameterSchema>

// ============================================================================
// Config Template (simple or parameterized)
// ============================================================================

export const SimpleConfigTemplateSchema = z.object({
  type: z.literal('simple'),
  id: z.string(),
  name: z.string(),
  transport: TransportConfigSchema,
  permissions: z.any().optional(),
  budgets: z.any().optional(),
  toolPrefix: z.string().optional(),
  connectTimeout: z.number().positive().optional(),
  autoReconnect: z.boolean().optional()
})

export const ParameterizedConfigTemplateSchema = z.object({
  type: z.literal('parameterized'),
  id: z.string(),
  name: z.string(),
  parameters: z.array(TemplateParameterSchema),
  transport: z.object({
    type: z.literal('stdio'),
    command: z.string(),
    baseArgs: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional()
  }),
  permissions: z.any().optional(),
  budgets: z.any().optional(),
  toolPrefix: z.string().optional(),
  connectTimeout: z.number().positive().optional(),
  autoReconnect: z.boolean().optional()
})

export const ConfigTemplateSchema = z.discriminatedUnion('type', [
  SimpleConfigTemplateSchema,
  ParameterizedConfigTemplateSchema
])

export type ConfigTemplate = z.infer<typeof ConfigTemplateSchema>

// ============================================================================
// MCP Server Entry
// ============================================================================

export const MCPServerEntrySchema = z.object({
  // Basic info
  name: z.string(),
  package: z.string(),
  description: z.string(),
  category: MCPCategorySchema,

  // Keywords and use cases
  keywords: z.array(z.string()),
  useCases: z.array(z.string()),

  // Popularity and risk
  popularity: PopularitySchema,
  riskLevel: RiskLevelSchema,

  // Configuration
  configTemplate: ConfigTemplateSchema,

  // Environment variables
  envVars: z.array(z.string()).optional(),
  envVarDescriptions: z.record(z.string()).optional(),

  // Install and documentation
  installCommand: z.string(),
  documentation: z.string().url(),

  // Structured permissions
  permissions: z.array(PermissionSchema),

  // New metadata fields
  platform: z.array(PlatformSchema).optional(),
  requires: RequirementsSchema,
  versionOrRange: z.string().optional(),
  lastVerified: z.string().optional()
})

export type MCPServerEntry = z.infer<typeof MCPServerEntrySchema>

// ============================================================================
// Full Catalog Schema
// ============================================================================

export const MCPCatalogSchema = z.object({
  version: z.string(),
  lastUpdated: z.string(),
  entries: z.array(MCPServerEntrySchema)
})

export type MCPCatalog = z.infer<typeof MCPCatalogSchema>

// ============================================================================
// Category Order (for deterministic LLM output)
// ============================================================================

export const CATEGORY_ORDER: MCPCategory[] = [
  'filesystem',
  'database',
  'search',
  'dev-tools',
  'communication',
  'documents',
  'memory',
  'other'
]
