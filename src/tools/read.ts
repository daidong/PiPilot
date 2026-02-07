/**
 * read - File reading tool
 *
 * Features:
 * - Streams large files
 * - Hard limits on maxBytes/maxLines
 * - Consistent output structure (count/truncated/error)
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface ReadInput {
  path: string
  encoding?: BufferEncoding
  offset?: number
  limit?: number
}

export interface ReadOutput {
  /** File content */
  content: string
  /** Total line count (may be actual or estimated before truncation) */
  lines: number
  /** Whether the content was truncated */
  truncated: boolean
  /** Bytes read */
  bytes: number
}

type ReadGuardState = {
  readHistory: Map<string, { revision: number; count: number; lastAt: number; fingerprint?: string }>
  fileRevisions: Map<string, number>
}

/** Extract filename from a path */
function getFileName(path: string): string {
  if (!path) return ''
  return path.split('/').pop() || path
}

export const read: Tool<ReadInput, ReadOutput> = defineTool({
  name: 'read',
  description: `Read file contents. Auto-truncates at system limit. For most files (<500 lines), read the ENTIRE file at once (no offset/limit). Only use offset/limit when you need to re-examine a specific section of a file you already read.`,
  parameters: {
    path: {
      type: 'string',
      description: 'File path (relative to project root)',
      required: true
    },
    encoding: {
      type: 'string',
      description: 'File encoding, defaults to utf-8',
      required: false,
      default: 'utf-8'
    },
    offset: {
      type: 'number',
      description: 'Starting line number (0-based)',
      required: false
    },
    limit: {
      type: 'number',
      description: 'Maximum number of lines to read (subject to system hard limit)',
      required: false
    }
  },
  activity: {
    formatCall: (a) => ({ label: `Read ${getFileName(a.path as string)}`, icon: 'file' }),
    formatResult: (r, a) => {
      const lines = ((r.data as any)?.lines as number) ?? ((r.data as any)?.content as string)?.split('\n').length ?? 0
      return { label: `Read ${getFileName(a?.path as string)} (${lines} lines)`, icon: 'file' }
    }
  },
  execute: async (input, { runtime }) => {
    // Prevent redundant reads within the same run to save tokens.
    // If the exact same read is requested again without the file changing,
    // return a guidance error instead of re-reading.
    const guard = (() => {
      const existing = runtime.sessionState.get<ReadGuardState>('ioGuard')
      if (existing) return existing
      const fresh: ReadGuardState = {
        readHistory: new Map(),
        fileRevisions: new Map()
      }
      runtime.sessionState.set('ioGuard', fresh)
      return fresh
    })()

    const encoding = input.encoding ?? 'utf-8'
    const offset = input.offset ?? 0
    const limit = input.limit
    const readKey = JSON.stringify({ path: input.path, encoding, offset, limit: input.limit ?? null })
    const revision = guard.fileRevisions.get(input.path) ?? 0
    const prior = guard.readHistory.get(readKey)

    // Best-effort fingerprint to detect external edits (size + mtime).
    let fingerprint: string | undefined
    if (runtime.io.stat) {
      const statResult = await runtime.io.stat(input.path)
      if (statResult.success && statResult.data) {
        const size = statResult.data.size
        const mtime = statResult.data.mtimeMs ?? 0
        fingerprint = `${size}:${mtime}`
      }
    }

    if (prior && prior.revision === revision && fingerprint && prior.fingerprint === fingerprint) {
      return {
        success: false,
        error: `Duplicate read detected for ${input.path}. You already read this exact slice in this run. Use read with offset/limit to fetch a different section, or proceed with the content you have.`
      }
    }

    const result = await runtime.io.readFile(input.path, {
      encoding,
      offset,
      limit
    })

    if (!result.success) {
      return {
        success: false,
        error: result.error
      }
    }

    const content = result.data!
    const meta = result.meta ?? {}

    // Record successful reads for duplicate detection
    const count = (prior?.count ?? 0) + 1
    guard.readHistory.set(readKey, { revision, count, lastAt: Date.now(), fingerprint })
    if (guard.readHistory.size > 200) {
      guard.readHistory.clear()
    }

    return {
      success: true,
      data: {
        content,
        lines: meta.lines ?? content.split('\n').length,
        truncated: meta.truncated ?? false,
        bytes: meta.bytes ?? content.length
      }
    }
  }
})
