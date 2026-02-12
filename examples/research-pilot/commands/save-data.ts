/**
 * Legacy compatibility wrapper for data artifact creation.
 * RFC-012 canonical API is artifact.create(type=data).
 */

import { existsSync } from 'fs'
import { type CLIContext, type DataAttachment } from '../types.js'
import { artifactCreate } from './artifact.js'

export interface SaveDataResult {
  success: boolean
  data?: DataAttachment
  filePath?: string
  error?: string
}

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

  const created = artifactCreate({
    type: 'data',
    title: name,
    filePath: opts.filePath,
    mimeType: opts.mimeType,
    schema: (opts.rowCount || opts.columns)
      ? {
          rowCount: opts.rowCount,
          columns: opts.columns
        }
      : undefined,
    runId: opts.runId,
    runLabel: opts.runLabel,
    tags: opts.tags ?? [],
    provenance: {
      source: 'user',
      sessionId: context.sessionId,
      extractedFrom: 'user-input'
    }
  }, context)

  if (!created.success || !created.artifact || created.artifact.type !== 'data') {
    return { success: false, error: 'Failed to create data artifact.' }
  }

  return { success: true, data: created.artifact, filePath: created.filePath }
}

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
