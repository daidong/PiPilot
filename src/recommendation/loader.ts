/**
 * Catalog Loader - Load and validate YAML catalog files
 *
 * Provides cached loading of MCP and tool catalogs from YAML files
 * with Zod schema validation.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { ZodError } from 'zod'

import {
  MCPCatalogSchema,
  type MCPCatalog,
  type MCPServerEntry
} from './schemas/mcp-catalog.schema.js'

import {
  ToolCatalogSchema,
  type ToolCatalog,
  type ToolCatalogEntry,
  type PackCatalogEntry
} from './schemas/tool-catalog.schema.js'

// ============================================================================
// Path Resolution
// ============================================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Find the data directory - handles both development (src/) and production (dist/)
 */
function findDataDir(): string {
  // Try relative to current file first (works in both src and dist)
  const localDataDir = join(__dirname, 'data')
  if (existsSync(localDataDir)) {
    return localDataDir
  }

  // Try going up from dist/recommendation to find src/recommendation/data
  const srcDataDir = join(__dirname, '..', '..', 'src', 'recommendation', 'data')
  if (existsSync(srcDataDir)) {
    return srcDataDir
  }

  // Fallback to local (will error if files don't exist)
  return localDataDir
}

const DATA_DIR = findDataDir()
const MCP_CATALOG_PATH = join(DATA_DIR, 'mcp-catalog.yaml')
const TOOL_CATALOG_PATH = join(DATA_DIR, 'tool-catalog.yaml')

// ============================================================================
// Cache
// ============================================================================

interface CacheEntry<T> {
  data: T
  loadedAt: number
}

const cache: {
  mcp?: CacheEntry<MCPCatalog>
  tool?: CacheEntry<ToolCatalog>
} = {}

// Cache TTL: 5 minutes (in development, files might change)
const CACHE_TTL_MS = 5 * 60 * 1000

function isCacheValid<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  if (!entry) return false
  return Date.now() - entry.loadedAt < CACHE_TTL_MS
}

// ============================================================================
// Loader Functions
// ============================================================================

/**
 * Load the MCP catalog from YAML file
 * @param forceReload - Force reload from disk, ignoring cache
 * @throws Error if file cannot be read or validation fails
 */
export function loadMCPCatalog(forceReload = false): MCPCatalog {
  if (!forceReload && isCacheValid(cache.mcp)) {
    return cache.mcp.data
  }

  try {
    const content = readFileSync(MCP_CATALOG_PATH, 'utf-8')
    const parsed = YAML.parse(content)
    const validated = MCPCatalogSchema.parse(parsed)

    cache.mcp = {
      data: validated,
      loadedAt: Date.now()
    }

    return validated
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
      throw new Error(`MCP catalog validation failed:\n${issues}`)
    }
    throw error
  }
}

/**
 * Load the tool catalog from YAML file
 * @param forceReload - Force reload from disk, ignoring cache
 * @throws Error if file cannot be read or validation fails
 */
export function loadToolCatalog(forceReload = false): ToolCatalog {
  if (!forceReload && isCacheValid(cache.tool)) {
    return cache.tool.data
  }

  try {
    const content = readFileSync(TOOL_CATALOG_PATH, 'utf-8')
    const parsed = YAML.parse(content)
    const validated = ToolCatalogSchema.parse(parsed)

    cache.tool = {
      data: validated,
      loadedAt: Date.now()
    }

    return validated
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
      throw new Error(`Tool catalog validation failed:\n${issues}`)
    }
    throw error
  }
}

// ============================================================================
// Convenience Accessors
// ============================================================================

/**
 * Get all MCP server entries from the catalog
 */
export function getMCPEntries(): MCPServerEntry[] {
  return loadMCPCatalog().entries
}

/**
 * Get all tool entries from the catalog
 */
export function getToolEntries(): ToolCatalogEntry[] {
  return loadToolCatalog().tools
}

/**
 * Get all pack entries from the catalog
 */
export function getPackEntries(): PackCatalogEntry[] {
  return loadToolCatalog().packs
}

/**
 * Get an MCP server entry by name
 */
export function getMCPByName(name: string): MCPServerEntry | undefined {
  return getMCPEntries().find(e => e.name === name)
}

/**
 * Get a tool entry by name
 */
export function getToolByName(name: string): ToolCatalogEntry | undefined {
  return getToolEntries().find(t => t.name === name)
}

/**
 * Get a pack entry by name
 */
export function getPackByName(name: string): PackCatalogEntry | undefined {
  return getPackEntries().find(p => p.name === name)
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Clear the loader cache
 */
export function clearCache(): void {
  delete cache.mcp
  delete cache.tool
}

/**
 * Get cache status for debugging
 */
export function getCacheStatus(): {
  mcp: { loaded: boolean; age?: number }
  tool: { loaded: boolean; age?: number }
} {
  return {
    mcp: {
      loaded: !!cache.mcp,
      age: cache.mcp ? Date.now() - cache.mcp.loadedAt : undefined
    },
    tool: {
      loaded: !!cache.tool,
      age: cache.tool ? Date.now() - cache.tool.loadedAt : undefined
    }
  }
}
