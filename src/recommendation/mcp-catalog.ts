/**
 * MCP Server Catalog - MCP Server Directory
 *
 * Provides functions to query and filter MCP servers from the catalog.
 * Data is loaded from YAML files and validated with Zod schemas.
 */

import { getMCPEntries, getMCPByName } from './loader.js'
import { scoreMCPServers, type ScoredRecommendation } from './scorer.js'
import {
  type MCPServerEntry,
  type MCPCategory,
  CATEGORY_ORDER
} from './schemas/mcp-catalog.schema.js'

// Re-export types for backward compatibility
export type { MCPServerEntry } from './schemas/mcp-catalog.schema.js'
export type { ConfigTemplate, Permission } from './schemas/mcp-catalog.schema.js'

// ============================================================================
// Catalog Access
// ============================================================================

/**
 * Get all MCP servers in the catalog
 */
export function getMCPCatalog(): MCPServerEntry[] {
  return getMCPEntries()
}

// ============================================================================
// Scoring-based Search (New API)
// ============================================================================

/**
 * Score MCP servers against a query text
 *
 * Returns scored results with match reasons, sorted by relevance.
 *
 * @param query - User query text
 * @param options - Scoring options
 * @returns Scored MCP server recommendations
 */
export function scoreMCPByQuery(
  query: string,
  options: {
    minScore?: number
    limit?: number
    categoryHint?: MCPCategory
  } = {}
): ScoredRecommendation<MCPServerEntry>[] {
  return scoreMCPServers(getMCPEntries(), query, options)
}

// ============================================================================
// Category and Filter Functions
// ============================================================================

/**
 * Get MCP servers by category
 */
export function getMCPByCategory(category: MCPCategory): MCPServerEntry[] {
  return getMCPEntries().filter(server => server.category === category)
}

/**
 * Get high-popularity MCP servers
 */
export function getPopularMCP(): MCPServerEntry[] {
  return getMCPEntries().filter(server => server.popularity === 'high')
}

/**
 * Get MCP server by name
 */
export function getMCPServerByName(name: string): MCPServerEntry | undefined {
  return getMCPByName(name)
}

// ============================================================================
// LLM Formatting
// ============================================================================

/**
 * Format MCP catalog for LLM consumption
 *
 * Uses deterministic ordering (by category, then by popularity, then by name)
 * for consistent LLM behavior.
 */
export function formatMCPCatalogForLLM(): string {
  const entries = getMCPEntries()

  // Group by category
  const byCategory = new Map<MCPCategory, MCPServerEntry[]>()
  for (const category of CATEGORY_ORDER) {
    byCategory.set(category, [])
  }

  for (const server of entries) {
    const list = byCategory.get(server.category) || []
    list.push(server)
    byCategory.set(server.category, list)
  }

  // Sort entries within each category by popularity (high first), then by name
  const popularityOrder = { high: 0, medium: 1, low: 2 }
  for (const [, servers] of byCategory) {
    servers.sort((a, b) => {
      const popDiff = popularityOrder[a.popularity] - popularityOrder[b.popularity]
      if (popDiff !== 0) return popDiff
      return a.name.localeCompare(b.name)
    })
  }

  // Build output
  const sections: string[] = []

  for (const category of CATEGORY_ORDER) {
    const servers = byCategory.get(category) || []
    if (servers.length === 0) continue

    const serverDescriptions = servers.map(s => {
      const popularity = s.popularity === 'high' ? ' ⭐' : ''
      const envNote = s.envVars?.length ? ` (needs: ${s.envVars.join(', ')})` : ''
      return `  - ${s.name}${popularity}: ${s.description}${envNote}`
    }).join('\n')

    sections.push(`
### ${category}
${serverDescriptions}
`.trim())
  }

  return sections.join('\n\n')
}

// ============================================================================
// Environment Variable Collection
// ============================================================================

/**
 * Collect all required environment variables from a list of servers
 */
export function collectEnvVars(servers: MCPServerEntry[]): Record<string, string> {
  const envVars: Record<string, string> = {}

  for (const server of servers) {
    if (server.envVars && server.envVarDescriptions) {
      for (const envVar of server.envVars) {
        envVars[envVar] = server.envVarDescriptions[envVar] || ''
      }
    }
  }

  return envVars
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if an MCP server has parameterized configuration
 */
export function hasParameterizedConfig(entry: MCPServerEntry): boolean {
  return entry.configTemplate.type === 'parameterized'
}

/**
 * Get servers that require user configuration
 */
export function getServersRequiringConfig(): MCPServerEntry[] {
  return getMCPEntries().filter(server =>
    hasParameterizedConfig(server) || (server.envVars && server.envVars.length > 0)
  )
}
