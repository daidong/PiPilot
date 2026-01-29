/**
 * Tool Catalog Schema - Zod schemas for tool and pack catalog entries
 *
 * Defines the structure of tool and pack catalog entries with full type safety
 * and runtime validation support.
 */

import { z } from 'zod'

// ============================================================================
// Category and Risk Level Enums
// ============================================================================

export const ToolCategorySchema = z.enum([
  'safe',
  'exec',
  'network',
  'compute'
])

export type ToolCategory = z.infer<typeof ToolCategorySchema>

export const RiskLevelSchema = z.enum(['safe', 'elevated', 'high'])

export type RiskLevel = z.infer<typeof RiskLevelSchema>

// ============================================================================
// Tool Catalog Entry
// ============================================================================

export const ToolCatalogEntrySchema = z.object({
  // Basic info
  name: z.string(),
  category: ToolCategorySchema,
  description: z.string(),

  // Keywords and use cases
  useCases: z.array(z.string()),
  keywords: z.array(z.string()),

  // Risk and approval
  riskLevel: RiskLevelSchema,
  requiresApproval: z.boolean(),

  // Pack association
  providedBy: z.string(),

  // Optional fields
  dependencies: z.array(z.string()).optional(),
  exampleUsage: z.string().optional()
})

export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntrySchema>

// ============================================================================
// Pack Catalog Entry
// ============================================================================

export const PackCatalogEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  tools: z.array(z.string()),
  riskLevel: RiskLevelSchema,
  keywords: z.array(z.string())
})

export type PackCatalogEntry = z.infer<typeof PackCatalogEntrySchema>

// ============================================================================
// Full Catalog Schemas
// ============================================================================

export const ToolCatalogSchema = z.object({
  version: z.string(),
  lastUpdated: z.string(),
  tools: z.array(ToolCatalogEntrySchema),
  packs: z.array(PackCatalogEntrySchema)
})

export type ToolCatalog = z.infer<typeof ToolCatalogSchema>

// ============================================================================
// Pack Order (for deterministic output)
// ============================================================================

export const PACK_ORDER: string[] = [
  'safe',
  'compute',
  'network',
  'exec'
]
