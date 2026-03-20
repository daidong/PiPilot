/**
 * sqlite - SQLite Database Pack
 *
 * Provides SQLite query and schema inspection via the official SQLite MCP server.
 * Tools: read_query, write_query, create_table, list_tables, describe_table, append_insight
 */

import { createStdioMCPProvider } from '../mcp/index.js'
import type { Pack } from '../types/pack.js'

export interface SqlitePackOptions {
  /** Absolute path to the SQLite database file */
  dbPath: string
  /** Tool name prefix. Default: none */
  toolPrefix?: string
  /** Request timeout in ms. Default: 30000 */
  timeout?: number
  /** Server startup timeout in ms. Default: 15000 */
  startTimeout?: number
}

/**
 * Creates a SQLite database pack using the official MCP SQLite server.
 *
 * Provides tools for querying and managing SQLite databases:
 * - read_query: Execute SELECT queries
 * - write_query: Execute INSERT/UPDATE/DELETE
 * - create_table: Create new tables
 * - list_tables: List all tables
 * - describe_table: Show table schema
 * - append_insight: Save analysis insights
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   packs: [packs.safe(), await packs.sqlite({ dbPath: '/path/to/db.sqlite' })]
 * })
 * ```
 */
export async function sqlite(options: SqlitePackOptions): Promise<Pack> {
  const { dbPath, toolPrefix, timeout = 30000, startTimeout = 15000 } = options

  const provider = createStdioMCPProvider({
    id: 'sqlite',
    name: 'SQLite',
    command: 'npx',
    args: ['-y', 'mcp-server-sqlite-npx', dbPath],
    toolPrefix,
    timeout,
    startTimeout
  })

  const packs = await provider.createPacks()

  const pack = packs[0]
  if (!pack) {
    throw new Error('Failed to create SQLite MCP pack')
  }

  return pack
}
