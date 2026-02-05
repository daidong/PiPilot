/**
 * /save-data Command Handler
 *
 * Registers a data file attachment with provenance tracking.
 *
 * Usage (Ink UI):
 *   /save-data <name> --path /path/to/file.csv [--mime text/csv] [--rows 1000] [--tags "a, b"]
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { PATHS, DataAttachment, CLIContext } from '../types.js'
import { applyProjectCardPolicy } from '../../../src/core/project-card-policy.js'

export interface SaveDataResult {
  success: boolean
  data?: DataAttachment
  filePath?: string
  error?: string
}

/**
 * Save a data attachment programmatically.
 */
export function saveData(
  name: string,
  opts: {
    filePath: string
    mimeType?: string
    rowCount?: number
    columns?: Array<{ name: string; type: string; description?: string }>
    tags?: string[]
    runId?: string
    runLabel?: string
  },
  context: CLIContext
): SaveDataResult {
  if (!name) return { success: false, error: 'Data name is required.' }
  if (!opts.filePath) return { success: false, error: 'File path is required (--path).' }

  if (!existsSync(opts.filePath)) {
    return { success: false, error: `File not found: ${opts.filePath}` }
  }

  const data: DataAttachment = {
    id: crypto.randomUUID(),
    type: 'data',
    name,
    filePath: opts.filePath,
    mimeType: opts.mimeType,
    schema: (opts.rowCount || opts.columns) ? {
      rowCount: opts.rowCount,
      columns: opts.columns
    } : undefined,
    tags: opts.tags ?? [],
    runId: opts.runId,
    runLabel: opts.runLabel,
    projectCard: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance: {
      source: 'user',
      sessionId: context.sessionId,
      extractedFrom: 'user-input'
    }
  }

  applyProjectCardPolicy([data])

  // Use projectPath if provided, otherwise fall back to relative path
  const dataPath = context.projectPath
    ? join(context.projectPath, PATHS.data)
    : PATHS.data

  mkdirSync(dataPath, { recursive: true })
  const metaPath = join(dataPath, `${data.id}.json`)
  writeFileSync(metaPath, JSON.stringify(data, null, 2))

  return { success: true, data, filePath: metaPath }
}

/**
 * Parse /save-data arguments.
 * Format: /save-data <name> --path <file> [--mime type] [--rows N] [--tags "a, b"]
 */
export function parseSaveDataArgs(raw: string): {
  name: string
  filePath: string
  mimeType?: string
  rowCount?: number
  tags?: string[]
} {
  const flagPattern = /--(\w+)\s+"([^"]+)"|--(\w+)\s+(\S+)/g
  const flags: Record<string, string> = {}
  let cleaned = raw

  let match: RegExpExecArray | null
  while ((match = flagPattern.exec(raw)) !== null) {
    const key = match[1] || match[3]
    const value = match[2] || match[4]
    flags[key] = value
    cleaned = cleaned.replace(match[0], '')
  }

  return {
    name: cleaned.trim(),
    filePath: flags.path ?? '',
    mimeType: flags.mime,
    rowCount: flags.rows ? parseInt(flags.rows, 10) : undefined,
    tags: flags.tags?.split(',').map(t => t.trim())
  }
}
