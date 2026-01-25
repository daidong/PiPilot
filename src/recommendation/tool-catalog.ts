/**
 * Tool Catalog - Built-in Tools Directory
 *
 * Provides functions to query and filter tools and packs from the catalog.
 * Data is loaded from YAML files and validated with Zod schemas.
 */

import { getToolEntries, getPackEntries, getToolByName, getPackByName } from './loader.js'
import { scoreTools, scorePacks, type ScoredRecommendation } from './scorer.js'
import {
  type ToolCatalogEntry,
  type PackCatalogEntry,
  PACK_ORDER
} from './schemas/tool-catalog.schema.js'

// Re-export types for backward compatibility
export type { ToolCatalogEntry, PackCatalogEntry } from './schemas/tool-catalog.schema.js'

// ============================================================================
// Catalog Access
// ============================================================================

/**
 * Get all tools in the catalog
 */
export function getToolCatalog(): ToolCatalogEntry[] {
  return getToolEntries()
}

/**
 * Get all packs in the catalog
 */
export function getPackCatalog(): PackCatalogEntry[] {
  return getPackEntries()
}

// ============================================================================
// Scoring-based Search (New API)
// ============================================================================

/**
 * Score tools against a query text
 *
 * Returns scored results with match reasons, sorted by relevance.
 *
 * @param query - User query text
 * @param options - Scoring options
 * @returns Scored tool recommendations
 */
export function scoreToolsByQuery(
  query: string,
  options: {
    minScore?: number
    limit?: number
  } = {}
): ScoredRecommendation<ToolCatalogEntry>[] {
  return scoreTools(getToolEntries(), query, options)
}

/**
 * Score packs against a query text
 *
 * Returns scored results with match reasons, sorted by relevance.
 *
 * @param query - User query text
 * @param options - Scoring options
 * @returns Scored pack recommendations
 */
export function scorePacksByQuery(
  query: string,
  options: {
    minScore?: number
    limit?: number
  } = {}
): ScoredRecommendation<PackCatalogEntry>[] {
  return scorePacks(getPackEntries(), query, options)
}

// ============================================================================
// Tool and Pack Lookup
// ============================================================================

/**
 * Get a tool by name
 */
export function getToolCatalogByName(name: string): ToolCatalogEntry | undefined {
  return getToolByName(name)
}

/**
 * Get a pack by name
 */
export function getPackCatalogByName(name: string): PackCatalogEntry | undefined {
  return getPackByName(name)
}

/**
 * Get all tools provided by a pack
 */
export function getPackTools(packName: string): ToolCatalogEntry[] {
  const pack = getPackByName(packName)
  if (!pack) return []

  return getToolEntries().filter(tool => pack.tools.includes(tool.name))
}

// ============================================================================
// LLM Formatting
// ============================================================================

/**
 * Format tool catalog for LLM consumption
 *
 * Uses deterministic pack ordering for consistent LLM behavior.
 */
export function formatToolCatalogForLLM(): string {
  const packs = getPackEntries()
  const sections: string[] = []

  // Sort packs by PACK_ORDER
  const sortedPacks = [...packs].sort((a, b) => {
    const aIndex = PACK_ORDER.indexOf(a.name)
    const bIndex = PACK_ORDER.indexOf(b.name)
    // Unknown packs go to the end
    const aOrder = aIndex === -1 ? PACK_ORDER.length : aIndex
    const bOrder = bIndex === -1 ? PACK_ORDER.length : bIndex
    return aOrder - bOrder
  })

  for (const pack of sortedPacks) {
    const tools = getPackTools(pack.name)
    // Sort tools alphabetically within pack
    tools.sort((a, b) => a.name.localeCompare(b.name))

    const toolDescriptions = tools.map(t =>
      `  - ${t.name}: ${t.description}`
    ).join('\n')

    sections.push(`
### ${pack.name} Pack (${pack.riskLevel})
${pack.description}

Tools:
${toolDescriptions}
`.trim())
  }

  return sections.join('\n\n')
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get tools by risk level
 */
export function getToolsByRiskLevel(riskLevel: 'safe' | 'elevated' | 'high'): ToolCatalogEntry[] {
  return getToolEntries().filter(tool => tool.riskLevel === riskLevel)
}

/**
 * Get packs by risk level
 */
export function getPacksByRiskLevel(riskLevel: 'safe' | 'elevated' | 'high'): PackCatalogEntry[] {
  return getPackEntries().filter(pack => pack.riskLevel === riskLevel)
}

/**
 * Get tools that require user approval
 */
export function getToolsRequiringApproval(): ToolCatalogEntry[] {
  return getToolEntries().filter(tool => tool.requiresApproval)
}

/**
 * Check if a pack contains high-risk tools
 */
export function isHighRiskPack(packName: string): boolean {
  const pack = getPackByName(packName)
  if (!pack) return false
  return pack.riskLevel === 'high'
}
